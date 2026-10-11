import { FCAFallbackManager } from './fca/FCAFallbackManager';
import { FCAConnection } from './fca/FCAProvider';
import { normalizeFcaApi } from './fca/normalizeFcaApi';
import { coerceAppState } from './fca/normalizeAppState';
import { isMqttListenerEnabled } from './fca/fcaConfig';
import { messengerLogger, MessengerLogger } from './MessengerLogger';
import { ErrorClassifier } from './ErrorClassifier';
import { messengerAccountsData, MessengerAccountRecord } from '../../db/database';
import { decryptAuthState, encryptAuthState } from '../../utils/crypto';
import { groupSetupService } from '../../services/groupSetupService';
import { accountRuntimeLogManager } from '../../services/AccountRuntimeLogManager';
import { MultiAccountManager } from './MultiAccountManager';

export type AccountStatus =
  | 'VALIDATING'
  | 'AUTHENTICATING'
  | 'AUTHENTICATED'
  | 'CONNECTING'
  | 'MQTT_LISTENING'
  | 'CONNECTED'
  | 'ONLINE'
  | 'FAILED'
  | 'DISCONNECTED'
  | 'TEMPORARY_ERROR'
  | 'AUTH_EXPIRED'
  | 'CHECKPOINT'
  | 'SECURITY_CHALLENGE'
  | 'REAUTH_REQUIRED'
  | 'DISABLED'
  | 'PENDING'
  | 'MQTT_ACTIVE'
  | 'AI_READY'
  | 'AUTH_FAILED'
  | 'COOKIE_EXPIRED'
  | 'RECONNECTING'
  | 'BLOCKED';

export type AccountMqttStatus =
  | 'OFF'
  | 'CONNECTING'
  | 'CONNECTED'
  | 'LISTENING'
  | 'WAITING_FOR_FIRST_EVENT'
  | 'EVENT_STREAM_ACTIVE'
  | 'DISCONNECTED'
  | 'ERROR'
  | 'MQTT_ACTIVE';

import { isSelfEvent } from '../../utils/commandParser';

/**
 * Normalize whatever `listenMqtt` returned into a safe teardown call.
 * FCA returns an emitter object (with stopListening/stopListeningAsync) — NOT
 * a stop function — and also attaches stop methods on the api object itself.
 * Calling the raw return value as a function throws TypeError and leaves the
 * old stream open, stacking duplicate subscriptions on every reconnect.
 */
function teardownFcaListener(api: any, listenReturnValue: any): void {
  try {
    const asyncStop = api?.stopListeningAsync;
    if (typeof asyncStop === 'function') {
      const p = asyncStop.call(api);
      if (p && typeof p.then === 'function') p.catch(() => {});
      return;
    }
    const syncStop = api?.stopListening;
    if (typeof syncStop === 'function') {
      syncStop.call(api, () => {});
      return;
    }
    const ret = listenReturnValue;
    if (ret && typeof ret === 'object') {
      if (typeof ret.stopListeningAsync === 'function') {
        const p = ret.stopListeningAsync();
        if (p && typeof p.then === 'function') p.catch(() => {});
        return;
      }
      if (typeof ret.stopListening === 'function') {
        ret.stopListening(() => {});
        return;
      }
    }
    if (typeof ret === 'function') {
      ret();
    }
  } catch {}
}

export interface AccountSessionState {
  accountId: string;
  uid: string;
  status:
    | 'AUTHENTICATING'
    | 'AUTHENTICATED'
    | 'LISTENING'
    | 'DISCONNECTED'
    | 'AUTH_INVALID'
    | 'CHECKPOINT';

  loginAttempted: boolean;
  authenticated: boolean;
  api: unknown | null;
  provider: string | null;
  authenticatedAt: number | null;
  reconnectCount: number;
  lastEventAt: number | null;
}

export interface SafeAccountMeta {
  accountId: string;
  uid: string;
  rawUid?: string;
  displayName: string;
  authType: 'cookie' | 'oauth';
  provider: string;
  status: AccountStatus;
  mqttStatus: AccountMqttStatus;
  loginStatus?: string;
  creationSource?: string;
  lastHeartbeat?: string;
  lastSuccessfulLogin?: string;
  failureReason?: string;
  botEnabled: boolean;
  enabled?: boolean;
  aiEnabled?: boolean;
  personalAiEnabled?: boolean;
  lastIncomingMessageAt?: string;
  lastOutgoingMessageAt?: string;
  stats?: {
    messagesToday: number;
    aiMessages: number;
    totalMessages: number;
    reconnects: number;
    uptimeMs: number;
  };
  connectedAt?: string;
  lastValidatedAt?: string;
  lastErrorCode?: string;
  reconnectCount: number;
  activeProviderName: string;
  sessionDurationMs?: number;
  cookieAgeMs?: number;
  mongoBackupStatus?: 'HEALTHY' | 'FAILED' | 'NOT_SAVED';
  ftpBackupStatus?: 'HEALTHY' | 'FAILED' | 'NOT_SAVED';
  persistentSession?: 'SAVED' | 'NOT_SAVED';
  restoreStatus?: 'RESTORED' | 'FAILED' | 'NONE';
}

