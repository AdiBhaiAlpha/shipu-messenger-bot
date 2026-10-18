import { ShiPuUser, ShiPuThread, BotConfig } from '../types/shipu';
import { isDatabaseConnected } from './firebaseDb';
import {
  UserModel,
  ThreadModel,
  AdminBotModel,
  FtpConfigModel,
  AuditLogModel,
  StoredCommandModel,
  BotSettingModel,
  MessengerAccountModel,
  PersonalAIAccountModel,
  TelegramConfigModel,
  connectDatabase,
  executeFallback
} from './firebaseDb';
import { TelegramConfigRecord } from '../types/telegram';

export interface MessengerAccountRecord {
  accountId: string;
  uid: string;
  slotId?: string;
  botId?: string;
  ownerId?: string;
  encryptedMongoUri?: string;
  dbName?: string;
  collectionPrefix?: string;
  connectionMode?: 'default' | 'custom';
  displayName: string;
  authType: 'cookie' | 'oauth';
  provider: string;
  encryptedAuthState: string;
  authStateVersion: number;
  status: string;
  mqttStatus: string;
  loginStatus?: string;
  creationSource?: string;
  source?: string;
  lastHeartbeat?: number;
  lastSuccessfulLogin?: number;
  retryCounter?: number;
  failureReason?: string;
  lastRestoreAt?: number;
  botEnabled: boolean;
  enabled?: boolean;
  aiEnabled?: boolean;
  personalAiEnabled?: boolean;
  lastIncomingMessageAt?: number;
  lastOutgoingMessageAt?: number;
  stats?: {
    messagesToday: number;
    aiMessages: number;
    totalMessages: number;
    reconnects: number;
    uptimeMs: number;
  };
  lastValidatedAt: number;
  lastConnectedAt: number;
  lastDisconnectedAt: number;
  lastErrorCode: string;
  lastErrorAt: number;
  reconnectCount: number;
  createdAt: number;
  updatedAt: number;
}

import { encryptPassword, decryptPassword } from '../utils/crypto';
import { initialAdminBot } from '../config/database';

export interface StoredCommandData {
  name: string;
  filename: string;
  description: string;
  category: string;
  role: number;
  aliases: string[];
  guide: string;
  countDown: number;
  enabled: boolean;
  author: string;
  version: string;
  code: string;
  updatedAt: string;
}

export interface FtpConfigRecord {
  enabled: boolean;
  protocol: 'ftp' | 'ftps' | 'sftp';
  host: string;
  port: number;
  username: string;
  encryptedPassword: string;
  rootDirectory: string;
  passiveMode: boolean;
  secure: boolean;
  timeout: number;
  updatedAt: string;
  updatedBy: string;
}

// Ensure Firebase RTDB is connected before query
async function ensureDb() {
  try {
    if (isDatabaseConnected()) {
      return { connected: true };
    }
    const status = await connectDatabase();
    return status;
    return status;
  } catch (err: any) {
    return { connected: false, error: err.message || String(err) };
  }
}

// --- ADMIN BOT DATA ABSTRACTION ---
export const adminBotData = {
  getAll: async (): Promise<{ uid: string; addedBy: string; addedAt: string; role: string }[]> => {
    await ensureDb();
    try {
      const records = await AdminBotModel.find().lean();
      const rawList = (!records || records.length === 0)
        ? initialAdminBot.map(uid => ({
            uid,
            addedBy: 'SYSTEM_CONFIG',
            addedAt: new Date().toISOString(),
            role: 'OWNER'
          }))
        : records.map(r => ({
            uid: r.uid,
            addedBy: r.addedBy || 'ADMIN',
            addedAt: r.addedAt || new Date().toISOString(),
            role: r.role || 'ADMIN'
          }));

      const seen = new Set<string>();
      return rawList.filter(item => {
        if (!item.uid || seen.has(item.uid)) return false;
        seen.add(item.uid);
        return true;
      });
    } catch {
      const seen = new Set<string>();
      return initialAdminBot.map(uid => ({
        uid,
        addedBy: 'SYSTEM_CONFIG',
        addedAt: new Date().toISOString(),
        role: 'OWNER'
      })).filter(item => {
        if (!item.uid || seen.has(item.uid)) return false;
        seen.add(item.uid);
        return true;
      });
    }
  },

  getUids: async (): Promise<string[]> => {
    const list = await adminBotData.getAll();
    return list.map(item => item.uid);
  },

  add: async (uid: string, addedBy: string = 'ADMIN'): Promise<{ success: boolean; message: string }> => {
    await ensureDb();
    const cleanUid = uid.trim();
    if (!cleanUid || !/^\d+$/.test(cleanUid)) {
      return { success: false, message: 'Invalid UID format. UID must be numbers only.' };
    }

    try {
      const existing = await AdminBotModel.findOne({ uid: cleanUid } as any);
      if (existing) {
        return { success: false, message: `UID ${cleanUid} is already an Admin Bot.` };
      }

      await AdminBotModel.create({
        uid: cleanUid,
        addedBy,
        addedAt: new Date().toISOString(),
        role: 'ADMIN'
      });

      return { success: true, message: `Successfully added ${cleanUid} to Admin Bot list.` };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Failed to add Admin Bot.' };
    }
  },

  remove: async (uid: string): Promise<{ success: boolean; message: string }> => {
    await ensureDb();
    const cleanUid = uid.trim();
    try {
      const allAdmins = await adminBotData.getUids();
      if (allAdmins.length <= 1) {
        return { success: false, message: 'Cannot remove the last remaining Admin Bot.' };
      }

      const res = await AdminBotModel.deleteOne({ uid: cleanUid });
      if (res.deletedCount === 0) {
        return { success: false, message: `Admin Bot UID ${cleanUid} not found.` };
      }

      return { success: true, message: `Successfully removed ${cleanUid} from Admin Bot list.` };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Failed to remove Admin Bot.' };
    }
  }
};

