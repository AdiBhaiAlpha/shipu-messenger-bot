import { createRequire } from 'module';
import path from 'path';
import { goatBotLoader, customRequire } from './goatBotLoader';

import {
  ShiPuCommandModule,
  ShiPuThread,
  ShiPuUser,
  UserRole,
  BotConfig,
  BotSystemStats,
  BotLog,
  ShiPuBotResponse,
  ShiPuEvent,
  ShiPuMessageReplyApi
} from '../types/shipu';
import { defaultPlugins } from './defaultPlugins';
import { contextEngine } from '../services/contextEngine';
import { MessengerAdapter, MockMessengerAdapter, FacebookMessengerAdapter } from '../adapters/messengerAdapter';
import { commandsData, usersData, threadsData, StoredCommandData } from '../db/database';
import { defaultCommandSeeds } from './commandSeeds';
import { formatBotText } from '../utils/textFormatter';
import { messengerLogger, MessengerLogger } from '../adapters/messenger/MessengerLogger';
import { multiAccountManager } from '../adapters/messenger/MultiAccountManager';
import { accountRuntimeLogManager } from '../services/AccountRuntimeLogManager';
import { parseCommand, isSelfEvent, recordBotMessageId } from '../utils/commandParser';
import { smartConversationBrain } from './smartConversationBrain';
import { brainService } from '../services/brainService';
import { aiosService } from '../services/aiosService';
import { BrainMemoryModel, BrainSuggestionModel } from '../db/firebaseDb';
import { emergencyAntiSpamGuard } from './EmergencyAntiSpamGuard';
import { performanceTracker } from '../services/performanceTracker';
import { prepareAttachments } from './attachmentUtils';
import { initialAdminBot } from '../config/database';
import { generatePingImage } from '../utils/imageUtils';
import { subscriptionService } from '../services/subscriptionService';
import { messageBus } from './bus/MessageBus';
import { IncomingMessage, OutgoingMessage } from './bus/messageTypes';

export type MessageRouteResult = 'COMMAND' | 'NORMAL_CHAT' | 'IGNORED';

export interface RouteSession {
  botUid?: string;
  accountId?: string;
}

/**
 * Authoritative single event-routing gate for all incoming events.
 * Guarantees a message is routed to exactly ONE category: COMMAND, NORMAL_CHAT, or IGNORED.
 */
export function routeIncomingMessage(
  event: { senderID?: string; senderId?: string; author?: string; messageID?: string; body?: string; threadID?: string; thread_fbid?: string; accountId?: string; isSelf?: boolean },
  session?: RouteSession,
  prefix: string = '#'
): MessageRouteResult {
  const senderID = String(event?.senderID || event?.senderId || event?.author || '').trim();
  const rawText = String(event?.body || '');
  const threadID = String(event?.threadID || event?.thread_fbid || '').trim();
  const accountId = event?.accountId || session?.accountId;
  const botUid = session?.botUid || process.env.BOT_UID || '';

  // 1. Self-Event Guard
  if (senderID && botUid && (senderID === botUid || isSelfEvent({ ...event, senderID, accountId }, botUid))) {
    return 'IGNORED';
  }

  // 2. Emergency Anti-Spam Check
  if (threadID && emergencyAntiSpamGuard.isThreadInEmergency(threadID, accountId)) {
    return 'IGNORED';
  }

  if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
    return 'IGNORED';
  }

  // 3. Strict Command Syntax Check
  const parsed = parseCommand(rawText, prefix);
  if (parsed.isCommand && parsed.commandName) {
    return 'COMMAND';
  }

  // 4. Normal Conversational Chat
  return 'NORMAL_CHAT';
}

interface PendingReply {
  messageID: string;
  threadID: string;
  senderID: string;
  commandName: string;
  expiresAt: number;
}

class ShiPuBotEngine {
  private plugins: ShiPuCommandModule[] = [];
  private customPlugins: ShiPuCommandModule[] = [];
  private users: Map<string, ShiPuUser> = new Map();
  private threads: Map<string, ShiPuThread> = new Map();
  private logs: BotLog[] = [];
  private cooldowns: Map<string, number> = new Map();
  private pendingReplies: Map<string, PendingReply> = new Map();
  private processedMessageIDs: Set<string> = new Set();
  private adapter: MessengerAdapter;
  public selfUserId: string = '';

  private isDuplicateMessage(messageID: string): boolean {
    if (!messageID || messageID.startsWith('msg_') && messageID.length < 10) return false;
    if (this.processedMessageIDs.has(messageID)) {
      return true;
    }
    this.processedMessageIDs.add(messageID);
    if (this.processedMessageIDs.size > 1000) {
      const oldest = Array.from(this.processedMessageIDs).slice(0, 200);
      for (const id of oldest) {
        this.processedMessageIDs.delete(id);
      }
    }
    return false;
  }

  private stats: BotSystemStats = {
    uptimeSeconds: 0,
    totalCommandsExecuted: 0,
    totalEventsHandled: 0,
    activeThreadsCount: 0,
    registeredUsersCount: 0,
    memoryUsageMB: 48,
    cpuLoadPercent: 2,
    status: 'ONLINE'
  };

  private config: BotConfig = {
    botName: 'ShiPu Ai🤖',
    globalPrefix: '#',
    botAdminIDs: [],
    botOwnerID: '',
    autoRestart: true,
    webhookUrl: '',
    facebookAppState: '[]',
    enableAI: true,
    maintenanceMode: false
  };

  constructor() {
    if (!(globalThis as any).shipuSessions) {
      (globalThis as any).shipuSessions = {};
    }
    this.adapter = new MockMessengerAdapter(this.config.botName);
    this.initializeEngine();
    this.loadPluginsFromDatabase();
    
    // Register Brain Services on globalThis for JS sandboxed commands
    (globalThis as any).brainService = brainService;
    (globalThis as any).BrainMemoryModel = BrainMemoryModel;
    (globalThis as any).BrainSuggestionModel = BrainSuggestionModel;
    (globalThis as any).generatePingImage = generatePingImage;

    // Connect to Unified Message Bus
    messageBus.setCoreProcessor(async (incoming: IncomingMessage) => {
      return this.processIncomingMessage(incoming);
    });
  }

