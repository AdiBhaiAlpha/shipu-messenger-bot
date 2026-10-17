import axios from 'axios';
import { aiConfigManager } from './aiConfigManager';
import { OPENROUTER_FALLBACK_KEY, AI_API_KEYS, COHERE_API_KEY } from '../config/aiKeys';
import { OPENROUTER_FALLBACK_ORDER } from '../config/aiModels';
import fs from 'fs-extra';
import path from 'path';

export class OpenRouterService {
  private static instance: OpenRouterService;

  // Per-model circuit breaker: skip models failing repeatedly (reset on success/cooldown).
  private modelFailures = new Map<string, { count: number; lastFail: number }>();
  private static readonly MODEL_FAIL_LIMIT = 3;
  private static readonly MODEL_FAIL_WINDOW_MS = 10 * 60 * 1000;

  /** The model that served the most recent successful response (sticky default). */
  public lastUsedModel = '';

  private constructor() {}

  public static getInstance(): OpenRouterService {
    if (!OpenRouterService.instance) {
      OpenRouterService.instance = new OpenRouterService();
    }
    return OpenRouterService.instance;
  }

  private isModelBlocked(model: string): boolean {
    const rec = this.modelFailures.get(model);
    if (!rec) return false;
    if (Date.now() - rec.lastFail > OpenRouterService.MODEL_FAIL_WINDOW_MS) {
      this.modelFailures.delete(model);
      return false;
    }
    return rec.count >= OpenRouterService.MODEL_FAIL_LIMIT;
  }

  private recordModelFailure(model: string): void {
    const rec = this.modelFailures.get(model) || { count: 0, lastFail: 0 };
    rec.count++;
    rec.lastFail = Date.now();
    this.modelFailures.set(model, rec);
  }

  private recordModelSuccess(model: string): void {
    this.modelFailures.delete(model);
  }

  /**
   * Ordered model chain for one request:
   * explicit model param first, then sticky lastWorkingModel, then the
   * configured fallback order (skipping circuit-broken models).
   */
  public buildModelChain(config: any, explicitModel?: string): string[] {
    const chain: string[] = [];
    const push = (m?: string) => {
      if (m && typeof m === 'string' && !chain.includes(m)) chain.push(m);
    };
    push(explicitModel);
    push(config.lastWorkingModel);
    push(config.defaultModel);
    const order = (config.modelFallbackOrder && config.modelFallbackOrder.length > 0)
      ? config.modelFallbackOrder
      : OPENROUTER_FALLBACK_ORDER;
    for (const m of order) push(m);
    return chain.filter(m => !this.isModelBlocked(m));
  }