export class AccountConnection {
  public accountId: string;
  public uid: string;
  public displayName: string;
  public authType: 'cookie' | 'oauth';
  public provider: string;
  public encryptedAuthState: string;
  public authStateVersion: number;
  public status: AccountStatus = 'DISCONNECTED';
  public mqttStatus: AccountMqttStatus = 'OFF';
  public loginStatus: 'LOGGED_IN' | 'LOGGED_OUT' | 'PENDING' | 'FAILED' = 'LOGGED_OUT';
  public creationSource: string = 'ADMIN_DASHBOARD';
  public lastHeartbeat: number = Date.now();
  public lastSuccessfulLogin: number = 0;
  public failureReason: string = '';
  public botEnabled = true;
  public enabled = true;
  public aiEnabled = true;
  public personalAiEnabled = false;
  public lastIncomingMessageAt = 0;
  public lastOutgoingMessageAt = 0;
  public createdAt = Date.now();
  public stats = {
    messagesToday: 0,
    aiMessages: 0,
    totalMessages: 0,
    reconnects: 0,
    uptimeMs: 0
  };

  public sessionState: AccountSessionState;

  private connectedAt?: number;
  private lastValidatedAt?: number;
  private lastErrorCode?: string;
  private reconnectCount = 0;
  private maxReconnectAttempts = 15;
  private baseDelayMs = 5000;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private fcaConnection: FCAConnection | null = null;
  private stopListenerFunc: (() => void) | null = null;
  private stopListenerRaw: any = null;
  /** Fires if a registered listener delivers no event within the grace period. */
  private deadStreamWatchdog: NodeJS.Timeout | null = null;
  /** Incremented on every start/teardown to invalidate stale listener handles. */
  private listenerGeneration = 0;
  public activeProviderName = 'DongDev FCA';
  private fallbackManager = new FCAFallbackManager();

  private eventListeners: ((event: any) => void)[] = [];
  private statusListeners: ((meta: SafeAccountMeta) => void)[] = [];
  private recentlySeenCache = new Map<string, number>();

  constructor(record: MessengerAccountRecord) {
    this.accountId = record.accountId;
    this.uid = record.uid;
    this.displayName = record.displayName || `Facebook User (${MessengerLogger.maskUid(record.uid)})`;
    this.authType = record.authType || 'cookie';
    this.provider = record.provider || 'DongDev FCA';
    this.encryptedAuthState = record.encryptedAuthState;
    this.authStateVersion = record.authStateVersion || 1;
    this.status = (record.status as AccountStatus) || 'DISCONNECTED';
    this.mqttStatus = (record.mqttStatus as AccountMqttStatus) || 'OFF';
    this.loginStatus = (record.loginStatus as any) || (record.status === 'CONNECTED' || record.status === 'ONLINE' ? 'LOGGED_IN' : 'LOGGED_OUT');
    this.creationSource = record.creationSource || 'ADMIN_DASHBOARD';
    this.lastHeartbeat = record.lastHeartbeat || Date.now();
    this.lastSuccessfulLogin = record.lastSuccessfulLogin || record.lastConnectedAt || 0;
    this.failureReason = record.failureReason || record.lastErrorCode || '';
    this.botEnabled = record.botEnabled ?? true;
    this.enabled = record.enabled ?? record.botEnabled ?? true;
    this.aiEnabled = record.aiEnabled ?? true;
    this.personalAiEnabled = record.personalAiEnabled ?? false;
    this.lastIncomingMessageAt = record.lastIncomingMessageAt || 0;
    this.lastOutgoingMessageAt = record.lastOutgoingMessageAt || 0;
    this.reconnectCount = record.reconnectCount || 0;
    this.lastValidatedAt = record.lastValidatedAt || Date.now();
    this.createdAt = record.createdAt || Date.now();
    this.stats = record.stats || {
      messagesToday: 0,
      aiMessages: 0,
      totalMessages: 0,
      reconnects: this.reconnectCount,
      uptimeMs: 0
    };

    this.sessionState = {
      accountId: this.accountId,
      uid: this.uid,
      status: 'DISCONNECTED',
      loginAttempted: false,
      authenticated: false,
      api: null,
      provider: null,
      authenticatedAt: null,
      reconnectCount: 0,
      lastEventAt: null
    };
  }

  public setFcaConnection(fcaConn: FCAConnection, providerName?: string) {
    if (fcaConn && fcaConn.api) {
      fcaConn.api = normalizeFcaApi(fcaConn.api, providerName || this.activeProviderName);
    }
    this.fcaConnection = fcaConn;
    if (providerName) this.activeProviderName = providerName;
    this.sessionState.authenticated = true;
    this.sessionState.loginAttempted = true;
    this.sessionState.status = 'AUTHENTICATED';
    this.sessionState.api = fcaConn?.api;
    this.sessionState.provider = providerName || this.provider;
    this.sessionState.authenticatedAt = Date.now();
    this.status = 'AUTHENTICATED';
    this.lastValidatedAt = Date.now();
  }

  public getFcaApi(): any {
    if (this.fcaConnection?.api) {
      return normalizeFcaApi(this.fcaConnection.api, this.activeProviderName);
    }
    return null;
  }

  public getCapabilities() {
    const api = this.getFcaApi();
    return {
      cookieAuthentication: this.sessionState.authenticated,
      fcaInstanceCreation: this.fcaConnection !== null,
      mqttListenerConnection: this.mqttStatus === 'EVENT_STREAM_ACTIVE',
      incomingMessageEvents: this.sessionState.lastEventAt !== null || this.mqttStatus === 'EVENT_STREAM_ACTIVE',
      sendMessage: typeof api?.sendMessage === 'function',
      threadList: typeof api?.getThreadList === 'function',
      threadHistory: typeof api?.getThreadHistory === 'function'
    };
  }

