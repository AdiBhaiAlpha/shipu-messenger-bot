import { encryptAuthState, decryptAuthState, encryptPassword } from '../utils/crypto';
import { coerceAppState } from '../adapters/messenger/fca/normalizeAppState';
import { CookieLoader } from '../adapters/messenger/CookieLoader';
import { FCAFallbackManager } from '../adapters/messenger/fca/FCAFallbackManager';
import { MultiAccountManager } from '../adapters/messenger/MultiAccountManager';
import { AccountConnection } from '../adapters/messenger/AccountConnection';
import { messengerAccountsData } from '../db/database';
import { accountRuntimeLogManager } from './AccountRuntimeLogManager';
import { firebaseConfig, FIREBASE_BOT_ROOT } from '../config/firebase';

/**
 * Client Bots Manager — Firebase RTDB edition (Supabase removed).
 *
 * The Supabase tables this manager used map to RTDB nodes under
 * `shipu-messsenger-bot/client-bots/`:
 *   client_bot_sessions  -> client-bots/sessions/{id}
 *   client_bot_queue     -> client-bots/queue/{id}
 *   client_bot_logs      -> client-bots/logs/{botId}/{pushId}
 *   client_bot_metrics   -> client-bots/metrics/{botId}
 *   client_bot_heartbeats-> client-bots/heartbeats/{botId} (+ history, capped)
 *   client_bot_runtime   -> client-bots/runtime/{botId}
 *
 * Supabase Realtime subscriptions are replaced by short-interval polling
 * inside the existing heartbeat/supervisor loops. Public method names and
 * the activation pipeline behavior are unchanged.
 */

function baseUrl(): string {
  return (firebaseConfig.databaseURL || '').replace(/\/+$/, '');
}

function nodeUrl(nodePath: string): string {
  return `${baseUrl()}/${FIREBASE_BOT_ROOT}/client-bots/${nodePath}.json`;
}

async function fbReq(url: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`RTDB HTTP ${res.status}: ${text.slice(0, 150)}`);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(timer);
  }
}

const fbGet = (p: string) => fbReq(nodeUrl(p), { method: 'GET' });
const fbPut = (p: string, v: any) => fbReq(nodeUrl(p), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v ?? null) });
const fbPatch = (p: string, v: any) => fbReq(nodeUrl(p), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
const fbDelete = (p: string) => fbReq(nodeUrl(p), { method: 'DELETE' });
const fbPush = async (p: string, v: any): Promise<string> => {
  const r = await fbReq(nodeUrl(p), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) });
  return String(r?.name || `k_${Date.now()}`);
};

function asList(obj: any): Array<any & { id: string }> {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).map(([id, v]: any) => ({ id, ...(v || {}) }));
}

export class ClientBotsManager {
  private static instance: ClientBotsManager;
  private pollTimer: any = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private supervisorInterval: NodeJS.Timeout | null = null;

  // In-memory runtime registry mapping accountId -> bot state
  private runtimes = new Map<string, {
    sessionId: string;
    botId: string;
    managedVersion: number;
    accountId: string;
    lastSeen: number;
  }>();
  private activationLocks = new Set<string>();
  private knownSessionState = new Map<string, { status: string; version: number }>();
  private knownQueueIds = new Set<string>();

  private fallbackManager = new FCAFallbackManager();

  private constructor() {}

  public static getInstance(): ClientBotsManager {
    if (!ClientBotsManager.instance) {
      ClientBotsManager.instance = new ClientBotsManager();
    }
    return ClientBotsManager.instance;
  }

  /** Firebase is always the configured store (hardcoded credentials). */
  public isConfigured(): boolean {
    return Boolean(baseUrl());
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (!baseUrl()) return { success: false, error: 'Firebase databaseURL is not configured.' };
      await fbGet('sessions');
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  }

