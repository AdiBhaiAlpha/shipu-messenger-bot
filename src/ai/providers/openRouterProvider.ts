import { AIProvider, AIProviderResponse, AIOSGenerateOptions } from './googleStudio';
import { aiConfigManager } from '../../services/aiConfigManager';
import { openRouterService } from '../../services/openRouterService';

export class OpenRouterAIProvider implements AIProvider {
  public readonly id = 'openrouter';
  public readonly name = 'OpenRouter';

  public async generateText(contents: any[], options?: AIOSGenerateOptions, metadata?: { requestId?: string; endpoint?: string }): Promise<AIProviderResponse> {
    const config = await aiConfigManager.getConfig();
    if (!config.aiEnabled) {
      throw new Error('AI features are disabled globally.');
    }

    const startTime = Date.now();
    const requestedModel = config.defaultModel || 'google/gemma-2-9b-it:free';

    try {
      // Reformat standard contents parts to simpler messages array for OpenRouter
      const messages = contents.map(item => {
        const role = item.role === 'model' ? 'assistant' : 'user';
        const text = item.parts?.map((p: any) => p.text).join('\n') || '';
        return { role, content: text };
      });

      const responseText = await openRouterService.generateChatCompletion(
        messages,
        requestedModel,
        options?.systemInstruction
      );

      const latencyMs = Date.now() - startTime;
      const servedModel = openRouterService.lastUsedModel || requestedModel;
      return {
        text: responseText,
        model: servedModel,
        latencyMs,
        retries: 0,
        success: true
      };
    } catch (err: any) {
      const latencyMs = Date.now() - startTime;
      return {
        text: '',
        model: requestedModel,
        latencyMs,
        retries: 0,
        success: false,
        errorMessage: err.message
      };
    }
  }
}
