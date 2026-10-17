import { TelegramTransport } from './TelegramTransport';
import { TelegramAdapter } from '../../adapters/telegramAdapter';
import { telegramLogger } from './TelegramLogger';
import { telegramConfigData } from '../../db/database';
import { encrypt, decrypt } from '../../utils/crypto';
import {
  TelegramConnectionStatus,
  TelegramReceiverStatus,
  TelegramStats,
  TelegramStatusResponse,
  TelegramUpdate,
  TelegramMessage,
  TelegramUser,
  TelegramChat
} from '../../types/telegram';
import { botEngine } from '../../core/botEngine';
import { aiAutoReplyEngine } from '../aiAutoReplyEngine';
import { emotionEngine } from '../emotionEngine';
import { selfLearning } from '../selfLearning';
import { behaviourObserver } from '../behaviourObserver';
import { UserRole } from '../../types/shipu';

export type TelegramErrorCode =
  | 'CONFIG_MISSING'
  | 'TOKEN_INVALID'
  | 'TELEGRAM_API_UNREACHABLE'
  | 'TELEGRAM_API_ERROR'
  | 'BOT_VALIDATION_FAILED'
  | 'RECEIVER_START_FAILED'
  | 'DATABASE_LOAD_FAILED'
  | 'DATABASE_SAVE_FAILED';

export interface TelegramValidationResult {
  success: boolean;
  bot?: TelegramUser;
  error?: string;
  code?: TelegramErrorCode;
}

export class TelegramBotManager {
  private static instance: TelegramBotManager;

  private transport: TelegramTransport | null = null;
  private adapter: TelegramAdapter | null = null;

  private token: string = '';
  private adminUserIds: string[] = [];
  private enabled: boolean = false;
  private autoConnect: boolean = true;

  private botUsername: string = '';
  private botId: string = '';
  private botFirstName: string = '';

  private status: TelegramConnectionStatus = 'OFFLINE';
  private receiverStatus: TelegramReceiverStatus = 'STOPPED';

  private lastConnectedAt: number = 0;
  private lastDisconnectedAt: number = 0;
  private lastUpdateAt: number = 0;
  private lastSuccessfulValidation: number = 0;
  private lastError: string = '';

  private stats: TelegramStats = {
    messagesReceived: 0,
    messagesProcessed: 0,
    messagesFailed: 0,
    commandsExecuted: 0,
    uptimeMs: 0
  };

  private isPolling: boolean = false;
  private isStarting: boolean = false;
  private isStopping: boolean = false;
  private pollAbortController: AbortController | null = null;
  private pollOffset: number = 0;
  private networkRetryCount: number = 0;
  private startTimestamp: number = 0;

  private customUpdateHandler: ((update: TelegramUpdate) => Promise<void>) | null = null;

  private constructor() {}

  public static getInstance(): TelegramBotManager {
    if (!TelegramBotManager.instance) {
      TelegramBotManager.instance = new TelegramBotManager();
    }
    return TelegramBotManager.instance;
  }

  public getAdapter(): TelegramAdapter | null {
    return this.adapter;
  }

  public getTransport(): TelegramTransport | null {
    return this.transport;
  }

  public setIncomingUpdateHandler(handler: (update: TelegramUpdate) => Promise<void>): void {
    this.customUpdateHandler = handler;
  }