  public async init(): Promise<void> {
    this.logConsole('SYSTEM', 'INFO', 'startup', 'Initializing Firebase Client Bots Manager...');

    if (!this.isConfigured()) {
      this.logConsole('SYSTEM', 'WARNING', 'startup', 'Firebase is not configured yet. Client Bots Manager in standby.');
      return;
    }

    try {
      const connTest = await this.testConnection();
      if (!connTest.success) {
        this.logConsole('SYSTEM', 'WARNING', 'startup', `Firebase connection validation failed (${connTest.error}). Client Bots Manager in standby.`);
        return;
      }
    } catch (testErr: any) {
      this.logConsole('SYSTEM', 'WARNING', 'startup', `Firebase connection test threw an error: ${testErr.message}. Client Bots Manager in standby.`);
      return;
    }

    try {
      // 2. Perform startup recovery of previously active bots
      await this.startupScanAndRecover();

      // 3. Start polling watcher (replaces Supabase Realtime subscriptions)
      this.startPollingWatcher();

      // 4. Start 30-Second Heartbeat & Supervisor Loops
      this.startHeartbeatLoop();
      this.startSupervisorLoop();

      this.logConsole('SYSTEM', 'SUCCESS', 'startup', 'Firebase Client Bots Manager active.');
    } catch (err: any) {
      this.logConsole('SYSTEM', 'ERROR', 'startup', `Initialization error: ${err.message}`);
    }
  }

  /**
   * Scans and recovers bots that were left in running or connected states before restart.
   */
  private async startupScanAndRecover(): Promise<void> {
    try {
      const sessions = asList(await fbGet('sessions'));
      const activeSessions = sessions.filter(s =>
        ['running', 'connected', 'recovering', 'logging_in', 'processing', 'pending'].includes(s.status)
      );

      if (activeSessions.length > 0) {
        this.logConsole('SYSTEM', 'INFO', 'recovery', `Found ${activeSessions.length} active client bots. Recovering...`);
        for (const session of activeSessions) {
          this.knownSessionState.set(session.id, { status: session.status, version: session.version || 0 });
          // Push to activation pipeline asynchronously to avoid blocking
          this.activationPipeline(session).catch((err: any) => {
            this.log(session.bot_id, 'ERROR', 'SYSTEM', `Startup recovery failed: ${err.message}`);
          });
        }
      }
    } catch (err: any) {
      this.logConsole('SYSTEM', 'WARNING', 'recovery_error', `Startup scan error: ${err.message}`);
    }
  }

  /**
   * Polling watcher: replaces Supabase Realtime subscriptions.
   * Picks up pending sessions, removals, version bumps and queue commands.
   */
  public startRealtimeSubscriptions(): void {
    this.startPollingWatcher();
  }

  private startPollingWatcher(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(async () => {
      try {
        const sessions = asList(await fbGet('sessions'));
        for (const record of sessions) {
          const prev = this.knownSessionState.get(record.id);
          const version = record.version || 0;
          if (!prev) {
            this.knownSessionState.set(record.id, { status: record.status, version });
            if (record.status === 'pending') {
              this.log(record.bot_id, 'INFO', 'SESSION', `Watcher detected new pending bot. Enqueuing for sync.`);
              this.activationPipeline(record).catch(() => {});
            }
            continue;
          }
          if (record.status === 'pending' && prev.status !== 'pending') {
            this.log(record.bot_id, 'INFO', 'SESSION', `Watcher detected status pending. Starting sync.`);
            this.activationPipeline(record).catch(() => {});
          } else if (record.status === 'removed' && prev.status !== 'removed') {
            this.log(record.bot_id, 'INFO', 'SESSION', `Watcher detected status removed. Tearing down.`);
            this.handleDeleteFlow(record.bot_id).catch(() => {});
          } else if (version > prev.version) {
            this.log(record.bot_id, 'INFO', 'SESSION', `Cookie version bump detected (v${prev.version} -> v${version}). Hot-reloading...`);
            this.activationPipeline(record).catch(() => {});
          }
          this.knownSessionState.set(record.id, { status: record.status, version });
        }

        const queue = asList(await fbGet('queue'));
        for (const item of queue) {
          if (item.status !== 'pending' || this.knownQueueIds.has(item.id)) continue;
          this.knownQueueIds.add(item.id);
          this.log(item.bot_id, 'INFO', 'SESSION', `Watcher picked up queue command: ${item.action}`);
          this.processQueueItem(item).catch(() => {});
          if (this.knownQueueIds.size > 500) {
            const first = this.knownQueueIds.values().next().value;
            this.knownQueueIds.delete(first);
          }
        }
      } catch (err: any) {
        this.logConsole('SYSTEM', 'WARNING', 'watcher_error', `Polling watcher error: ${err.message}`);
      }
    }, 15000);
    if (typeof (this.pollTimer as any)?.unref === 'function') (this.pollTimer as any).unref();
  }

