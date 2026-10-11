import { AILogModel, FallbackApiModel } from '../../db/firebaseDb';
import { aiConfigManager } from '../../services/aiConfigManager';

export interface AIOSGenerateOptions {
  systemInstruction?: string;
  responseMimeType?: string;
  responseSchema?: any;
}

export interface AIProviderResponse {
  text: string;
  model: string;
  latencyMs: number;
  tokenUsage?: {
    promptTokens: number;
    candidatesTokens: number;
    totalTokens: number;
  };
  finishReason?: string;
  retries: number;
  success: boolean;
  errorMessage?: string;
}

export interface AIProvider {
  id: string;
  name: string;
  generateText(contents: any[], options?: AIOSGenerateOptions, metadata?: { requestId?: string; endpoint?: string }): Promise<AIProviderResponse>;
}

export class GoogleAIStudioProvider implements AIProvider {
  public readonly id = 'google_studio';
  public readonly name = 'Google AI Studio';
  public readonly version = '1.0.0';

  private getApiKeys(): string[] {
    const keys: string[] = [];
    if (process.env.GEMINI_API_KEY) {
      const parts = process.env.GEMINI_API_KEY.split(/[,;]/).map(k => k.trim()).filter(Boolean);
      keys.push(...parts);
    }
    if (process.env.GOOGLE_API_KEY) {
      const parts = process.env.GOOGLE_API_KEY.split(/[,;]/).map(k => k.trim()).filter(Boolean);
      for (const p of parts) {
        if (!keys.includes(p)) keys.push(p);
      }
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (value && typeof value === 'string' && value.length > 10) {
        const upperKey = key.toUpperCase();
        if (
          (upperKey.includes('GEMINI') && upperKey.includes('KEY')) ||
          (upperKey.includes('GOOGLE') && upperKey.includes('KEY')) ||
          upperKey.endsWith('API_KEY')
        ) {
          const valTrim = value.trim();
          if (!keys.includes(valTrim)) {
            keys.push(valTrim);
          }
        }
      }
    }
    return keys;
  }

  private getApiKey(): string {
    const keys = this.getApiKeys();
    return keys[0] || '';
  }

  private static unsupportedModels = new Set<string>();

  private getModels(): string[] {
    const configuredModel = process.env.AI_MODEL?.trim();
    
    // Hierarchical tier list of Gemini models ordered for fast response and high availability
    const defaultList = [
      'gemini-3.6-flash',
      'gemini-3.8-flash',
      'gemini-3-flash-preview',
      'gemini-flash-latest',
      'gemini-3.1-pro-preview',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
      'gemini-3.5-flash',
      'gemini-3.5-flash-lite'
    ];

    if (configuredModel && !defaultList.includes(configuredModel)) {
      return [configuredModel, ...defaultList];
    }
    return defaultList;
  }