  /**
   * CANONICAL LIFECYCLE METHOD 1: validateTelegramToken
   * Validates Telegram Bot API Token via official getMe endpoint.
   * Does NOT modify running receiver state.
   */
  public async validateTelegramToken(testToken?: string): Promise<TelegramValidationResult> {
    const rawToken = (testToken || this.token).trim();
    if (!rawToken) {
      telegramLogger.warn('TOKEN_VALIDATION', 'Validation failed: Token missing');
      return {
        success: false,
        error: 'Telegram Bot Token is required',
        code: 'CONFIG_MISSING'
      };
    }

    telegramLogger.info('TOKEN_VALIDATION', `Testing token ${telegramLogger.maskToken(rawToken)} via official getMe`);
    const tempTransport = new TelegramTransport(rawToken);

    try {
      const res = await tempTransport.getMe();

      if (res.ok && res.result) {
        if (!res.result.id || !res.result.is_bot) {
          telegramLogger.warn('TOKEN_VALIDATION', 'Validation response ok, but invalid bot identity');
          return {
            success: false,
            error: 'Telegram API returned invalid bot profile object',
            code: 'BOT_VALIDATION_FAILED'
          };
        }

        telegramLogger.success('TOKEN_VALIDATION', `Token verified for @${res.result.username || 'bot'} (ID: ${res.result.id})`, {
          botUsername: res.result.username,
          botId: res.result.id,
          firstName: res.result.first_name
        });

        this.lastSuccessfulValidation = Date.now();

        return {
          success: true,
          bot: res.result
        };
      } else {
        const desc = res.description || 'Invalid Telegram Bot token';
        const errCode = res.error_code;
        const isInvalid = errCode === 401 || errCode === 404 || desc.toLowerCase().includes('unauthorized') || desc.toLowerCase().includes('token');

        telegramLogger.warn('AUTH_FAILED', `Telegram getMe failed: ${desc} (Code: ${errCode || 'N/A'})`);

        return {
          success: false,
          error: desc,
          code: isInvalid ? 'TOKEN_INVALID' : 'TELEGRAM_API_ERROR'
        };
      }
    } catch (err: any) {
      telegramLogger.error('API_ERROR', `Network error validating Telegram token: ${err?.message || err}`);
      return {
        success: false,
        error: `Failed to reach Telegram API: ${err?.message || 'Network error'}`,
        code: 'TELEGRAM_API_UNREACHABLE'
      };
    }
  }

  // Alias for testToken
  public async testToken(testToken?: string): Promise<TelegramValidationResult> {
    return this.validateTelegramToken(testToken);
  }

  /**
   * CANONICAL LIFECYCLE METHOD 2: connectTelegram
   * Performs validate -> persist -> start single receiver receiver
   */
  public async connectTelegram(
    newToken?: string,
    adminIds?: string[],
    autoConnect: boolean = true
  ): Promise<TelegramValidationResult> {
    if (this.isStarting) {
      return { success: false, error: 'Connection attempt already in progress', code: 'RECEIVER_START_FAILED' };
    }

    this.isStarting = true;
    this.status = 'CONNECTING';
    this.receiverStatus = 'STARTING';

    try {
      if (newToken !== undefined && newToken.trim()) {
        this.token = newToken.trim();
      }

      if (adminIds !== undefined && Array.isArray(adminIds)) {
        // Strict validation for Admin User IDs: numeric strings only
        this.adminUserIds = adminIds
          .map(id => String(id).trim())
          .filter(id => /^\d+$/.test(id));
      }

      this.autoConnect = autoConnect;

      if (!this.token) {
        this.status = 'OFFLINE';
        this.receiverStatus = 'STOPPED';
        this.lastError = 'No bot token provided';
        this.isStarting = false;
        return { success: false, error: 'Please enter a valid Telegram Bot API token', code: 'CONFIG_MISSING' };
      }

      // Step 1: Validate token via official getMe
      telegramLogger.info('TOKEN_VALIDATION', `Connecting with token ${telegramLogger.maskToken(this.token)}`);
      const validation = await this.validateTelegramToken(this.token);

      if (!validation.success || !validation.bot) {
        this.status = 'AUTH_FAILED';
        this.receiverStatus = 'STOPPED';
        this.lastError = validation.error || 'Authentication failed: Invalid bot token';
        // Persist error state WITHOUT deleting saved token or admin IDs
        await this.persistConfig();
        this.isStarting = false;
        return validation;
      }

      const bot = validation.bot;
      this.botUsername = bot.username || '';
      this.botId = String(bot.id);
      this.botFirstName = bot.first_name || '';
      this.enabled = true;
      this.status = 'ONLINE';
      this.lastConnectedAt = Date.now();
      this.lastError = '';
      this.startTimestamp = Date.now();

      // Step 2: Instantiate transport and adapter
      this.transport = new TelegramTransport(this.token);
      this.adapter = new TelegramAdapter(this.transport, `@${this.botUsername} (${this.botFirstName})`);

      telegramLogger.success('BOT_CONNECTED', `Telegram Bot authenticated: @${this.botUsername} (ID: ${this.botId})`, {
        botUsername: this.botUsername,
        botId: this.botId,
        firstName: this.botFirstName
      });

      // Step 3: Drop any lingering getUpdates session on Telegram's side
      // (another instance / previous deploy) before starting our own loop.
      try {
        if (this.transport) await this.transport.callApi('deleteWebhook', { drop_pending_updates: false });
      } catch {}
      await this.stopTelegramReceiver();
      // Reset offset so we don't replay stale updates from a previous session.
      this.pollOffset = 0;

      // Step 4: Start exactly ONE receiver loop
      this.startTelegramReceiver();

      // Step 5: Save full configuration to database
      await this.persistConfig();
      this.isStarting = false;

      return {
        success: true,
        bot
      };
    } catch (err: any) {
      this.status = 'ERROR';
      this.receiverStatus = 'ERROR';
      this.lastError = err?.message || 'Unexpected connection error';
      telegramLogger.error('RUNTIME_ERROR', `Connect failed: ${this.lastError}`);
      await this.persistConfig();
      this.isStarting = false;
      return { success: false, error: this.lastError, code: 'RECEIVER_START_FAILED' };
    }
  }