// --- FTP CONFIGURATION ABSTRACTION ---
const HARDCODED_FTP_HOST = 'ftpupload.net';
const HARDCODED_FTP_USER = 'cpfr_38719167';
const HARDCODED_FTP_PASS = 'chitron2448766';
const HARDCODED_FTP_PORT = 21;

export const ftpConfigData = {
  get: async (): Promise<FtpConfigRecord | null> => {
    await ensureDb();
    try {
      const doc = await FtpConfigModel.findOne({ key: 'primary' } as any).lean();
      
      // Override or fallback to hardcoded credentials as requested by user
      return {
        enabled: doc?.enabled ?? false,
        protocol: doc?.protocol || 'ftp',
        host: HARDCODED_FTP_HOST,
        port: HARDCODED_FTP_PORT,
        username: HARDCODED_FTP_USER,
        encryptedPassword: doc?.encryptedPassword || encryptPassword(HARDCODED_FTP_PASS),
        rootDirectory: doc?.rootDirectory || '/htdocs',
        passiveMode: doc?.passiveMode ?? true,
        secure: doc?.secure ?? false,
        timeout: doc?.timeout || 30000,
        updatedAt: doc?.updatedAt || new Date().toISOString(),
        updatedBy: doc?.updatedBy || 'SYSTEM_HARDCODED'
      };
    } catch {
      // Fallback for DB failure
      return {
        enabled: false,
        protocol: 'ftp',
        host: HARDCODED_FTP_HOST,
        port: HARDCODED_FTP_PORT,
        username: HARDCODED_FTP_USER,
        encryptedPassword: encryptPassword(HARDCODED_FTP_PASS),
        rootDirectory: '/htdocs',
        passiveMode: true,
        secure: false,
        timeout: 30000,
        updatedAt: new Date().toISOString(),
        updatedBy: 'SYSTEM_HARDCODED'
      };
    }
  },

  getDecryptedPassword: async (): Promise<string> => {
    // Priority to hardcoded password to prevent 530 errors
    return HARDCODED_FTP_PASS;
  },

  set: async (data: Partial<FtpConfigRecord> & { rawPassword?: string }, updatedBy: string = 'ADMIN'): Promise<FtpConfigRecord> => {
    await ensureDb();
    const existing = await ftpConfigData.get();

    let encryptedPassword = existing?.encryptedPassword || '';
    if (data.rawPassword !== undefined && data.rawPassword !== '' && data.rawPassword !== '••••••••') {
      encryptedPassword = encryptPassword(data.rawPassword);
    }

    const newRecord: FtpConfigRecord = {
      enabled: data.enabled ?? existing?.enabled ?? true,
      protocol: data.protocol || existing?.protocol || 'ftp',
      host: data.host || existing?.host || '',
      port: data.port || existing?.port || 21,
      username: data.username || existing?.username || '',
      encryptedPassword,
      rootDirectory: data.rootDirectory || existing?.rootDirectory || '/shipu-bot/',
      passiveMode: data.passiveMode ?? existing?.passiveMode ?? true,
      secure: data.secure ?? existing?.secure ?? false,
      timeout: data.timeout || existing?.timeout || 10000,
      updatedAt: new Date().toISOString(),
      updatedBy
    };

    await FtpConfigModel.updateOne(
      { key: 'primary' } as any,
      { $set: newRecord },
      { upsert: true }
    );

    return newRecord;
  },

  getSafe: async () => {
    const config = await ftpConfigData.get();
    if (!config) return null;
    const { encryptedPassword, ...safe } = config;
    return {
      ...safe,
      hasPasswordSet: Boolean(encryptedPassword),
      maskedPassword: encryptedPassword ? '••••••••' : ''
    };
  }
};

// --- USERS DATA ABSTRACTION ---
export const usersData = {
  get: async (userID: string): Promise<ShiPuUser | null> => {
    await ensureDb();
    try {
      const u = await UserModel.findOne({ userID } as any).lean();
      if (!u) return null;
      const isOwner = userID === '61579127085437' || userID === '100081330372098' || initialAdminBot.includes(userID);
      return {
        userID: u.userID,
        name: u.name || `User_${u.userID}`,
        role: isOwner ? 3 : (u.role || 0),
        money: u.money || 0,
        bankMoney: u.bankMoney || 0,
        exp: u.exp || 0,
        level: u.level || 1,
        isBanned: u.isBanned || false
      };
    } catch {
      return null;
    }
  },

  set: async (userID: string, data: ShiPuUser): Promise<void> => {
    await ensureDb();
    try {
      await UserModel.updateOne(
        { userID } as any,
        { $set: data },
        { upsert: true }
      );
    } catch (err) {
      console.error('Failed to set user in MongoDB:', err);
    }
  },

  update: async (userID: string, updates: Partial<ShiPuUser>): Promise<void> => {
    await ensureDb();
    try {
      await UserModel.updateOne(
        { userID } as any,
        { $set: updates },
        { upsert: true }
      );
    } catch (err) {
      console.error('Failed to update user in MongoDB:', err);
    }
  },

  getAll: async (): Promise<ShiPuUser[]> => {
    await ensureDb();
    try {
      const users = await UserModel.find().lean();
      return users.map(u => {
        const isOwner = u.userID === '61579127085437' || u.userID === '100081330372098' || initialAdminBot.includes(u.userID);
        return {
          userID: u.userID,
          name: u.name || `User_${u.userID}`,
          role: isOwner ? 3 : (u.role || 0),
          money: u.money || 0,
          bankMoney: u.bankMoney || 0,
          exp: u.exp || 0,
          level: u.level || 1,
          isBanned: u.isBanned || false
        };
      });
    } catch {
      return [];
    }
  }
};