  private async updateSession(id: string, patch: any): Promise<void> {
    await fbPatch(`sessions/${encodeURIComponent(id)}`, { ...patch, updated_at: new Date().toISOString() });
  }

  private async getSessionByBotId(botId: string): Promise<any | null> {
    const sessions = asList(await fbGet('sessions'));
    return sessions.find(s => s.bot_id === botId) || null;
  }

  private async getSessionById(id: string): Promise<any | null> {
    const s = await fbGet(`sessions/${encodeURIComponent(id)}`);
    return s ? { id, ...s } : null;
  }

  /**
   * Processes a task item in the client queue.
   */
  private async processQueueItem(item: any): Promise<void> {
    await fbPatch(`queue/${encodeURIComponent(item.id)}`, { status: 'processing' });

    try {
      const session = await this.getSessionByBotId(item.bot_id);

      if (!session) {
        throw new Error('Associated bot session not found.');
      }

      if (item.action === 'SYNC' || item.action === 'REFRESH' || item.action === 'RESTART') {
        await this.activationPipeline(session);
      } else if (item.action === 'DELETE' || item.action === 'LOGOUT') {
        await this.handleDeleteFlow(item.bot_id);
      } else if (item.action === 'RECONNECT') {
        await this.reconnectBot(item.bot_id);
      }

      await fbPatch(`queue/${encodeURIComponent(item.id)}`, { status: 'completed' });
    } catch (err: any) {
      this.log(item.bot_id, 'ERROR', 'SYSTEM', `Queue processing failed: ${err.message}`);
      await fbPatch(`queue/${encodeURIComponent(item.id)}`, { status: 'failed', last_error: err.message });
    }
  }