  // Alias for connect
  public async connect(
    newToken?: string,
    adminIds?: string[],
    autoConnect: boolean = true
  ): Promise<TelegramValidationResult> {
    return this.connectTelegram(newToken, adminIds, autoConnect);
  }

  /**
   * CANONICAL LIFECYCLE METHOD 3: disconnectTelegram
   * Stops update receiver and marks bot disabled/offline
   */
  public async disconnectTelegram(): Promise<{ success: boolean; message: string }> {
    if (this.isStopping) {
      return { success: true, message: 'Disconnect in progress' };
    }

    this.isStopping = true;
    telegramLogger.info('RECEIVER_STOPPED', `Disconnecting Telegram bot @${this.botUsername || 'bot'}`);

    try {
      this.enabled = false;
      await this.stopTelegramReceiver();
      this.status = 'OFFLINE';
      this.receiverStatus = 'STOPPED';
      this.lastDisconnectedAt = Date.now();
      this.startTimestamp = 0;

      await this.persistConfig();
      this.isStopping = false;

      telegramLogger.success('RECEIVER_STOPPED', 'Telegram Bot disconnected successfully');
      return { success: true, message: 'Telegram Bot disconnected' };
    } catch (err: any) {
      this.isStopping = false;
      telegramLogger.error('RUNTIME_ERROR', `Disconnect error: ${err?.message || err}`);
      return { success: false, message: err?.message || 'Error disconnecting' };
    }
  }

  // Alias for disconnect
  public async disconnect(): Promise<{ success: boolean; message: string }> {
    return this.disconnectTelegram();
  }

  /**
   * CANONICAL LIFECYCLE METHOD 4: reconnectTelegram
   * Stops existing receiver loop cleanly, validates, and starts a fresh single receiver
   */
  public async reconnectTelegram(): Promise<TelegramValidationResult> {
    telegramLogger.info('BOT_CONNECTED', 'Reconnecting Telegram bot...');
    await this.stopTelegramReceiver();
    return await this.connectTelegram();
  }

  // Alias for reconnect
  public async reconnect(): Promise<TelegramValidationResult> {
    return this.reconnectTelegram();
  }