// --- THREADS DATA ABSTRACTION ---
export const threadsData = {
  get: async (threadID: string): Promise<ShiPuThread | null> => {
    await ensureDb();
    try {
      const t = await ThreadModel.findOne({ threadID } as any).lean();
      if (!t) return null;
      return {
        threadID: t.threadID,
        name: t.name || `Thread ${t.threadID}`,
        prefix: t.prefix || '#',
        language: t.language || 'en',
        timezone: t.timezone || 'Asia/Dhaka',
        members: t.members || [],
        adminIDs: t.adminIDs || [],
        autoWelcome: t.autoWelcome ?? true,
        welcomeMessage: t.welcomeMessage || 'Welcome!',
        goodbyeMessage: t.goodbyeMessage || 'Goodbye!',
        antiSpam: t.antiSpam ?? true,
        antiLink: t.antiLink ?? false,
        aiEnabled: t.aiEnabled ?? true,
        economyEnabled: t.economyEnabled ?? true,
        isBanned: t.isBanned ?? false,
        createdAt: t.createdAt || Date.now(),
        initializedAt: t.initializedAt || 0,
        connectionMessageSent: t.connectionMessageSent ?? false,
        nicknameUpdated: t.nicknameUpdated ?? false,
        botPresent: t.botPresent ?? true,
        botNickname: t.botNickname || 'ShiPu Ai🤖'
      };
    } catch {
      return null;
    }
  },

  set: async (threadID: string, data: ShiPuThread): Promise<void> => {
    await ensureDb();
    try {
      await ThreadModel.updateOne(
        { threadID } as any,
        { $set: data },
        { upsert: true }
      );
    } catch (err) {
      console.error('Failed to set thread in MongoDB:', err);
    }
  },

  update: async (threadID: string, updates: Partial<ShiPuThread>): Promise<void> => {
    await ensureDb();
    try {
      await ThreadModel.updateOne(
        { threadID } as any,
        { $set: updates },
        { upsert: true }
      );
    } catch (err) {
      console.error('Failed to update thread in MongoDB:', err);
    }
  },

  getAll: async (): Promise<ShiPuThread[]> => {
    await ensureDb();
    try {
      const threads = await ThreadModel.find().lean();
      return threads.map(t => ({
        threadID: t.threadID,
        name: t.name || `Thread ${t.threadID}`,
        prefix: t.prefix || '#',
        language: t.language || 'en',
        timezone: t.timezone || 'Asia/Dhaka',
        members: t.members || [],
        adminIDs: t.adminIDs || [],
        autoWelcome: t.autoWelcome ?? true,
        welcomeMessage: t.welcomeMessage || 'Welcome!',
        goodbyeMessage: t.goodbyeMessage || 'Goodbye!',
        antiSpam: t.antiSpam ?? true,
        antiLink: t.antiLink ?? false,
        aiEnabled: t.aiEnabled ?? true,
        economyEnabled: t.economyEnabled ?? true,
        isBanned: t.isBanned ?? false,
        createdAt: t.createdAt || Date.now(),
        initializedAt: t.initializedAt || 0,
        connectionMessageSent: t.connectionMessageSent ?? false,
        nicknameUpdated: t.nicknameUpdated ?? false,
        botPresent: t.botPresent ?? true,
        botNickname: t.botNickname || 'ShiPu Ai🤖'
      }));
    } catch {
      return [];
    }
  }
};

// --- SETTINGS DATA ABSTRACTION ---
export const settingsData = {
  get: async (): Promise<BotConfig> => {
    await ensureDb();
    const defaultConfig: BotConfig = {
      botName: 'ShiPu Ai🤖',
      globalPrefix: '#',
      botAdminIDs: await adminBotData.getUids(),
      botOwnerID: initialAdminBot[0] || '100081330372098',
      autoRestart: true,
      webhookUrl: 'https://graph.facebook.com/v18.0/me/messages',
      facebookAppState: '[]',
      enableAI: true,
      maintenanceMode: false
    };

    try {
      const doc = await BotSettingModel.findOne({ key: 'globalConfig' } as any).lean();
      if (doc && doc.value) {
        return { ...defaultConfig, ...doc.value, botAdminIDs: await adminBotData.getUids() };
      }
    } catch {
      // Fallback to default
    }

    return defaultConfig;
  },

  update: async (updates: Partial<BotConfig>): Promise<BotConfig> => {
    await ensureDb();
    const current = await settingsData.get();
    const updated = { ...current, ...updates };
    try {
      await BotSettingModel.updateOne(
        { key: 'globalConfig' } as any,
        { $set: { key: 'globalConfig', value: updated } },
        { upsert: true }
      );
    } catch (err) {
      console.error('Failed to save settings to MongoDB:', err);
    }
    return updated;
  }
};

// --- AUDIT LOGS ABSTRACTION ---
export const auditLogsData = {
  add: async (admin: string, action: string, target?: string, result: string = 'SUCCESS'): Promise<void> => {
    try {
      const status = await connectDatabase();
      if (!status.connected) {
        console.warn(`[AUDIT] Skipping log due to DB disconnect: ${action}`);
        return;
      }
      
      const logItem = {
        id: `audit_${Date.now()}_${Math.floor(Math.random() * 1000)}`,
        admin,
        action,
        timestamp: new Date().toISOString(),
        target: target || 'System Global',
        result
      };
      await AuditLogModel.create(logItem);
    } catch (err) {
      console.error('Failed to log audit in MongoDB:', err);
    }
  },

  getAll: async () => {
    await ensureDb();
    try {
      const logs = await AuditLogModel.find().sort({ createdAt: -1 }).limit(100).lean();
      return logs.map(l => ({
        id: l.id,
        admin: l.admin,
        action: l.action,
        timestamp: l.timestamp,
        target: l.target,
        result: l.result
      }));
    } catch {
      return [];
    }
  }
};

