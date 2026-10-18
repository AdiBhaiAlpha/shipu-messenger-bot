import { PersonalAccountConnection, PersonalSafeAccountMeta } from './PersonalAccountConnection';
import { personalAIAccountsData, PersonalAIAccountRecord } from '../../db/database';
import { CookieLoader } from './CookieLoader';
import { messengerLogger, MessengerLogger } from './MessengerLogger';
import { encryptAuthState } from '../../utils/crypto';
import { coerceAppState } from './fca/normalizeAppState';

export class PersonalAIManager {
  private static instance: PersonalAIManager;
  private accounts = new Map<string, PersonalAccountConnection>();
  private statusListeners: ((meta: PersonalSafeAccountMeta) => void)[] = [];
  private isInitialized = false;

  private constructor() {}

  public static getInstance(): PersonalAIManager {
    if (!PersonalAIManager.instance) {
      PersonalAIManager.instance = new PersonalAIManager();
    }
    return PersonalAIManager.instance;
  }

  public registerStatusListener(cb: (meta: PersonalSafeAccountMeta) => void) {
    this.statusListeners.push(cb);
  }

  public async initializeAllAccountsFromDB(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;

    messengerLogger.info('SYSTEM', 'Initializing Personal AI Session Manager from MongoDB...');

    const records = await personalAIAccountsData.getAll();
    messengerLogger.info('SYSTEM', `Found ${records.length} Personal AI accounts stored in MongoDB.`);

    if (records.length === 0) {
      messengerLogger.info('SYSTEM', 'No stored Personal AI accounts in MongoDB. Waiting for user registration.');
      return;
    }

    const concurrency = 2;
    for (let i = 0; i < records.length; i += concurrency) {
      const chunk = records.slice(i, i + concurrency);
      await Promise.all(
        chunk.map(record => this.loadAndStartAccount(record))
      );
      if (i + concurrency < records.length) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    messengerLogger.success('SYSTEM', `Personal AI Manager startup complete. ${this.accounts.size} active accounts loaded.`);
  }

  private async loadAndStartAccount(record: PersonalAIAccountRecord): Promise<void> {
    try {
      let connection = this.accounts.get(record.accountId);
      if (!connection) {
        connection = new PersonalAccountConnection(record);
        connection.registerStatusListener(meta => {
          for (const listener of this.statusListeners) {
            try {
              listener(meta);
            } catch {}
          }
        });
        this.accounts.set(record.accountId, connection);
      }

      if (record.enabled) {
        await connection.connect();
      } else {
        connection.addConsoleLog('INFO', `Account is disabled. Skipping connection on startup.`);
      }
    } catch (err: any) {
      messengerLogger.error('SYSTEM', `Failed to load Personal AI account [${record.accountId}]: ${err.message}`);
    }
  }

  public async getAllAccountsMeta(): Promise<PersonalSafeAccountMeta[]> {
    const records = await personalAIAccountsData.getAll();
    const metas: PersonalSafeAccountMeta[] = [];
    for (const record of records) {
      const conn = this.accounts.get(record.accountId);
      if (conn) {
        metas.push(conn.getSafeMetadata());
      } else {
        // Fallback for offline/database-only records
        metas.push({
          accountId: record.accountId,
          uid: MessengerLogger.maskUid(record.uid),
          displayName: record.displayName || 'Personal AI Assistant',
          authType: record.authType || 'cookie',
          provider: record.provider || 'DongDev FCA',
          status: record.status || 'DISCONNECTED',
          mqttStatus: record.mqttStatus || 'OFF',
          enabled: record.enabled ?? true,
          autoReplyEnabled: record.autoReplyEnabled ?? true,
          typingIndicatorEnabled: record.typingIndicatorEnabled ?? true,
          readReceiptsEnabled: record.readReceiptsEnabled ?? false,
          replyDelayMs: record.replyDelayMs ?? 1000,
          maxHistory: record.maxHistory ?? 20,
          aiModel: record.aiModel || 'gemma-4-26b-a4b-it',
          memorySize: record.memorySize ?? 10,
          autoSleepMode: record.autoSleepMode ?? false,
          ignoreUnknownUsers: record.ignoreUnknownUsers ?? false,
          ignoreGroupChats: record.ignoreGroupChats ?? true,
          allowOnlyPrivateInbox: record.allowOnlyPrivateInbox ?? true,
          businessHoursEnabled: record.businessHoursEnabled ?? false,
          businessHoursStart: record.businessHoursStart || '09:00',
          businessHoursEnd: record.businessHoursEnd || '22:00',
          blacklistUids: record.blacklistUids || [],
          whitelistUids: record.whitelistUids || [],
          totalConversations: record.totalConversations || 0,
          messagesReceivedToday: record.messagesReceivedToday || 0,
          messagesRepliedToday: record.messagesRepliedToday || 0,
          avgResponseTimeMs: record.avgResponseTimeMs || 0,
          contextMemoryUsage: record.contextMemoryUsage || 0,
          lastIncomingMessageTime: record.lastIncomingMessageTime || 0,
          lastOutgoingReplyTime: record.lastOutgoingReplyTime || 0,
          sessionUptime: record.sessionUptime || 0,
          reconnectCount: record.reconnectCount || 0,
          errorCount: record.errorCount || 0,
          aiRequestCount: record.aiRequestCount || 0,
          currentQueueLength: record.currentQueueLength || 0,
          connectedAt: record.lastConnectedAt ? new Date(record.lastConnectedAt).toISOString() : undefined,
          lastValidatedAt: record.lastValidatedAt ? new Date(record.lastValidatedAt).toISOString() : undefined,
          lastErrorCode: record.lastErrorCode,
          activeProviderName: record.provider || 'DongDev FCA',
          liveConsoleLogs: record.liveConsoleLogs || []
        });
      }
    }
    return metas;
  }

  public async getAccountMeta(accountId: string): Promise<PersonalSafeAccountMeta | null> {
    const conn = this.accounts.get(accountId);
    if (conn) {
      return conn.getSafeMetadata();
    }
    const record = await personalAIAccountsData.get(accountId);
    if (!record) return null;
    return {
      accountId: record.accountId,
      uid: MessengerLogger.maskUid(record.uid),
      displayName: record.displayName || 'Personal AI Assistant',
      authType: record.authType || 'cookie',
      provider: record.provider || 'DongDev FCA',
      status: record.status || 'DISCONNECTED',
      mqttStatus: record.mqttStatus || 'OFF',
      enabled: record.enabled ?? true,
      autoReplyEnabled: record.autoReplyEnabled ?? true,
      typingIndicatorEnabled: record.typingIndicatorEnabled ?? true,
      readReceiptsEnabled: record.readReceiptsEnabled ?? false,
      replyDelayMs: record.replyDelayMs ?? 1000,
      maxHistory: record.maxHistory ?? 20,
      aiModel: record.aiModel || 'gemma-4-26b-a4b-it',
      memorySize: record.memorySize ?? 10,
      autoSleepMode: record.autoSleepMode ?? false,
      ignoreUnknownUsers: record.ignoreUnknownUsers ?? false,
      ignoreGroupChats: record.ignoreGroupChats ?? true,
      allowOnlyPrivateInbox: record.allowOnlyPrivateInbox ?? true,
      businessHoursEnabled: record.businessHoursEnabled ?? false,
      businessHoursStart: record.businessHoursStart || '09:00',
      businessHoursEnd: record.businessHoursEnd || '22:00',
      blacklistUids: record.blacklistUids || [],
      whitelistUids: record.whitelistUids || [],
      totalConversations: record.totalConversations || 0,
      messagesReceivedToday: record.messagesReceivedToday || 0,
      messagesRepliedToday: record.messagesRepliedToday || 0,
      avgResponseTimeMs: record.avgResponseTimeMs || 0,
      contextMemoryUsage: record.contextMemoryUsage || 0,
      lastIncomingMessageTime: record.lastIncomingMessageTime || 0,
      lastOutgoingReplyTime: record.lastOutgoingReplyTime || 0,
      sessionUptime: record.sessionUptime || 0,
      reconnectCount: record.reconnectCount || 0,
      errorCount: record.errorCount || 0,
      aiRequestCount: record.aiRequestCount || 0,
      currentQueueLength: record.currentQueueLength || 0,
      connectedAt: record.lastConnectedAt ? new Date(record.lastConnectedAt).toISOString() : undefined,
      lastValidatedAt: record.lastValidatedAt ? new Date(record.lastValidatedAt).toISOString() : undefined,
      lastErrorCode: record.lastErrorCode,
      activeProviderName: record.provider || 'DongDev FCA',
      liveConsoleLogs: record.liveConsoleLogs || []
    };
  }

  public async addCookieAccount(cookieJson: string): Promise<{ success: boolean; accountMeta?: PersonalSafeAccountMeta; error?: string }> {
    const formatValidation = CookieLoader.validateCookieJson(cookieJson);
    if (!formatValidation.valid || !formatValidation.userId) {
      return { success: false, error: formatValidation.error || 'Invalid cookie format.' };
    }

    const uid = formatValidation.userId;
    const accountId = `pai_${uid}`;
    const parsedCookies = coerceAppState(cookieJson);
    const encryptedState = encryptAuthState(JSON.stringify(parsedCookies));

    const record: PersonalAIAccountRecord = {
      accountId,
      uid,
      displayName: `Personal AI (${MessengerLogger.maskUid(uid)})`,
      authType: 'cookie',
      provider: 'DongDev FCA',
      encryptedAuthState: encryptedState,
      authStateVersion: 1,
      status: 'AUTHENTICATING',
      mqttStatus: 'CONNECTING',
      enabled: true,
      autoReplyEnabled: true,
      typingIndicatorEnabled: true,
      readReceiptsEnabled: false,
      replyDelayMs: 1000,
      maxHistory: 20,
      aiModel: 'gemma-4-26b-a4b-it',
      memorySize: 10,
      autoSleepMode: false,
      ignoreUnknownUsers: false,
      ignoreGroupChats: true,
      allowOnlyPrivateInbox: true,
      businessHoursEnabled: false,
      businessHoursStart: '09:00',
      businessHoursEnd: '22:00',
      blacklistUids: [],
      whitelistUids: [],
      totalConversations: 0,
      messagesReceivedToday: 0,
      messagesRepliedToday: 0,
      avgResponseTimeMs: 0,
      contextMemoryUsage: 0,
      lastIncomingMessageTime: 0,
      lastOutgoingReplyTime: 0,
      sessionUptime: 0,
      reconnectCount: 0,
      errorCount: 0,
      aiRequestCount: 0,
      currentQueueLength: 0,
      liveConsoleLogs: [{ id: `log_${Date.now()}`, timestamp: Date.now(), type: 'AUTH', message: 'Account registered via AppState cookie.' }],
      lastValidatedAt: Date.now(),
      lastConnectedAt: 0,
      lastDisconnectedAt: 0,
      lastErrorCode: '',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await personalAIAccountsData.upsert(record);

    let connection = this.accounts.get(accountId);
    if (!connection) {
      connection = new PersonalAccountConnection(record);
      connection.registerStatusListener(meta => {
        for (const listener of this.statusListeners) {
          try {
            listener(meta);
          } catch {}
        }
      });
      this.accounts.set(accountId, connection);
    }

    const success = await connection.connect();
    return {
      success: true,
      accountMeta: connection.getSafeMetadata()
    };
  }

  public async reconnectAccount(accountId: string): Promise<boolean> {
    const conn = this.accounts.get(accountId);
    if (!conn) return false;
    await conn.disconnect();
    return conn.connect();
  }

  public async disconnectAccount(accountId: string): Promise<boolean> {
    const conn = this.accounts.get(accountId);
    if (!conn) return false;
    await conn.disconnect();
    return true;
  }

  public async removeAccount(accountId: string): Promise<boolean> {
    const conn = this.accounts.get(accountId);
    if (conn) {
      await conn.disconnect();
      this.accounts.delete(accountId);
    }
    return personalAIAccountsData.delete(accountId);
  }

  public async toggleAccount(accountId: string, enabled: boolean): Promise<boolean> {
    const conn = this.accounts.get(accountId);
    if (!conn) return false;
    await conn.updateSettings({ enabled });
    if (enabled) {
      return conn.connect();
    } else {
      await conn.disconnect();
      return true;
    }
  }

  public async updateSettings(accountId: string, settings: any): Promise<boolean> {
    const conn = this.accounts.get(accountId);
    if (!conn) return false;
    await conn.updateSettings(settings);
    return true;
  }

  public async clearLogs(accountId: string): Promise<boolean> {
    const conn = this.accounts.get(accountId);
    if (conn) {
      conn.liveConsoleLogs = [];
      await personalAIAccountsData.update(accountId, { liveConsoleLogs: [] });
      return true;
    }
    return false;
  }

  public getAccountConnection(accountIdOrUid?: string): PersonalAccountConnection | null {
    if (!accountIdOrUid) {
      return this.accounts.values().next().value || null;
    }
    if (this.accounts.has(accountIdOrUid)) {
      return this.accounts.get(accountIdOrUid)!;
    }
    for (const conn of this.accounts.values()) {
      if (conn.uid === accountIdOrUid || conn.accountId === accountIdOrUid) {
        return conn;
      }
    }
    return null;
  }

  public async shutdownAll(): Promise<void> {
    for (const conn of this.accounts.values()) {
      try {
        await conn.disconnect();
      } catch {}
    }
  }
}

export const personalAIManager = PersonalAIManager.getInstance();
