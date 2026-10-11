import { AsyncLocalStorage } from 'async_hooks';
import { messengerLogger } from '../adapters/messenger/MessengerLogger';
import { messengerAccountsData } from '../db/database';
import { FIREBASE_BOT_ROOT } from '../config/firebase';

export interface BotDbContext {
  accountId: string;
  /** Firebase RTDB namespace prefix for this bot (replaces the old Mongo connection). */
  namespace: string;
  collectionPrefix: string;
}

/**
 * Per-bot database contexts on Firebase RTDB.
 *
 * Previously each bot could point at its own MongoDB cluster. MongoDB is
 * removed: every bot now shares the Firebase database, isolated by an RTDB
 * namespace (`shipu-messsenger-bot/bots/{accountId}/...`). Custom
 * `encryptedMongoUri` values stored on old records are ignored.
 */
export class DynamicDbManager {
  private static instance: DynamicDbManager;

  // Maps accountId to its Firebase namespace (for reference)
  private accountNamespaces = new Map<string, string>();

  // Node.js AsyncLocalStorage to propagate active bot context down the async call stack
  private contextStorage = new AsyncLocalStorage<BotDbContext>();

  private constructor() {}

  public static getInstance(): DynamicDbManager {
    if (!DynamicDbManager.instance) {
      DynamicDbManager.instance = new DynamicDbManager();
    }
    return DynamicDbManager.instance;
  }

  /**
   * Run a callback function within the context of a specific bot's database
   */
  public runWithContext<T>(context: BotDbContext, callback: () => T): T {
    return this.contextStorage.run(context, callback);
  }

  /**
   * Get the currently active bot context (if any)
   */
  public getActiveContext(): BotDbContext | undefined {
    return this.contextStorage.getStore();
  }

  /**
   * Gets or creates the Firebase namespace handle for a bot record.
   * Always resolves locally — no network connections to pool.
   */
  public async getBotConnection(record: any): Promise<BotDbContext> {
    const accountId = String(record?.accountId || 'default');
    if (record?.encryptedMongoUri) {
      messengerLogger.warn('DB_MANAGER', `Custom database URI on bot [${accountId}] ignored (MongoDB removed; using Firebase namespace).`);
    }
    const namespace = `${FIREBASE_BOT_ROOT}/bots/${accountId}`;
    const ctx: BotDbContext = {
      accountId,
      namespace,
      collectionPrefix: record?.collectionPrefix || ''
    };
    this.accountNamespaces.set(accountId, namespace);
    return ctx;
  }

  /**
   * Release a bot's namespace registration (no connection to close).
   */
  public async disconnectBotDb(accountId: string): Promise<void> {
    this.accountNamespaces.delete(accountId);
  }

  /**
   * Monitor health and sync bot status
   */
  private async syncBotStatusIfOnline(accountId: string, isHealthy: boolean): Promise<void> {
    try {
      const record = await messengerAccountsData.get(accountId);
      if (!record) return;

      if (!isHealthy) {
        if (record.status !== 'DATABASE_OFFLINE') {
          messengerLogger.error('DB_MANAGER', `Marking bot [${accountId}] as DATABASE_OFFLINE due to connection loss.`);
          await messengerAccountsData.update(accountId, { status: 'DATABASE_OFFLINE' });
        }
      } else {
        if (record.status === 'DATABASE_OFFLINE') {
          messengerLogger.info('DB_MANAGER', `Restoring bot [${accountId}] to ONLINE as database is healthy.`);
          await messengerAccountsData.update(accountId, { status: 'ONLINE' });
        }
      }
    } catch (err: any) {
      messengerLogger.error('DB_MANAGER', `Error syncing bot status: ${err.message}`);
    }
  }

  public async reportHealthy(accountId: string): Promise<void> {
    await this.syncBotStatusIfOnline(accountId, true);
  }

  public async reportUnhealthy(accountId: string): Promise<void> {
    await this.syncBotStatusIfOnline(accountId, false);
  }
}

export const dynamicDbManager = DynamicDbManager.getInstance();

(globalThis as any).getActiveBotDbContext = () => {
  return dynamicDbManager.getActiveContext();
};