// --- COMMANDS DATABASE ABSTRACTION ---
export const commandsData = {
  get: async (name: string): Promise<StoredCommandData | null> => {
    await ensureDb();
    const key = name.toLowerCase().trim();
    try {
      const cmd = await StoredCommandModel.findOne({ name: key } as any).lean();
      if (!cmd) return null;
      return {
        name: cmd.name,
        filename: cmd.filename || '',
        description: cmd.description || '',
        category: cmd.category || 'general',
        role: cmd.role || 0,
        aliases: cmd.aliases || [],
        guide: cmd.guide || '',
        countDown: cmd.countDown || 5,
        enabled: cmd.enabled ?? true,
        author: cmd.author || 'ShiPu Team',
        version: cmd.version || '1.0.0',
        code: cmd.code || '',
        updatedAt: cmd.updatedAt || new Date().toISOString()
      };
    } catch {
      return null;
    }
  },

  set: async (name: string, data: StoredCommandData): Promise<void> => {
    await ensureDb();
    const key = name.toLowerCase().trim();
    try {
      await StoredCommandModel.updateOne(
        { name: key } as any,
        { $set: { ...data, name: key } },
        { upsert: true }
      );
    } catch (err) {
      console.error('Failed to set command in MongoDB:', err);
    }
  },

  delete: async (name: string): Promise<void> => {
    await ensureDb();
    const key = name.toLowerCase().trim();
    try {
      await StoredCommandModel.deleteOne({ name: key } as any);
    } catch (err) {
      console.error('Failed to delete command in MongoDB:', err);
    }
  },

  getAll: async (): Promise<StoredCommandData[]> => {
    await ensureDb();
    try {
      const list = await StoredCommandModel.find().lean();
      return list.map(cmd => ({
        name: cmd.name,
        filename: cmd.filename || '',
        description: cmd.description || '',
        category: cmd.category || 'general',
        role: cmd.role || 0,
        aliases: cmd.aliases || [],
        guide: cmd.guide || '',
        countDown: cmd.countDown || 5,
        enabled: cmd.enabled ?? true,
        author: cmd.author || 'ShiPu Team',
        version: cmd.version || '1.0.0',
        code: cmd.code || '',
        updatedAt: cmd.updatedAt || new Date().toISOString()
      }));
    } catch {
      return [];
    }
  },

  seedDefaultsIfEmpty: async (defaultSeeds: StoredCommandData[]): Promise<void> => {
    await ensureDb();
    try {
      // Only seed when the collection is truly empty. Previously this wiped
      // every stored (including user-installed) command on each boot.
      const existingCount = await StoredCommandModel.countDocuments();
      if (existingCount > 0) return;
      for (const seed of defaultSeeds) {
        await commandsData.set(seed.name, seed);
      }
    } catch (err) {
      console.error('Failed to seed default commands in MongoDB:', err);
    }
  }
};

const mapRecord = (r: any): MessengerAccountRecord => {
  const encState = r.encryptedAuthState || (r.cookie ? encryptPassword(r.cookie) : '');
  return {
    accountId: r.accountId,
    uid: r.uid || r.facebookUID || '',
    slotId: r.slotId || r.botSlotId || '',
    botId: r.botId || '',
    ownerId: r.ownerId || r.ownerUserId || '',
    encryptedMongoUri: r.encryptedMongoUri || '',
    dbName: r.dbName || '',
    collectionPrefix: r.collectionPrefix || '',
    connectionMode: r.connectionMode || 'default',
    displayName: r.displayName || r.accountName || 'Facebook User',
    authType: r.authType || 'cookie',
    provider: r.provider || 'DongDev FCA',
    encryptedAuthState: encState,
    authStateVersion: r.authStateVersion || 1,
    status: r.status || 'DISCONNECTED',
    mqttStatus: r.mqttStatus || 'OFF',
    loginStatus: r.loginStatus || (r.status === 'CONNECTED' || r.status === 'ONLINE' || r.status === 'AI_READY' ? 'LOGGED_IN' : 'LOGGED_OUT'),
    creationSource: r.creationSource || 'ADMIN_DASHBOARD',
    source: r.source || (r.creationSource === 'CLIENT_SYNC' ? 'client' : 'admin'),
    lastHeartbeat: r.lastHeartbeat || Date.now(),
    lastSuccessfulLogin: r.lastSuccessfulLogin || r.lastConnectedAt || 0,
    retryCounter: r.retryCounter || r.reconnectCount || 0,
    failureReason: r.failureReason || r.lastErrorCode || '',
    botEnabled: r.botEnabled ?? true,
    enabled: r.enabled ?? r.botEnabled ?? true,
    aiEnabled: r.aiEnabled ?? true,
    personalAiEnabled: r.personalAiEnabled ?? false,
    lastIncomingMessageAt: r.lastIncomingMessageAt || 0,
    lastOutgoingMessageAt: r.lastOutgoingMessageAt || 0,
    stats: r.stats || {
      messagesToday: 0,
      aiMessages: 0,
      totalMessages: 0,
      reconnects: r.reconnectCount || 0,
      uptimeMs: 0
    },
    lastValidatedAt: r.lastValidatedAt || Date.now(),
    lastConnectedAt: r.lastConnectedAt || 0,
    lastDisconnectedAt: r.lastDisconnectedAt || 0,
    lastErrorCode: r.lastErrorCode || '',
    lastErrorAt: r.lastErrorAt || 0,
    reconnectCount: r.reconnectCount || 0,
    createdAt: r.createdAt || Date.now(),
    updatedAt: r.updatedAt || Date.now()
  };
};