  /**
   * Process a normalized IncomingMessage from the unified MessageBus.
   * Dispatches through Command Parser -> Permissions -> AI -> Memory -> Business Logic.
   */
  public async processIncomingMessage(incoming: IncomingMessage): Promise<OutgoingMessage | void> {
    if (!incoming || !incoming.chatId || !incoming.senderId) return;

    const rawEvent = {
      type: 'message',
      threadID: incoming.chatId,
      senderID: incoming.senderId,
      messageID: incoming.messageId,
      body: incoming.text,
      timestamp: incoming.timestamp,
      senderName: incoming.senderName,
      provider: incoming.provider,
      accountId: incoming.accountId,
      isTelegram: incoming.provider === 'telegram',
      isMessenger: incoming.provider === 'messenger',
      messageReply: incoming.replyToMessageId ? {
        messageID: incoming.replyToMessageId,
        senderID: '',
        body: ''
      } : undefined,
      raw: incoming.raw
    };

    const res = await this.handleIncomingEvent(
      incoming.chatId,
      incoming.senderId,
      incoming.text,
      incoming.messageId,
      undefined,
      rawEvent
    );

    if (res && res.body) {
      return {
        provider: incoming.provider,
        accountId: incoming.accountId,
        chatId: incoming.chatId,
        text: res.body,
        replyToMessageId: incoming.messageId,
        attachments: res.attachments
      };
    }
  }

  public async loadPluginsFromDatabase(): Promise<void> {
    try {
      // 1. Register Default Native ShiPu Commands
      for (const nativePlugin of defaultPlugins) {
        nativePlugin.diagnostic = this.diagnosePlugin(nativePlugin);
        goatBotLoader.registerShiPuCommand(nativePlugin, 'Native Seed');
      }

      // 2. Scan Disk Directories for GoatBot & ShiPu Command Files
      const dirsToScan = [
        path.join(process.cwd(), 'commands'),
        path.resolve('commands'),
        '/commands',
        path.join(process.cwd(), 'scripts', 'cmds'),
        path.join(process.cwd(), 'src', 'commands')
      ];

      for (const dir of dirsToScan) {
        goatBotLoader.scanDirectoryAndLoad(dir);
      }

      // 3. Seed & Load Database Commands
      await commandsData.seedDefaultsIfEmpty(defaultCommandSeeds);
      const storedCmds = await commandsData.getAll();

      for (const item of storedCmds) {
        if (item.code && item.code.trim().length > 10) {
          const { module } = goatBotLoader.loadCommandFromCode(item.code, `${item.name}.js`);
          const existing = goatBotLoader.getRegisteredCommands().get(module.config.name);
          // If no file command exists or database has explicitly defined custom code, set it
          if (!existing) {
            goatBotLoader.getRegisteredCommands().set(module.config.name, module);
          }
        }
      }

      this.plugins = Array.from(goatBotLoader.getRegisteredCommands().values());
      for (const plugin of this.plugins) {
        plugin.diagnostic = this.diagnosePlugin(plugin);
      }

      const report = goatBotLoader.generateReport();
      this.addLog('info', `Dual Command Loader initialized: ${report.shiPuCount} ShiPu Native, ${report.goatBotCount} GoatBot CommonJS (${report.totalLoaded} Total)`, 'DualCommandLoader');
      if (report.conflicts.length > 0) {
        this.addLog('warn', `Command conflicts detected: ${report.conflicts.join('; ')}`, 'DualCommandLoader');
      }
    } catch (err: any) {
      this.addLog('error', `Failed in Dual Command Loader: ${err.message}. Falling back to defaults.`, 'DualCommandLoader');
      this.plugins = [...defaultPlugins];
    }
  }

  public async reloadPluginsFromDatabase(): Promise<void> {
    await this.loadPluginsFromDatabase();
    this.addLog('info', '⚡ Hot-reloaded all commands from Database live!', 'EngineHotReload');
  }

  private diagnosePlugin(plugin: ShiPuCommandModule): { status: 'valid' | 'invalid'; error?: string } {
    try {
      if (!plugin.config || !plugin.config.name) {
        return { status: 'invalid', error: 'Missing plugin config or name' };
      }
      if (typeof plugin.onStart !== 'function') {
        return { status: 'invalid', error: 'Missing onStart function' };
      }
      return { status: 'valid' };
    } catch (err: any) {
      return { status: 'invalid', error: err.message };
    }
  }

  private initializeEngine() {
    // Seed default command plugins
    this.plugins = [...defaultPlugins];

    this.users.clear();
    this.threads.clear();

    // Default Seed Users
    const defaultOwner: ShiPuUser = {
      userID: '10001',
      name: 'ShiPu Admin (Owner)',
      role: 3,
      exp: 2850,
      level: 25,
      money: 500000,
      bankMoney: 2000000,
      isBanned: false
    };

    const defaultBotAdmin: ShiPuUser = {
      userID: '10002',
      name: 'Alex (Bot Admin)',
      role: 2,
      exp: 1200,
      level: 12,
      money: 100000,
      bankMoney: 500000,
      isBanned: false
    };

    const defaultMember: ShiPuUser = {
      userID: '10003',
      name: 'Sam (Group Member)',
      role: 0,
      exp: 150,
      level: 2,
      money: 5000,
      bankMoney: 20000,
      isBanned: false
    };

    [defaultOwner, defaultBotAdmin, defaultMember].forEach(u => {
      this.users.set(u.userID, u);
      usersData.set(u.userID, u);
    });

    // Default Seed Threads
    const defaultThread1: ShiPuThread = {
      threadID: 'thread_101',
      name: '🤖 ShiPu Ai Official Lounge',
      prefix: '#',
      language: 'en',
      timezone: 'Asia/Dhaka',
      members: [defaultOwner, defaultBotAdmin, defaultMember],
      adminIDs: ['10001'],
      autoWelcome: true,
      welcomeMessage: 'Welcome to ShiPu Ai🤖 Official Group {name}!',
      goodbyeMessage: 'Goodbye!',
      antiSpam: true,
      antiLink: false,
      aiEnabled: true,
      economyEnabled: true,
      isBanned: false,
      createdAt: Date.now()
    };

    const defaultThread2: ShiPuThread = {
      threadID: 'thread_102',
      name: '🎮 Gaming & Economy Circle',
      prefix: '!',
      language: 'en',
      timezone: 'Asia/Dhaka',
      members: [defaultOwner, defaultBotAdmin, defaultMember],
      adminIDs: ['10001'],
      autoWelcome: true,
      welcomeMessage: 'Welcome to Gaming Circle {name}!',
      goodbyeMessage: 'Goodbye!',
      antiSpam: true,
      antiLink: false,
      aiEnabled: true,
      economyEnabled: true,
      isBanned: false,
      createdAt: Date.now()
    };

    [defaultThread1, defaultThread2].forEach(t => {
      this.threads.set(t.threadID, t);
      threadsData.set(t.threadID, t);
    });

    this.updateStats();
    this.addLog('info', 'ShiPu Ai🤖 Core Engine initialized with default runtime state.', 'CoreEngine');
  }

  // --- GETTERS & PUBLIC METHODS ---

  public getPlugins(): ShiPuCommandModule[] {
    return [...this.plugins, ...this.customPlugins];
  }

  public clearCooldowns(): void {
    this.cooldowns.clear();
  }