  public async generateText(contents: any[], options?: AIOSGenerateOptions, metadata?: { requestId?: string; endpoint?: string }): Promise<AIProviderResponse> {
    const apiKeys = this.getApiKeys();
    if (apiKeys.length === 0) {
      const errRes = {
        text: '❌ Gemini API Key is missing. Please configure GEMINI_API_KEY in your project secrets.',
        model: 'unknown',
        latencyMs: 0,
        retries: 0,
        success: false,
        errorMessage: 'GEMINI_API_KEY is missing.'
      };
      await this.logToDb(errRes, contents, false, { ...metadata, httpStatus: 400, source: 'Google AI Studio Client' });
      throw new Error(errRes.text);
    }

    const modelsToTry = this.getModels();
    let lastError: any = null;
    const unsupportedModels = GoogleAIStudioProvider.unsupportedModels;

    // Try primary models across available keys first before falling back to lower tier models
    for (const model of modelsToTry) {
      if (unsupportedModels.has(model)) {
        continue;
      }
      for (const apiKey of apiKeys) {
        if (unsupportedModels.has(model)) {
          break;
        }
        const maxRetries = 1;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const startTime = Date.now();
          try {
            if (attempt > 0) {
              const backoffMs = Math.min(1000 * Math.pow(2, attempt), 2500) + Math.random() * 300;
              await new Promise(resolve => setTimeout(resolve, backoffMs));
            }

            const response = await this.makeApiCall(model, apiKey, contents, options);
            const latencyMs = Date.now() - startTime;

            const promptTokens = response.usageMetadata?.promptTokenCount || 0;
            const candidatesTokens = response.usageMetadata?.candidatesTokenCount || 0;
            const totalTokens = response.usageMetadata?.totalTokenCount || 0;
            const finishReason = response.candidates?.[0]?.finishReason || 'STOP';
            const parts = response.candidates?.[0]?.content?.parts || [];
            const text = parts.find((p: any) => typeof p.text === 'string')?.text ?? parts[0]?.text;

            if (text === undefined || text === null) {
              throw new Error('EMPTY_RESPONSE');
            }

            const successRes: AIProviderResponse = {
              text,
              model,
              latencyMs,
              tokenUsage: { promptTokens, candidatesTokens, totalTokens },
              finishReason,
              retries: attempt,
              success: true
            };

            await this.logToDb(successRes, contents, false, { ...metadata, httpStatus: 200, source: 'Google AI Studio API' });
            return successRes;

          } catch (err: any) {
            const latencyMs = Date.now() - startTime;
            const errorMsg = err.message || 'Unknown error';
            const cleanMsg = this.extractErrorMessage(errorMsg);
            const status = err.status;

            console.warn(`[GoogleAIStudio] Model ${model} (Key ${apiKey.slice(0, 6)}..., Attempt ${attempt}): Status ${status || 'ERR'} - ${cleanMsg}`);
            lastError = err;

            const isNotFound = status === 404 || status === 400 ||
              cleanMsg.includes('not found') || cleanMsg.includes('no longer available') || cleanMsg.includes('not supported') || cleanMsg.includes('API_KEY_INVALID') || cleanMsg.includes('invalid');

            if (isNotFound) {
              unsupportedModels.add(model);
            }

            const isQuotaOrNotFound = status === 429 || status === 404 || status === 400 ||
              cleanMsg.includes('RESOURCE_EXHAUSTED') || cleanMsg.includes('quota') || cleanMsg.includes('Rate exceeded') || cleanMsg.includes('not found') || cleanMsg.includes('no longer available');

            if (isQuotaOrNotFound) {
              const isQuota = status === 429 || cleanMsg.includes('RESOURCE_EXHAUSTED') || cleanMsg.includes('quota');
              await this.logToDb({
                text: '',
                model,
                latencyMs,
                retries: attempt,
                success: false,
                errorMessage: cleanMsg,
                quotaFailure: isQuota
              }, contents, isQuota, { ...metadata, httpStatus: status || 429, source: 'Google AI Studio API' });

              // Break current retry loop to switch key or model immediately
              break;
            }
          }
        }
      }
    }

    console.warn('[GoogleAIStudio] All active Gemini models and keys rate-limited or exhausted. Querying database for custom fallback APIs...');
    const fallbackStartTime = Date.now();
    try {
      const fallbackApis = await (FallbackApiModel as any).find({ enabled: true }).sort({ priority: -1 }).lean();
      if (fallbackApis && fallbackApis.length > 0) {
        console.warn(`[GoogleAIStudio] Found ${fallbackApis.length} custom fallback APIs. Executing sequential failover...`);
        
        for (const api of fallbackApis) {
          try {
            console.log(`[GoogleAIStudio] Trying fallback API: "${api.name}" (${api.model})...`);
            
            let activeKey = api.apiKey;
            if (api.url && api.url.includes('openrouter.ai')) {
              const centralConfig = aiConfigManager.getConfigSync();
              activeKey = centralConfig.openRouterApiKey || api.apiKey;
            } else if (activeKey === 'USE_SYSTEM_KEY' || activeKey === 'SYSTEM_KEY' || activeKey.startsWith('AQ.Ab8RN')) {
              activeKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
              if (!activeKey || activeKey.startsWith('AQ.Ab8RN')) {
                for (const [envName, envVal] of Object.entries(process.env)) {
                  if (envVal && typeof envVal === 'string' && envVal.startsWith('AIzaSy')) {
                    activeKey = envVal;
                    break;
                  }
                }
              }
              if (!activeKey) {
                activeKey = api.apiKey;
              }
            }

            const response = await this.makeCustomFallbackApiCall(api.url, activeKey, api.model, contents, options);
            const latencyMs = Date.now() - fallbackStartTime;

            const promptTokens = response.usageMetadata?.promptTokenCount || 0;
            const candidatesTokens = response.usageMetadata?.candidatesTokenCount || 0;
            const totalTokens = response.usageMetadata?.totalTokenCount || 0;
            const finishReason = response.candidates?.[0]?.finishReason || 'STOP';
            const parts = response.candidates?.[0]?.content?.parts || [];
            const text = parts.find((p: any) => typeof p.text === 'string')?.text ?? parts[0]?.text;

            if (text !== undefined && text !== null) {
              const successRes: AIProviderResponse = {
                text,
                model: `${api.name} (${api.model})`,
                latencyMs,
                tokenUsage: { promptTokens, candidatesTokens, totalTokens },
                finishReason,
                retries: 0,
                success: true
              };

              await this.logToDb(successRes, contents, false, { ...metadata, httpStatus: 200, source: `Custom Fallback API: ${api.name}` });
              
              // Increment successCount
              await (FallbackApiModel as any).updateOne(
                { _id: api._id },
                { 
                  $inc: { successCount: 1 },
                  $set: { lastUsedAt: new Date() }
                }
              );

              console.log(`[GoogleAIStudio] Fallback API "${api.name}" succeeded!`);
              return successRes;
            }
          } catch (err: any) {
            console.error(`[GoogleAIStudio] Fallback API "${api.name}" failed:`, err.message || err);
            
            // Increment failCount and set lastError
            await (FallbackApiModel as any).updateOne(
              { _id: api._id },
              { 
                $inc: { failCount: 1 },
                $set: { lastError: err.message || 'Unknown API Error', lastUsedAt: new Date() }
              }
            );
          }
        }
      }
    } catch (dbErr: any) {
      console.error('[GoogleAIStudio] Database query for fallback APIs failed:', dbErr.message);
    }

