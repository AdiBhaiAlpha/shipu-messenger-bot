import { BotSettingModel } from '../db/firebaseDb';
import { encryptPassword, decryptPassword } from '../utils/crypto';
import { OPENROUTER_FALLBACK_ORDER } from '../config/aiModels';
import axios from 'axios';

export interface AIConfiguration {
  openRouterApiKey: string; // decrypted at runtime, stored encrypted
  defaultProvider: string;  // 'openrouter' or 'google_studio'
  defaultModel: string;     // default model name, e.g., 'google/gemma-2-9b-it:free'
  /** Last model that successfully generated a response. Used first until it errors. */
  lastWorkingModel?: string;
  /** Ordered OpenRouter fallback chain (defaults to the hardcoded catalog order). */
  modelFallbackOrder?: string[];
  aiEnabled: boolean;
  status: 'Connected' | 'Invalid' | 'Rate Limited' | 'Offline';
  lastSuccessfulRequestTime?: string;
  lastError?: string;
  keyHistory: Array<{
    key: string; // Encrypted
    timestamp: string;
  }>;
}

export class AIConfigManager {
  private static instance: AIConfigManager;
  private currentConfig: AIConfiguration | null = null;
  private readonly DB_KEY = 'ai_provider_configuration';

  private constructor() {}

  public static getInstance(): AIConfigManager {
    if (!AIConfigManager.instance) {
      AIConfigManager.instance = new AIConfigManager();
    }
    return AIConfigManager.instance;
  }

  /**
   * Synchronous helper to get cached config
   */
  public getConfigSync(): AIConfiguration {
    if (this.currentConfig) {
      return this.currentConfig;
    }
    return {
      openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
      defaultProvider: 'openrouter',
      defaultModel: 'liquid/lfm-2.5-2.6b:free',
      lastWorkingModel: '',
      modelFallbackOrder: [...OPENROUTER_FALLBACK_ORDER],
      aiEnabled: true,
      status: 'Offline',
      keyHistory: []
    };
  }