  /**
   * The Centralized Activation Pipeline:
   * Validates Cookie -> Decrypts -> FB Login -> Select FCA -> Restore Session -> Connect MQTT -> Run
   */
  public async activationPipeline(session: any): Promise<void> {
    const botId = session.bot_id;
    const accountId = `cloud_${botId}`;

    if (this.activationLocks.has(accountId)) {
      this.log(botId, 'INFO', 'SESSION', 'Activation pipeline already running for this bot. Skipping duplicate event.');
      return;
    }
    this.activationLocks.add(accountId);

    try {
      this.log(botId, 'INFO', 'SESSION', 'Starting client bot activation pipeline...');
      await this.updateSession(session.id, { status: 'processing' });

      // 1. Cookie validation stage
      await this.updateSession(session.id, { status: 'validating' });
      const valResult = CookieLoader.validateCookieJson(session.cookie);
      if (!valResult.valid) {
        const err = valResult.error || 'Invalid cookie format';
        this.log(botId, 'ERROR', 'AUTH', `Cookie validation failed: ${err}`);
        await this.updateSession(session.id, { status: 'failed', last_error: err });
        return;
      }
      this.log(botId, 'SUCCESS', 'AUTH', 'Cookie format validation passed.');

      // 2. FB login & authentication stage
      await this.updateSession(session.id, { status: 'logging_in' });
      this.log(botId, 'INFO', 'LOGIN', 'Authenticating and selecting FCA provider...');

      const parsedCookies = coerceAppState(session.cookie);
      if (parsedCookies.length === 0) {
        throw new Error('Cookie payload contained no usable cookies');
      }
      const authResult = await this.fallbackManager.authenticate(parsedCookies);

      if (!authResult.connection) {
        const authErr = authResult.failureReason || 'FCA authentication failed';
        this.log(botId, 'ERROR', 'LOGIN', `FCA Authentication failed: ${authErr}. Preserving existing session if active.`);

        const existing = this.runtimes.get(accountId);
        if (existing) {
          await this.updateSession(session.id, { status: 'running', last_error: `Update failed: ${authErr}. Reverted to previous session.` });
        } else {
          await this.updateSession(session.id, { status: 'failed', last_error: authErr });
        }
        return;
      }

      // Stop current instance if running for version upgrade / hot reload
      const existing = this.runtimes.get(accountId);
      if (existing) {
        this.log(botId, 'INFO', 'SESSION', `Replacing current active instance (v${existing.managedVersion} -> v${session.version})`);
        await this.stopAccount(accountId);
      }

      this.log(botId, 'SUCCESS', 'LOGIN', `FB Login successful via ${authResult.activeProviderName}`);
      await this.updateSession(session.id, { status: 'connected' });

      // 3. Construct DB Record in memory (persisted to Firebase below)
      const encryptedAuthState = encryptAuthState(session.cookie);
      const dbRecord = {
        accountId,
        uid: valResult.userId || botId,
        slotId: session.slot_id || '',
        botId: session.bot_id,
        displayName: session.owner || 'Client Bot',
        authType: 'cookie',
        provider: authResult.activeProviderName || 'FCA',
        encryptedAuthState,
        status: 'CONNECTED',
        mqttStatus: 'OFF',
        creationSource: 'CLIENT_SYNC',
        source: 'client',
        botEnabled: true,
        enabled: true,
        aiEnabled: true,
        connectionMode: session.connection_mode || 'default',
        dbName: session.db_name || '',
        updatedAt: Date.now()
      } as any;

      // 4. Initialize MQTT connection and start receiving messages
      await this.updateSession(session.id, { status: 'mqtt_connecting' });
      this.log(botId, 'INFO', 'MQTT', 'Establishing MQTT listening session...');

      const multiMgr = MultiAccountManager.getInstance();
      let connection = multiMgr.getAccountConnection(accountId);

      if (!connection) {
        connection = new AccountConnection(dbRecord);
        connection.registerEventListener((evt) => {
          if (evt && (evt.type === 'message' || evt.type === 'message_reply' || Boolean(evt.body))) {
            connection?.recordIncomingMessage(
              String(evt.threadID || evt.thread_fbid || ''),
              String(evt.senderID || evt.senderId || evt.author || ''),
              String(evt.messageID || evt.messageId || '')
            );
          }
        });
        multiMgr.addAccountConnection(accountId, connection);
      } else {
        connection.updateRecord(dbRecord);
      }

      // Reuse the session authenticated above. connect() would otherwise
      // decrypt dbRecord.encryptedAuthState and perform a second Facebook
      // login for the same account.
      connection.setFcaConnection(authResult.connection, authResult.activeProviderName);

      const connected = await connection.connect();

      if (connected) {
        this.log(botId, 'SUCCESS', 'SYSTEM', 'Client bot engine fully active and running.');

        // Persist to Firebase database store for synchronization and recovery
        try {
          await messengerAccountsData.upsert(dbRecord);
        } catch (err: any) {
          this.log(botId, 'ERROR', 'DATABASE', `Failed to persist account to database: ${err.message}`);
        }

        await this.updateSession(session.id, {
          status: 'running',
          last_login: new Date().toISOString(),
          last_error: ''
        });

        // Register running instance in registry
        this.runtimes.set(accountId, {
          sessionId: session.id,
          botId: botId,
          managedVersion: session.version,
          accountId: accountId,
          lastSeen: Date.now()
        });

        // Initialize metrics record in Firebase
        await fbPut(`metrics/${encodeURIComponent(botId)}`, {
          bot_id: botId,
          total_messages: 0,
          ai_messages: 0,
          reconnects: 0,
          updated_at: new Date().toISOString()
        });

      } else {
        throw new Error('MQTT connection handshake timed out');
      }

    } catch (err: any) {
      this.log(botId, 'ERROR', 'SYSTEM', `Pipeline Error: ${err.message}`);
      await this.updateSession(session.id, {
        status: 'failed',
        last_error: err.message
      });
    } finally {
      this.activationLocks.delete(accountId);
    }
  }

