export interface AIClientResponse {
  text: string;
  provider: string;
  latencyMs: number;
  success: boolean;
  error?: string;
}

export interface AIClientOptions {
  systemInstruction?: string;
  contextKey?: string;
  threadId?: string;
  conversationId?: string;
  userId?: string;
  accountId?: string;
}

export class AIClient {
  private static defaultEndpoint = 'https://generativelanguage.googleapis.com/v1beta/models/gemma-4-26b-a4b-it:generateContent';
  private static defaultKey = 'AQ.Ab8RN6IehQEBeOqTHmEkmOGOYbYzSrS6VNkYVzWf_SJDbLSERA';

  /**
   * Executes a prompt with load-balancing, exponential backoff, per-context concurrency locking, and dual failover.
   * Tries primary server-side Gemini Proxy route with retry, then secondary direct REST API fallback.
   */
  public static async executePrompt(
    prompt: string, 
    optionsOrSysInstruction?: string | AIClientOptions
  ): Promise<AIClientResponse> {
    const startTime = Date.now();
    const requestId = 'ai_req_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
    
    const options: AIClientOptions = typeof optionsOrSysInstruction === 'string'
      ? { systemInstruction: optionsOrSysInstruction }
      : (optionsOrSysInstruction || {});

    const { systemInstruction, contextKey, threadId, conversationId, userId, accountId } = options;

    const maxAttempts = 3;
    let attempt = 0;
    let primaryError: any = null;

    // 1. Try Primary Server-side Proxy Connection (with resilient retries & backoff)
    while (attempt < maxAttempts) {
      try {
        if (attempt > 0) {
          // Exponential backoff: 1s, 2s, 4s, etc. with a small random jitter
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 4000) + Math.random() * 500;
          console.log(`[AIClient] Waiting ${Math.round(backoffMs)}ms before retry attempt ${attempt + 1}/${maxAttempts} for ${requestId}`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }

        const response = await fetch('/api/gemini/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            prompt, 
            systemInstruction, 
            requestId,
            contextKey,
            threadId,
            conversationId,
            userId,
            accountId
          })
        });

        // Handle platform plain text "Rate exceeded." which doesn't have application/json content-type
        const contentType = response.headers.get('content-type');
        if (!contentType || !contentType.includes('application/json')) {
          const text = await response.text();
          if (response.status === 429 || (text && text.includes('Rate exceeded'))) {
            throw { 
              status: 429, 
              code: 'PLATFORM_RATE_LIMIT', 
              message: 'Platform proxy gatekeeper rate limit exceeded ("Rate exceeded"). Please try again in a few seconds.' 
            };
          }
          throw { status: response.status, code: 'NON_JSON_RESPONSE', message: `Non-JSON server response: ${text.substring(0, 150)}` };
        }

        const data = await response.json();
        
        if (response.ok && data.response) {
          return {
            text: data.response,
            provider: 'Primary Gemini Proxy',
            latencyMs: Date.now() - startTime,
            success: true
          };
        }

        // Server returned an error payload
        const errorCode = data.error || 'SERVER_ERROR';
        const errorMsg = data.message || 'Server proxy returned error status';

        throw { status: response.status, code: errorCode, message: errorMsg };

      } catch (err: any) {
        primaryError = err;
        attempt++;
        
        const status = err.status;
        const code = err.code;
        const msg = err.message || '';

        console.warn(`[AIClient] Attempt ${attempt}/${maxAttempts} failed for requestId ${requestId}. Status: ${status}, Code: ${code}, Message: ${msg}`);

        // Only retry for transient rate limits, concurrent locks, or temporary server errors
        const isTransient = 
          status === 429 || 
          code === 'CONCURRENT_LIMIT' || 
          code === 'RATE_LIMIT_EXCEEDED' || 
          code === 'PLATFORM_RATE_LIMIT' ||
          msg.includes('Rate exceeded') || 
          [500, 502, 503, 504].includes(status);

        if (!isTransient || attempt >= maxAttempts) {
          break; // Stop immediately for non-transient failures
        }
      }
    }

    // 2. Try Client-side Direct REST Fallback API if the primary route fails completely
    console.warn('[AIClient] Primary Gemini Proxy failed or rate limited after attempts. Trying direct client-side fallback API...', primaryError);
    
    try {
      const url = `${this.defaultEndpoint}?key=${this.defaultKey}`;
      const body: any = {
        contents: [{ role: 'user', parts: [{ text: prompt }] }]
      };
      
      if (systemInstruction) {
        body.systemInstruction = {
          parts: [{ text: systemInstruction }]
        };
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Fallback API returned HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json();
      const text = data.candidates?.[0]?.content?.parts?.find((p: any) => typeof p.text === 'string')?.text || data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (text) {
        return {
          text,
          provider: 'Secondary Client Fallback REST API',
          latencyMs: Date.now() - startTime,
          success: true
        };
      }
      throw new Error('Successfully connected to fallback REST API, but response text was empty.');
    } catch (fallbackError: any) {
      console.error('[aiClient] All connections failed.', fallbackError.message || fallbackError);
      
      // Formulate a diagnostic message based on why it failed
      const primaryMsg = primaryError?.message || 'Primary route connection failed';
      const primaryCode = primaryError?.code || 'CONNECTION_FAILURE';
      
      let errorMsg = `❌ AI Service Rate Limit or Connection Failure [Req ID: ${requestId}]\n\n`;
      
      if (primaryCode === 'CONCURRENT_LIMIT') {
        errorMsg += `📍 **Source**: Per-Thread Concurrency Safeguard\n`;
        errorMsg += `📝 **Detail**: ${primaryMsg}\n\n`;
        errorMsg += `💡 Another response is already generating for this active conversation thread. Please wait for it to complete.`;
      } else if (primaryCode === 'QUOTA_EXHAUSTED') {
        errorMsg += `📍 **Source**: Google AI Studio Quota Limit\n`;
        errorMsg += `📝 **Detail**: ${primaryMsg}\n\n`;
        errorMsg += `💡 All available free API keys have reached their hourly limits. Please configure custom api keys in the Fallback APIs tab.`;
      } else if (primaryCode === 'PLATFORM_RATE_LIMIT') {
        errorMsg += `📍 **Source**: Platform Proxy Gatekeeper (429)\n`;
        errorMsg += `📝 **Detail**: ${primaryMsg}\n\n`;
        errorMsg += `💡 The hosting container or reverse proxy triggered its safety limits. We attempted 3 retries with backoff but the limit is still active. Please wait 10 seconds before retrying.`;
      } else {
        errorMsg += `📍 **Source**: AI Link Load Balancer (${primaryCode})\n`;
        errorMsg += `📝 **Detail**: ${primaryMsg}\n\n`;
        errorMsg += `Fallback error: ${fallbackError.message || 'REST direct API connection failed.'}`;
      }

      return {
        text: '',
        provider: 'Failed',
        latencyMs: Date.now() - startTime,
        success: false,
        error: errorMsg
      };
    }
  }
}