export const messengerAccountsData = {
  getAll: async (): Promise<MessengerAccountRecord[]> => {
    try {
      await ensureDb();
      const records = await MessengerAccountModel.find().lean();
      return records.map(r => mapRecord(r));
    } catch {
      return [];
    }
  },

  get: async (accountId: string): Promise<MessengerAccountRecord | null> => {
    try {
      await ensureDb();
      const r: any = await MessengerAccountModel.findOne({ accountId } as any).lean();
      if (!r) return null;
      return mapRecord(r);
    } catch {
      return null;
    }
  },

  getByUid: async (uid: string): Promise<MessengerAccountRecord | null> => {
    try {
      await ensureDb();
      const r: any = await MessengerAccountModel.findOne({ uid } as any).lean();
      if (!r) return null;
      return mapRecord(r);
    } catch {
      return null;
    }
  },

  getBySlotId: async (slotId: string): Promise<MessengerAccountRecord | null> => {
    try {
      await ensureDb();
      const r: any = await MessengerAccountModel.findOne({ slotId } as any).lean();
      if (!r) return null;
      return mapRecord(r);
    } catch {
      return null;
    }
  },

  upsert: async (account: Partial<MessengerAccountRecord> & { accountId: string; uid: string; encryptedAuthState: string }): Promise<void> => {
    try {
      await ensureDb();
      const now = Date.now();
      let rawCookie = '';
      try {
        rawCookie = decryptPassword(account.encryptedAuthState);
      } catch (err) {}

      const updatePayload = {
        $set: {
          uid: account.uid,
          facebookUID: account.uid,
          slotId: account.slotId || '',
          botSlotId: account.slotId || '',
          botId: account.botId || '',
          ownerId: account.ownerId || '',
          ownerUserId: account.ownerId || '',
          cookie: rawCookie,
          encryptedMongoUri: account.encryptedMongoUri || '',
          dbName: account.dbName || '',
          collectionPrefix: account.collectionPrefix || '',
          connectionMode: account.connectionMode || 'default',
          displayName: account.displayName || 'Facebook User',
          accountName: account.displayName || 'Facebook User',
          authType: account.authType || 'cookie',
          provider: account.provider || 'DongDev FCA',
          encryptedAuthState: account.encryptedAuthState,
          authStateVersion: account.authStateVersion || 1,
          status: account.status || 'VALIDATING',
          mqttStatus: account.mqttStatus || 'OFF',
          loginStatus: account.loginStatus || 'PENDING',
          creationSource: account.creationSource || 'ADMIN_DASHBOARD',
          source: account.source || (account.creationSource === 'CLIENT_SYNC' ? 'client' : 'admin'),
          lastHeartbeat: account.lastHeartbeat || now,
          lastSuccessfulLogin: account.lastSuccessfulLogin || 0,
          retryCounter: account.retryCounter || 0,
          failureReason: account.failureReason || '',
          botEnabled: account.botEnabled ?? true,
          enabled: account.enabled ?? true,
          aiEnabled: account.aiEnabled ?? true,
          personalAiEnabled: account.personalAiEnabled ?? false,
          lastIncomingMessageAt: account.lastIncomingMessageAt || 0,
          lastOutgoingMessageAt: account.lastOutgoingMessageAt || 0,
          stats: account.stats || {
            messagesToday: 0,
            aiMessages: 0,
            totalMessages: 0,
            reconnects: 0,
            uptimeMs: 0
          },
          lastValidatedAt: account.lastValidatedAt || now,
          lastConnectedAt: account.lastConnectedAt || 0,
          lastDisconnectedAt: account.lastDisconnectedAt || 0,
          lastErrorCode: account.lastErrorCode || '',
          lastErrorAt: account.lastErrorAt || 0,
          reconnectCount: account.reconnectCount || 0,
          updatedAt: now
        },
        $setOnInsert: {
          accountId: account.accountId,
          createdAt: now
        }
      };

      await MessengerAccountModel.updateOne(
        { accountId: account.accountId },
        updatePayload,
        { upsert: true }
      );
    } catch (err: any) {
      console.warn(`[DATABASE] Model upsert error for ${account.accountId}, falling back:`, err?.message || err);
      try {
        executeFallback('MessengerAccount', 'updateOne', [
          { accountId: account.accountId },
          { ...account, updatedAt: Date.now() },
          { upsert: true }
        ]);
      } catch (fbErr) {
        console.error(`Failed to upsert Messenger account fallback ${account.accountId}:`, fbErr);
      }
    }
  },

  update: async (accountId: string, updates: Partial<MessengerAccountRecord>): Promise<void> => {
    const extra: any = {};
    if (updates.uid !== undefined) extra.facebookUID = updates.uid;
    if (updates.slotId !== undefined) extra.botSlotId = updates.slotId;
    if (updates.ownerId !== undefined) extra.ownerUserId = updates.ownerId;
    if (updates.displayName !== undefined) extra.accountName = updates.displayName;
    if (updates.encryptedAuthState !== undefined) {
       try {
         extra.cookie = decryptPassword(updates.encryptedAuthState);
       } catch (e) {}
    }
    const setDoc = { ...updates, ...extra, updatedAt: Date.now() };

    try {
      await ensureDb();
      await MessengerAccountModel.updateOne(
        { accountId },
        { $set: setDoc }
      );
    } catch (err: any) {
      console.warn(`[DATABASE] Model update error for ${accountId}, falling back:`, err?.message || err);
      try {
        executeFallback('MessengerAccount', 'updateOne', [
          { accountId },
          { $set: setDoc }
        ]);
      } catch (fbErr) {
        console.error(`Failed to update Messenger account fallback ${accountId}:`, fbErr);
      }
    }
  },

  delete: async (accountId: string): Promise<boolean> => {
    try {
      await ensureDb();
      const res = await MessengerAccountModel.deleteOne({ accountId });
      return res.deletedCount > 0;
    } catch {
      return false;
    }
  }
};