  /**
   * Direct manual reconnection triggered by user / recovery engine.
   */
  public async reconnectBot(botId: string): Promise<void> {
    const accountId = `cloud_${botId}`;
    this.log(botId, 'INFO', 'SYSTEM', 'Manual reconnect triggered. Restarting pipeline...');
    await this.stopAccount(accountId);

    const session = await this.getSessionByBotId(botId);

    if (session) {
      await this.activationPipeline(session);
    }
  }

  /**
   * Safe teardown & deletion flow of client bot.
   */
  public async handleDeleteFlow(botId: string): Promise<void> {
    const accountId = `cloud_${botId}`;
    this.log(botId, 'WARNING', 'SESSION', 'Client bot deletion / teardown triggered.');

    await this.stopAccount(accountId);
    this.runtimes.delete(accountId);

    // Clean up local database sync mirroring
    try {
      await messengerAccountsData.delete(accountId);
    } catch {}

    // Update Firebase session status to removed if still exists
    try {
      const session = await this.getSessionByBotId(botId);
      if (session) {
        await this.updateSession(session.id, { status: 'removed' });
      }
    } catch {}

    this.log(botId, 'INFO', 'SESSION', 'Client bot successfully terminated & resources released.');
  }

  /**
   * Stops an account's execution and releases all listeners.
   */
  private async stopAccount(accountId: string): Promise<void> {
    const multiMgr = MultiAccountManager.getInstance();
    try {
      await multiMgr.disconnectAccount(accountId);
      await multiMgr.removeAccount(accountId);
    } catch (err: any) {
      console.error(`[ClientBotsManager] Error stopping account ${accountId}:`, err.message);
    }
  }

  /** List all client bot sessions (used by the dashboard API). */
  public async listSessions(): Promise<any[]> {
    try {
      return asList(await fbGet('sessions'));
    } catch {
      return [];
    }
  }

  /**
   * Writes live logs to the Firebase client-bots log node (capped per bot).
   */
  public async log(botId: string, level: 'INFO' | 'WARNING' | 'ERROR' | 'SUCCESS', category: string, message: string, details: any = {}): Promise<void> {
    const timestamp = new Date().toISOString();
    const prefix = `[CLIENT_BOT][${category}][${level}] [${botId}]`;
    console.log(`${prefix} ${message}`);

    // Map log to local Runtime Log Manager for global console view
    const accountId = `cloud_${botId}`;
    const mappedLevel: 'INFO' | 'SUCCESS' | 'WARN' | 'ERROR' | 'DEBUG' =
      level === 'ERROR' ? 'ERROR' :
      level === 'WARNING' ? 'WARN' : 'INFO';

    accountRuntimeLogManager.addLog(accountId, {
      level: mappedLevel,
      category: category as any,
      message,
      details,
      accountId,
      accountName: 'Client Bot',
      uid: botId,
      provider: 'FirebaseClient',
      mqttStatus: 'OFF',
      stage: category
    });

    // Mirror to Firebase logs (capped at 200 entries per bot)
    try {
      const key = await fbPush(`logs/${encodeURIComponent(botId)}`, {
        bot_id: botId,
        level,
        category,
        message,
        details: typeof details === 'object' ? details : { raw: details },
        created_at: timestamp
      });
      void key;
      const existing = asList(await fbGet(`logs/${encodeURIComponent(botId)}`));
      if (existing.length > 200) {
        const sorted = existing.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
        for (const stale of sorted.slice(0, existing.length - 200)) {
          await fbDelete(`logs/${encodeURIComponent(botId)}/${encodeURIComponent(stale.id)}`);
        }
      }
    } catch (err: any) {
      console.error(`[ClientBotsManager] Failed to write live log to Firebase: ${err.message}`);
    }
  }

  private logConsole(tag: string, level: string, action: string, message: string): void {
    console.log(`[CLIENT_BOT_MANAGER][${tag}][${level}][${action}] ${message}`);
  }