  public getRecord(): MessengerAccountRecord {
    return {
      accountId: this.accountId,
      uid: this.uid,
      displayName: this.displayName,
      authType: this.authType,
      provider: this.activeProviderName || this.provider,
      encryptedAuthState: this.encryptedAuthState,
      authStateVersion: this.authStateVersion || 1,
      status: this.status,
      mqttStatus: this.mqttStatus,
      loginStatus: this.loginStatus,
      creationSource: this.creationSource,
      lastHeartbeat: this.lastHeartbeat,
      lastSuccessfulLogin: this.lastSuccessfulLogin,
      failureReason: this.failureReason,
      botEnabled: this.botEnabled,
      enabled: this.enabled,
      aiEnabled: this.aiEnabled,
      personalAiEnabled: this.personalAiEnabled,
      lastIncomingMessageAt: this.lastIncomingMessageAt,
      lastOutgoingMessageAt: this.lastOutgoingMessageAt,
      lastValidatedAt: this.lastValidatedAt || Date.now(),
      lastConnectedAt: Date.now(),
      lastDisconnectedAt: 0,
      lastErrorCode: this.lastErrorCode || '',
      lastErrorAt: 0,
      reconnectCount: this.reconnectCount,
      stats: this.stats,
      createdAt: this.createdAt || Date.now(),
      updatedAt: Date.now()
    };
  }

  public registerEventListener(cb: (event: any) => void) {
    if (!this.eventListeners.includes(cb)) {
      this.eventListeners.push(cb);
    }
  }

  public registerStatusListener(cb: (meta: SafeAccountMeta) => void) {
    if (!this.statusListeners.includes(cb)) {
      this.statusListeners.push(cb);
    }
  }

  public resetSession() {
    this.teardownListener('reset');
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.sessionState.loginAttempted = false;
    this.sessionState.authenticated = false;
    this.sessionState.api = null;
    this.fcaConnection = null;
    this.lastEmittedStatus = '';
    this.lastEmittedMqttStatus = '';
  }

  /**
   * Tear down any previous MQTT subscription BEFORE creating a new one.
   * Handles every shape FCA surfaces (stop function / emitter object /
   * api-attached stop method) and invalidates stale handles via generation.
   */
  private teardownListener(reason: string) {
    this.listenerGeneration += 1;
    if (this.deadStreamWatchdog) {
      clearTimeout(this.deadStreamWatchdog);
      this.deadStreamWatchdog = null;
    }
    const raw = this.stopListenerRaw;
    const fn = this.stopListenerFunc;
    this.stopListenerRaw = null;
    this.stopListenerFunc = null;
    if (raw !== null || fn) {
      messengerLogger.info('MQTT', `[MQTT][Account ${this.accountId}] Tearing down previous listener (${reason})`);
      if (raw !== null) {
        teardownFcaListener(this.getFcaApi(), raw);
      } else if (fn) {
        try { fn(); } catch {}
      }
    }
  }

  /** Watchdog: FCA emits neither error nor event when getSeqID handshake fails. */
  private armDeadStreamWatchdog(generation: number, graceMs = 60000) {
    if (this.deadStreamWatchdog) {
      clearTimeout(this.deadStreamWatchdog);
      this.deadStreamWatchdog = null;
    }
    this.deadStreamWatchdog = setTimeout(() => {
      if (generation !== this.listenerGeneration) return;
      if (this.mqttStatus === 'EVENT_STREAM_ACTIVE') return;
      messengerLogger.warn('MQTT', `[WARN][MQTT][Account ${this.accountId}] Listener registered but no event within ${Math.round(graceMs / 1000)}s (dead stream). Scheduling reconnect...`);
      this.status = 'TEMPORARY_ERROR';
      this.mqttStatus = 'DISCONNECTED';
      this.sessionState.status = 'DISCONNECTED';
      this.emitStatusChange();
      this.scheduleMqttReconnect();
    }, graceMs);
    if (typeof this.deadStreamWatchdog.unref === 'function') {
      this.deadStreamWatchdog.unref();
    }
  }

  public updateRecord(record: MessengerAccountRecord) {
    this.displayName = record.displayName || this.displayName;
    this.encryptedAuthState = record.encryptedAuthState;
    this.botEnabled = record.botEnabled ?? this.botEnabled;
    this.enabled = record.enabled ?? this.enabled;
    this.aiEnabled = record.aiEnabled ?? this.aiEnabled;
    this.personalAiEnabled = record.personalAiEnabled ?? this.personalAiEnabled;
    this.provider = record.provider || this.provider;
  }

  public logAccountEvent(
    level: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'DEBUG',
    category: string,
    message: string,
    details?: any,
    extra?: { threadID?: string; senderUID?: string; sourceModule?: string; executionTimeMs?: number; messageID?: string; correlationID?: string }
  ) {
    accountRuntimeLogManager.addLog(this.accountId, {
      level,
      category,
      message,
      details,
      accountName: this.displayName,
      uid: this.uid,
      provider: this.activeProviderName || this.provider,
      mqttStatus: this.mqttStatus,
      ...extra
    });
  }

  public recordIncomingMessage(threadID?: string, senderUID?: string, messageID?: string) {
    this.lastIncomingMessageAt = Date.now();
    this.stats.totalMessages++;
    this.stats.messagesToday++;
    this.logAccountEvent(
      'INFO',
      'EVENT',
      `Incoming event received for account ${this.accountId}`,
      { threadID, senderUID, messageID },
      { threadID, senderUID, messageID, sourceModule: 'AccountConnection' }
    );
  }

  public recordOutgoingMessage(isAi = false, threadID?: string, messageID?: string, executionTimeMs?: number) {
    this.lastOutgoingMessageAt = Date.now();
    this.stats.totalMessages++;
    this.stats.messagesToday++;
    if (isAi) this.stats.aiMessages++;
    this.logAccountEvent(
      'SUCCESS',
      isAi ? 'AI' : 'SEND',
      `${isAi ? 'AI response generated' : 'Outgoing message sent'} successfully`,
      { isAi, threadID, messageID, executionTimeMs },
      { threadID, messageID, executionTimeMs, sourceModule: isAi ? 'SmartConversationBrain' : 'MessengerAdapter' }
    );
  }