export interface PersonalAIAccountRecord {
  accountId: string;
  uid: string;
  displayName: string;
  authType: 'cookie' | 'oauth';
  provider: string;
  encryptedAuthState: string;
  authStateVersion: number;
  status: string;
  mqttStatus: string;
  enabled: boolean;
  autoReplyEnabled: boolean;
  typingIndicatorEnabled: boolean;
  readReceiptsEnabled: boolean;
  replyDelayMs: number;
  maxHistory: number;
  aiModel: string;
  memorySize: number;
  autoSleepMode: boolean;
  ignoreUnknownUsers: boolean;
  ignoreGroupChats: boolean;
  allowOnlyPrivateInbox: boolean;
  businessHoursEnabled: boolean;
  businessHoursStart: string;
  businessHoursEnd: string;
  blacklistUids: string[];
  whitelistUids: string[];
  totalConversations: number;
  messagesReceivedToday: number;
  messagesRepliedToday: number;
  avgResponseTimeMs: number;
  contextMemoryUsage: number;
  lastIncomingMessageTime: number;
  lastOutgoingReplyTime: number;
  sessionUptime: number;
  reconnectCount: number;
  errorCount: number;
  aiRequestCount: number;
  currentQueueLength: number;
  liveConsoleLogs: Array<{ id: string; timestamp: number; type: string; message: string }>;
  lastValidatedAt: number;
  lastConnectedAt: number;
  lastDisconnectedAt: number;
  lastErrorCode: string;
  createdAt: number;
  updatedAt: number;
}

