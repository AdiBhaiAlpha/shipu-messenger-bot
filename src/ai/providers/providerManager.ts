import { GoogleAIStudioProvider, AIProvider, AIProviderResponse, AIOSGenerateOptions } from './googleStudio';
import { OpenRouterAIProvider } from './openRouterProvider';
import { CohereAIProvider } from './cohereProvider';
import { aiConfigManager } from '../../services/aiConfigManager';

export interface ProviderMetrics {
  providerId: string;
  providerName: string;
  totalCalls: number;
  successCalls: number;
  failedCalls: number;
  circuitBreakerTripped: boolean;
  consecutiveFailures: number;
  avgLatencyMs: number;
  lastUsedAt?: string;
}

export class AIProviderManager {
  private static instance: AIProviderManager;
  private providers: Map<string, AIProvider> = new Map();
  private activeProviderId = 'cohere';

  // Circuit Breaker & Metrics State
  private circuitBreakers = new Map<string, { consecutiveFailures: number; trippedUntil: number }>();
  private metrics = new Map<string, { total: number; success: number; failed: number; totalLatencyMs: number; lastUsed: number }>();
  private MAX_CONSECUTIVE_FAILURES = 5;
  private COOLDOWN_MS = 60000; // 1 minute circuit breaker cooldown

  private constructor() {
    this.registerProvider(new CohereAIProvider());
    this.registerProvider(new GoogleAIStudioProvider());
    this.registerProvider(new OpenRouterAIProvider());
  }

  public static getInstance(): AIProviderManager {
    if (!AIProviderManager.instance) {
      AIProviderManager.instance = new AIProviderManager();
    }
    return AIProviderManager.instance;
  }

  public registerProvider(provider: AIProvider) {
    this.providers.set(provider.id, provider);
    if (!this.metrics.has(provider.id)) {
      this.metrics.set(provider.id, { total: 0, success: 0, failed: 0, totalLatencyMs: 0, lastUsed: 0 });
    }
    if (!this.circuitBreakers.has(provider.id)) {
      this.circuitBreakers.set(provider.id, { consecutiveFailures: 0, trippedUntil: 0 });
    }
  }

  public isCircuitOpen(providerId: string): boolean {
    const cb = this.circuitBreakers.get(providerId);
    if (!cb) return false;
    if (cb.trippedUntil > Date.now()) {
      return true; // Circuit open (disabled)
    }
    if (cb.trippedUntil > 0 && cb.trippedUntil <= Date.now()) {
      // Cooldown expired, reset to half-open
      cb.consecutiveFailures = 0;
      cb.trippedUntil = 0;
    }
    return false;
  }

  public recordSuccess(providerId: string, latencyMs: number) {
    const cb = this.circuitBreakers.get(providerId);
    if (cb) cb.consecutiveFailures = 0;

    const m = this.metrics.get(providerId) || { total: 0, success: 0, failed: 0, totalLatencyMs: 0, lastUsed: 0 };
    m.total += 1;
    m.success += 1;
    m.totalLatencyMs += latencyMs;
    m.lastUsed = Date.now();
    this.metrics.set(providerId, m);
  }

  public recordFailure(providerId: string) {
    const cb = this.circuitBreakers.get(providerId) || { consecutiveFailures: 0, trippedUntil: 0 };
    cb.consecutiveFailures += 1;
    if (cb.consecutiveFailures >= this.MAX_CONSECUTIVE_FAILURES) {
      cb.trippedUntil = Date.now() + this.COOLDOWN_MS;
      console.warn(`[Circuit Breaker] Tripped for provider ${providerId} due to ${cb.consecutiveFailures} consecutive failures. Cooldown for ${this.COOLDOWN_MS / 1000}s.`);
    }
    this.circuitBreakers.set(providerId, cb);

    const m = this.metrics.get(providerId) || { total: 0, success: 0, failed: 0, totalLatencyMs: 0, lastUsed: 0 };
    m.total += 1;
    m.failed += 1;
    m.lastUsed = Date.now();
    this.metrics.set(providerId, m);
  }

