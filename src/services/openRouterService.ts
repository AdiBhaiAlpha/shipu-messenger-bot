import axios from 'axios';
import { aiConfigManager } from './aiConfigManager';
import { OPENROUTER_FALLBACK_KEY } from '../config/aiKeys';
import fs from 'fs-extra';
import path from 'path';

export class OpenRouterService {
  private static instance: OpenRouterService;

  private constructor() {}

  public static getInstance(): OpenRouterService {
    if (!OpenRouterService.instance) {
      OpenRouterService.instance = new OpenRouterService();
    }
    return OpenRouterService.instance;
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

    const targetModel = model || config.defaultModel || 'google/gemma-2-9b-it:free';
    const requestMessages = [...messages];
    if (systemInstruction) {
      requestMessages.unshift({ role: 'system', content: systemInstruction });
    }

    // Primary key first, hardcoded fallback second (only when different).
    const candidateKeys = [apiKey];
    if (OPENROUTER_FALLBACK_KEY && OPENROUTER_FALLBACK_KEY !== apiKey) {
      candidateKeys.push(OPENROUTER_FALLBACK_KEY);
    }

    let lastError: any = null;
    for (let keyIdx = 0; keyIdx < candidateKeys.length; keyIdx++) {
      const keyInUse = candidateKeys[keyIdx];
      const isFallback = keyIdx > 0;
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

        // Update successful request stats
        await aiConfigManager.updateConfig({
          status: 'Connected',
          lastSuccessfulRequestTime: new Date().toISOString(),
          lastError: isFallback ? `Primary key failed, fallback key served this request (Time: ${new Date().toLocaleTimeString()})` : undefined
        });

        if (isFallback) {
          console.log('[OpenRouter] Primary key failed; fallback key served the request.');
        }
        return content;
      } catch (err: any) {
        lastError = err;
        const status = err.response?.status;
        // Only fail over on auth rejection, rate limit, or transport failure —
        // never on bad-request class errors caused by our own payload.
        const canFailOver = isFallback === false && (
          status === 401 || status === 403 || status === 429 || status === undefined
        );
        if (!canFailOver) break;
        console.warn(`[OpenRouter] Primary key failed (HTTP ${status ?? 'network error'}). Trying hardcoded fallback key...`);
      }
    }

    const err: any = lastError;
    {
      const status = err.response?.status;
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