export const personalAIAccountsData = {
  getAll: async (): Promise<PersonalAIAccountRecord[]> => {
    await ensureDb();
    try {
      const records = await PersonalAIAccountModel.find().lean();
      return records.map((r: any) => ({
        accountId: r.accountId,
        uid: r.uid,
        displayName: r.displayName || 'Personal AI Assistant',
        authType: r.authType || 'cookie',
        provider: r.provider || 'DongDev FCA',
        encryptedAuthState: r.encryptedAuthState,
        authStateVersion: r.authStateVersion || 1,
        status: r.status || 'DISCONNECTED',
        mqttStatus: r.mqttStatus || 'OFF',
        enabled: r.enabled ?? true,
        autoReplyEnabled: r.autoReplyEnabled ?? true,
        typingIndicatorEnabled: r.typingIndicatorEnabled ?? true,
        readReceiptsEnabled: r.readReceiptsEnabled ?? false,
        replyDelayMs: r.replyDelayMs ?? 1000,
        maxHistory: r.maxHistory ?? 20,
        aiModel: r.aiModel || 'gemma-4-26b-a4b-it',
        memorySize: r.memorySize ?? 10,
        autoSleepMode: r.autoSleepMode ?? false,
        ignoreUnknownUsers: r.ignoreUnknownUsers ?? false,
        ignoreGroupChats: r.ignoreGroupChats ?? true,
        allowOnlyPrivateInbox: r.allowOnlyPrivateInbox ?? true,
        businessHoursEnabled: r.businessHoursEnabled ?? false,
        businessHoursStart: r.businessHoursStart || '09:00',
        businessHoursEnd: r.businessHoursEnd || '22:00',
        blacklistUids: r.blacklistUids || [],
        whitelistUids: r.whitelistUids || [],
        totalConversations: r.totalConversations || 0,
        messagesReceivedToday: r.messagesReceivedToday || 0,
        messagesRepliedToday: r.messagesRepliedToday || 0,
        avgResponseTimeMs: r.avgResponseTimeMs || 0,
        contextMemoryUsage: r.contextMemoryUsage || 0,
        lastIncomingMessageTime: r.lastIncomingMessageTime || 0,
        lastOutgoingReplyTime: r.lastOutgoingReplyTime || 0,
        sessionUptime: r.sessionUptime || 0,
        reconnectCount: r.reconnectCount || 0,
        errorCount: r.errorCount || 0,
        aiRequestCount: r.aiRequestCount || 0,
        currentQueueLength: r.currentQueueLength || 0,
        liveConsoleLogs: r.liveConsoleLogs || [],
        lastValidatedAt: r.lastValidatedAt || Date.now(),
        lastConnectedAt: r.lastConnectedAt || 0,
        lastDisconnectedAt: r.lastDisconnectedAt || 0,
        lastErrorCode: r.lastErrorCode || '',
        createdAt: r.createdAt || Date.now(),
        updatedAt: r.updatedAt || Date.now()
      }));
    } catch {
      return [];
    }
  },

  get: async (accountId: string): Promise<PersonalAIAccountRecord | null> => {
    await ensureDb();
    try {
      const r: any = await PersonalAIAccountModel.findOne({ accountId } as any).lean();
      if (!r) return null;
      return {
        accountId: r.accountId,
        uid: r.uid,
        displayName: r.displayName || 'Personal AI Assistant',
        authType: r.authType || 'cookie',
        provider: r.provider || 'DongDev FCA',
        encryptedAuthState: r.encryptedAuthState,
        authStateVersion: r.authStateVersion || 1,
        status: r.status || 'DISCONNECTED',
        mqttStatus: r.mqttStatus || 'OFF',
        enabled: r.enabled ?? true,
        autoReplyEnabled: r.autoReplyEnabled ?? true,
        typingIndicatorEnabled: r.typingIndicatorEnabled ?? true,
        readReceiptsEnabled: r.readReceiptsEnabled ?? false,
        replyDelayMs: r.replyDelayMs ?? 1000,
        maxHistory: r.maxHistory ?? 20,
        aiModel: r.aiModel || 'gemma-4-26b-a4b-it',
        memorySize: r.memorySize ?? 10,
        autoSleepMode: r.autoSleepMode ?? false,
        ignoreUnknownUsers: r.ignoreUnknownUsers ?? false,
        ignoreGroupChats: r.ignoreGroupChats ?? true,
        allowOnlyPrivateInbox: r.allowOnlyPrivateInbox ?? true,
        businessHoursEnabled: r.businessHoursEnabled ?? false,
        businessHoursStart: r.businessHoursStart || '09:00',
        businessHoursEnd: r.businessHoursEnd || '22:00',
        blacklistUids: r.blacklistUids || [],
        whitelistUids: r.whitelistUids || [],
        totalConversations: r.totalConversations || 0,
        messagesReceivedToday: r.messagesReceivedToday || 0,
        messagesRepliedToday: r.messagesRepliedToday || 0,
        avgResponseTimeMs: r.avgResponseTimeMs || 0,
        contextMemoryUsage: r.contextMemoryUsage || 0,
        lastIncomingMessageTime: r.lastIncomingMessageTime || 0,
        lastOutgoingReplyTime: r.lastOutgoingReplyTime || 0,
        sessionUptime: r.sessionUptime || 0,
        reconnectCount: r.reconnectCount || 0,
        errorCount: r.errorCount || 0,
        aiRequestCount: r.aiRequestCount || 0,
        currentQueueLength: r.currentQueueLength || 0,
        liveConsoleLogs: r.liveConsoleLogs || [],
        lastValidatedAt: r.lastValidatedAt || Date.now(),
        lastConnectedAt: r.lastConnectedAt || 0,
        lastDisconnectedAt: r.lastDisconnectedAt || 0,
        lastErrorCode: r.lastErrorCode || '',
        createdAt: r.createdAt || Date.now(),
        updatedAt: r.updatedAt || Date.now()
      };
    } catch {
      return null;
    }
  },

  getByUid: async (uid: string): Promise<PersonalAIAccountRecord | null> => {
    await ensureDb();
    try {
      const r: any = await PersonalAIAccountModel.findOne({ uid } as any).lean();
      if (!r) return null;
      return {
        accountId: r.accountId,
        uid: r.uid,
        displayName: r.displayName || 'Personal AI Assistant',
        authType: r.authType || 'cookie',
        provider: r.provider || 'DongDev FCA',
        encryptedAuthState: r.encryptedAuthState,
        authStateVersion: r.authStateVersion || 1,
        status: r.status || 'DISCONNECTED',
        mqttStatus: r.mqttStatus || 'OFF',
        enabled: r.enabled ?? true,
        autoReplyEnabled: r.autoReplyEnabled ?? true,
        typingIndicatorEnabled: r.typingIndicatorEnabled ?? true,
        readReceiptsEnabled: r.readReceiptsEnabled ?? false,
        replyDelayMs: r.replyDelayMs ?? 1000,
        maxHistory: r.maxHistory ?? 20,
        aiModel: r.aiModel || 'gemma-4-26b-a4b-it',
        memorySize: r.memorySize ?? 10,
        autoSleepMode: r.autoSleepMode ?? false,
        ignoreUnknownUsers: r.ignoreUnknownUsers ?? false,
        ignoreGroupChats: r.ignoreGroupChats ?? true,
        allowOnlyPrivateInbox: r.allowOnlyPrivateInbox ?? true,
        businessHoursEnabled: r.businessHoursEnabled ?? false,
        businessHoursStart: r.businessHoursStart || '09:00',
        businessHoursEnd: r.businessHoursEnd || '22:00',
        blacklistUids: r.blacklistUids || [],
        whitelistUids: r.whitelistUids || [],
        totalConversations: r.totalConversations || 0,
        messagesReceivedToday: r.messagesReceivedToday || 0,
        messagesRepliedToday: r.messagesRepliedToday || 0,
        avgResponseTimeMs: r.avgResponseTimeMs || 0,
        contextMemoryUsage: r.contextMemoryUsage || 0,
        lastIncomingMessageTime: r.lastIncomingMessageTime || 0,
        lastOutgoingReplyTime: r.lastOutgoingReplyTime || 0,
        sessionUptime: r.sessionUptime || 0,
        reconnectCount: r.reconnectCount || 0,
        errorCount: r.errorCount || 0,
        aiRequestCount: r.aiRequestCount || 0,
        currentQueueLength: r.currentQueueLength || 0,
        liveConsoleLogs: r.liveConsoleLogs || [],
        lastValidatedAt: r.lastValidatedAt || Date.now(),
        lastConnectedAt: r.lastConnectedAt || 0,
        lastDisconnectedAt: r.lastDisconnectedAt || 0,
        lastErrorCode: r.lastErrorCode || '',
        createdAt: r.createdAt || Date.now(),
        updatedAt: r.updatedAt || Date.now()
      };
    } catch {
      return null;
    }
  },

  upsert: async (account: Partial<PersonalAIAccountRecord> & { accountId: string; uid: string; encryptedAuthState: string }): Promise<void> => {
    await ensureDb();
    try {
      const now = Date.now();
      await PersonalAIAccountModel.updateOne(
        { accountId: account.accountId },
        {
          $set: {
            uid: account.uid,
            displayName: account.displayName || `Personal AI (${account.uid})`,
            authType: account.authType || 'cookie',
            provider: account.provider || 'DongDev FCA',
            encryptedAuthState: account.encryptedAuthState,
            authStateVersion: account.authStateVersion || 1,
            status: account.status || 'DISCONNECTED',
            mqttStatus: account.mqttStatus || 'OFF',
            enabled: account.enabled ?? true,
            autoReplyEnabled: account.autoReplyEnabled ?? true,
            typingIndicatorEnabled: account.typingIndicatorEnabled ?? true,
            readReceiptsEnabled: account.readReceiptsEnabled ?? false,
            replyDelayMs: account.replyDelayMs ?? 1000,
            maxHistory: account.maxHistory ?? 20,
            aiModel: account.aiModel || 'gemma-4-26b-a4b-it',
            memorySize: account.memorySize ?? 10,
            autoSleepMode: account.autoSleepMode ?? false,
            ignoreUnknownUsers: account.ignoreUnknownUsers ?? false,
            ignoreGroupChats: account.ignoreGroupChats ?? true,
            allowOnlyPrivateInbox: account.allowOnlyPrivateInbox ?? true,
            businessHoursEnabled: account.businessHoursEnabled ?? false,
            businessHoursStart: account.businessHoursStart || '09:00',
            businessHoursEnd: account.businessHoursEnd || '22:00',
            blacklistUids: account.blacklistUids || [],
            whitelistUids: account.whitelistUids || [],
            updatedAt: now
          },
          $setOnInsert: {
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
            liveConsoleLogs: [],
            createdAt: now
          }
        },
        { upsert: true }
      );
    } catch (err) {
      console.error(`Failed to upsert Personal AI account ${account.accountId}:`, err);
    }
  },

  update: async (accountId: string, updates: Partial<PersonalAIAccountRecord>): Promise<void> => {
    await ensureDb();
    try {
      await PersonalAIAccountModel.updateOne(
        { accountId },
        { $set: { ...updates, updatedAt: Date.now() } }
      );
    } catch (err) {
      console.error(`Failed to update Personal AI account ${accountId}:`, err);
    }
  },

  delete: async (accountId: string): Promise<boolean> => {
    await ensureDb();
    try {
      const res = await PersonalAIAccountModel.deleteOne({ accountId });
      return res.deletedCount > 0;
    } catch {
      return false;
    }
  }
};