  private generateOfflineFallback(contents: any[], options?: AIOSGenerateOptions): AIProviderResponse {
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

    return {
      text: generatedText,
      model: 'shipu-fallback-engine',
      latencyMs: 0,
      retries: 0,
      success: true
    };
  }

  /**
   * Resilient execution with Automatic Circuit-Breaker & Cross-Provider Fallback
   */
  public async generateTextWithFallback(
    contents: any[], 
    options?: AIOSGenerateOptions, 
    metadata?: { requestId?: string; endpoint?: string }
  ): Promise<AIProviderResponse> {
    const registered = Array.from(this.providers.values());
    const config = aiConfigManager.getConfigSync();
    const primaryId = config.defaultProvider || this.activeProviderId;

    // Prioritize primary provider, then remaining providers
    const orderedProviders = registered.sort((a, b) => {
      // cohere always first (user mandate), then configured primary, then rest
      if (a.id === 'cohere') return -1;
      if (b.id === 'cohere') return 1;
      if (a.id === primaryId) return -1;
      if (b.id === primaryId) return 1;
      return 0;
    });

    let lastError: any = null;

    for (const provider of orderedProviders) {
      if (this.isCircuitOpen(provider.id)) {
        console.warn(`[AIProviderManager] Skipping provider ${provider.id} because circuit breaker is OPEN.`);
        continue;
      }

      const startTime = Date.now();
      try {
        const result = await provider.generateText(contents, options, metadata);
        if (result.success) {
          const latency = Date.now() - startTime;
          this.recordSuccess(provider.id, latency);
          return result;
        } else {
          this.recordFailure(provider.id);
          lastError = new Error(result.errorMessage || 'Provider generation failed');
        }
      } catch (err: any) {
        this.recordFailure(provider.id);
        lastError = err;
        console.warn(`[AIProviderManager] Provider ${provider.id} failed, attempting next fallback...`, err.message || err);
      }
    }

    console.warn('[AIProviderManager] All AI providers failed. Returning friendly offline fallback message.');
    return this.generateOfflineFallback(contents, options);
  }

  public getProvider(id?: string): AIProvider {
    const config = aiConfigManager.getConfigSync();
    const targetId = id || config.defaultProvider || this.activeProviderId;
    const provider = this.providers.get(targetId);
    if (!provider) {
      const fallbackProvider = this.providers.get('google_studio');
      if (!fallbackProvider) {
        throw new Error(`AI Provider is not registered.`);
      }
      return fallbackProvider;
    }
    return provider;
  }

  public getActiveProvider(): AIProvider {
    const config = aiConfigManager.getConfigSync();
    return this.getProvider(config.defaultProvider || this.activeProviderId);
  }

  public setActiveProvider(id: string) {
    if (!this.providers.has(id)) {
      throw new Error(`AI Provider with ID "${id}" is not registered.`);
    }
    this.activeProviderId = id;
  }

  public getAllProviders(): AIProvider[] {
    return Array.from(this.providers.values());
  }

  public getMetrics(): ProviderMetrics[] {
    return Array.from(this.providers.values()).map(p => {
      const m = this.metrics.get(p.id) || { total: 0, success: 0, failed: 0, totalLatencyMs: 0, lastUsed: 0 };
      const cb = this.circuitBreakers.get(p.id) || { consecutiveFailures: 0, trippedUntil: 0 };
      const avgLatency = m.success > 0 ? Math.round(m.totalLatencyMs / m.success) : 0;

      return {
        providerId: p.id,
        providerName: p.name,
        totalCalls: m.total,
        successCalls: m.success,
        failedCalls: m.failed,
        circuitBreakerTripped: cb.trippedUntil > Date.now(),
        consecutiveFailures: cb.consecutiveFailures,
        avgLatencyMs: avgLatency,
        lastUsedAt: m.lastUsed ? new Date(m.lastUsed).toISOString() : undefined
      };
    });
  }
}

export const aiProviderManager = AIProviderManager.getInstance();
export type { AIProvider, AIProviderResponse, AIOSGenerateOptions } from './googleStudio';