  /**
   * Helper to mask an API key
   */
  public maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 12) return '************';
    const prefix = key.slice(0, 9);
    const suffix = key.slice(-4);
    return `${prefix}****************************${suffix}`;
  }

  /**
   * Loads the AI configuration from DB or returns cached
   */
  public async getConfig(bypassCache = false): Promise<AIConfiguration> {
    if (this.currentConfig && !bypassCache) {
      return this.currentConfig;
    }

    const defaultConf: AIConfiguration = {
      openRouterApiKey: process.env.OPENROUTER_API_KEY || '',
      defaultProvider: 'openrouter',
      defaultModel: 'liquid/lfm-2.5-2.6b:free',
      lastWorkingModel: '',
      modelFallbackOrder: [...OPENROUTER_FALLBACK_ORDER],
      aiEnabled: true,
      status: 'Offline',
      keyHistory: []
    };

    try {
      const doc = await (BotSettingModel as any).findOne({ key: this.DB_KEY }).lean() as any;
      if (doc && doc.value) {
        const stored = doc.value as AIConfiguration;
        
        // Decrypt the api key
        let decryptedKey = '';
        if (stored.openRouterApiKey) {
          decryptedKey = decryptPassword(stored.openRouterApiKey) || stored.openRouterApiKey;
        }

        this.currentConfig = {
          ...defaultConf,
          ...stored,
          openRouterApiKey: decryptedKey
        };
      } else {
        // Encrypt the default key if exists
        const encryptedKey = defaultConf.openRouterApiKey ? encryptPassword(defaultConf.openRouterApiKey) : '';
        const initialToSave = {
          ...defaultConf,
          openRouterApiKey: encryptedKey
        };
        await (BotSettingModel as any).updateOne(
          { key: this.DB_KEY },
          { $set: { value: initialToSave } },
          { upsert: true }
        );
        this.currentConfig = defaultConf;
      }
    } catch (err: any) {
      console.error('[AIConfigManager] Failed to load AI configuration:', err.message);
      this.currentConfig = defaultConf;
    }

    return this.currentConfig;
  }

  /**
   * Save AI Configuration
   */
  public async updateConfig(updates: Partial<AIConfiguration>): Promise<AIConfiguration> {
    const current = await this.getConfig(true);
    
    // If a new key is provided (not masked)
    let finalKey = current.openRouterApiKey;
    let keyHistory = current.keyHistory || [];

    if (updates.openRouterApiKey && !updates.openRouterApiKey.includes('**')) {
      const newKey = updates.openRouterApiKey.trim();
      
      // If key is actually changing
      if (newKey !== current.openRouterApiKey) {
        // Add previous key to history if it exists
        if (current.openRouterApiKey) {
          const encryptedPrevKey = encryptPassword(current.openRouterApiKey);
          // Keep unique keys in history (up to 10 entries)
          const alreadyInHistory = keyHistory.some(h => {
            const dec = decryptPassword(h.key);
            return dec === current.openRouterApiKey;
          });

          if (!alreadyInHistory) {
            keyHistory = [
              { key: encryptedPrevKey, timestamp: new Date().toISOString() },
              ...keyHistory
            ].slice(0, 10);
          }
        }
        finalKey = newKey;
      }
    }

    const updatedInMemory: AIConfiguration = {
      ...current,
      ...updates,
      openRouterApiKey: finalKey,
      keyHistory
    };

    // To save in DB, encrypt the API key
    const toSaveInDB = {
      ...updatedInMemory,
      openRouterApiKey: finalKey ? encryptPassword(finalKey) : ''
    };

    try {
      await (BotSettingModel as any).updateOne(
        { key: this.DB_KEY },
        { $set: { value: toSaveInDB } },
        { upsert: true }
      );
      this.currentConfig = updatedInMemory;
      console.log('[AIConfigManager] Central AI configuration updated dynamically');
    } catch (err: any) {
      console.error('[AIConfigManager] Failed to save updated configuration:', err.message);
      throw err;
    }

    return updatedInMemory;
  }

  /**
   * Test connection status of OpenRouter Key
   */
  public async testConnection(apiKey: string): Promise<{ success: boolean; status: AIConfiguration['status']; error?: string }> {
    if (!apiKey) {
      return { success: false, status: 'Offline', error: 'API key is missing' };
    }

    try {
      // Try Cohere first (primary), then OpenRouter.
      if (apiKey.startsWith('cohere_')) {
        const r = await axios.post('https://api.cohere.com/v1/chat', { model: 'command-a-03-2025', message: 'ping' }, {
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          timeout: 10000
        });
        if (r.status === 200) return { success: true, status: 'Connected' };
      }
      const response = await axios.get('https://openrouter.ai/api/v1/models', {
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'HTTP-Referer': 'https://ai.studio/build',
          'X-Title': 'ShiPu AI Bot'
        },
        timeout: 10000
      });

      if (response.status === 200) {
        return { success: true, status: 'Connected' };
      } else if (response.status === 401 || response.status === 403) {
        return { success: false, status: 'Invalid', error: 'Invalid API key credentials' };
      } else if (response.status === 429) {
        return { success: false, status: 'Rate Limited', error: 'Rate limit reached or quota exhausted' };
      } else {
        return { success: false, status: 'Offline', error: `Unexpected response status: ${response.status}` };
      }
    } catch (err: any) {
      const status = err.response?.status;
      let errorMsg = err.message || 'Unknown network error';
      if (status === 401 || status === 403) {
        return { success: false, status: 'Invalid', error: 'Invalid API key credentials (401)' };
      }
      if (status === 429) {
        return { success: false, status: 'Rate Limited', error: 'Rate limit or quota exceeded (429)' };
      }
      return { success: false, status: 'Offline', error: errorMsg };
    }
  }

  /**
   * Rolls back the API key to a specific history entry
   */
  public async rollbackKey(index: number): Promise<AIConfiguration> {
    const current = await this.getConfig(true);
    if (!current.keyHistory || !current.keyHistory[index]) {
      throw new Error('History index not found');
    }

    const targetEncrypted = current.keyHistory[index].key;
    const targetDecrypted = decryptPassword(targetEncrypted);
    if (!targetDecrypted) {
      throw new Error('Failed to decrypt rollback key');
    }

    // Remove from history
    const updatedHistory = current.keyHistory.filter((_, idx) => idx !== index);

    return await this.updateConfig({
      openRouterApiKey: targetDecrypted,
      keyHistory: updatedHistory
    });
  }
}

export const aiConfigManager = AIConfigManager.getInstance();
