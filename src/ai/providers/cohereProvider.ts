import { AIProvider, AIProviderResponse, AIOSGenerateOptions } from './googleStudio';
import { aiConfigManager } from '../../services/aiConfigManager';
import axios from 'axios';

/**
 * Native Cohere provider (api.cohere.com).
 * Tried FIRST (before OpenRouter) per user request. Free trial key.
 */
export class CohereAIProvider implements AIProvider {
  public readonly id = 'cohere';
  public readonly name = 'Cohere';

  public async generateText(contents: any[], options?: AIOSGenerateOptions, metadata?: { requestId?: string; endpoint?: string }): Promise<AIProviderResponse> {
    const config = await aiConfigManager.getConfig();
    if (!config.aiEnabled) {
      return { text: '', model: 'cohere', latencyMs: 0, retries: 0, success: false, errorMessage: 'AI features disabled globally.' };
    }

    const apiKey = (config.openRouterApiKey || '').startsWith('cohere_')
      ? config.openRouterApiKey
      : (process.env.COHERE_API_KEY || 'cohere_nNS6cpJnJiYYKW8wUkUjWClGx6MzyLRW8pT6nuSx3szSg2');

    const startTime = Date.now();
    try {
      const messages = contents.map(item => {
        const role = item.role === 'model' ? 'assistant' : (item.role === 'system' ? 'system' : 'user');
        const text = item.parts?.map((p: any) => p.text).join('\n') || item.content || '';
        return { role, content: text };
      });

      const systemInstruction = options?.systemInstruction;
      const chatHistory = messages.filter(m => m.role !== 'system');
      const lastUser = chatHistory.pop();

      const body: any = {
        model: 'command-a-03-2025',
        message: lastUser?.content || '',
        chat_history: chatHistory.map(m => ({ role: m.role === 'assistant' ? 'CHATBOT' : 'USER', message: m.content })),
        temperature: 0.7,
        max_tokens: 1024
      };
      if (systemInstruction) body.preamble = systemInstruction;

      const res = await axios.post('https://api.cohere.com/v1/chat', body, {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        },
        timeout: 45000
      });

      const text = res.data?.text || res.data?.message?.content?.[0]?.text || '';
      if (!text) throw new Error('Empty Cohere response');

      const latencyMs = Date.now() - startTime;
      await aiConfigManager.updateConfig({ status: 'Connected', lastSuccessfulRequestTime: new Date().toISOString() });
      return { text, model: 'cohere/command-a-03-2025', latencyMs, retries: 0, success: true };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      const msg = err.response?.data?.message || err.message || 'Cohere API error';
      return { text: '', model: 'cohere/command-a-03-2025', latencyMs, retries: 0, success: false, errorMessage: msg };
    }
  }
}