  public async hotReloadEngine(): Promise<{ reloadedCommands: number; timestamp: string }> {
    this.cooldowns.clear();
    await this.reloadPluginsFromDatabase();
    this.updateStats();
    const totalCount = this.plugins.length + this.customPlugins.length;
    this.addLog('info', `⚡ Hot-reloaded ShiPu Ai Engine (${totalCount} commands/plugins active)`, 'EngineHotReload');
    return {
      reloadedCommands: totalCount,
      timestamp: new Date().toISOString()
    };
  }

  public getBotConfig(): BotConfig {
    return { ...this.config };
  }

  public updateBotConfig(newConfig: Partial<BotConfig>) {
    this.config = { ...this.config, ...newConfig };
    this.addLog('info', 'Bot Configuration updated.', 'Settings');
  }

  public getPrefix(): string {
    return '#';
  }

  public getStats(): BotSystemStats {
    this.updateStats();
    return { ...this.stats };
  }

  public getLogs(): BotLog[] {
    return [...this.logs];
  }

  public addLog(level: BotLog['level'], message: string, source: string = 'Engine') {
    const newLog: BotLog = {
      id: Math.random().toString(36).substring(2, 9),
      timestamp: new Date().toLocaleTimeString(),
      level,
      message,
      source
    };
    this.logs.unshift(newLog);
    if (this.logs.length > 300) this.logs.pop();
  }

  public clearLogs() {
    this.logs = [];
    this.addLog('info', 'Terminal logs cleared by user.', 'Admin');
  }

  public setAdapter(adapter: MessengerAdapter) {
    this.adapter = adapter;
    this.addLog('info', 'Messenger adapter linked to BotEngine.', 'System');
  }

  public getThreads(): ShiPuThread[] {
    return Array.from(this.threads.values());
  }

  public getThread(threadID: string): ShiPuThread | undefined {
    return this.threads.get(threadID);
  }

  public createNewThread(name: string, prefix: string = '#'): ShiPuThread {
    const threadID = `thread_${Date.now()}`;
    const newThread: ShiPuThread = {
      threadID,
      name,
      prefix,
      language: 'en',
      timezone: 'Asia/Dhaka',
      members: [],
      adminIDs: [],
      autoWelcome: true,
      welcomeMessage: 'Welcome to the group {name}!',
      goodbyeMessage: 'Goodbye {name}!',
      antiSpam: true,
      antiLink: false,
      aiEnabled: true,
      economyEnabled: true,
      isBanned: false,
      createdAt: Date.now()
    };
    this.threads.set(threadID, newThread);
    this.updateStats();
    return newThread;
  }

  public getUsers(): ShiPuUser[] {
    return Array.from(this.users.values());
  }

  public getUser(userID: string): ShiPuUser | undefined {
    return this.users.get(userID);
  }

  public setUserData(userID: string, updates: Partial<ShiPuUser>): ShiPuUser {
    const existing = this.users.get(userID) || {
      userID,
      name: `User_${userID}`,
      role: 0 as UserRole,
      exp: 0,
      level: 1,
      money: 0,
      bankMoney: 0,
      isBanned: false
    };
    const updated = { ...existing, ...updates };
    this.users.set(userID, updated);
    this.updateStats();

    // Async sync to MongoDB UserModel
    import('../db/firebaseDb').then(({ UserModel }) => {
      (UserModel as any).updateOne({ userID }, { $set: updated }, { upsert: true }).catch(() => {});
    }).catch(() => {});

    return updated;
  }

  public togglePlugin(name: string, enabled?: boolean): boolean {
    const plugin = this.plugins.find(p => p.config.name.toLowerCase() === name.toLowerCase());
    if (!plugin) return false;
    plugin.config.enabled = enabled !== undefined ? enabled : !plugin.config.enabled;
    this.addLog('info', `Plugin "${name}" ${plugin.config.enabled ? 'enabled' : 'disabled'}.`, 'PluginManager');
    return plugin.config.enabled;
  }

  public registerCustomPlugin(plugin: ShiPuCommandModule) {
    this.customPlugins.push(plugin);
    this.addLog('info', `Registered custom plugin: ${plugin.config.name}`, 'PluginManager');
  }

  // --- CORE EVENT DISPATCHER & COMMAND PARSER ---