    console.warn('[GoogleAIStudio] All database-defined custom fallback APIs failed. Throwing to try other active providers in manager...');
    throw lastError || new Error('All active Gemini models and fallback APIs failed.');
  }

  private async makeCustomFallbackApiCall(url: string, apiKey: string, model: string, contents: any[], options?: AIOSGenerateOptions): Promise<any> {
    const isOpenRouter = url.includes('openrouter.ai');
    const isOpenAI = url.includes('api.openai.com') || url.includes('/v1/chat/completions') || (model && model.startsWith('gpt')) || isOpenRouter;

    let finalUrl = url;
    let headers: any = {
      'Content-Type': 'application/json',
      'User-Agent': 'aistudio-build'
    };

    if (isOpenRouter) {
      headers['HTTP-Referer'] = 'https://ai.studio/build';
      headers['X-Title'] = 'ShiPu AI Bot';
    }

    let body: any;

    if (isOpenAI) {
      const messages = contents.map(item => {
        const role = item.role === 'model' ? 'assistant' : 'user';
        const text = item.parts?.map((p: any) => p.text).join('\n') || '';
        return { role, content: text };
      });
      if (options?.systemInstruction) {
        messages.unshift({ role: 'system', content: options.systemInstruction });
      }
      body = {
        model: model || 'gpt-4o-mini',
        messages
      };
      headers['Authorization'] = `Bearer ${apiKey}`;
    } else {
      body = {
        contents
      };

      if (options?.systemInstruction) {
        body.systemInstruction = {
          parts: [{ text: options.systemInstruction }]
        };
      }

      if (options?.responseMimeType) {
        body.generationConfig = body.generationConfig || {};
        body.generationConfig.responseMimeType = options.responseMimeType;
        
        if (options.responseSchema) {
          body.generationConfig.responseSchema = options.responseSchema;
        }
      }

      if (!finalUrl.includes(':generateContent') && !finalUrl.includes('/chat/completions')) {
        if (finalUrl.includes('generativelanguage.googleapis.com')) {
          finalUrl = `${finalUrl.replace(/\/$/, '')}/v1beta/models/${model}:generateContent`;
        }
      }

      const separator = finalUrl.includes('?') ? '&' : '?';
      finalUrl = finalUrl.includes('key=') ? finalUrl : `${finalUrl}${separator}key=${apiKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(finalUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        let textErr = '';
        try {
          textErr = await res.text();
        } catch {
          textErr = res.statusText;
        }
        const error: any = new Error(textErr || `HTTP Error ${res.status}`);
        error.status = res.status;
        throw error;
      }

      const rawJson = await res.json();
      if (isOpenAI) {
        const textResponse = rawJson.choices?.[0]?.message?.content || '';
        return {
          candidates: [{
            content: {
              parts: [{ text: textResponse }]
            },
            finishReason: rawJson.choices?.[0]?.finish_reason?.toUpperCase() || 'STOP'
          }],
          usageMetadata: {
            promptTokenCount: rawJson.usage?.prompt_tokens || 0,
            candidatesTokenCount: rawJson.usage?.completion_tokens || 0,
            totalTokenCount: rawJson.usage?.total_tokens || 0
          }
        };
      }

      return rawJson;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('TIMEOUT');
      }
      throw err;
    }
  }

  private async fallbackTextGeneration(contents: any[], options?: AIOSGenerateOptions, lastErr?: any, metadata?: { requestId?: string; endpoint?: string }): Promise<AIProviderResponse> {
    const startTime = Date.now();
    try {
      // Extract prompt text from last user message
      let promptText = 'Hello';
      if (Array.isArray(contents) && contents.length > 0) {
        const lastMsg = contents[contents.length - 1];
        if (lastMsg.parts && Array.isArray(lastMsg.parts)) {
          const textPart = lastMsg.parts.find((p: any) => typeof p.text === 'string');
          if (textPart) promptText = textPart.text;
        } else if (typeof lastMsg.content === 'string') {
          promptText = lastMsg.content;
        }
      }

      let generatedText = '';

      if (options?.responseMimeType === 'application/json') {
        const casualReplies = [
          "হুমম ভাই, তোমার কথা শুনলাম! তবে এই মুহূর্তে আমার এআই সার্ভারটা একটু বেশি লোড নিচ্ছে 😅 পরে কথা বলি?",
          "একটু টেকনিক্যাল কোটা বা রেট লিমিট দেখাচ্ছে ভাই। কিছুক্ষণ পর এসে নক দাও না? ✌️",
          "আরে বন্ধু! আমি সাময়িকভাবে একটু ধীরগতির রেসপন্স দিচ্ছি সার্ভার ওভারলোডের কারণে। একটু পর আবার মেসেজ করো! 😊",
          "ধুর! এআই কোটা শেষ হয়ে গেছে মনে হচ্ছে এই ঘণ্টার জন্য। একটু পর আবার ট্রাই করো, কথা হবে! 😉",
          "আরে ভাই, সার্ভারে একটু চাপ বেশি তাই ইনস্ট্যান্ট এআই কাজ করছে না। পরে কথা বলি কিন্তু! ❤️",
          "হুমম বুঝতে পারছি, কিন্তু এআই ইঞ্জিনটা এখন একটু রিফ্রেশ হচ্ছে। কিছুক্ষণ পর আবার ট্রাই করো তো! 🤞"
        ];
        const idx = Math.floor(Math.random() * casualReplies.length);
        const selectedReply = casualReplies[idx];

        generatedText = JSON.stringify({
          reply: selectedReply,
          extractedFact: null
        });
      } else {
        const casualRepliesText = [
          "আরে বন্ধু, আমার সার্ভারটা একটু বেশি লোড নিচ্ছে এই মুহূর্তে 😅 পরে আবার নক দিলে ভালো হতো না?",
          "একটু স্লো রেসপন্স হচ্ছে হয়তো, জাস্ট নেটওয়ার্ক চেক করছি! কিছুক্ষণ পর আবার ট্রাই করো তো ভাই ✌️",
          "উফফ! একটু টেকনিক্যাল কোটা বা রেট লিমিট ইস্যু হচ্ছে মনে হয়। কিছুক্ষণ পর কথা বলি? 😊",
          "হুমম, শুনতে পেয়েছি! তবে আমার এআই ইঞ্জিনটা একটু রিফ্রেশ হচ্ছে, একটু পরে এসে নক দাও, একদম ফাটিয়ে চ্যাট করব! 😉",
          "আরে ভাই, এআই রেট লিমিটের কারণে একটু আটকে গেছি। পরে আবার কথা হচ্ছে কিন্তু! ❤️"
        ];
        const idx = Math.floor(Math.random() * casualRepliesText.length);
        generatedText = casualRepliesText[idx];
      }

      const res: AIProviderResponse = {
        text: generatedText,
        model: 'shipu-fallback-engine',
        latencyMs: Date.now() - startTime,
        retries: 0,
        success: true
      };

      await this.logToDb(res, contents, false, { ...metadata, httpStatus: 200, source: 'Offline Fallback Engine' });
      return res;
    } catch (e: any) {
      throw this.formatUserError(lastErr, lastErr?.message || 'AI Generation failed');
    }
  }

  private checkIsRetryable(err: any, errorMsg: string): boolean {
    // 429, 500, 502, 503, 504 are retryable
    const status = err.status;
    if (status) {
      return [429, 500, 502, 503, 504].includes(status);
    }
    // Check message keywords
    const retryableKeywords = ['429', '500', '502', '503', '504', 'RESOURCE_EXHAUSTED', 'Service Unavailable', 'Internal Server Error', 'timeout', 'TIMEOUT', 'fetch failed'];
    return retryableKeywords.some(kw => errorMsg.includes(kw));
  }

  private extractErrorMessage(msg: string): string {
    if (msg && msg.trim().startsWith('{')) {
      try {
        const parsed = JSON.parse(msg);
        if (parsed?.error?.message) {
          return parsed.error.message;
        }
      } catch (e) {
        // Not valid JSON, return original
      }
    }
    return msg || 'Unknown error';
  }

  private formatUserError(err: any, msg: string): Error {
    const status = err.status;
    const cleanMsg = this.extractErrorMessage(msg);
    
    if (status === 400 && (cleanMsg.includes('key') || cleanMsg.includes('API_KEY_INVALID') || cleanMsg.includes('API key') || cleanMsg.includes('invalid'))) {
      return new Error('❌ Invalid API Key. Please verify your GEMINI_API_KEY in your project secrets.');
    }
    if (status === 403) {
      return new Error('❌ Invalid API Key. Access forbidden. Please verify your GEMINI_API_KEY in your project secrets.');
    }
    if (status === 429 || cleanMsg.includes('RESOURCE_EXHAUSTED') || cleanMsg.includes('429') || cleanMsg.includes('quota') || cleanMsg.includes('Rate exceeded')) {
      return new Error('⚠️ Free AI quota has been exhausted.\nPlease try again later.');
    }
    if ([500, 502, 503, 504].includes(status) || cleanMsg.includes('500') || cleanMsg.includes('502') || cleanMsg.includes('503') || cleanMsg.includes('504')) {
      return new Error('⚠️ Google AI Studio is temporarily unavailable.');
    }
    if (cleanMsg === 'EMPTY_RESPONSE') {
      return new Error('⚠️ Google AI Studio returned an empty response.');
    }
    if (cleanMsg.includes('timeout') || cleanMsg.includes('TIMEOUT')) {
      return new Error('⚠️ Request to Google AI Studio timed out.');
    }
    if (cleanMsg.includes('fetch failed') || cleanMsg.includes('network') || cleanMsg.includes('ENOTFOUND')) {
      return new Error('⚠️ Network error: Failed to reach Google AI Studio.');
    }

    return new Error(`⚠️ AI Studio Error: ${cleanMsg}`);
  }

  private async makeApiCall(model: string, apiKey: string, contents: any[], options?: AIOSGenerateOptions): Promise<any> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    
    const body: any = {
      contents
    };

    if (options?.systemInstruction) {
      body.systemInstruction = {
        parts: [{ text: options.systemInstruction }]
      };
    }

    if (options?.responseMimeType) {
      body.generationConfig = body.generationConfig || {};
      body.generationConfig.responseMimeType = options.responseMimeType;
      
      if (options.responseSchema) {
        body.generationConfig.responseSchema = options.responseSchema;
      }
    }

    // Set a 12 second timeout for fast failover
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'aistudio-build'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        let textErr = '';
        try {
          textErr = await res.text();
        } catch {
          textErr = res.statusText;
        }
        const error: any = new Error(textErr || `HTTP Error ${res.status}`);
        error.status = res.status;
        throw error;
      }

      return await res.json();
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        throw new Error('TIMEOUT');
      }
      throw err;
    }
  }

  private async logToDb(
    res: any, 
    contents: any[], 
    isQuota: boolean = false, 
    metadata?: { requestId?: string; endpoint?: string; httpStatus?: number; source?: string }
  ): Promise<void> {
    try {
      // Avoid crash on MongoDB operations
      const promptSnippet = contents && contents.length > 0 
        ? JSON.stringify(contents[contents.length - 1]).substring(0, 500)
        : '';

      await AILogModel.create({
        provider: this.name,
        model: res.model || 'unknown',
        prompt: promptSnippet,
        responseTimeMs: res.latencyMs || 0,
        tokenUsage: res.tokenUsage || { promptTokens: 0, candidatesTokens: 0, totalTokens: 0 },
        finishReason: res.finishReason || '',
        retries: res.retries || 0,
        success: res.success,
        errorMessage: res.errorMessage || '',
        quotaFailure: isQuota || res.quotaFailure || false,
        requestId: metadata?.requestId,
        endpoint: metadata?.endpoint || 'https://generativelanguage.googleapis.com',
        httpStatus: metadata?.httpStatus || (res.success ? 200 : undefined),
        source: metadata?.source || 'Google AI Studio'
      });
    } catch (err) {
      console.error('[GoogleAIStudio] Database logging failed:', err);
    }
  }
}
