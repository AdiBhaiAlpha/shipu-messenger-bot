import { FCAFallbackManager } from './fca/FCAFallbackManager';
import { FCAConnection } from './fca/FCAProvider';
import { messengerLogger, MessengerLogger } from './MessengerLogger';
import { ErrorClassifier } from './ErrorClassifier';
import { personalAIAccountsData, PersonalAIAccountRecord } from '../../db/database';
import { decryptAuthState, encryptAuthState } from '../../utils/crypto';
import { coerceAppState } from './fca/normalizeAppState';
import { isSelfEvent } from '../../utils/commandParser';
import { contextEngine } from '../../services/contextEngine';
import { GoogleGenAI } from '@google/genai';

export interface PersonalSafeAccountMeta {
  accountId: string;
  uid: string;
  displayName: string;
  authType: 'cookie' | 'oauth';
  provider: string;
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
  connectedAt?: string;
  lastValidatedAt?: string;
  lastErrorCode?: string;
  activeProviderName: string;
  liveConsoleLogs: Array<{ id: string; timestamp: number; type: string; message: string }>;
}

export class PersonalAccountConnection {
  public accountId: string;
  public uid: string;
  public displayName: string;
  public authType: 'cookie' | 'oauth';
  public provider: string;
  public encryptedAuthState: string;
  public authStateVersion: number;
  public status: string = 'DISCONNECTED';
  public mqttStatus: string = 'OFF';
  public enabled = true;
  public sessionState = { status: 'DISCONNECTED', authenticated: false };

  // Configurable options
  public autoReplyEnabled = true;
  public typingIndicatorEnabled = true;
  public readReceiptsEnabled = false;
  public replyDelayMs = 1000;
  public maxHistory = 20;
  public aiModel = 'gemma-4-26b-a4b-it';
  public memorySize = 10;
  public autoSleepMode = false;
  public ignoreUnknownUsers = false;
  public ignoreGroupChats = true;
  public allowOnlyPrivateInbox = true;
  public businessHoursEnabled = false;
  public businessHoursStart = '09:00';
  public businessHoursEnd = '22:00';
  public blacklistUids: string[] = [];
  public whitelistUids: string[] = [];

  // Stats & State
  public totalConversations = 0;
  public messagesReceivedToday = 0;
  public messagesRepliedToday = 0;
  public avgResponseTimeMs = 0;
  public contextMemoryUsage = 0;
  public lastIncomingMessageTime = 0;
  public lastOutgoingReplyTime = 0;
  public sessionUptime = 0;
  public reconnectCount = 0;
  public errorCount = 0;
  public aiRequestCount = 0;
  public currentQueueLength = 0;
  public liveConsoleLogs: Array<{ id: string; timestamp: number; type: string; message: string }> = [];

  private connectedAt?: number;
  private lastValidatedAt?: number;
  private lastErrorCode?: string;
  private maxReconnectAttempts = 15;
  private baseDelayMs = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private fcaConnection: FCAConnection | null = null;
  private stopListenerFunc: (() => void) | null = null;
  private activeProviderName = 'DongDev FCA';
  private fallbackManager = new FCAFallbackManager();

  private statusListeners: ((meta: PersonalSafeAccountMeta) => void)[] = [];