  public async handleIncomingEvent(
    threadID: string,
    senderID: string,
    rawText: string,
    messageID: string = `msg_${Date.now()}`,
    accountId?: string,
    rawEvent?: any
  ): Promise<ShiPuBotResponse> {
    const traceId = rawEvent?._traceId || `evt_trace_${messageID}_${Math.random().toString(36).substring(2, 7)}`;
    console.log(`[PIPELINE TRACE][STAGE 4: BOT_ENGINE_ENTRY][ID: ${traceId}] BotEngine.handleIncomingEvent invoked. Thread: ${threadID}, Sender: ${senderID}, MessageID: ${messageID}`);

    if (this.isDuplicateMessage(messageID)) {
      console.log(`[PIPELINE TRACE][STAGE 4: BOT_ENGINE_ENTRY][ID: ${traceId}] Duplicate messageID "${messageID}" detected. Skipping execution.`);
      return {
        messageID,
        threadID,
        body: '',
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    const isTelegram = Boolean((rawEvent as any)?.isTelegram);
    const accountMeta = (accountId ? multiAccountManager.getAccountMeta(accountId) : null) || multiAccountManager.getDefaultAccountMeta();
    const botUid = (rawEvent as any)?.botUid || accountMeta?.uid || (accountMeta?.botUserID && accountMeta?.botUserID !== '—' ? accountMeta?.botUserID : '') || this.selfUserId || process.env.BOT_UID || '1000889201982';

    if (botUid && !isTelegram) {
      this.selfUserId = botUid;
    }

    const targetAdapter = (rawEvent as any)?.targetAdapter || (accountId ? multiAccountManager.getAdapterForAccount(accountId) : this.adapter);

    const thread = await this.getOrCreateThread(threadID);
    const user = this.getOrCreateUser(senderID);

    // Auto-initialize Economy Profile via Centralized Economy Service
    try {
      const { economyService } = await import('../services/economyService');
      const acc = await economyService.getAccount(senderID, user?.name);
      if (acc && user) {
        user.money = acc.money;
        user.bankMoney = acc.bankMoney;
      }
    } catch (err) {
      console.warn('[botEngine] Error initializing financial profile:', err);
    }

    // Ensure incoming user is registered as a member in currentThread
    if (thread && user) {
      if (!Array.isArray(thread.members)) thread.members = [];
      const existingIdx = thread.members.findIndex((m: any) => m.userID === user.userID);
      if (existingIdx === -1) {
        thread.members.push({ ...user });
      } else {
        thread.members[existingIdx] = { ...thread.members[existingIdx], ...user };
      }
    }

    const prefix = thread.prefix || this.config.globalPrefix;

    // Call Central Event-Routing Gate
    const route = routeIncomingMessage(
      { senderID, messageID, body: rawText, threadID, accountId },
      { botUid, accountId },
      prefix
    );
    console.log(`[PIPELINE TRACE][STAGE 5: ROUTER_DECISION][ID: ${traceId}] Message routed as: ${route}`);

    if (accountId) {
      accountRuntimeLogManager.addLog(accountId, {
        level: route === 'COMMAND' ? 'INFO' : 'INFO',
        category: route === 'COMMAND' ? 'COMMAND' : 'EVENTS',
        message: `Event received on thread [${threadID}] from [${senderID}]: "${rawText.substring(0, 50)}${rawText.length > 50 ? '...' : ''}"`,
        details: { threadID, senderID, messageID, route, textLength: rawText.length },
        threadID,
        senderUID: senderID,
        messageID,
        sourceModule: 'BotEngineRouter'
      });
    }

    if (route === 'IGNORED') {
      messengerLogger.info('COMMAND', '[ROUTER] Message route: IGNORED');
      return {
        messageID,
        threadID,
        body: '',
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    // Record incoming message in contextEngine for reply chain tracking
    contextEngine.recordMessage({
      messageID,
      threadID,
      senderID,
      body: rawText,
      replyToMessageID: rawEvent?.messageReply?.messageID || rawEvent?.message_reply?.messageID || rawEvent?.replyTo?.messageID || null,
      isBotMessage: false
    }).catch(() => {});

    // Passive conversation observer: learn trigger-reply patterns and factual insights in the background
    brainService.observeConversation(
      threadID,
      senderID,
      rawText,
      rawEvent || { threadID, senderID, body: rawText, messageID, messageReply: rawEvent?.messageReply || rawEvent?.message_reply },
      accountId
    ).catch(err => {
      console.error('[PassiveLearning] observeConversation background error:', err.message);
    });

    if (user.isBanned) {
      messengerLogger.warn('AUTH', `User ${MessengerLogger.maskUid(senderID)} is banned`);
      return {
        messageID,
        threadID,
        body: '⛔ You are currently banned from using ShiPu Ai🤖.',
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    if (thread.isBanned) {
      messengerLogger.warn('AUTH', `Thread ${MessengerLogger.maskUid(threadID)} is banned`);
      return {
        messageID,
        threadID,
        body: '⛔ This group thread is banned from ShiPu Ai🤖.',
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    // ROUTE 1: NORMAL CHAT ROUTE
    if (route === 'NORMAL_CHAT') {

      // Check if user has an active persistent AI session
      const shipuSessions = (globalThis as any).shipuSessions || {};
      let activeSession = shipuSessions[senderID];
      if (!activeSession || !activeSession.active) {
        try {
          const { AIOSSessionModel } = await import('../db/firebaseDb');
          const dbSession = await (AIOSSessionModel as any).findOne({ userID: senderID, status: 'active' });
          if (dbSession && new Date(dbSession.expiresAt) > new Date()) {
            activeSession = { active: true };
          }
        } catch (e) {}
      }

      if (activeSession && activeSession.active) {
        messengerLogger.info('COMMAND', `[AIOS] User ${senderID} has an active persistent AI session. Intercepting in onChat hook.`);
        const allPlugins = this.getPlugins();
        const shipuPlugin = allPlugins.find(p => p.config.name === 'shipu');
        if (shipuPlugin && typeof shipuPlugin.onChat === 'function') {
          try {
            await shipuPlugin.onChat({
              message: {
                reply: async (textOrObj: any, attachments?: any) => {
                  let text = typeof textOrObj === 'string' ? textOrObj : (textOrObj?.body || '');
                  let att = attachments || (typeof textOrObj === 'object' ? (textOrObj?.attachment || textOrObj?.attachments) : undefined);
                  return targetAdapter.sendMessage(threadID, text, att);
                },
                send: async (textOrObj: any, tID?: string, attachments?: any) => {
                  let targetThread = (typeof tID === 'string' && tID) ? tID : threadID;
                  let text = typeof textOrObj === 'string' ? textOrObj : (textOrObj?.body || '');
                  let att = attachments || (typeof textOrObj === 'object' ? (textOrObj?.attachment || textOrObj?.attachments) : undefined);
                  return targetAdapter.sendMessage(targetThread, text, att);
                },
                react: (emoji: string) => targetAdapter.react(messageID, emoji),
                reaction: (emoji: string) => targetAdapter.react(messageID, emoji),
                kick: (uID: string) => targetAdapter.removeUser(threadID, uID)
              },
              args: [],
              event: { type: 'message', threadID, senderID, body: rawText, messageID, accountId, args: [], prefixUsed: prefix, timestamp: Date.now() },
              threadID,
              senderID,
              botUid,
              currentUser: user,
              currentThread: thread,
              usersData: {
                get: async (uID: string, field?: string) => {
                  const u = this.getOrCreateUser(uID);
                  return field ? (u as any)[field] : u;
                },
                set: (uID: string, data: Partial<ShiPuUser>) => {
                  const u = this.getOrCreateUser(uID);
                  Object.assign(u, data);
                  this.setUserData(uID, u);
                },
                increment: (uID: string, field: 'money' | 'bankMoney' | 'exp', amount: number) => {
                  const u = this.getOrCreateUser(uID);
                  u[field] = (u[field] || 0) + amount;
                  this.setUserData(uID, u);
                }
              },
              threadsData: {
                get: async (tID: string, field?: string) => {
                  const t = await this.getOrCreateThread(tID);
                  return field ? (t as any)[field] : t;
                },
                set: async (tID: string, data: Partial<ShiPuThread>) => {
                  const t = await this.getOrCreateThread(tID);
                  Object.assign(t, data);
                  this.threads.set(tID, t);
                }
              },
              api: targetAdapter
            } as any);
          } catch (err: any) {
            console.error(`[Plugin onChat Error] in shipu persistent session:`, err.message);
          }
        }
        return {
          messageID,
          threadID,
          body: '',
          timestamp: Date.now(),
          senderName: this.config.botName
        };
      }

      // Execute onChat hooks for all plugins (GoatBot onChat / handleEvent / onMessage)
      const allPlugins = this.getPlugins();
      for (const p of allPlugins) {
        if (p.config.enabled !== false && typeof p.onChat === 'function') {
          try {
            await p.onChat({
              message: {
                reply: async (textOrObj: any, attachments?: any) => {
                  let text = typeof textOrObj === 'string' ? textOrObj : (textOrObj?.body || '');
                  let att = attachments || (typeof textOrObj === 'object' ? (textOrObj?.attachment || textOrObj?.attachments) : undefined);
                  return targetAdapter.sendMessage(threadID, text, att);
                },
                send: async (textOrObj: any, tID?: string, attachments?: any) => {
                  let targetThread = (typeof tID === 'string' && tID) ? tID : threadID;
                  let text = typeof textOrObj === 'string' ? textOrObj : (textOrObj?.body || '');
                  let att = attachments || (typeof textOrObj === 'object' ? (textOrObj?.attachment || textOrObj?.attachments) : undefined);
                  return targetAdapter.sendMessage(targetThread, text, att);
                },
                react: (emoji: string) => targetAdapter.react(messageID, emoji),
                reaction: (emoji: string) => targetAdapter.react(messageID, emoji),
                kick: (uID: string) => targetAdapter.removeUser(threadID, uID)
              },
              args: [],
              event: { type: 'message', threadID, senderID, body: rawText, messageID, args: [], prefixUsed: prefix, timestamp: Date.now() },
              threadID,
              senderID,
              botUid,
              currentUser: user,
              currentThread: thread,
              usersData: {
                get: async (uID: string, field?: string) => {
                  const u = this.getOrCreateUser(uID);
                  return field ? (u as any)[field] : u;
                },
                set: (uID: string, data: Partial<ShiPuUser>) => {
                  const u = this.getOrCreateUser(uID);
                  Object.assign(u, data);
                  this.setUserData(uID, u);
                },
                increment: (uID: string, field: 'money' | 'bankMoney' | 'exp', amount: number) => {
                  const u = this.getOrCreateUser(uID);
                  u[field] = (u[field] || 0) + amount;
                  this.setUserData(uID, u);
                }
              },
              threadsData: {
                get: async (tID: string, field?: string) => {
                  const t = await this.getOrCreateThread(tID);
                  return field ? (t as any)[field] : t;
                },
                set: async (tID: string, data: Partial<ShiPuThread>) => {
                  const t = await this.getOrCreateThread(tID);
                  Object.assign(t, data);
                  this.threads.set(tID, t);
                }
              },
              api: targetAdapter
            });
          } catch (err: any) {
            console.error(`[Plugin onChat Error] in ${p.config.name}:`, err.message);
          }
        }
      }

      messengerLogger.info('COMMAND', '[COMMAND] NOT EXECUTED - Normal chat message routed to Smart Conversation Brain');

      // 1. Check if user has an active AIOS Session
      if (this.config.enableAI && thread.aiEnabled) {
        try {
          const eventObj = rawEvent || { type: 'message', threadID, senderID, body: rawText, messageID };
          const aiosReply = await aiosService.processUserMessage(senderID, threadID, rawText, accountId, eventObj);
          if (aiosReply) {
            const parts = aiosReply.split('|||SPLIT_MSG|||').map(p => p.trim()).filter(Boolean);
            let lastSentRes: any = null;
            for (const part of parts) {
              lastSentRes = await targetAdapter.sendMessage(threadID, part);
              if (parts.length > 1) {
                await new Promise(resolve => setTimeout(resolve, 500));
              }
            }
            const resMsgId = lastSentRes?.messageID || `msg_aios_${Date.now()}`;
            recordBotMessageId(resMsgId);
            return {
              messageID: resMsgId,
              threadID,
              body: parts[parts.length - 1] || aiosReply,
              timestamp: Date.now(),
              senderName: this.config.botName
            };
          }
        } catch (err: any) {
          console.error('[AIOS Router Error]:', err.message);
        }
      }

      // 2. Fallback to local General Brain fuzzy-matching (no LLM)
      if (this.config.enableAI && thread.aiEnabled) {
        const brainRes = smartConversationBrain.processMessage({
          text: rawText,
          threadID,
          senderID,
          prefix,
          botUid,
          botName: this.config.botName
        });

        if (brainRes.shouldReply && brainRes.replyText) {
          const sentRes = await targetAdapter.sendMessage(threadID, brainRes.replyText);
          const resMsgId = sentRes?.messageID || `msg_ai_${Date.now()}`;
          recordBotMessageId(resMsgId);
          return {
            messageID: resMsgId,
            threadID,
            body: brainRes.replyText,
            timestamp: Date.now(),
            senderName: this.config.botName
          };
        }

        // If user mentions bot name but no session is active, guide them
        const botNameLower = this.config.botName.toLowerCase().replace(/🤖/g, '').trim();
        const textLower = rawText.toLowerCase();
        if (textLower.includes(botNameLower) || textLower.includes('shipu') || textLower.includes('aipus')) {
          const guideMsg = `💡 **SHIPU AIOS টিপস!**\n` +
            `আপনি আমাকে ম্যানশন করেছেন, কিন্তু কোনো চ্যাট সেশন চালু নেই। বটের সাথে সরাসরি অবিরত এআই কথপোকথন শুরু করতে লিখুন: **#shipu on**\n` +
            `অথবা উপলব্ধ কমান্ডসমূহ দেখতে টাইপ করুন: **#help**`;
          const sentRes = await targetAdapter.sendMessage(threadID, guideMsg);
          const resMsgId = sentRes?.messageID || `msg_guide_${Date.now()}`;
          recordBotMessageId(resMsgId);
          return {
            messageID: resMsgId,
            threadID,
            body: guideMsg,
            timestamp: Date.now(),
            senderName: this.config.botName
          };
        }
      }

      return {
        messageID,
        threadID,
        body: '',
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    // ROUTE 2: COMMAND ROUTE
    messengerLogger.resetPipeline();
    messengerLogger.info('COMMAND', '[ROUTER] Message route: COMMAND');
    messengerLogger.updatePipelineStage('mqtt_receive', 'success', 'MQTT event received');

    messengerLogger.info('MESSAGE', 'New command message received', {
      senderID,
      threadID,
      messageID,
      body: rawText,
      attachments: 0
    });
    messengerLogger.updatePipelineStage('event_parse', 'success', `Parsed text payload`);
    messengerLogger.updatePipelineStage('sender_id', 'success', MessengerLogger.maskUid(senderID));
    messengerLogger.updatePipelineStage('thread_id', 'success', MessengerLogger.maskUid(threadID));
    messengerLogger.updatePipelineStage('msg_norm', 'success', 'Normalized ShiPuEvent');

    this.stats.totalEventsHandled++;
    messengerLogger.info('ENGINE', 'Dispatching command to BotEngine');
    messengerLogger.updatePipelineStage('bot_dispatch', 'success', 'BotEngine command handler engaged');

    const parsed = parseCommand(rawText, prefix);
    const commandName = parsed.commandName || '';
    const commandArgs = parsed.args;

    console.log(`[PIPELINE TRACE][STAGE 6: PARSER][ID: ${traceId}] Parsed command: "${commandName}" with ${commandArgs.length} args: [${commandArgs.join(', ')}]`);
    console.log(`[PIPELINE TRACE][STAGE 7: EXECUTOR][ID: ${traceId}] Executing handler for command: "${commandName}"`);

    messengerLogger.info('COMMAND', '[COMMAND] Prefix detected at message start');
    messengerLogger.info('COMMAND', `[COMMAND] Command: ${commandName}`);
    messengerLogger.info('COMMAND', `[COMMAND] Arguments: ${commandArgs.length > 0 ? commandArgs.join(' ') : 'none'}`);
    messengerLogger.info('COMMAND', `[COMMAND] Executing: ${commandName}`);

    const event: ShiPuEvent = {
      type: 'message',
      threadID,
      senderID,
      messageID,
      body: rawText,
      args: commandArgs,
      prefixUsed: prefix,
      timestamp: Date.now(),
      ...(rawEvent || {})
    };

    const capturedReplies: string[] = [];
    const replyApi: ShiPuMessageReplyApi = {
      reply: async (textOrObj: any, attachments?: any) => {
        let text = typeof textOrObj === 'string' ? textOrObj : (textOrObj?.body || String(textOrObj || ''));
        let att = attachments || (typeof textOrObj === 'object' ? (textOrObj?.attachment || textOrObj?.attachments) : undefined);
        if (text) text = formatBotText(text);
        if (text) capturedReplies.push(text);
        const preparedAtt = await prepareAttachments(att);
        try {
          console.log(`[PIPELINE TRACE][STAGE 8: REPLY_DELIVERY][ID: ${traceId}] Sending reply to thread ${threadID}. Body snippet: "${text.substring(0, 40)}"`);
          const res = await targetAdapter.sendMessage(threadID, text, preparedAtt);
          if (res?.messageID) {
            console.log(`[PIPELINE TRACE][STAGE 8: REPLY_DELIVERY][ID: ${traceId}] Reply delivered successfully. Sent MessageID: ${res.messageID}`);
            recordBotMessageId(res.messageID);
            contextEngine.recordMessage({
              messageID: res.messageID,
              threadID: res.threadID || threadID,
              senderID: this.selfUserId || process.env.BOT_UID || '1000889201982',
              senderName: this.config.botName || 'ShiPu Ai🤖',
              body: text,
              replyToMessageID: messageID || null,
              isBotMessage: true
            }).catch(() => {});
          }
          return res;
        } catch (err: any) {
          messengerLogger.warn('REPLY', `reply warning: ${err?.message || err}`);
          const fallbackRes = { messageID: `msg_fallback_${Date.now()}`, threadID, body: text, timestamp: Date.now(), senderName: this.config.botName };
          return fallbackRes;
        }
      },
      send: async (textOrObj: any, tID?: string, attachments?: any) => {
        let text = typeof textOrObj === 'string' ? textOrObj : (textOrObj?.body || String(textOrObj || ''));
        let att = attachments || (typeof textOrObj === 'object' ? (textOrObj?.attachment || textOrObj?.attachments) : undefined);
        if (text) text = formatBotText(text);
        if (text) capturedReplies.push(text);
        const targetThread = tID || threadID;
        const preparedAtt = await prepareAttachments(att);
        try {
          const res = await targetAdapter.sendMessage(targetThread, text, preparedAtt);
          if (res?.messageID) {
            recordBotMessageId(res.messageID);
            contextEngine.recordMessage({
              messageID: res.messageID,
              threadID: targetThread,
              senderID: this.selfUserId || process.env.BOT_UID || '1000889201982',
              senderName: this.config.botName || 'ShiPu Ai🤖',
              body: text,
              replyToMessageID: messageID || null,
              isBotMessage: true
            }).catch(() => {});
          }
          return res;
        } catch (err: any) {
          messengerLogger.warn('SEND', `send warning: ${err?.message || err}`);
          const fallbackRes = { messageID: `msg_fallback_${Date.now()}`, threadID: targetThread, body: text, timestamp: Date.now(), senderName: this.config.botName };
          return fallbackRes;
        }
      },
      react: async (emoji: string) => {
        return targetAdapter.react(messageID, emoji);
      },
      reaction: async (emoji: string) => {
        return targetAdapter.react(messageID, emoji);
      },
      kick: async (uID: string) => {
        return targetAdapter.removeUser(threadID, uID);
      }
    };

    const accountConn = accountId ? multiAccountManager.getAccountConnection(accountId) : multiAccountManager.getAccountConnection();
    const realFcaApi = accountConn?.getFcaApi() || (targetAdapter as any)?.session?.getFcaApi?.() || null;

    const baseApi = realFcaApi || {};
    const apiFacade: any = Object.create(baseApi);

    for (const key of Object.keys(baseApi)) {
      if (typeof baseApi[key] === 'function') {
        apiFacade[key] = baseApi[key].bind(baseApi);
      } else {
        apiFacade[key] = baseApi[key];
      }
    }

    apiFacade.getBotConfig = () => this.getBotConfig();
    if (!apiFacade.getCurrentUserID) {
      apiFacade.getCurrentUserID = () => botUid || this.selfUserId;
    }

    if (realFcaApi && typeof realFcaApi.sendMessage === 'function') {
      apiFacade.sendMessage = async (msg: any, tID?: string, cb?: any) => {
        let text = typeof msg === 'string' ? msg : (msg?.body || String(msg));
        if (text) text = formatBotText(text);
        if (text) capturedReplies.push(text);
        const targetThread = tID || threadID;
        const rawAtt = typeof msg === 'object' ? (msg.attachment || msg.attachments) : undefined;
        const preparedAtt = await prepareAttachments(rawAtt);
        const msgToSend = typeof msg === 'string' ? text : { ...msg, body: text, attachment: preparedAtt };
        if (preparedAtt && typeof msgToSend === 'object') {
          delete (msgToSend as any).attachments;
        }

        return new Promise((resolve) => {
          realFcaApi.sendMessage(msgToSend, targetThread, (err: any, info: any) => {
            if (err) {
              const errDetail = err?.error || err?.message || String(err);
              messengerLogger.warn('SEND', `realFcaApi.sendMessage warning: ${errDetail}`);
              const fallbackInfo = { messageID: info?.messageID || `msg_sim_${Date.now()}`, threadID: targetThread };
              if (typeof cb === 'function') cb(null, fallbackInfo);
              return resolve(fallbackInfo);
            }
            if (!err && info?.messageID) {
              recordBotMessageId(info.messageID);
            }
            if (typeof cb === 'function') {
              cb(err, info);
            }
            resolve(info);
          });
        });
      };
    } else {
      apiFacade.sendMessage = async (msg: any, tID?: string, cb?: any) => {
        let text = typeof msg === 'string' ? msg : (msg?.body || String(msg));
        if (text) text = formatBotText(text);
        if (text) capturedReplies.push(text);
        const targetThread = tID || threadID;
        const rawAtt = typeof msg === 'object' ? (msg.attachment || msg.attachments) : undefined;
        const preparedAtt = await prepareAttachments(rawAtt);
        try {
          const res = await targetAdapter.sendMessage(targetThread, text, preparedAtt);
          if (res?.messageID) {
            recordBotMessageId(res.messageID);
          }
          const info = { messageID: res?.messageID || `msg_${Date.now()}`, threadID: targetThread, timestamp: res?.timestamp || Date.now() };
          if (typeof cb === 'function') cb(null, info);
          return info;
        } catch (err: any) {
          if (typeof cb === 'function') cb(err, null);
          throw err;
        }
      };
    }

    const ctx = {
      message: replyApi,
      args: commandArgs,
      event,
      threadID,
      senderID,
      accountId,
      botUid,
      currentUser: user,
      currentThread: thread,
      usersData: {
        get: async (uID: string, field?: string) => {
          const u = this.getOrCreateUser(uID);
          return field ? (u as any)[field] : u;
        },
        set: (uID: string, data: Partial<ShiPuUser>) => {
          const u = this.getOrCreateUser(uID);
          Object.assign(u, data);
          this.setUserData(uID, u);
        },
        increment: (uID: string, field: 'money' | 'bankMoney' | 'exp', amount: number) => {
          const u = this.getOrCreateUser(uID);
          u[field] = (u[field] || 0) + amount;
          this.setUserData(uID, u);
        }
      },
      threadsData: {
        get: async (tID: string, field?: string) => {
          const t = await this.getOrCreateThread(tID);
          return field ? (t as any)[field] : t;
        },
        set: async (tID: string, data: Partial<ShiPuThread>) => {
          const t = await this.getOrCreateThread(tID);
          Object.assign(t, data);
          this.threads.set(tID, t);
        }
      },
      api: apiFacade,
      getLang: (key: string) => {
        const langs: any = {
          needAdmin: '❌ I need group administrator privileges to perform this action.',
          notAdmin: '❌ Permission Denied: Only group administrators can use this command.',
          targetNotFound: '❌ User not found in this group.'
        };
        return langs[key] || key;
      }
    };

    if (!(replyApi as any).SyntaxError) {
      (replyApi as any).SyntaxError = () => {
        return replyApi.reply(`❌ Invalid Usage! Correct syntax: ${prefix}${commandName} ${plugin.config.guide || ''}`);
      };
    }

    const plugin = this.findPlugin(commandName);

    if (!plugin) {
      performanceTracker.recordUnknownCommand(commandName, { userId: senderID, groupId: threadID });
      messengerLogger.warn('COMMAND', `Unknown command "${commandName}" called`);
      messengerLogger.updatePipelineStage('cmd_router', 'failed', `Unknown command ${commandName}`);
      this.addLog('warn', `Unknown command "${commandName}" called in ${thread.name}`, 'CommandRouter');
      const notFoundMsg = `❌ Command "${commandName}" not found. Type ${prefix}help for available commands.`;
      if (realFcaApi) {
        await replyApi.reply(notFoundMsg);
      }
      return {
        messageID,
        threadID,
        body: notFoundMsg,
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    messengerLogger.success('COMMAND', `Command matched: ${commandName}`);
    messengerLogger.updatePipelineStage('cmd_router', 'success', `Matched command: /${commandName}`);

    if (plugin.config.enabled === false) {
      messengerLogger.warn('COMMAND', `Command "${commandName}" is disabled`);
      const disabledMsg = `⚠️ Command "${commandName}" is currently disabled by administrator.`;
      if (realFcaApi) {
        await replyApi.reply(disabledMsg);
      }
      return {
        messageID,
        threadID,
        body: disabledMsg,
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    if (user.role < plugin.config.role) {
      messengerLogger.warn('COMMAND', `Permission denied for command "${commandName}"`);
      const rolesMap = ['Normal User', 'Group Admin', 'Bot Admin', 'Bot Owner'];
      const deniedMsg = `🔒 Permission Denied! This command requires [${rolesMap[plugin.config.role]}] role or higher.`;
      if (realFcaApi) {
        await replyApi.reply(deniedMsg);
      }
      return {
        messageID,
        threadID,
        body: deniedMsg,
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    // SUBSCRIPTION ECONOMY ROUTER GUARD
    try {
      const subCheck = await subscriptionService.checkSubscription(senderID, user?.name);

      if (subCheck.notificationMessage) {
        replyApi.reply(subCheck.notificationMessage).catch(() => {});
      }

      if (subCheck.status === 'LIMITED' || subCheck.status === 'SUSPENDED') {
        const cmdLower = commandName.toLowerCase();
        const allowedLimitedCommands = new Set([
          'rent', 'payrent', 'autorenew', 'balance', 'bal', 'money', 'wallet',
          'daily', 'work', 'deposit', 'withdraw', 'bank', 'topbal', 'help',
          'support', 'info', 'ping', 'uptime', 'shipu', 'ai', 'ask', 'resetai', 'memory'
        ]);

        if (!allowedLimitedCommands.has(cmdLower)) {
          messengerLogger.warn('SUBSCRIPTION', `User ${senderID} in ${subCheck.status} mode blocked from command "${commandName}"`);
          const renewalMsg =
            `🔒 **SUBSCRIPTION EXPIRED / LIMITED MODE**\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `Your bot subscription or 7-day free trial has expired!\n` +
            `📊 **Current Status:** ${subCheck.status}\n` +
            `💰 **Weekly Rent:** 1,000 Coins / week\n` +
            `💵 **Your Wallet:** ${subCheck.walletBalance.toLocaleString()} Coins | Bank: ${subCheck.bankBalance.toLocaleString()} Coins\n` +
            `─────────────────────\n` +
            `⚠️ All premium bot commands are locked until subscription is renewed.\n` +
            `👉 Run \`#payrent 1\` to renew your subscription for 1 week (1,000 Coins).\n` +
            `👉 Run \`#rent\` to check your full subscription details.`;

          if (realFcaApi) {
            await replyApi.reply(renewalMsg);
          }

          return {
            messageID,
            threadID,
            body: renewalMsg,
            timestamp: Date.now(),
            senderName: this.config.botName
          };
        }
      }
    } catch (subErr: any) {
      messengerLogger.warn('SUBSCRIPTION', `Subscription check error: ${subErr?.message}`);
    }

    const cooldownKey = `${senderID}_${plugin.config.name}`;
    const now = Date.now();
    const lastExecution = this.cooldowns.get(cooldownKey) || 0;
    const cooldownMs = (plugin.config.countDown || 2) * 1000;

    if (now - lastExecution < cooldownMs) {
      const remainingSecs = Math.ceil((cooldownMs - (now - lastExecution)) / 1000);
      const cooldownMsg = `⏳ Please wait ${remainingSecs}s before using ${plugin.config.name} again.`;
      if (realFcaApi) {
        await replyApi.reply(cooldownMsg);
      }
      return {
        messageID,
        threadID,
        body: cooldownMsg,
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }

    this.cooldowns.set(cooldownKey, now);
    this.stats.totalCommandsExecuted++;

    const startTime = performance.now();
    try {
      messengerLogger.info('COMMAND', `Executing ${plugin.config.name}`);
      const result = await plugin.onStart(ctx);
      const executionTimeMs = Math.max(1, Math.round((performance.now() - startTime) * 100) / 100);

      performanceTracker.recordCommandExecution(
        plugin.config.name,
        plugin.config.category || 'General',
        executionTimeMs,
        true,
        { userId: senderID, groupId: threadID, args: commandArgs }
      );

      messengerLogger.updatePipelineStage('handler_comp', 'success', `Plugin ${plugin.config.name} completed (${executionTimeMs}ms)`);
      
      let finalBody = '';
      if (result && typeof result === 'object' && result.body) {
        finalBody = result.body;
        if (capturedReplies.length === 0 && realFcaApi) {
          await replyApi.reply(finalBody);
        }
      } else if (capturedReplies.length > 0) {
        finalBody = capturedReplies.join('\n\n');
      }

      messengerLogger.updatePipelineStage('resp_gen', 'success', 'Bot response body formatted');

      const logEntry = {
        command: plugin.config.name,
        userId: senderID,
        groupId: threadID,
        arguments: commandArgs,
        timestamp: new Date().toISOString(),
        success: true,
        durationMs: executionTimeMs
      };
      this.addLog('command', JSON.stringify(logEntry), 'CommandEngine');

      const resMsgId = `res_${Date.now()}`;
      recordBotMessageId(resMsgId);

      const safeToSend = emergencyAntiSpamGuard.recordOutgoingMessage(threadID, finalBody, resMsgId, accountId);
      if (!safeToSend) {
        messengerLogger.warn('SAFETY', '[SAFETY] Blocking further outgoing messages for this thread');
        return {
          messageID: 'blocked_by_safety',
          threadID,
          body: '',
          timestamp: Date.now(),
          senderName: this.config.botName
        };
      }

      return {
        messageID: resMsgId,
        threadID,
        body: finalBody,
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    } catch (err: any) {
      const executionTimeMs = Math.max(1, Math.round((performance.now() - startTime) * 100) / 100);

      performanceTracker.recordCommandExecution(
        plugin.config.name,
        plugin.config.category || 'General',
        executionTimeMs,
        false,
        { userId: senderID, groupId: threadID, args: commandArgs, error: err.message }
      );

      messengerLogger.error('ERROR', `Command execution failed: ${err.message}`);
      messengerLogger.updatePipelineStage('handler_comp', 'failed', err.message);

      const logEntry = {
        command: plugin.config.name,
        userId: senderID,
        groupId: threadID,
        arguments: commandArgs,
        timestamp: new Date().toISOString(),
        success: false,
        error: err.message,
        durationMs: executionTimeMs
      };
      this.addLog('error', JSON.stringify(logEntry), 'PluginExecution');

      return {
        messageID,
        threadID,
        body: `💥 Command execution failed:\n${err.message}`,
        timestamp: Date.now(),
        senderName: this.config.botName
      };
    }
  }

  private findPlugin(name: string): ShiPuCommandModule | undefined {
    const cleanName = name.toLowerCase().trim();
    return this.getPlugins().find(p => {
      const matchName = p.config.name.toLowerCase() === cleanName;
      const matchAlias = p.config.aliases?.some(a => a.toLowerCase() === cleanName);
      return matchName || matchAlias;
    });
  }

  public async getOrCreateThread(threadID: string): Promise<ShiPuThread> {
    let thread = this.threads.get(threadID);
    if (!thread) {
      thread = {
        threadID,
        name: `Messenger Thread ${threadID.slice(-4)}`,
        prefix: '#',
        language: 'en',
        timezone: 'Asia/Dhaka',
        members: [],
        adminIDs: [],
        autoWelcome: true,
        welcomeMessage: 'Welcome to the group!',
        goodbyeMessage: 'Goodbye!',
        antiSpam: true,
        antiLink: false,
        aiEnabled: true,
        economyEnabled: true,
        isBanned: false,
        createdAt: Date.now()
      };
      this.threads.set(threadID, thread);
      this.updateStats();
    }

    const now = Date.now();
    const isStub = !thread.adminIDs || thread.adminIDs.length === 0;
    const isStale = thread.initializedAt && (now - thread.initializedAt > 5 * 60 * 1000); // 5 mins stale

    const activeAdapter = multiAccountManager.getAdapterForAccount() || this.adapter;
    if ((isStub || isStale) && activeAdapter && typeof activeAdapter.getThreadInfo === 'function') {
      try {
        const info = await activeAdapter.getThreadInfo(threadID);
        if (info) {
          Object.assign(thread, info);
          thread.initializedAt = now;
          this.threads.set(threadID, thread);
        }
      } catch (err) {
        // Silent fail
      }
    }

    return thread;
  }

  private getOrCreateUser(userID: string): ShiPuUser {
    let user = this.users.get(userID);
    const isOwner = userID === '61579127085437' || userID === '100081330372098' || initialAdminBot.includes(userID);
    if (!user) {
      user = {
        userID,
        name: isOwner ? 'ShiPu Admin (Owner)' : `User_${userID}`,
        role: isOwner ? 3 : 0,
        exp: isOwner ? 2850 : 0,
        level: isOwner ? 25 : 1,
        money: isOwner ? 500000 : 0,
        bankMoney: isOwner ? 2000000 : 0,
        isBanned: false
      };
      this.users.set(userID, user);
      this.updateStats();

      // Async sync to MongoDB UserModel
      import('../db/firebaseDb').then(({ UserModel }) => {
        (UserModel as any).updateOne({ userID }, { $setOnInsert: user }, { upsert: true }).catch(() => {});
      }).catch(() => {});
    } else if (isOwner && user.role !== 3) {
      user.role = 3;
    }
    return user;
  }

  private updateStats() {
    this.stats.activeThreadsCount = this.threads.size;
    this.stats.registeredUsersCount = this.users.size;
    if (typeof process !== 'undefined' && process.uptime) {
      this.stats.uptimeSeconds = Math.floor(process.uptime());
      const mem = process.memoryUsage();
      if (mem && mem.heapUsed) {
        this.stats.memoryUsageMB = Math.round(mem.heapUsed / 1024 / 1024);
      }
    }
  }
}

export const botEngine = new ShiPuBotEngine();