  /**
   * Helper to make Chat Completions requests to OpenRouter
   */
  public async generateChatCompletion(
    messages: Array<{ role: string; content: string }>,
    model?: string,
    systemInstruction?: string
  ): Promise<string> {
    const config = await aiConfigManager.getConfig();
    if (!config.aiEnabled) {
      throw new Error('AI features are currently disabled globally.');
    }

    const apiKey = config.openRouterApiKey;
    if (!apiKey) {
      throw new Error('OpenRouter API key is not configured. Please set it in the Admin Dashboard.');
    }

    const requestMessages = [...messages];
    if (systemInstruction) {
      requestMessages.unshift({ role: 'system', content: systemInstruction });
    }

    // Primary key first, hardcoded fallback second (only when different).
    // Cohere trial key first, then OpenRouter keys (dedup).
    const candidateKeys: string[] = [];
    for (const k of AI_API_KEYS) {
      if (k && !candidateKeys.includes(k)) candidateKeys.push(k);
    }
    if (apiKey && !candidateKeys.includes(apiKey)) candidateKeys.unshift(apiKey);

    const modelChain = this.buildModelChain(config, model);
    if (modelChain.length === 0) {
      throw new Error('[OpenRouter API Error]: All models are circuit-broken after repeated failures. Try again later.');
    }

    let lastError: any = null;
    let lastStatus: number | undefined;
    let keysDead = false;
    modelLoop:
    for (const targetModel of modelChain) {
      for (let keyIdx = 0; keyIdx < candidateKeys.length; keyIdx++) {
        const keyInUse = candidateKeys[keyIdx];
        const isFallbackKey = keyIdx > 0;
        try {
          const response = await axios.post(
            'https://openrouter.ai/api/v1/chat/completions',
            {
              model: targetModel,
              messages: requestMessages
            },
            {
              headers: {
                'Authorization': `Bearer ${keyInUse}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': 'https://ai.studio/build',
                'X-Title': 'ShiPu AI Bot'
              },
              timeout: 45000
            }
          );

          const content = response.data?.choices?.[0]?.message?.content;
          if (content === undefined || content === null) {
            throw new Error('Invalid or empty response from OpenRouter');
          }

          // SUCCESS: remember this model as the sticky default until it errors.
          this.lastUsedModel = targetModel;
          this.recordModelSuccess(targetModel);
          const updates: any = {
            status: 'Connected',
            lastSuccessfulRequestTime: new Date().toISOString()
          };
          if (targetModel !== config.lastWorkingModel) {
            updates.lastWorkingModel = targetModel;
          }
          if (isFallbackKey || targetModel !== (model || config.defaultModel)) {
            updates.lastError = `Served by ${targetModel}${isFallbackKey ? ' (fallback key)' : ''} at ${new Date().toLocaleTimeString()}`;
          }
          await aiConfigManager.updateConfig(updates);

          if (isFallbackKey || targetModel !== (model || config.defaultModel)) {
            console.log(`[OpenRouter] Served by fallback model ${targetModel}${isFallbackKey ? ' (fallback key)' : ''}.`);
          }
          return content;
        } catch (err: any) {
          lastError = err;
          lastStatus = err.response?.status;
          const msgText = String(err.response?.data?.error?.message || err.message || '').toLowerCase();
          // Account-level death ("User not found") kills every model+key the
          // same way — abort the whole chain instead of burning 16 models.
          if (msgText.includes('user not found')) {
            keysDead = true;
            console.error('[OpenRouter] API keys rejected (account gone). Aborting model chain.');
            break modelLoop;
          }
          // Fail over across keys AND models on auth rejection, rate limit,
          // missing-model (404), or transport failure — never on 400 payloads.
          const retryable = lastStatus === 401 || lastStatus === 403 || lastStatus === 429 || lastStatus === 404 || lastStatus === undefined;
          if (!retryable) break;
          console.warn(`[OpenRouter] ${targetModel} failed (HTTP ${lastStatus ?? 'network error'}). Trying next...`);
        }
      }
      // Model exhausted on all keys -> circuit-break it and move to next model.
      this.recordModelFailure(targetModel);
    }

    const err: any = lastError || new Error('All OpenRouter models failed');
    {
      const status = lastStatus ?? err.response?.status;
      let errorMsg = err.response?.data?.error?.message || err.message || 'Unknown OpenRouter Error';

      let newStatus: typeof config.status = 'Offline';
      if (status === 401 || status === 403) {
        newStatus = 'Invalid';
      } else if (status === 429) {
        newStatus = 'Rate Limited';
      }

      await aiConfigManager.updateConfig({
        status: newStatus,
        lastError: `${newStatus}: ${errorMsg} (Time: ${new Date().toLocaleTimeString()})`
      });

      throw new Error(`[OpenRouter API Error]: ${errorMsg}`);
    }
  }

  /**
   * Generate speech/audio using the Fish Audio model on OpenRouter
   */
  public async generateSpeech(text: string): Promise<Buffer> {
    const config = await aiConfigManager.getConfig();
    if (!config.aiEnabled) {
      throw new Error('AI features are currently disabled globally.');
    }

    const apiKey = config.openRouterApiKey;
    if (!apiKey) {
      throw new Error('OpenRouter API key is not configured. Please set it in the Admin Dashboard.');
    }

    const model = 'fish-audio/s2.1-pro-free:free';
    
    // Split long text into chunks
    const chunks = this.splitTextForSpeech(text);
    console.log(`[OpenRouter Speech] Text length: ${text.length}, split into ${chunks.length} chunks`);

    const audioBuffers: Buffer[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i].trim();
      if (!chunk) continue;

      try {
        const response = await axios.post(
          'https://openrouter.ai/api/v1/audio/speech',
          {
            model: model,
            input: chunk,
            response_format: 'mp3'
          },
          {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://ai.studio/build',
              'X-Title': 'ShiPu AI Bot'
            },
            responseType: 'arraybuffer',
            timeout: 30000
          }
        );

        if (response.data) {
          audioBuffers.push(Buffer.from(response.data));
        }
      } catch (err: any) {
        const status = err.response?.status;
        let errorMsg = err.message || 'Unknown speech generation error';
        
        let newStatus: typeof config.status = 'Offline';
        if (status === 401 || status === 403) {
          newStatus = 'Invalid';
        } else if (status === 429) {
          newStatus = 'Rate Limited';
        }

        await aiConfigManager.updateConfig({
          status: newStatus,
          lastError: `Speech Gen Error (${newStatus}): ${errorMsg}`
        });

        throw new Error(`Speech generation failed on chunk ${i+1}/${chunks.length}: ${errorMsg}`);
      }
    }

    if (audioBuffers.length === 0) {
      throw new Error('No audio was generated.');
    }

    // Concatenate all chunks together
    return Buffer.concat(audioBuffers);
  }

  /**
   * Save a speech Buffer to a temp file, returning the path
   */
  public async saveTempAudioFile(buffer: Buffer): Promise<string> {
    const tempDir = path.join(process.cwd(), 'temp_audio');
    await fs.ensureDir(tempDir);
    const fileName = `speech_${Date.now()}_${Math.random().toString(36).substring(7)}.mp3`;
    const filePath = path.join(tempDir, fileName);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  /**
   * Automatically delete a temp file
   */
  public async deleteTempFile(filePath: string): Promise<void> {
    try {
      if (await fs.pathExists(filePath)) {
        await fs.unlink(filePath);
        console.log(`[OpenRouter Speech] Cleared temp file: ${filePath}`);
      }
    } catch (err: any) {
      console.error(`[OpenRouter Speech] Failed to delete temp file ${filePath}:`, err.message);
    }
  }

  /**
   * Intelligently split text into smaller sentence-based chunks (max 150 chars each)
   */
  private splitTextForSpeech(text: string, maxChunkSize = 150): string[] {
    // Regex for sentence endings in Bengali, English, and other common marks
    const sentenceEndings = /([.!?|।\n]+)/g;
    const parts = text.split(sentenceEndings);
    
    const chunks: string[] = [];
    let currentChunk = '';

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (!part) continue;

      if ((currentChunk + part).length > maxChunkSize) {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
        }
        
        if (part.length > maxChunkSize) {
          // If a single part is larger than max size, slice it word-by-word
          const words = part.split(/\s+/);
          let subChunk = '';
          for (const word of words) {
            if ((subChunk + ' ' + word).length > maxChunkSize) {
              if (subChunk.trim()) chunks.push(subChunk.trim());
              subChunk = word;
            } else {
              subChunk += (subChunk ? ' ' : '') + word;
            }
          }
          currentChunk = subChunk;
        } else {
          currentChunk = part;
        }
      } else {
        currentChunk += part;
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }
}

export const openRouterService = OpenRouterService.getInstance();