  public getSafeMetadata(): SafeAccountMeta {
    const sessionDurationMs = this.connectedAt ? Date.now() - this.connectedAt : 0;
    const cookieAgeMs = this.lastValidatedAt ? Date.now() - this.lastValidatedAt : 0;
    this.stats.uptimeMs = sessionDurationMs;

    const multiMgr = MultiAccountManager.getInstance();

    return {
      accountId: this.accountId,
      uid: MessengerLogger.maskUid(this.uid),
      rawUid: this.uid,
      displayName: this.displayName,
      authType: this.authType,
      provider: this.provider,
      status: this.status,
      mqttStatus: this.mqttStatus,
      loginStatus: this.loginStatus,
      creationSource: this.creationSource,
      lastHeartbeat: new Date(this.lastHeartbeat).toISOString(),
      lastSuccessfulLogin: this.lastSuccessfulLogin ? new Date(this.lastSuccessfulLogin).toISOString() : undefined,
      failureReason: this.failureReason,
      botEnabled: this.botEnabled,
      enabled: this.enabled,
      aiEnabled: this.aiEnabled,
      personalAiEnabled: this.personalAiEnabled,
      lastIncomingMessageAt: this.lastIncomingMessageAt ? new Date(this.lastIncomingMessageAt).toISOString() : undefined,
      lastOutgoingMessageAt: this.lastOutgoingMessageAt ? new Date(this.lastOutgoingMessageAt).toISOString() : undefined,
      stats: { ...this.stats, reconnects: this.reconnectCount },
      connectedAt: this.connectedAt ? new Date(this.connectedAt).toISOString() : undefined,
      lastValidatedAt: this.lastValidatedAt ? new Date(this.lastValidatedAt).toISOString() : undefined,
      lastErrorCode: this.lastErrorCode,
      reconnectCount: this.reconnectCount,
      activeProviderName: this.activeProviderName,
      sessionDurationMs,
      cookieAgeMs,
      mongoBackupStatus: multiMgr.getMongoBackupStatus(this.accountId),
      ftpBackupStatus: multiMgr.getFtpBackupStatus(this.accountId),
      persistentSession: multiMgr.getPersistentSession(this.accountId),
      restoreStatus: multiMgr.getRestoreStatus(this.accountId)
    };
  }

  private lastEmittedStatus: string = '';
  private lastEmittedMqttStatus: string = '';

  private emitStatusChange(forcePersist = false) {
    const meta = this.getSafeMetadata();
    for (const listener of this.statusListeners) {
      try {
        listener(meta);
      } catch {}
    }

    const statusChanged = this.status !== this.lastEmittedStatus || this.mqttStatus !== this.lastEmittedMqttStatus;
    if (!statusChanged && !forcePersist) {
      return;
    }

    this.lastEmittedStatus = this.status;
    this.lastEmittedMqttStatus = this.mqttStatus;

    this.logAccountEvent(
      this.status === 'FAILED' || this.status === 'REAUTH_REQUIRED' ? 'ERROR' : 'INFO',
      'SESSION',
      `Session status changed to [${this.status}] (MQTT: ${this.mqttStatus})`,
      { status: this.status, mqttStatus: this.mqttStatus, failureReason: this.failureReason }
    );

    // Persist status change to MongoDB atomically only on actual transitions
    messengerAccountsData.update(this.accountId, {
      status: this.status,
      mqttStatus: this.mqttStatus,
      reconnectCount: this.reconnectCount,
      lastValidatedAt: this.lastValidatedAt,
      lastConnectedAt: this.connectedAt,
      lastErrorCode: this.lastErrorCode || ''
    }).catch(() => {});
  }

  private static inFlightConnectPromises = new Map<string, Promise<boolean>>();

  public async connect(): Promise<boolean> {
    const existingPromise = AccountConnection.inFlightConnectPromises.get(this.accountId);
    if (existingPromise) {
      messengerLogger.info('AUTH', `[AUTH][Account ${this.accountId}] Connection/authentication operation already in progress. Reusing in-flight request.`);
      return existingPromise;
    }

    const connectPromise = this.internalConnect().finally(() => {
      AccountConnection.inFlightConnectPromises.delete(this.accountId);
    });

    AccountConnection.inFlightConnectPromises.set(this.accountId, connectPromise);
    return connectPromise;
  }