  constructor(record: PersonalAIAccountRecord) {
    this.accountId = record.accountId;
    this.uid = record.uid;
    this.displayName = record.displayName || `Personal AI (${MessengerLogger.maskUid(record.uid)})`;
    this.authType = record.authType || 'cookie';
    this.provider = record.provider || 'DongDev FCA';
    this.encryptedAuthState = record.encryptedAuthState;
    this.authStateVersion = record.authStateVersion || 1;
    this.status = record.status || 'DISCONNECTED';
    this.mqttStatus = record.mqttStatus || 'OFF';
    this.enabled = record.enabled ?? true;

    this.autoReplyEnabled = record.autoReplyEnabled ?? true;
    this.typingIndicatorEnabled = record.typingIndicatorEnabled ?? true;
    this.readReceiptsEnabled = record.readReceiptsEnabled ?? false;
    this.replyDelayMs = record.replyDelayMs ?? 1000;
    this.maxHistory = record.maxHistory ?? 20;
    this.aiModel = record.aiModel || 'gemma-4-26b-a4b-it';
    this.memorySize = record.memorySize ?? 10;
    this.autoSleepMode = record.autoSleepMode ?? false;
    this.ignoreUnknownUsers = record.ignoreUnknownUsers ?? false;
    this.ignoreGroupChats = record.ignoreGroupChats ?? true;
    this.allowOnlyPrivateInbox = record.allowOnlyPrivateInbox ?? true;
    this.businessHoursEnabled = record.businessHoursEnabled ?? false;
    this.businessHoursStart = record.businessHoursStart || '09:00';
    this.businessHoursEnd = record.businessHoursEnd || '22:00';
    this.blacklistUids = record.blacklistUids || [];
    this.whitelistUids = record.whitelistUids || [];

    this.totalConversations = record.totalConversations || 0;
    this.messagesReceivedToday = record.messagesReceivedToday || 0;
    this.messagesRepliedToday = record.messagesRepliedToday || 0;
    this.avgResponseTimeMs = record.avgResponseTimeMs || 0;
    this.contextMemoryUsage = record.contextMemoryUsage || 0;
    this.lastIncomingMessageTime = record.lastIncomingMessageTime || 0;
    this.lastOutgoingReplyTime = record.lastOutgoingReplyTime || 0;
    this.reconnectCount = record.reconnectCount || 0;
    this.errorCount = record.errorCount || 0;
    this.aiRequestCount = record.aiRequestCount || 0;
    this.currentQueueLength = record.currentQueueLength || 0;
    this.liveConsoleLogs = record.liveConsoleLogs || [];
    this.lastValidatedAt = record.lastValidatedAt || Date.now();
  }

  public addConsoleLog(type: string, message: string) {
    const logItem = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      timestamp: Date.now(),
      type: type.toUpperCase(),
      message
    };
    this.liveConsoleLogs.unshift(logItem);
    if (this.liveConsoleLogs.length > 150) {
      this.liveConsoleLogs = this.liveConsoleLogs.slice(0, 150);
    }