  /**
   * CANONICAL LIFECYCLE METHOD 5: restoreTelegram
   * Loads saved configuration from DB on server startup and restores connection if enabled
   */
  public async restoreTelegram(): Promise<void> {
    try {
      const savedConfig = await telegramConfigData.get();
      this.enabled = Boolean(savedConfig.enabled);
      this.autoConnect = savedConfig.autoConnect !== false;

      // Extract numeric Admin User IDs safely
      this.adminUserIds = Array.isArray(savedConfig.adminUserIds)
        ? savedConfig.adminUserIds.map(id => String(id).trim()).filter(id => /^\d+$/.test(id))
        : [];

      this.botUsername = savedConfig.botUsername || '';
      this.botId = savedConfig.botId || '';
      this.botFirstName = savedConfig.botFirstName || '';
      this.stats = savedConfig.stats || this.stats;

      if (savedConfig.encryptedToken) {
        try {
          this.token = decrypt(savedConfig.encryptedToken);
        } catch (err) {
          this.token = savedConfig.encryptedToken;
        }
      }

      if (this.enabled && this.autoConnect && this.token) {
        telegramLogger.info('RECEIVER_STARTED', 'Restoring saved Telegram Bot configuration on server boot');
        const result = await this.connectTelegram();
        if (!result.success) {
          telegramLogger.warn('AUTH_FAILED', `Server boot restore failed: ${result.error}. Preserving configuration in database.`);
        }
      } else {
        telegramLogger.info('RECEIVER_STOPPED', 'Telegram Bot auto-start skipped (bot disabled or token not set)');
      }
    } catch (err: any) {
      telegramLogger.error('DATABASE_LOAD_FAILED', `Database restore error: ${err?.message || err}`);
    }
  }

  // Alias for autoStart
  public async autoStart(): Promise<void> {
    return this.restoreTelegram();
  }

  /**
   * CANONICAL LIFECYCLE METHOD 6: startTelegramReceiver
   * Starts long-polling update receiver loop with strict single-instance protection
   */
  public startTelegramReceiver(): void {
    if (this.isPolling) {
      telegramLogger.warn('RECEIVER_STARTED', 'Telegram update receiver is already running, ignoring duplicate start request');
      return;
    }

    this.isPolling = true;
    this.receiverStatus = 'RUNNING';
    this.pollAbortController = new AbortController();
    this.networkRetryCount = 0;

    telegramLogger.info('RECEIVER_STARTED', `Update receiver active for @${this.botUsername} via long-polling`);

    // Asynchronous background polling execution
    (async () => {
      while (this.isPolling && this.status === 'ONLINE' && this.transport) {
        try {
          const res = await this.transport.getUpdates(
            this.pollOffset,
            25,
            50,
            this.pollAbortController?.signal
          );

          if (!this.isPolling) break;

          if (res.ok && Array.isArray(res.result)) {
            this.networkRetryCount = 0;
            const updates = res.result;

            for (const update of updates) {
              if (!this.isPolling) break;

              // Maintain polling offset to guarantee single update processing
              if (update.update_id >= this.pollOffset) {
                this.pollOffset = update.update_id + 1;
              }

              this.lastUpdateAt = Date.now();
              this.stats.messagesReceived++;

              // Process update safely through normalized engine pipeline
              await this.handleUpdate(update);
            }
          } else {
            const errCode = res.error_code;
            const desc = res.description || 'Unknown Telegram API error';

            if (errCode === 401 || errCode === 404) {
              telegramLogger.error('AUTH_FAILED', `Telegram API token rejected: ${desc} (Code: ${errCode}). Halting receiver.`);
              this.status = 'AUTH_FAILED';
              this.receiverStatus = 'STOPPED';
              this.lastError = `Authentication failed: ${desc}`;
              this.isPolling = false;
              await this.persistConfig();
              break;
            } else if (errCode === 409) {
              telegramLogger.warn('API_ERROR', `Conflict (409): Another update receiver is active. Backing off...`);
              await new Promise(r => setTimeout(r, 5000));
            } else {
              telegramLogger.warn('API_ERROR', `getUpdates error: ${desc} (Code: ${errCode || 'N/A'})`);
              await new Promise(r => setTimeout(r, 3000));
            }
          }
        } catch (err: any) {
          if (!this.isPolling) break;

          if (err?.message === 'REQUEST_ABORTED' || this.pollAbortController?.signal.aborted) {
            break;
          }

          this.networkRetryCount++;
          const backoffDelay = Math.min(30000, 1000 * Math.pow(1.5, Math.min(this.networkRetryCount, 8)));
          telegramLogger.warn('NETWORK_RETRY', `Network error during polling: ${err?.message || err}. Retrying in ${Math.round(backoffDelay / 1000)}s (Attempt ${this.networkRetryCount})`);

          await new Promise(r => setTimeout(r, backoffDelay));
        }
      }

      this.isPolling = false;
      if (this.status === 'ONLINE') {
        this.receiverStatus = 'STOPPED';
      }
      telegramLogger.info('RECEIVER_STOPPED', 'Telegram update receiver loop terminated cleanly');
    })().catch(err => {
      telegramLogger.error('RUNTIME_ERROR', `Fatal error in update receiver loop: ${err?.message || err}`);
      this.isPolling = false;
      this.receiverStatus = 'ERROR';
    });
  }