let cachedTelegramConfig: TelegramConfigRecord = {
  configId: 'primary',
  encryptedToken: '',
  adminUserIds: [],
  enabled: false,
  autoConnect: true,
  botUsername: '',
  botId: '',
  botFirstName: '',
  status: 'OFFLINE',
  receiverStatus: 'STOPPED',
  lastConnectedAt: 0,
  lastDisconnectedAt: 0,
  lastUpdateAt: 0,
  lastError: '',
  stats: {
    messagesReceived: 0,
    messagesProcessed: 0,
    messagesFailed: 0,
    commandsExecuted: 0,
    uptimeMs: 0
  }
};

export const telegramConfigData = {
  get: async (): Promise<TelegramConfigRecord> => {
    await ensureDb();
    try {
      const doc = await TelegramConfigModel.findOne({ configId: 'primary' }).lean();
      if (doc) {
        cachedTelegramConfig = {
          configId: doc.configId || 'primary',
          encryptedToken: doc.encryptedToken || '',
          adminUserIds: Array.isArray(doc.adminUserIds) ? doc.adminUserIds : [],
          enabled: Boolean(doc.enabled),
          autoConnect: doc.autoConnect !== false,
          botUsername: doc.botUsername || '',
          botId: doc.botId || '',
          botFirstName: doc.botFirstName || '',
          status: (doc.status as any) || 'OFFLINE',
          receiverStatus: (doc.receiverStatus as any) || 'STOPPED',
          lastConnectedAt: doc.lastConnectedAt || 0,
          lastDisconnectedAt: doc.lastDisconnectedAt || 0,
          lastUpdateAt: doc.lastUpdateAt || 0,
          lastError: doc.lastError || '',
          stats: {
            messagesReceived: doc.stats?.messagesReceived || 0,
            messagesProcessed: doc.stats?.messagesProcessed || 0,
            messagesFailed: doc.stats?.messagesFailed || 0,
            commandsExecuted: doc.stats?.commandsExecuted || 0,
            uptimeMs: doc.stats?.uptimeMs || 0
          }
        };
      }
    } catch (err) {
      console.warn('[Database] Telegram config load fallback:', (err as any)?.message);
    }
    return { ...cachedTelegramConfig };
  },

  save: async (updates: Partial<TelegramConfigRecord>): Promise<TelegramConfigRecord> => {
    cachedTelegramConfig = {
      ...cachedTelegramConfig,
      ...updates,
      stats: {
        ...cachedTelegramConfig.stats,
        ...(updates.stats || {})
      }
    };
    await ensureDb();
    try {
      await TelegramConfigModel.updateOne(
        { configId: 'primary' },
        { $set: { ...cachedTelegramConfig, updatedAt: Date.now() } },
        { upsert: true }
      );
    } catch (err: any) {
      console.warn('[Database] Telegram config upsert to MongoDB failed, updating fallback DB:', err?.message || err);
      try {
        executeFallback('TelegramConfig', 'updateOne', [
          { configId: 'primary' },
          { $set: { ...cachedTelegramConfig, updatedAt: Date.now() } },
          { upsert: true }
        ]);
      } catch {}
    }
    return { ...cachedTelegramConfig };
  }
};



export const fontData = {
  sansBoldUpper: '𝗔𝗕𝗖𝗗𝗘𝗙𝗚𝗛𝗜𝗝𝗞𝗟𝗠𝗡𝗢𝗣𝗤𝗥𝗦𝗧𝗨𝗩𝗪𝗫𝗬𝗭',
  sansBoldLower: '𝗮𝗯𝗰𝗱𝗲𝗳𝗴𝗵𝗶𝗷𝗸𝗹𝗺𝗻𝗼𝗽𝗾𝗿𝘀𝘁𝘂𝘃w𝘅𝘆𝘇',
  sansBoldDigits: '𝟭𝟮𝟯𝟰𝟱𝟲𝟳𝟴𝟵𝟬',
  serifBoldUpper: '𝐀𝐁𝐂𝐃𝐄𝐅𝐆𝐇𝐈𝐉𝐊𝐋𝐌𝐍𝐎𝐏𝐐𝐑𝐒𝐓𝐔𝐕𝐖𝐗𝐘𝐙',
  serifBoldLower: '𝐚𝐛𝐜𝐝𝐞𝐟𝐠𝐡𝐢𝐣𝐤𝐥𝐦𝐧𝐨𝐩𝐪𝐫𝐬𝐭𝐮𝐯𝐰𝐱𝐲𝐳',
  serifBoldDigits: '𝟏𝟐𝟑𝟒𝟓𝟔𝟕𝟖𝟗𝟎'
};