  private async internalConnect(): Promise<boolean> {
    if (this.status === 'DISABLED') {
      messengerLogger.warn('SESSION', `Account ${this.accountId} is disabled. Skipping connection.`);
      return false;
    }

    // 1. Guard against Duplicate Authentication Attempts in the current server process
    if (this.sessionState.authenticated && this.sessionState.api) {
      messengerLogger.info('AUTH', `[AUTH][Account ${this.accountId}] Reusing existing authenticated FCA session (no re-login required).`);
      
      if (
        !this.stopListenerFunc &&
        !this.stopListenerRaw &&
        this.mqttStatus !== 'EVENT_STREAM_ACTIVE' &&
        this.mqttStatus !== 'LISTENING' &&
        this.mqttStatus !== 'WAITING_FOR_FIRST_EVENT'
      ) {
        return this.startMqttListener();
      }
      return true;
    }

    if (this.sessionState.status === 'AUTH_INVALID' || this.status === 'COOKIE_EXPIRED' || this.status === 'AUTH_FAILED' || this.status === 'CHECKPOINT') {
      messengerLogger.warn('AUTH', `[AUTH][Account ${this.accountId}] Session is marked AUTH_INVALID/COOKIE_EXPIRED. Automatic login loop stopped.`);
      messengerLogger.warn('AUTH', `[AUTH][Account ${this.accountId}] Manual cookie replacement required from admin dashboard.`);
      return false;
    }

    if (this.sessionState.loginAttempted) {
      messengerLogger.warn('AUTH', `[WARN][AUTH][Account ${this.accountId}] Initial authentication attempt already completed for process lifetime.`);
      messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Automatic re-login blocked. Manual cookie update required.`);
      return false;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // 2. Perform ONE-TIME Authentication
    this.sessionState.loginAttempted = true; // Lock immediately for process lifetime!
    this.sessionState.status = 'AUTHENTICATING';
    this.status = 'AUTHENTICATING';
    this.mqttStatus = 'CONNECTING';
    this.emitStatusChange();

    messengerLogger.info('SYSTEM', `[SYSTEM] Multi-Account Session Manager starting Account [${this.accountId}]`);
    messengerLogger.info('AUTH', `[AUTH][Account ${this.accountId}] Initial authentication attempt 1/1`);

    const authState = decryptAuthState(this.encryptedAuthState);
    if (!authState) {
      this.sessionState.status = 'AUTH_INVALID';
      this.sessionState.authenticated = false;
      this.status = 'COOKIE_EXPIRED';
      this.mqttStatus = 'OFF';
      this.lastErrorCode = 'DECRYPTION_FAILED';
      messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Initial authentication failed: DECRYPTION_FAILED`);
      messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Authentication locked for current server process`);
      messengerLogger.warn('AUTH', `[WARN][AUTH][Account ${this.accountId}] No automatic re-login will be attempted until server restart`);
      this.emitStatusChange();
      return false;
    }

    if (this.authType === 'cookie') {
      // coerceAppState (not JSON.parse) so object-format / header-string
      // exports cannot reach the provider and blow up on .map() with an
      // "unexpected token type" style failure.
      const appState = coerceAppState(authState);
      if (appState.length === 0) {
        this.sessionState.status = 'AUTH_INVALID';
        this.sessionState.authenticated = false;
        this.status = 'AUTH_FAILED';
        this.mqttStatus = 'OFF';
        this.lastErrorCode = 'INVALID_APPSTATE';
        messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Stored session has no usable cookies. Manual cookie update required.`);
        this.emitStatusChange();
        return false;
      }
      const authResult = await this.fallbackManager.authenticate(appState);

      if (!authResult.connection) {
        const classified = ErrorClassifier.classify({
          message: authResult.failureReason,
          category: authResult.failureCategory
        });

        this.lastErrorCode = classified.code;
        this.sessionState.authenticated = false;

        if (classified.code === 'CHECKPOINT' || authResult.failureCategory === 'CHECKPOINT' || classified.code === 'SECURITY_CHALLENGE') {
          this.sessionState.status = 'CHECKPOINT';
          this.status = 'COOKIE_EXPIRED';
          this.mqttStatus = 'OFF';
          messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Facebook security verification/checkpoint required.`);
          messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Authentication locked for current server process`);
          messengerLogger.warn('AUTH', `[WARN][AUTH][Account ${this.accountId}] No automatic re-login will be attempted until server restart`);
        } else {
          this.sessionState.status = 'AUTH_INVALID';
          this.status = 'AUTH_FAILED';
          this.mqttStatus = 'OFF';
          messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Initial authentication failed: ${classified.reason}`);
          messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Authentication locked for current server process`);
          messengerLogger.warn('AUTH', `[WARN][AUTH][Account ${this.accountId}] No automatic re-login will be attempted until server restart`);
        }

        this.emitStatusChange();
        return false;
      }

      this.fcaConnection = authResult.connection;
      this.activeProviderName = authResult.activeProviderName || this.provider;

      this.sessionState.authenticated = true;
      this.sessionState.status = 'AUTHENTICATED';
      this.sessionState.api = authResult.connection.api;
      this.sessionState.provider = this.activeProviderName;
      this.sessionState.authenticatedAt = Date.now();

      this.status = 'AUTHENTICATED';
      this.lastValidatedAt = Date.now();

      messengerLogger.success('AUTH', `[SUCCESS][AUTH][Account ${this.accountId}] Facebook authentication successful`);
      messengerLogger.success('AUTH', `[SUCCESS][AUTH][Account ${this.accountId}] Authentication locked for current server process`);
      messengerLogger.info('SESSION', `[INFO][SESSION][Account ${this.accountId}] Reusing authenticated API session`);
    } else if (this.authType === 'oauth') {
      this.sessionState.authenticated = true;
      this.sessionState.status = 'AUTHENTICATED';
      this.sessionState.provider = 'Official Meta Graph API';
      this.sessionState.authenticatedAt = Date.now();
      this.status = 'AUTHENTICATED';
      this.lastValidatedAt = Date.now();
      this.activeProviderName = 'Official Meta Graph API';
      messengerLogger.success('AUTH', `[SUCCESS][AUTH][Account ${this.accountId}] Meta OAuth token validated`);
      messengerLogger.success('AUTH', `[SUCCESS][AUTH][Account ${this.accountId}] Authentication locked for current server process`);
      messengerLogger.info('SESSION', `[INFO][SESSION][Account ${this.accountId}] Reusing authenticated API session`);
    }

    this.status = 'CONNECTING';
    this.mqttStatus = 'WAITING_FOR_FIRST_EVENT';
    this.connectedAt = Date.now();
    this.reconnectCount = 0;
    this.emitStatusChange();

    try {
      return this.startMqttListener();
    } catch (listenErr: any) {
      messengerLogger.warn('MQTT', `[WARN][MQTT][Account ${this.accountId}] Listener startup threw: ${listenErr?.message || listenErr}. Scheduling reconnect...`);
      this.lastErrorCode = 'LISTENER_STARTUP_ERROR';
      this.status = 'TEMPORARY_ERROR';
      this.mqttStatus = 'ERROR';
      this.sessionState.status = 'DISCONNECTED';
      this.emitStatusChange();
      this.scheduleMqttReconnect();
      return false;
    }
  }

  public startMqttListener(): boolean {
    try {
      // fca-config.json's mqtt.enabled is ignored by FCA itself; honour it here.
      if (!isMqttListenerEnabled()) {
        messengerLogger.info(
          'MQTT',
          `[MQTT][Account ${this.accountId}] Realtime listener disabled via fca-config.json (mqtt.enabled = false)`
        );
        this.teardownListener('mqtt-disabled');
        this.status = 'CONNECTED';
        this.mqttStatus = 'OFF';
        this.sessionState.status = 'AUTHENTICATED';
        this.emitStatusChange();
        return false;
      }
    } catch (cfgErr: any) {
      messengerLogger.warn('MQTT', `[MQTT][Account ${this.accountId}] Listener config check failed, proceeding: ${cfgErr?.message || cfgErr}`);
    }

    const api = this.getFcaApi();
    const listenFunc = typeof api?.listenMqtt === 'function' ? api.listenMqtt.bind(api) : (typeof api?.listen === 'function' ? api.listen.bind(api) : null);
    if (!api || !listenFunc) {
      if (this.authType === 'oauth') {
        // Meta OAuth Webhook transport mode
        this.status = 'CONNECTED';
        this.mqttStatus = 'EVENT_STREAM_ACTIVE';
        this.sessionState.status = 'LISTENING';
        this.emitStatusChange();
        return true;
      }

      this.status = 'TEMPORARY_ERROR';
      this.mqttStatus = 'ERROR';
      this.lastErrorCode = 'MISSING_LISTEN_MQTT';
      this.scheduleMqttReconnect();
      this.emitStatusChange();
      return false;
    }

    // Tear down any previous subscription BEFORE creating a new one. FCA's
    // listenMqtt returns an emitter object (not a stop function), so the raw
    // value is kept and torn down via teardownFcaListener().
    this.teardownListener('reconnect');

    try {
      messengerLogger.info('MQTT', `[INFO][MQTT][Account ${this.accountId}] Attempting listener reconnect using existing authenticated session`);

      if (typeof api.setOptions === 'function') {
        api.setOptions({
          listenEvents: true,
          selfListen: false,
          autoReconnect: false,
          emitReady: false,
          logLevel: 'silent',
          updatePresence: false
        });
      }

      const generation = this.listenerGeneration;
      const rawStop = listenFunc((err: any, event: any) => {
        messengerLogger.info('MQTT', `[DEBUG][LISTEN][Account ${this.accountId}] Received callback in listen. Error: ${!!err}, Event: ${!!event}`);
        
        // Handle explicit error parameter OR inactive/auth error objects passed inside event parameter
        const isAuthEvent = event && (event.type === 'account_inactive' || event.type === 'auth_error' || event.type === 'login_blocked' || event.type === 'stop_listen' || event.error);
        const activeErr = err || (isAuthEvent ? (event.error || event.reason || event) : null);

        if (activeErr) {
          const classified = ErrorClassifier.classify(activeErr);
          this.lastErrorCode = classified.code;

          messengerLogger.warn('MQTT', `[WARN][MQTT][Account ${this.accountId}] MQTT connection lost: ${classified.reason}`);

          if (!classified.isTemporary) {
            messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Hard authentication error during MQTT session: ${classified.reason}`);
            this.status = classified.code === 'CHECKPOINT' ? 'CHECKPOINT' : (classified.code === 'ACCOUNT_RESTRICTED' ? 'BLOCKED' : 'COOKIE_EXPIRED');
            this.failureReason = classified.reason || 'Facebook authentication failed';
            this.mqttStatus = 'OFF';
            this.sessionState.status = 'AUTH_INVALID';
            this.sessionState.authenticated = false;
            if (this.reconnectTimer) {
              clearTimeout(this.reconnectTimer);
              this.reconnectTimer = null;
            }
            this.teardownListener('terminal-auth-error');
            this.emitStatusChange();
            return;
          }

          this.status = 'TEMPORARY_ERROR';
          this.mqttStatus = 'DISCONNECTED';
          this.sessionState.status = 'DISCONNECTED';
          messengerLogger.info('RECONNECT', `[Account ${this.accountId}] Preserving saved session/cookie during temporary error. Scheduling reconnect...`);
          this.emitStatusChange();

          // Schedule MQTT reconnect using the existing authenticated API session (NO login() call)
          this.scheduleMqttReconnect();
          return;
        }

        if (event && event.type === 'ready') {
          messengerLogger.success('MQTT', `[SUCCESS][MQTT][Account ${this.accountId}] MQTT event stream connected and ready.`);
          this.status = 'CONNECTED';
          this.mqttStatus = 'EVENT_STREAM_ACTIVE';
          this.sessionState.status = 'LISTENING';
          this.emitStatusChange();
          return;
        }

        if (event) {
          const traceId = event._traceId || `evt_trace_${event.messageID || Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
          event._traceId = traceId;

          const msgSnippet = String(event.body || '').substring(0, 30);
          console.log(`[PIPELINE TRACE][STAGE 1: FCA_MQTT_RECEIVE][ID: ${traceId}] Event received from MQTT stream. Account: ${this.accountId}, Thread: ${event.threadID || event.thread_fbid || 'N/A'}, Sender: ${event.senderID || event.senderId || event.author || 'N/A'}, Snippet: "${msgSnippet}"`);

          // Self-event filter check BEFORE any processing or dispatch
          if (isSelfEvent(event, this.uid)) {
            console.log(`[PIPELINE TRACE][STAGE 1: FCA_MQTT_RECEIVE][ID: ${traceId}] Dropping self-event for bot UID ${this.uid}`);
            messengerLogger.info('MQTT', `[MQTT] Incoming message`);
            messengerLogger.info('EVENT', `[EVENT] Sender UID: ${event.senderID || event.senderId || event.author || 'BOT_SELF'}`);
            messengerLogger.info('SESSION', `[SELF-FILTER] Sender matches authenticated bot UID (${this.uid})`);
            messengerLogger.info('SESSION', `[SELF-FILTER] Ignoring bot's own event`);
            messengerLogger.info('COMMAND', `[COMMAND] NOT EXECUTED`);
            return;
          }

          // MANDATORY AUTO-SEEN / READ RECEIPT (MESSAGE_RECEIVED -> MARK_SEEN -> PROCESS_MESSAGE)
          const threadID = String(event.threadID || event.thread_fbid || '');
          const messageID = String(event.messageID || event.messageId || '');
          
          console.log(`[PIPELINE TRACE][MESSAGE_RECEIVED][ID: ${traceId}] Account ${this.accountId} received message event in Thread ${threadID || 'N/A'}`);

          if (threadID && api) {
            const dedupeKey = `${threadID}_${messageID || event.timestamp || 'latest'}`;
            const now = Date.now();
            const lastSeenTime = this.recentlySeenCache.get(threadID) || 0;

            if (now - lastSeenTime > 4000 || !this.recentlySeenCache.has(dedupeKey)) {
              this.recentlySeenCache.set(threadID, now);
              this.recentlySeenCache.set(dedupeKey, now);

              console.log(`[PIPELINE TRACE][MARK_SEEN][ID: ${traceId}] Attempting markAsRead/markAsSeen for Thread ${threadID}`);
              try {
                if (typeof api.markAsRead === 'function') {
                  api.markAsRead(threadID, (err: any) => {
                    if (err) {
                      console.warn(`[PIPELINE TRACE][MARK_SEEN_WARN][ID: ${traceId}] markAsRead failed: ${err.message || err}`);
                    } else {
                      console.log(`[PIPELINE TRACE][MARK_SEEN_SUCCESS][ID: ${traceId}] Successfully marked thread ${threadID} as read/seen via markAsRead`);
                    }
                  });
                } else if (api.messages && typeof api.messages.markRead === 'function') {
                  api.messages.markRead(threadID, (err: any) => {
                    if (err) {
                      console.warn(`[PIPELINE TRACE][MARK_SEEN_WARN][ID: ${traceId}] messages.markRead failed: ${err.message || err}`);
                    } else {
                      console.log(`[PIPELINE TRACE][MARK_SEEN_SUCCESS][ID: ${traceId}] Successfully marked thread ${threadID} as read/seen via messages.markRead`);
                    }
                  });
                } else if (typeof api.markAsSeen === 'function') {
                  api.markAsSeen(threadID, (err: any) => {
                    if (err) {
                      console.warn(`[PIPELINE TRACE][MARK_SEEN_WARN][ID: ${traceId}] markAsSeen failed: ${err.message || err}`);
                    } else {
                      console.log(`[PIPELINE TRACE][MARK_SEEN_SUCCESS][ID: ${traceId}] Successfully marked thread ${threadID} as seen via markAsSeen`);
                    }
                  });
                }
              } catch (markErr: any) {
                console.warn(`[PIPELINE TRACE][MARK_SEEN_ERROR][ID: ${traceId}] Error executing MARK_SEEN:`, markErr?.message || markErr);
              }
            }
          }

          console.log(`[PIPELINE TRACE][PROCESS_MESSAGE][ID: ${traceId}] Proceeding with normal processing and dispatch`);

          if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
          }
          this.reconnectCount = 0;

          const wasEventStreamActive = this.status === 'CONNECTED' && this.mqttStatus === 'EVENT_STREAM_ACTIVE';
          if (this.mqttStatus !== 'EVENT_STREAM_ACTIVE') {
            messengerLogger.success('MQTT', `[SUCCESS][MQTT][Account ${this.accountId}] MQTT listener restored`);
            messengerLogger.success('SESSION', `[SUCCESS][ACCOUNT][Account ${this.accountId}] Account ONLINE`);
          }

          this.status = 'CONNECTED';
          this.mqttStatus = 'EVENT_STREAM_ACTIVE';
          this.sessionState.status = 'LISTENING';
          this.sessionState.lastEventAt = Date.now();
          if (!wasEventStreamActive) {
            this.emitStatusChange();
          }

          // Normalize event to carry account isolation metadata
          const normalizedEvent = {
            ...event,
            accountId: this.accountId,
            authenticatedUid: this.uid,
            _traceId: traceId
          };

          if (event.type === 'event') {
            groupSetupService.handleGroupEvent(api, event, this.uid);
          }

          console.log(`[PIPELINE TRACE][STAGE 2: ACCOUNT_CONNECTION_DISPATCH][ID: ${traceId}] Dispatching event to ${this.eventListeners.length} listener(s) for Account ${this.accountId}`);

          // Direct fast dispatch to all registered listeners
          for (const listener of this.eventListeners) {
            try {
              listener(normalizedEvent);
            } catch (dispatchErr: any) {
              console.error(`[PIPELINE TRACE][STAGE 2: ACCOUNT_CONNECTION_DISPATCH][ID: ${traceId}] Listener error:`, dispatchErr?.message || dispatchErr);
            }
          }
        }
      });

      // Keep the raw return value (emitter object on real FCA) and expose a
      // normalized stop closure. Never call the raw value directly.
      this.stopListenerRaw = rawStop;
      const selfApi = api;
      const selfRaw = rawStop;
      this.stopListenerFunc = () => teardownFcaListener(selfApi, selfRaw);

      this.status = 'MQTT_LISTENING';
      this.mqttStatus = 'LISTENING';
      this.sessionState.status = 'LISTENING';
      this.emitStatusChange();
      messengerLogger.success('MQTT', `[SUCCESS][MQTT][Account ${this.accountId}] listenMqtt active`);
      this.armDeadStreamWatchdog(generation);
      return true;
    } catch (mqttErr: any) {
      const classified = ErrorClassifier.classify(mqttErr);
      this.lastErrorCode = classified.code;
      messengerLogger.warn('MQTT', `[WARN][MQTT][Account ${this.accountId}] MQTT connection error: ${classified.reason}`);

      if (!classified.isTemporary) {
        messengerLogger.error('AUTH', `[ERROR][AUTH][Account ${this.accountId}] Terminal authentication error during MQTT listener creation: ${classified.reason}`);
        this.status = classified.code === 'CHECKPOINT' ? 'CHECKPOINT' : (classified.code === 'ACCOUNT_RESTRICTED' ? 'BLOCKED' : 'COOKIE_EXPIRED');
        this.failureReason = classified.reason || 'Facebook authentication failed';
        this.mqttStatus = 'OFF';
        this.sessionState.status = 'AUTH_INVALID';
        this.sessionState.authenticated = false;
        if (this.reconnectTimer) {
          clearTimeout(this.reconnectTimer);
          this.reconnectTimer = null;
        }
        this.teardownListener('terminal-mqtt-error');
        this.emitStatusChange();
        return false;
      }

      this.status = 'TEMPORARY_ERROR';
      this.mqttStatus = 'ERROR';
      this.sessionState.status = 'DISCONNECTED';
      this.emitStatusChange();

      this.scheduleMqttReconnect();
      return false;
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
      this.status === 'COOKIE_EXPIRED' ||
      this.status === 'AUTH_FAILED' ||
      this.status === 'CHECKPOINT' ||
      this.status === 'DISABLED'
    ) {
      messengerLogger.warn('RECONNECT', `[Account ${this.accountId}] Terminal status detected (${this.status}). Automatic reconnect loop halted.`);
      return;
    }

    this.reconnectCount += 1;
    this.sessionState.reconnectCount = this.reconnectCount;

    if (this.reconnectCount > this.maxReconnectAttempts) {
      messengerLogger.error('RECONNECT', `Account [${this.accountId}] exceeded max MQTT reconnect attempts (${this.maxReconnectAttempts}). Holding state as TEMPORARY_ERROR.`);
      return;
    }

    const delay = Math.min(this.baseDelayMs * Math.pow(1.5, this.reconnectCount - 1), 300000);
    messengerLogger.info('MQTT', `[INFO][MQTT][Account ${this.accountId}] Scheduling MQTT listener reconnect attempt #${this.reconnectCount} in ${Math.round(delay / 1000)}s using existing authenticated session`);

    this.reconnectTimer = setTimeout(() => {
      // Re-invoke startMqttListener to reuse existing authenticated API session without re-authenticating
      this.startMqttListener();
    }, delay);
  }

  public async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.teardownListener('disconnect');

    // CRITICAL: Do NOT call api.logout() during normal disconnect / process restart!
    // Calling api.logout() revokes the session on Facebook's servers.
    // Preserving the fcaConnection or clearing memory references allows stored cookies to remain valid for future restarts.
    this.fcaConnection = null;
    this.sessionState.loginAttempted = false;
    this.sessionState.authenticated = false;
    this.sessionState.api = null;
    this.status = 'DISCONNECTED';
    this.mqttStatus = 'OFF';
    this.emitStatusChange();
    messengerLogger.info('SESSION', `Account [${this.accountId}] disconnected cleanly without invalidating persistent session.`);
  }

  public async adminLogout(reason = 'ADMIN_EXPLICIT_LOGOUT'): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.teardownListener('admin-logout');

    if (this.fcaConnection?.api?.logout) {
      try {
        const p = this.fcaConnection.api.logout();
        if (p && typeof p.catch === 'function') {
          p.catch(() => {});
        }
      } catch {}
    }

    this.fcaConnection = null;
    this.status = 'DISABLED';
    this.mqttStatus = 'OFF';
    this.loginStatus = 'LOGGED_OUT';
    this.botEnabled = false;
    this.enabled = false;
    this.failureReason = reason;

    await messengerAccountsData.update(this.accountId, {
      status: 'DISABLED',
      mqttStatus: 'OFF',
      loginStatus: 'LOGGED_OUT',
      botEnabled: false,
      enabled: false,
      failureReason: reason,
      lastDisconnectedAt: Date.now()
    });

    this.emitStatusChange();
    messengerLogger.info('SESSION', `Account [${this.accountId}] logged out explicitly by administrator.`);
  }

  public async updateAuthState(newAuthState: any): Promise<void> {
    const encrypted = encryptAuthState(newAuthState);
    this.encryptedAuthState = encrypted;
    this.authStateVersion += 1;

    await messengerAccountsData.update(this.accountId, {
      encryptedAuthState: encrypted,
      authStateVersion: this.authStateVersion,
      lastValidatedAt: Date.now()
    });

    messengerLogger.success('AUTH', `Updated encrypted auth state for Account [${this.accountId}] (v${this.authStateVersion})`);
  }
}