  // Alias for startReceiver
  public startReceiver(): void {
    this.startTelegramReceiver();
  }

  /**
   * CANONICAL LIFECYCLE METHOD 7: stopTelegramReceiver
   * Stops receiver loop and aborts active getUpdates HTTP request
   */
  public async stopTelegramReceiver(): Promise<void> {
    if (!this.isPolling && !this.pollAbortController) return;

    this.isPolling = false;
    if (this.pollAbortController) {
      try {
        this.pollAbortController.abort();
      } catch {}
      this.pollAbortController = null;
    }

    this.receiverStatus = 'STOPPED';
    await new Promise(r => setTimeout(r, 100));
  }

  // Alias for stopReceiver
  public async stopReceiver(): Promise<void> {
    return this.stopTelegramReceiver();
  }

  /**
   * CANONICAL LIFECYCLE METHOD 8: getTelegramStatus
   * Returns current status response for Admin Panel with masked token
   */
  public getTelegramStatus(): TelegramStatusResponse {
    const uptimeSeconds = this.startTimestamp > 0 && this.status === 'ONLINE'
      ? Math.floor((Date.now() - this.startTimestamp) / 1000)
      : 0;

    return {
      status: this.status,
      receiverStatus: this.receiverStatus,
      botUsername: this.botUsername,
      botId: this.botId,
      botFirstName: this.botFirstName,
      adminUserIds: [...this.adminUserIds],
      hasToken: Boolean(this.token && this.token.length > 5),
      maskedToken: telegramLogger.maskToken(this.token),
      enabled: this.enabled,
      autoConnect: this.autoConnect,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastUpdateAt: this.lastUpdateAt,
      lastError: this.lastError,
      stats: { ...this.stats },
      uptimeSeconds
    };
  }

  // Alias for getStatus
  public getStatus(): TelegramStatusResponse {
    return this.getTelegramStatus();
  }

  /**
   * Ingests and routes a Telegram update into the unified ShiPu AI engine
   */
  public async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      const msg: TelegramMessage | undefined =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post;

      if (!msg) {
        if (update.callback_query && update.callback_query.message) {
          telegramLogger.info('UPDATE_RECEIVED', `Callback query received from @${update.callback_query.from.username || update.callback_query.from.id}: ${update.callback_query.data}`);
        }
        return;
      }

      const rawText = (msg.text || msg.caption || '').trim();
      const chatId = String(msg.chat.id);
      const senderId = String(msg.from?.id || msg.chat.id);
      const messageId = `tg_${msg.message_id}`;
      const username = msg.from?.username || '';
      const senderName = `${msg.from?.first_name || ''} ${msg.from?.last_name || ''}`.trim() || username || `User ${senderId.slice(-4)}`;
      const chatTitle = msg.chat.title || senderName;
      const chatType = msg.chat.type;