  /**
   * Periodic loop updating bot heartbeats to Firebase every 30 seconds.
   */
  private startHeartbeatLoop(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    this.heartbeatInterval = setInterval(async () => {
      const multiMgr = MultiAccountManager.getInstance();

      const memUsage = process.memoryUsage();
      const heapMB = Math.round((memUsage.heapUsed / 1024 / 1024) * 100) / 100;

      for (const [accountId, runtime] of this.runtimes.entries()) {
        const conn = multiMgr.getAccountConnection(accountId);
        if (!conn) continue;

        const stats = conn.getSafeMetadata();
        const isOnline = conn.status === 'CONNECTED' || conn.status === 'ONLINE' || conn.status === 'AI_READY';

        try {
          const fbStatus = conn.status || 'DISCONNECTED';
          const mqttStatus = conn.mqttStatus || 'OFF';

          // Update active heartbeats node (latest + capped history)
          await fbPut(`heartbeats/${encodeURIComponent(runtime.botId)}/latest`, {
            bot_id: runtime.botId,
            session_id: runtime.sessionId,
            status: isOnline ? 'running' : 'offline',
            messages_today: stats.stats?.messagesToday || 0,
            commands_today: stats.stats?.aiMessages || 0,
            errors_today: stats.lastErrorCode ? 1 : 0,
            uptime_seconds: Math.floor((Date.now() - runtime.lastSeen) / 1000),
            cpu_usage: 1.5, // approximate
            memory_usage: heapMB,
            mqtt_status: mqttStatus,
            facebook_status: fbStatus,
            created_at: new Date().toISOString()
          });

          // Update main session heartbeat
          const session = await this.getSessionById(runtime.sessionId);
          if (session) {
            await this.updateSession(runtime.sessionId, { last_heartbeat: new Date().toISOString() });
          }

          // Update runtime metrics
          await fbPut(`runtime/${encodeURIComponent(runtime.botId)}`, {
            bot_id: runtime.botId,
            cpu: 1.5,
            memory: heapMB,
            uptime: Math.floor((Date.now() - runtime.lastSeen) / 1000),
            last_updated: new Date().toISOString()
          });

          // Update metrics
          if (stats.stats) {
            await fbPut(`metrics/${encodeURIComponent(runtime.botId)}`, {
              bot_id: runtime.botId,
              total_messages: stats.stats.totalMessages || 0,
              ai_messages: stats.stats.aiMessages || 0,
              reconnects: stats.reconnectCount || 0,
              uptime_ms: stats.sessionDurationMs || 0,
              updated_at: new Date().toISOString()
            });
          }

        } catch (err: any) {
          console.error(`[ClientBotsManager] Heartbeat failure for ${runtime.botId}:`, err.message);
        }
      }
    }, 30000); // 30 seconds interval as per requirement
  }

  /**
   * Supervisor loop running every 30 seconds to automatically recover broken connections.
   */
  private startSupervisorLoop(): void {
    if (this.supervisorInterval) clearInterval(this.supervisorInterval);

    this.supervisorInterval = setInterval(async () => {
      const multiMgr = MultiAccountManager.getInstance();

      for (const [accountId, runtime] of this.runtimes.entries()) {
        const conn = multiMgr.getAccountConnection(accountId);

        // Auto-recovery triggering if bot went offline or disconnected unexpectedly
        if (!conn || (conn.status !== 'CONNECTED' && conn.status !== 'ONLINE' && conn.status !== 'AI_READY')) {
          this.log(runtime.botId, 'WARNING', 'SYSTEM', 'Unexpected disconnection detected. Attempting automatic recovery...');

          const session = await this.getSessionById(runtime.sessionId);

          if (session && session.status !== 'removed') {
            await this.updateSession(runtime.sessionId, { status: 'recovering' });
            this.activationPipeline(session).catch((err: any) => {
              this.log(runtime.botId, 'ERROR', 'SYSTEM', `Auto recovery failed: ${err.message}`);
            });
          }
        }
      }
    }, 30000); // 30 seconds check
  }

  public shutdown(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    if (this.supervisorInterval) clearInterval(this.supervisorInterval);
  }
}

export const clientBotsManager = ClientBotsManager.getInstance();
export default clientBotsManager;
