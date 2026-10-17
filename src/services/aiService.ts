import { aiProviderManager } from '../ai/providers/providerManager';
import { brainService } from './brainService';
import { extractImageParts } from '../utils/fileParser';

export interface AIProvider {
  generateText(prompt: string, systemInstruction?: string, attachments?: any): Promise<string>;
  analyzeImage?(prompt: string, imageSource: any): Promise<string>;
  summarize(text: string): Promise<string>;
  chat(messages: { role: 'user' | 'model'; content: string }[]): Promise<string>;
}

export class GeminiAIProvider implements AIProvider {
  async generateText(prompt: string, systemInstruction?: string, attachments?: any): Promise<string> {
    // Query ShiPu Brain database before generating response
    const brainMatch = brainService.findMatch(prompt);
    let systemKnowledge = '';
    if (brainMatch && brainMatch.memory) {
      systemKnowledge = `\n\n=== SYSTEM KNOWLEDGE (ShiPu Brain Database) ===\nTrigger: "${brainMatch.memory.trigger}"\nSaved Data: "${brainMatch.memory.reply}"\nCategory: "${brainMatch.memory.category || 'General'}"\nINSTRUCTION: Utilize this System Knowledge saved personalized data when crafting your natural response to the user.`;
    }

    const baseInstruction = systemInstruction || 'You are a helpful, natural human-like assistant in a Facebook Messenger group. Never reveal that you are an AI or a bot; reply naturally, concisely, with emojis. Use the provided knowledge silently.';
    
    // Extract vision image parts from attachments if provided
    const imageParts = attachments ? await extractImageParts(attachments) : [];
    const userParts: any[] = [...imageParts, { text: prompt }];

    const contents = [{ role: 'user', parts: userParts }];
    const res = await aiProviderManager.generateTextWithFallback(contents, {
      systemInstruction: baseInstruction + systemKnowledge
    });
    return res.text;
  }

  async analyzeImage(prompt: string, imageSource: any): Promise<string> {
    const imageParts = await extractImageParts(imageSource);
    const userParts: any[] = [...imageParts, { text: prompt || 'Analyze and describe this image in detail.' }];
    const contents = [{ role: 'user', parts: userParts }];

    const res = await aiProviderManager.generateTextWithFallback(contents, {
      systemInstruction: 'You are a helpful, natural human-like assistant. Analyze the provided image accurately and answer clearly, without revealing you are an AI.'
    });
    return res.text;
  }

  async summarize(text: string): Promise<string> {
    return this.generateText(`Summarize the following group chat conversation in 3 key bullet points:\n\n${text}`);
  }

  async chat(messages: { role: 'user' | 'model'; content: string }[]): Promise<string> {
    const lastMsg = messages[messages.length - 1]?.content || 'Hello';
    return this.generateText(lastMsg);
  }
}

export const defaultAiProvider = new GeminiAIProvider();