      telegramLogger.info('UPDATE_RECEIVED', `Incoming ${chatType} update from ${senderName} (${senderId}) on chat ${chatId}: "${rawText.substring(0, 40)}${rawText.length > 40 ? '...' : ''}"`, {
        chatId,
        senderId,
        messageId,
        chatType
      });

      // Self-event protection
      if (this.botId && senderId === this.botId) {
        return;
      }

      // Check if user is in configured Telegram Admin User IDs list
      const isConfiguredAdmin = this.adminUserIds.includes(senderId);
      let userRole: UserRole = isConfiguredAdmin ? 3 : 0;

      // Cache user and thread info in adapter for fast lookups
      if (this.adapter) {
        this.adapter.cacheUserInfo(senderId, {
          userID: senderId,
          name: senderName,
          username,
          role: userRole
        });

        this.adapter.cacheThreadInfo(chatId, {
          threadID: chatId,
          name: chatTitle,
          prefix: '#',
          language: 'en'
        });
      }

      // Ensure user profile in BotEngine has correct role and name
      const existingUser = botEngine.getUser(senderId);
      if (existingUser) {
        botEngine.setUserData(senderId, {
          name: senderName,
          username,
          role: isConfiguredAdmin ? (existingUser.role < 2 ? 3 : existingUser.role) : (existingUser.role >= 2 ? 0 : existingUser.role)
        });
      } else {
        botEngine.setUserData(senderId, {
          userID: senderId,
          name: senderName,
          username,
          role: userRole,
          exp: 100,
          level: 1,
          money: 1000,
          bankMoney: 5000,
          isBanned: false
        });
      }

      // Ensure thread exists in BotEngine
      const existingThread = botEngine.getThread(chatId);
      if (!existingThread) {
        botEngine.createNewThread(chatTitle, '#');
        const created = botEngine.getThread(chatId);
        if (created) {
          created.threadID = chatId;
          created.name = chatTitle;
        }
      }

      // Construct normalized raw event with targetAdapter pointing to our Telegram adapter
      const rawEvent = {
        type: 'message',
        threadID: chatId,
        senderID: senderId,
        messageID: messageId,
        body: rawText,
        timestamp: (msg.date || Math.floor(Date.now() / 1000)) * 1000,
        isTelegram: true,
        targetAdapter: this.adapter,
        botUid: this.botId,
        telegramChat: msg.chat,
        telegramUser: msg.from,
        telegramMessage: msg,
        messageReply: msg.reply_to_message ? {
          messageID: `tg_${msg.reply_to_message.message_id}`,
          senderID: String(msg.reply_to_message.from?.id || ''),
          body: msg.reply_to_message.text || msg.reply_to_message.caption || ''
        } : undefined
      };

      // Dispatch into existing ShiPu AI Bot Engine pipeline
      telegramLogger.info('MESSAGE_PROCESSED', `Dispatching Telegram message to BotEngine pipeline [${chatId} : ${senderId}]`);

      const res = await botEngine.handleIncomingEvent(
        chatId,
        senderId,
        rawText,
        messageId,
        undefined,
        rawEvent
      );

      this.stats.messagesProcessed++;