    // Persist async to MongoDB
    personalAIAccountsData.update(this.accountId, {
      liveConsoleLogs: this.liveConsoleLogs
    }).catch(() => {});
  }

  public registerStatusListener(cb: (meta: PersonalSafeAccountMeta) => void) {
    this.statusListeners.push(cb);
  }

  public getSafeMetadata(): PersonalSafeAccountMeta {
    return {
      accountId: this.accountId,
      uid: MessengerLogger.maskUid(this.uid),
      displayName: this.displayName,
      authType: this.authType,
      provider: this.provider,
      status: this.status,
      mqttStatus: this.mqttStatus,
      enabled: this.enabled,
      autoReplyEnabled: this.autoReplyEnabled,
      typingIndicatorEnabled: this.typingIndicatorEnabled,
      readReceiptsEnabled: this.readReceiptsEnabled,
      replyDelayMs: this.replyDelayMs,
      maxHistory: this.maxHistory,
      aiModel: this.aiModel,
      memorySize: this.memorySize,
      autoSleepMode: this.autoSleepMode,
      ignoreUnknownUsers: this.ignoreUnknownUsers,
      ignoreGroupChats: this.ignoreGroupChats,
      allowOnlyPrivateInbox: this.allowOnlyPrivateInbox,
      businessHoursEnabled: this.businessHoursEnabled,
      businessHoursStart: this.businessHoursStart,
      businessHoursEnd: this.businessHoursEnd,
      blacklistUids: this.blacklistUids,
      whitelistUids: this.whitelistUids,
      totalConversations: this.totalConversations,
      messagesReceivedToday: this.messagesReceivedToday,
      messagesRepliedToday: this.messagesRepliedToday,
      avgResponseTimeMs: this.avgResponseTimeMs,
      contextMemoryUsage: this.contextMemoryUsage,
      lastIncomingMessageTime: this.lastIncomingMessageTime,
      lastOutgoingReplyTime: this.lastOutgoingReplyTime,
      sessionUptime: this.connectedAt ? Math.floor((Date.now() - this.connectedAt) / 1000) : 0,
      reconnectCount: this.reconnectCount,
      errorCount: this.errorCount,
      aiRequestCount: this.aiRequestCount,
      currentQueueLength: this.currentQueueLength,
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : undefined,
      lastValidatedAt: this.lastValidatedAt ? new Date(this.lastValidatedAt).toISOString() : undefined,
      lastErrorCode: this.lastErrorCode,
      activeProviderName: this.activeProviderName,
      liveConsoleLogs: this.liveConsoleLogs.slice(0, 50)
    };
  }

  private emitStatusChange() {
    const meta = this.getSafeMetadata();
    for (const listener of this.statusListeners) {
      try {
        listener(meta);
      } catch {}
    }

    personalAIAccountsData.update(this.accountId, {
      status: this.status,
      mqttStatus: this.mqttStatus,
      reconnectCount: this.reconnectCount,
      lastValidatedAt: this.lastValidatedAt,
      lastConnectedAt: this.connectedAt,
      lastErrorCode: this.lastErrorCode || '',
      totalConversations: this.totalConversations,
      messagesReceivedToday: this.messagesReceivedToday,
      messagesRepliedToday: this.messagesRepliedToday,
      avgResponseTimeMs: this.avgResponseTimeMs,
      contextMemoryUsage: this.contextMemoryUsage,
      lastIncomingMessageTime: this.lastIncomingMessageTime,
      lastOutgoingReplyTime: this.lastOutgoingReplyTime,
      errorCount: this.errorCount,
      aiRequestCount: this.aiRequestCount,
      currentQueueLength: this.currentQueueLength
    }).catch(() => {});
  }

  public async connect(): Promise<boolean> {
    if (!this.enabled) {
      this.addConsoleLog('WARN', `Account is disabled. Skipping connection.`);
      return false;
    }

    if (this.fcaConnection && (this.mqttStatus === 'EVENT_STREAM_ACTIVE' || this.mqttStatus === 'LISTENING')) {
      this.addConsoleLog('AUTH', `[AUTH] Reusing existing authenticated session for Personal AI account [${this.accountId}]. Skipping re-login (NO-OP).`);
      return true;
    }

    this.addConsoleLog('AUTH', `Authentication started for Personal AI account [${this.accountId}]`);
    this.status = 'AUTHENTICATING';
    this.mqttStatus = 'CONNECTING';
    this.emitStatusChange();

    const authState = decryptAuthState(this.encryptedAuthState);
    if (!authState) {
      this.status = 'AUTH_EXPIRED';
      this.mqttStatus = 'OFF';
      this.lastErrorCode = 'DECRYPTION_FAILED';
      this.errorCount++;
      this.addConsoleLog('ERROR', `Authentication failed: Decryption failed for auth state.`);
      this.emitStatusChange();
      return false;
    }

    const authResult = await this.fallbackManager.authenticate(coerceAppState(authState));
    if (!authResult.connection) {
      this.status = 'AUTH_EXPIRED';
      this.mqttStatus = 'OFF';
      this.lastErrorCode = authResult.failureCategory || 'AUTH_FAILED';
      this.errorCount++;
      this.addConsoleLog('ERROR', `Authentication failed: ${authResult.failureReason}`);
      this.emitStatusChange();
      return false;
    }

    this.fcaConnection = authResult.connection;
    this.activeProviderName = authResult.activeProviderName || this.provider;
    this.status = 'AUTHENTICATED';
    this.lastValidatedAt = Date.now();
    this.addConsoleLog('SUCCESS', `Authentication success via ${this.activeProviderName}. UID: ${this.uid}`);

    this.status = 'CONNECTING';
    this.mqttStatus = 'WAITING_FOR_FIRST_EVENT';
    this.connectedAt = Date.now();
    this.reconnectCount = 0;
    this.emitStatusChange();

    return this.startMqttListener();
  }

  private startMqttListener(): boolean {
    const api = this.fcaConnection?.api;
    if (!api || !api.listenMqtt) {
      this.status = 'TEMPORARY_ERROR';
      this.mqttStatus = 'ERROR';
      this.lastErrorCode = 'MISSING_LISTEN_MQTT';
      this.errorCount++;
      this.addConsoleLog('ERROR', `MQTT listener initialization failed: listenMqtt missing.`);
      this.emitStatusChange();
      return false;
    }

    if (this.stopListenerFunc) {
      try {
        this.stopListenerFunc();
      } catch {}
      this.stopListenerFunc = null;
    }

    try {
      this.addConsoleLog('MQTT', `Establishing isolated MQTT event stream listener...`);

      if (typeof api.setOptions === 'function') {
        api.setOptions({
          listenEvents: true,
          selfListen: true,
          autoReconnect: false,
          logLevel: 'silent',
          updatePresence: false
        });
      }

      const listenReturn = api.listenMqtt((err: any, event: any) => {
        const isAuthEvent = event && (event.type === 'account_inactive' || event.type === 'auth_error' || event.type === 'login_blocked' || event.type === 'stop_listen' || event.error);
        const activeErr = err || (isAuthEvent ? (event.error || event.reason || event) : null);

        if (activeErr) {
          const classified = ErrorClassifier.classify(activeErr);
          this.lastErrorCode = classified.code;
          this.errorCount++;
          this.addConsoleLog('WARN', `MQTT connection lost: ${classified.reason}`);

          if (!classified.isTemporary) {
            this.addConsoleLog('ERROR', `Hard authentication error during MQTT session: ${classified.reason}`);
            this.status = classified.code === 'CHECKPOINT' ? 'CHECKPOINT' : 'REAUTH_REQUIRED';
            this.mqttStatus = 'OFF';
            this.sessionState.status = 'AUTH_INVALID';
            this.sessionState.authenticated = false;
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
            if (typeof this.stopListenerFunc === 'function') {
              try {
                this.stopListenerFunc();
              } catch {}
              this.stopListenerFunc = null;
            }
            this.emitStatusChange();
            return;
          }

          this.status = 'TEMPORARY_ERROR';
          this.mqttStatus = 'DISCONNECTED';
          this.emitStatusChange();
          this.scheduleMqttReconnect();
          return;
        }

        if (event) {
          const senderID = String(event.senderID || event.senderId || event.author || '').trim();
          if (senderID && senderID === this.uid) {
            return; // skip self messages
          }
          if (isSelfEvent(event, this.uid)) {
            return;
          }

          if (this.mqttStatus !== 'EVENT_STREAM_ACTIVE') {
            this.addConsoleLog('MQTT', `MQTT connected & event stream active.`);
            this.addConsoleLog('SESSION', `Personal AI account is ONLINE and listening for inbox messages.`);
          }

          this.status = 'CONNECTED';
          this.mqttStatus = 'EVENT_STREAM_ACTIVE';
          this.lastIncomingMessageTime = Date.now();
          this.messagesReceivedToday++;
          this.emitStatusChange();

          // Handle incoming message as Personal AI Assistant (bypassing normal group command router)
          if (event.type === 'message' || event.type === 'message_reply' || event.body) {
            this.handlePersonalAiIncomingMessage(api, event).catch(e => {
              console.error(`[Personal AI ${this.accountId}] Error processing incoming message:`, e);
              this.addConsoleLog('ERROR', `Message processing error: ${e.message}`);
            });
          }
        }
      });

      // listenMqtt returns an emitter object (stopListening / stopListeningAsync),
      // NOT a stop function. Storing it raw meant every teardown call threw
      // "not a function" into an empty catch and the old subscription stayed
      // open, stacking a duplicate MQTT consumer on each reconnect.
      let stoppedLocally = false;
      this.stopListenerFunc = () => {
        if (stoppedLocally) return;
        stoppedLocally = true;
        const ret: any = listenReturn;
        if (typeof ret === 'function') {
          try { ret(); } catch {}
          return;
        }
        if (typeof api.stopListeningAsync === 'function') {
          try {
            const p = api.stopListeningAsync();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
          return;
        }
        if (typeof api.stopListening === 'function') {
          try { api.stopListening(() => {}); } catch {}
          return;
        }
        if (ret && typeof ret.stopListeningAsync === 'function') {
          try {
            const p = ret.stopListeningAsync();
            if (p && typeof p.catch === 'function') p.catch(() => {});
          } catch {}
        }
      };

      this.status = 'MQTT_LISTENING';
      this.mqttStatus = 'LISTENING';
      this.addConsoleLog('SUCCESS', `MQTT connected and listening for messages.`);
      this.emitStatusChange();
      return true;
    } catch (mqttErr: any) {
      this.errorCount++;
      const classified = ErrorClassifier.classify(mqttErr);
      this.lastErrorCode = classified.code;
      this.addConsoleLog('ERROR', `MQTT listener error: ${classified.reason}`);

      if (!classified.isTemporary) {
        this.addConsoleLog('ERROR', `Terminal authentication error: ${classified.reason}`);
        this.status = classified.code === 'CHECKPOINT' ? 'CHECKPOINT' : 'REAUTH_REQUIRED';
        this.mqttStatus = 'OFF';
        this.sessionState.status = 'AUTH_INVALID';
        this.sessionState.authenticated = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        if (typeof this.stopListenerFunc === 'function') {
          try {
            this.stopListenerFunc();
          } catch {}
          this.stopListenerFunc = null;
        }
        this.emitStatusChange();
        return false;
      }

      this.status = 'TEMPORARY_ERROR';
      this.mqttStatus = 'ERROR';
      this.emitStatusChange();
      this.scheduleMqttReconnect();
      return false;
    }
  }

  private async handlePersonalAiIncomingMessage(api: any, event: any) {
    const threadID = String(event.threadID || event.thread_fbid || '');
    const senderID = String(event.senderID || event.senderId || event.author || '').trim();
    const body = String(event.body || '').trim();
    const messageID = String(event.messageID || event.messageId || `msg_${Date.now()}`);

    if (!threadID || !body) return;

    this.addConsoleLog('INCOMING', `Incoming message from sender ${senderID} in thread ${threadID}: "${body.substring(0, 60)}..."`);

    // Check filters
    if (this.autoSleepMode) {
      this.addConsoleLog('INFO', `Auto sleep mode is active. Ignoring message.`);
      return;
    }
    if (!this.autoReplyEnabled) {
      this.addConsoleLog('INFO', `Auto replies disabled for this Personal AI account.`);
      return;
    }

    // Check if group chat and ignoreGroupChats is true
    const isGroup = threadID !== senderID;
    if (isGroup && this.ignoreGroupChats) {
      this.addConsoleLog('INFO', `Ignoring group chat message (Private inbox only mode).`);
      return;
    }

    if (this.allowOnlyPrivateInbox && isGroup) {
      this.addConsoleLog('INFO', `Ignoring non-private inbox message.`);
      return;
    }

    // Blacklist check
    if (this.blacklistUids.includes(senderID)) {
      this.addConsoleLog('INFO', `Sender ${senderID} is blacklisted. Ignored.`);
      return;
    }

    // Whitelist check if whitelist is configured
    if (this.whitelistUids.length > 0 && !this.whitelistUids.includes(senderID)) {
      this.addConsoleLog('INFO', `Sender ${senderID} is not in whitelist. Ignored.`);
      return;
    }

    this.addConsoleLog('SENDER', `Sender detected: ${senderID}. Loading conversation context...`);

    // Mark as read if enabled
    if (this.readReceiptsEnabled && api.markAsRead) {
      try {
        api.markAsRead(threadID, () => {});
        this.addConsoleLog('SEEN', `Read receipt updated for thread ${threadID}`);
      } catch {}
    }

    // Typing indicator
    if (this.typingIndicatorEnabled && api.sendTypingIndicator) {
      try {
        api.sendTypingIndicator(threadID, () => {});
      } catch {}
    }

    const startTime = Date.now();
    this.currentQueueLength++;
    this.aiRequestCount++;

    try {
      this.addConsoleLog('CONTEXT', `Loading User Memory, Thread Memory, and Context Intelligence Engine...`);
      
      // Record message in ContextEngine
      await contextEngine.recordMessage({
        messageID,
        threadID,
        senderID,
        body,
        isBotMessage: false,
        timestamp: Date.now()
      });

      // Build context
      const contextResult = await contextEngine.buildComprehensiveContext({
        userID: senderID,
        threadID,
        rawText: body,
        eventObj: event
      });

      this.addConsoleLog('MEMORY', `User memory & long-term context loaded successfully.`);
      this.addConsoleLog('PROMPT', `Prompt assembled with AI model (${this.aiModel}). Sending to LLM...`);

      // Generate AI response using GoogleGenAI SDK
      const apiKey = process.env.GEMINI_API_KEY || '';
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY environment variable is missing.');
      }

      const ai = new GoogleGenAI({ apiKey });
      const modelName = this.aiModel || 'gemma-4-26b-a4b-it';

      const systemInstruction = `You are a dedicated personal AI assistant powered by ShiPu AI. You behave like a warm, highly intelligent, helpful, and polite human assistant. You are chatting directly with user ${senderID} on Facebook Messenger. 
Context details:
${contextResult.systemPrompt}
User Memory: ${contextResult.userMemoryContext}
Thread Memory: ${contextResult.threadMemoryContext}

Respond naturally, concisely, and intelligently to the user's message without any technical prefixes or commands.`;

      const contents = [
        ...(contextResult.history || []),
        { role: 'user', parts: [{ text: body }] }
      ];

      this.addConsoleLog('LLM', `LLM request started with model ${modelName}`);

      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: {
          systemInstruction,
          temperature: 0.7,
          maxOutputTokens: 1000
        }
      });

      const replyText = response.text || "Hello! I received your message and I'm here to help as your personal AI assistant.";
      this.addConsoleLog('LLM', `LLM response received successfully.`);

      // Simulate reply delay if configured
      if (this.replyDelayMs > 0) {
        await new Promise(res => setTimeout(res, this.replyDelayMs));
      }

      this.addConsoleLog('REPLY', `Sending AI reply to thread ${threadID}: "${replyText.substring(0, 60)}..."`);

      await new Promise((resolve, reject) => {
        api.sendMessage({ body: replyText }, threadID, (err: any, info: any) => {
          if (err) reject(err);
          else resolve(info);
        });
      });

      const duration = Date.now() - startTime;
      this.messagesRepliedToday++;
      this.lastOutgoingReplyTime = Date.now();
      this.totalConversations++;

      // Update avg response time
      this.avgResponseTimeMs = Math.round((this.avgResponseTimeMs * (this.messagesRepliedToday - 1) + duration) / this.messagesRepliedToday);
      this.currentQueueLength = Math.max(0, this.currentQueueLength - 1);

      this.addConsoleLog('SUCCESS', `Message successfully sent and seen updated in ${duration}ms.`);
      this.emitStatusChange();
    } catch (aiErr: any) {
      this.currentQueueLength = Math.max(0, this.currentQueueLength - 1);
      this.errorCount++;
      this.addConsoleLog('ERROR', `AI generation or dispatch error: ${aiErr.message}`);
      this.emitStatusChange();

      // Fallback response
      try {
        api.sendMessage({ body: "I'm currently processing your request. Give me a moment to review!" }, threadID, () => {});
      } catch {}
    }
  }

  private scheduleMqttReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (
      !this.sessionState.authenticated ||
      this.sessionState.status === 'AUTH_INVALID' ||
      this.status === 'REAUTH_REQUIRED' ||
      this.status === 'COOKIE_EXPIRED' ||
      this.status === 'CHECKPOINT' ||
      !this.enabled
    ) {
      this.addConsoleLog('WARN', `Account is in terminal state (${this.status}). Skipping MQTT reconnect.`);
      return;
    }

    this.reconnectCount += 1;
    if (this.reconnectCount > this.maxReconnectAttempts) {
      this.addConsoleLog('ERROR', `Exceeded maximum MQTT reconnect attempts (${this.maxReconnectAttempts}).`);
      return;
    }

    const delay = Math.min(this.baseDelayMs * Math.pow(1.5, this.reconnectCount - 1), 300000);
    this.addConsoleLog('MQTT', `Scheduling reconnect attempt #${this.reconnectCount} in ${Math.round(delay / 1000)}s...`);

    this.reconnectTimer = setTimeout(() => {
      this.startMqttListener();
    }, delay);
  }

  public async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stopListenerFunc) {
      try {
        this.stopListenerFunc();
      } catch {}
      this.stopListenerFunc = null;
    }

    // Deliberately no api.logout() here: logout revokes the session on
    // Facebook's servers and invalidates the stored cookies, so a plain
    // disconnect must only tear down the transport. Use adminLogout() to
    // actually end the session.

    this.fcaConnection = null;
    this.status = 'DISCONNECTED';
    this.mqttStatus = 'OFF';
    this.addConsoleLog('SESSION', `Personal AI account disconnected cleanly.`);
    this.emitStatusChange();
  }

  public async updateAuthState(newAuthState: any): Promise<void> {
    const encrypted = encryptAuthState(newAuthState);
    this.encryptedAuthState = encrypted;
    this.authStateVersion += 1;
    await personalAIAccountsData.update(this.accountId, {
      encryptedAuthState: encrypted,
      authStateVersion: this.authStateVersion,
      lastValidatedAt: Date.now()
    });
    this.addConsoleLog('AUTH', `Auth state updated successfully (v${this.authStateVersion})`);
  }

  public async updateSettings(newSettings: Partial<PersonalAIAccountRecord>): Promise<void> {
    if (newSettings.autoReplyEnabled !== undefined) this.autoReplyEnabled = newSettings.autoReplyEnabled;
    if (newSettings.typingIndicatorEnabled !== undefined) this.typingIndicatorEnabled = newSettings.typingIndicatorEnabled;
    if (newSettings.readReceiptsEnabled !== undefined) this.readReceiptsEnabled = newSettings.readReceiptsEnabled;
    if (newSettings.replyDelayMs !== undefined) this.replyDelayMs = newSettings.replyDelayMs;
    if (newSettings.maxHistory !== undefined) this.maxHistory = newSettings.maxHistory;
    if (newSettings.aiModel !== undefined) this.aiModel = newSettings.aiModel;
    if (newSettings.memorySize !== undefined) this.memorySize = newSettings.memorySize;
    if (newSettings.autoSleepMode !== undefined) this.autoSleepMode = newSettings.autoSleepMode;
    if (newSettings.ignoreUnknownUsers !== undefined) this.ignoreUnknownUsers = newSettings.ignoreUnknownUsers;
    if (newSettings.ignoreGroupChats !== undefined) this.ignoreGroupChats = newSettings.ignoreGroupChats;
    if (newSettings.allowOnlyPrivateInbox !== undefined) this.allowOnlyPrivateInbox = newSettings.allowOnlyPrivateInbox;
    if (newSettings.businessHoursEnabled !== undefined) this.businessHoursEnabled = newSettings.businessHoursEnabled;
    if (newSettings.businessHoursStart !== undefined) this.businessHoursStart = newSettings.businessHoursStart;
    if (newSettings.businessHoursEnd !== undefined) this.businessHoursEnd = newSettings.businessHoursEnd;
    if (newSettings.blacklistUids !== undefined) this.blacklistUids = newSettings.blacklistUids;
    if (newSettings.whitelistUids !== undefined) this.whitelistUids = newSettings.whitelistUids;
    if (newSettings.enabled !== undefined) this.enabled = newSettings.enabled;

    await personalAIAccountsData.update(this.accountId, newSettings);
    this.addConsoleLog('CONFIG', `Account settings updated successfully.`);
    this.emitStatusChange();
  }

  public getFcaApi(): any {
    return this.fcaConnection?.api || null;
  }

  public getActiveProviderName(): string {
    return this.activeProviderName || this.provider || 'DongDev FCA';
  }
}