      // AI auto-reply for Telegram (no trigger needed, DM always replies).
      if (!res || !res.body) {
        const isDM = String(chatId) === String(senderId);
        try {
          const decision = await aiAutoReplyEngine.shouldReply({
            threadID: chatId,
            senderID: senderId,
            text: rawText,
            isDM,
            isCommand: rawText.startsWith('#') || rawText.startsWith('!'),
            isSelf: senderId === this.botId
          });
          await aiAutoReplyEngine.recordMessage(chatId, senderId);
          behaviourObserver.observe({ threadID: chatId, senderID: senderId, text: rawText });
          selfLearning.onMessageLearn(senderId, chatId, rawText, isDM).catch(() => {});

          if (decision.reply) {
            const enrich = await emotionEngine.onMessageEnrich(senderId, chatId, rawText, isDM);
            const replyText = await (async () => {
              const { openRouterService } = await import('../openRouterService');
              return openRouterService.generateChatCompletion(
                [{ role: 'user', content: rawText }],
                undefined,
                `You are Shipu, a real human in this Telegram ${isDM ? 'private chat' : 'group'}. ${emotionEngine.moodToneHint(enrich.mood)} ${emotionEngine.langInstruction(enrich.lang)} Personality: ${enrich.personality}. Reply naturally, concisely, with emojis. Never reveal you are an AI/bot.`
              );
            })();
            if (replyText && replyText.trim()) {
              await this.adapter?.sendMessage(chatId, replyText.trim());
              await aiAutoReplyEngine.recordReply(chatId, decision.intent, senderId);
              selfLearning.onReplyLearn(senderId, replyText.trim()).catch(() => {});
              this.stats.commandsExecuted++;
            }
          }
        } catch (autoErr: any) {
          telegramLogger.warn('RUNTIME_ERROR', `Telegram auto-reply failed: ${autoErr?.message || autoErr}`);
        }
      }

      if (this.customUpdateHandler) {
        try {
          await this.customUpdateHandler(update);
        } catch (hErr: any) {
          console.warn('[TelegramBotManager] Custom handler error:', hErr?.message);
        }
      }

      if (res && res.body) {
        telegramLogger.info('COMMAND_EXECUTED', `BotEngine completed response for Telegram message ${messageId}`);
        if (rawText.startsWith('#') || rawText.startsWith('!')) {
          this.stats.commandsExecuted++;
        }
      }
    } catch (err: any) {
      this.stats.messagesFailed++;
      telegramLogger.error('RUNTIME_ERROR', `Error handling Telegram update: ${err?.message || err}`);
    }
  }

  /**
   * Saves current configuration into database
   */
  public async saveConfig(
    token?: string,
    adminIds?: string[],
    autoConnect?: boolean
  ): Promise<TelegramStatusResponse> {
    if (token !== undefined && token.trim()) {
      this.token = token.trim();
    }
    if (adminIds !== undefined && Array.isArray(adminIds)) {
      this.adminUserIds = adminIds.map(id => String(id).trim()).filter(id => /^\d+$/.test(id));
    }
    if (autoConnect !== undefined) {
      this.autoConnect = autoConnect;
    }

    await this.persistConfig();
    return this.getTelegramStatus();
  }

  private async persistConfig(): Promise<void> {
    try {
      const encryptedToken = this.token ? encrypt(this.token) : '';
      await telegramConfigData.save({
        encryptedToken,
        adminUserIds: this.adminUserIds,
        enabled: this.enabled,
        autoConnect: this.autoConnect,
        botUsername: this.botUsername,
        botId: this.botId,
        botFirstName: this.botFirstName,
        status: this.status,
        receiverStatus: this.receiverStatus,
        lastConnectedAt: this.lastConnectedAt,
        lastDisconnectedAt: this.lastDisconnectedAt,
        lastUpdateAt: this.lastUpdateAt,
        lastError: this.lastError,
        stats: this.stats
      });
    } catch (err: any) {
      console.warn('[TelegramBotManager] Failed to persist config to MongoDB:', err?.message);
    }
  }

  public getLogs(limit: number = 100, category?: string) {
    return telegramLogger.getLogs(limit, category);
  }

  public async shutdown(): Promise<void> {
    telegramLogger.info('RECEIVER_STOPPED', 'Server shutdown signal received. Stopping Telegram Bot...');
    await this.stopTelegramReceiver();
    this.status = 'OFFLINE';
    this.receiverStatus = 'STOPPED';
    await this.persistConfig();
  }
}

export const telegramBotManager = TelegramBotManager.getInstance();
