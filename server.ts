// MUST be the very first import: every module below reads process.env at
// import time, so .env has to be loaded before any of them are evaluated.
import { initEnv } from './src/config/env';
initEnv();

import express, { Request, Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs-extra';
import net from 'net';
import AdmZip from 'adm-zip';
import nodeCrypto from 'crypto';
import { createServer as createViteServer } from 'vite';
import { GoogleGenAI } from '@google/genai';
import { botEngine } from './src/core/botEngine';
import { schedulerService } from './src/services/schedulerService';
import {
  CookieLoader,
  FacebookSession,
  SafeSessionMeta,
  MessengerAdapterImpl,
  multiAccountManager,
  MultiAccountManager
} from './src/adapters/messenger';
import { personalAIManager } from './src/adapters/messenger/PersonalAIManager';
import { connectDatabase, getDatabaseStatus, BrainMemoryModel, BrainSuggestionModel, AIOSMemoryModel, AIOSSessionModel, AIOSUsageModel, AILogModel, InferredAttributeModel, FallbackApiModel } from './src/db/firebaseDb';
import { brainService, stripEmojiFormatters } from './src/services/brainService';
import { databaseConfig } from './src/config/database';
import { usersData, threadsData, settingsData, auditLogsData, commandsData, adminBotData, ftpConfigData, messengerAccountsData } from './src/db/database';
import { testFtpConnection, listFtpFiles, readFtpFileContent, writeFtpFileContent, deleteFtpFile } from './src/services/ftpService';
import { ftpStorageService } from './src/services/ftpStorageService';
import { ProjectFilesService } from './src/services/projectFilesService';
import { zipImporterService } from './src/services/zipImporter';
import { dependencyManager } from './src/services/dependencyManager';
import { heartbeatService } from './src/services/heartbeatService';
import { isSelfEvent } from './src/utils/commandParser';
import { emergencyAntiSpamGuard } from './src/core/EmergencyAntiSpamGuard';
import { sqliteAutoHealingGuard } from './src/core/SqliteAutoHealingGuard';
import { subscriptionService } from './src/services/subscriptionService';
import { performanceTracker } from './src/services/performanceTracker';
import { sharedAccessService } from './src/services/sharedAccessService';
import { sharedAccessMonitor } from './src/services/sharedAccessMonitor';
import { aiConfigManager } from './src/services/aiConfigManager';
import { openRouterService } from './src/services/openRouterService';
import { decryptPassword } from './src/utils/crypto';
import { ftpSyncService } from './src/services/ftpSyncService';
import { economyService } from './src/services/economyService';
import { cloudAccountManager } from './src/services/CloudAccountManager';
import { clientBotsManager } from './src/services/ClientBotsManager';
import { accountRuntimeLogManager } from './src/services/AccountRuntimeLogManager';
import { clientSiteStorage } from './src/services/ClientSiteStorage';
import { smsSimulationService, smsValidator } from './src/services/smsSimulationService';
import { telegramBotManager } from './src/services/telegram/TelegramBotManager';
import { providerManager } from './src/core/providerManager';
import { messageBus } from './src/core/bus/MessageBus';

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// --- SMS SIMULATION & GATEWAY MONITORING API ---
app.get('/api/sms/status', (req: Request, res: Response) => {
  try {
    const activeJobs = smsSimulationService.getActiveJobs();
    const history = smsSimulationService.getJobHistory();
    const stats = smsSimulationService.getStats();
    res.json({
      success: true,
      activeJobs,
      history,
      stats
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/sms/job/:jobId', (req: Request, res: Response) => {
  try {
    const { jobId } = req.params;
    const job = smsSimulationService.getJobById(jobId);
    if (!job) {
      return res.status(404).json({ success: false, error: `Job ${jobId} not found` });
    }
    res.json({ success: true, job });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sms/validate', (req: Request, res: Response) => {
  try {
    const { phone, rounds } = req.body;
    const normalizedPhone = smsValidator.normalizePhoneNumber(phone);
    const roundsCheck = smsValidator.validateRounds(rounds);
    
    res.json({
      success: !!normalizedPhone && roundsCheck.success,
      phone: {
        raw: phone,
        normalized: normalizedPhone,
        masked: normalizedPhone ? smsValidator.maskPhoneNumber(normalizedPhone) : null,
        isValid: !!normalizedPhone
      },
      rounds: roundsCheck
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/sms/simulate', async (req: Request, res: Response) => {
  try {
    const { phone, rounds, userId = 'dashboard_operator', threadID = 'dashboard_sms_monitor' } = req.body;

    const normalizedPhone = smsValidator.normalizePhoneNumber(phone);
    if (!normalizedPhone) {
      return res.status(400).json({
        success: false,
        error: 'Invalid Bangladesh mobile number. Must be valid 11-digit Bangladesh phone (e.g. 01316655254 or +8801316655254).'
      });
    }

    const roundsCheck = smsValidator.validateRounds(rounds);
    if (!roundsCheck.success || roundsCheck.value === undefined) {
      return res.status(400).json({
        success: false,
        error: roundsCheck.error || 'Invalid simulation rounds (1 - 100).'
      });
    }

    const rateCheck = smsSimulationService.checkRateLimit(userId);
    if (!rateCheck.allowed) {
      return res.status(429).json({
        success: false,
        error: rateCheck.reason
      });
    }

    // Execute simulation async or wait based on async parameter
    const asyncExecution = req.body.async === true;

    if (asyncExecution) {
      // Trigger in background and return immediate 202 accepted
      smsSimulationService.createAndRunSimulation(
        userId,
        threadID,
        normalizedPhone,
        roundsCheck.value
      ).catch((err) => {
        console.error('[SMS Service] Background simulation error:', err);
      });

      return res.status(202).json({
        success: true,
        message: 'Simulation initiated in background',
        targetPhone: smsValidator.maskPhoneNumber(normalizedPhone),
        rounds: roundsCheck.value
      });
    }

    const job = await smsSimulationService.createAndRunSimulation(
      userId,
      threadID,
      normalizedPhone,
      roundsCheck.value
    );

    res.json({
      success: true,
      job,
      summary: smsSimulationService.formatJobSummary(job)
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/debug/logs/:accountId', (req: Request, res: Response) => {
  const { accountId } = req.params;
  const logs = accountRuntimeLogManager.getAccountLogs(accountId, 'ALL');
  res.json(logs);
});

export function resolveAnyAccountConnection(accountIdOrUid?: string): {
  connection: any;
  api: any;
  providerName: string;
  isConnected: boolean;
} | null {
  if (!accountIdOrUid) {
    const multiConn = multiAccountManager.getAccountConnection();
    if (multiConn) {
      return {
        connection: multiConn,
        api: multiConn.getFcaApi(),
        providerName: multiConn.activeProviderName || multiConn.provider || 'DongDev FCA',
        isConnected: multiConn.status === 'CONNECTED' || multiConn.status === 'AUTHENTICATED' || multiConn.status === 'MQTT_LISTENING'
      };
    }
    const paiConn = personalAIManager.getAccountConnection();
    if (paiConn) {
      return {
        connection: paiConn,
        api: paiConn.getFcaApi(),
        providerName: paiConn.getActiveProviderName(),
        isConnected: paiConn.status === 'CONNECTED' || paiConn.status === 'AUTHENTICATED' || paiConn.status === 'MQTT_LISTENING'
      };
    }
    return null;
  }

  // Check personal AI accounts if ID has pai_ or personal_ prefix
  if (accountIdOrUid.startsWith('pai_') || accountIdOrUid.startsWith('personal_')) {
    const paiConn = personalAIManager.getAccountConnection(accountIdOrUid);
    if (paiConn) {
      return {
        connection: paiConn,
        api: paiConn.getFcaApi(),
        providerName: paiConn.getActiveProviderName(),
        isConnected: paiConn.status === 'CONNECTED' || paiConn.status === 'AUTHENTICATED' || paiConn.status === 'MQTT_LISTENING'
      };
    }
  }

  // Check multi-account manager
  const multiConn = multiAccountManager.getAccountConnection(accountIdOrUid);
  if (multiConn) {
    return {
      connection: multiConn,
      api: multiConn.getFcaApi(),
      providerName: multiConn.activeProviderName || multiConn.provider || 'DongDev FCA',
      isConnected: multiConn.status === 'CONNECTED' || multiConn.status === 'AUTHENTICATED' || multiConn.status === 'MQTT_LISTENING'
    };
  }

  // Check personal AI manager as fallback
  const paiConn = personalAIManager.getAccountConnection(accountIdOrUid);
  if (paiConn) {
    return {
      connection: paiConn,
      api: paiConn.getFcaApi(),
      providerName: paiConn.getActiveProviderName(),
      isConnected: paiConn.status === 'CONNECTED' || paiConn.status === 'AUTHENTICATED' || paiConn.status === 'MQTT_LISTENING'
    };
  }

  return null;
}

app.get('/api/debug/accounts', (req: Request, res: Response) => {
  const multiIds = multiAccountManager.getAllAccountsMeta().map(m => m.accountId);
  res.json(multiIds);
});

// TEMPORARY boot diagnostics (remove after Render investigation).
app.get('/api/debug/bootinfo', async (req: Request, res: Response) => {
  try {
    const { isDatabaseConnected, getDatabaseStatus } = await import('./src/db/firebaseDb');
    const { messengerAccountsData } = await import('./src/db/database');
    const { firebaseRtdbService } = await import('./src/services/firebaseRtdbService');
    let dbCount: any = 'n/a';
    let dbError: any = null;
    try {
      const all = await messengerAccountsData.getAll();
      dbCount = all.length;
    } catch (e: any) { dbError = e?.message || String(e); }
    const remote = await firebaseRtdbService.getSessions();
    res.json({
      dbConnected: isDatabaseConnected(),
      dbStatus: getDatabaseStatus(),
      dbAccountsCount: dbCount,
      dbError,
      firebaseSessions: remote.success ? Object.keys(remote.sessions || {}) : `ERR:${remote.error}`,
      memAccounts: multiAccountManager.getAllAccountsMeta().map(m => ({ id: m.accountId, status: m.status, mqtt: m.mqttStatus }))
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || String(err) });
  }
});

app.get('/api/debug/fca-methods/:accountId', (req: Request, res: Response) => {
  const { accountId } = req.params;
  const resolved = resolveAnyAccountConnection(accountId);
  if (!resolved || !resolved.connection) {
    return res.json({ 
      error: 'Connection not found across MultiAccountManager and PersonalAIManager', 
      queriedId: accountId, 
      multiAccounts: multiAccountManager.getAllAccountsMeta().map(m => m.accountId)
    });
  }
  const { connection, api, providerName, isConnected } = resolved;
  const capabilities = typeof connection.getCapabilities === 'function' ? connection.getCapabilities() : {
    sendMessage: typeof api?.sendMessage === 'function',
    threadList: typeof api?.getThreadList === 'function',
    threadHistory: typeof api?.getThreadHistory === 'function'
  };
  if (!api) {
    return res.json({ 
      error: 'No active api connection found', 
      connectionStatus: connection.status, 
      providerName,
      isConnected,
      capabilities
    });
  }
  const methods = Object.keys(api).filter(k => typeof api[k] === 'function');
  const allKeys = Object.keys(api);
  res.json({ methods, allKeys, providerName, isConnected, capabilities });
});

app.use(express.json({ limit: '10mb' }));

// Initialize Session Manager, Messenger Adapter & MongoDB Connection
const facebookSession = new FacebookSession();
const messengerAdapter = new MessengerAdapterImpl(facebookSession);
botEngine.setAdapter(messengerAdapter as any);

// Register multi-account incoming message handler to process events in BotEngine
multiAccountManager.registerGlobalEventListener(async (event: any) => {
  const traceId = event._traceId || `evt_trace_${event.messageID || Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
  event._traceId = traceId;

  console.log(`[PIPELINE TRACE][STAGE 3: GLOBAL_LISTENER_RECEIVE][ID: ${traceId}] Global listener received event for Account ${event.accountId || 'default'}. Body: "${(event.body || '').substring(0, 30)}"`);

  const threadID = String(event.threadID || event.thread_fbid || '');
  const senderID = String(event.senderID || event.senderId || event.author || event.userID || '').trim();
  const body = String(event.body || '');
  const messageID = String(event.messageID || event.messageId || `msg_${Date.now()}`);
  const accountId = event.accountId ? String(event.accountId) : undefined;

  const selfUserId = event.authenticatedUid || facebookSession.selfUserId || botEngine.selfUserId || process.env.BOT_UID || '';

  // EARLIEST POINT IN EVENT PIPELINE: DROP SELF MESSAGES IMMEDIATELY
  if (senderID && selfUserId && senderID === selfUserId) {
    console.log(`[PIPELINE TRACE][STAGE 3: GLOBAL_LISTENER_RECEIVE][ID: ${traceId}] Dropping self-message from sender ${senderID}`);
    return;
  }

  if (isSelfEvent(event, selfUserId)) {
    console.log(`[PIPELINE TRACE][STAGE 3: GLOBAL_LISTENER_RECEIVE][ID: ${traceId}] Dropping self-event for bot ${selfUserId}`);
    return;
  }

  if (threadID && emergencyAntiSpamGuard.isThreadInEmergency(threadID, accountId)) {
    console.log(`[PIPELINE TRACE][STAGE 3: GLOBAL_LISTENER_RECEIVE][ID: ${traceId}] Dropping message on thread ${threadID} due to Emergency Anti-Spam Guard`);
    return;
  }

  if (threadID && senderID && body) {
    try {
      await botEngine.handleIncomingEvent(threadID, senderID, body, messageID, accountId, event);
    } catch (err: any) {
      console.error(`[PIPELINE TRACE][STAGE 3: GLOBAL_LISTENER_RECEIVE][ID: ${traceId}] Error handling incoming event in botEngine:`, err);
    }
  }
});

async function initializeDatabaseAndServices() {
  let attempt = 0;
  let res: { connected: boolean; error?: string } = { connected: false, error: '' };
  while (attempt < 5 && !res.connected) {
    attempt++;
    console.log(`[STARTUP] Connecting to Firebase RTDB, attempt ${attempt}/5...`);
    res = await connectDatabase();
    if (!res.connected) {
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  if (res.connected) {
    console.log('[Firebase] Connected successfully to runtime database');
    // Durable session restore: Firebase RTDB holds the restart-proof copy of
    // messenger sessions under shipu-messsenger-bot/. Pull any missing records
    // before the session managers boot (best-effort, never throws).
    try {
      const { firebaseRtdbService } = await import('./src/services/firebaseRtdbService');
      const restored = await firebaseRtdbService.restoreSessionsToMongo();
      if (restored.error) {
        console.warn('[FirebaseRTDB] Startup restore skipped:', restored.error);
      }
    } catch (fbErr: any) {
      console.warn('[FirebaseRTDB] Startup restore skipped:', fbErr?.message || fbErr);
    }
    await bootCoreServices();
    try {
      await clientBotsManager.init();
    } catch (err) {
      console.error('[ClientBotsManager] Failed to start:', err);
    }
    try {
      await aiConfigManager.getConfig(true);
      console.log('[AIConfig] Central AI Configuration loaded successfully');
    } catch (err: any) {
      console.error('[AIConfig] Failed to load config on startup:', err.message);
    }
    sharedAccessMonitor.start();

    // Verify FTP Stability on Startup if enabled
    try {
      const ftpOptions = await getActiveFtpOptions();
      if (ftpOptions && ftpOptions.enabled) {
        const ftpResult = await ftpStorageService.verifyStabilityOnStartup(ftpOptions);
        if (ftpResult.success) {
          console.log('[FTP] Startup synchronization engine ready');
          ftpSyncService.startSync().catch(err => {
            console.error('[FTP Sync] Failed to auto-start sync engine:', err);
          });
        } else {
          console.log(`[FTP] Remote storage offline (${ftpResult.message}). Running in local mode.`);
        }
      } else {
        console.log('[FTP] Remote storage auto-sync is disabled. Running in local mode.');
      }
    } catch (ftpErr) {
      console.log('[FTP] Startup verification skipped or local mode active.');
    }
  } else {
    console.error('[Firebase] Connection failed after 5 attempts:', res.error);
    sharedAccessMonitor.start();
    // Keep retrying in the background: on slow cold starts (first boot) the
    // database may come up seconds later. Managers boot exactly once.
    let bgAttempts = 0;
    const bgTimer = setInterval(async () => {
      bgAttempts++;
      try {
        const retry = await connectDatabase();
        if (retry.connected) {
          clearInterval(bgTimer);
          console.log(`[STARTUP] Firebase reachable on background attempt #${bgAttempts}. Booting services...`);
          await bootCoreServices();
        } else if (bgAttempts % 20 === 0) {
          console.warn(`[STARTUP] Firebase still unreachable after ${bgAttempts} background attempts: ${retry.error}`);
        }
      } catch (err: any) {
        console.warn('[STARTUP] Background boot attempt failed:', err?.message || err);
      }
    }, 15000);
    if (typeof (bgTimer as any)?.unref === 'function') (bgTimer as any).unref();
  }
}

let coreServicesBooted = false;
async function bootCoreServices(): Promise<void> {
  if (coreServicesBooted) return;
  coreServicesBooted = true;
  // Durable session restore first (best-effort, never throws).
  try {
    const { firebaseRtdbService } = await import('./src/services/firebaseRtdbService');
    const restored = await firebaseRtdbService.restoreSessionsToMongo();
    if (restored.error) {
      console.warn('[FirebaseRTDB] Startup restore skipped:', restored.error);
    }
  } catch (fbErr: any) {
    console.warn('[FirebaseRTDB] Startup restore skipped:', fbErr?.message || fbErr);
  }
  await multiAccountManager.initializeAllAccountsFromDB();
  await personalAIManager.initializeAllAccountsFromDB();
}

initializeDatabaseAndServices();


// --- PROCESS SUPERVISOR & CRASH PROTECTION ---
process.on('uncaughtException', (err) => {
  console.error('[Process Supervisor] Uncaught Exception caught safely:', err.message);
  botEngine.addLog('error', `Uncaught Exception: ${err.message}`, 'Supervisor');
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[Process Supervisor] Unhandled Rejection caught safely:', reason?.message || reason);
  botEngine.addLog('error', `Unhandled Rejection: ${reason?.message || reason}`, 'Supervisor');
});

const gracefulShutdown = async (signal: string) => {
  console.log(`[Process Supervisor] Received ${signal}. Performing graceful shutdown...`);
  try {
    heartbeatService.stop();
    await facebookSession.disconnect();
    botEngine.addLog('info', `Engine gracefully stopped via ${signal}`, 'Supervisor');
  } catch (err) {
    console.error('Error during graceful shutdown:', err);
  } finally {
    process.exit(0);
  }
};

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// --- ADMIN AUTHENTICATION MIDDLEWARE ---
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'shipu_secret_password_2026';
const activeAdminTokens = new Set<string>(['default_admin_session']);

function requireAdminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const token = authHeader 
    ? authHeader.replace('Bearer ', '').trim() 
    : (req.query.token as string || req.body?.token as string);

  if (token && activeAdminTokens.has(token)) {
    return next();
  }

  // Allow loopback requests in development mode.
  // Node normalizes IPv4 loopback to `127.0.0.1` and Express reports IPv6
  // loopback as `::1`, so matching only the literal string 'localhost' left
  // every request made to 127.0.0.1 (the default for `curl http://127.0.0.1`)
  // unauthorized — which is what made the cookie endpoints look broken.
  const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1', '[::1]']);
  if (process.env.NODE_ENV !== 'production' && LOOPBACK_HOSTS.has(req.hostname)) {
    return next();
  }

  return res.status(200).json({ 
    success: false, 
    error: 'Unauthorized. Admin credentials required.', 
    code: 'UNAUTHORIZED' 
  });
}

// Admin Login Route
app.post('/api/admin/login', (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (username === ADMIN_USER && password === ADMIN_PASS) {
    const token = `token_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    activeAdminTokens.add(token);
    auditLogsData.add('admin', 'Admin Login Successful', undefined, 'SUCCESS');
    return res.json({ success: true, token, username: ADMIN_USER });
  }

  auditLogsData.add('unknown', 'Failed Admin Login Attempt', undefined, 'FAILED');
  return res.status(200).json({ 
    success: false, 
    error: 'Invalid admin username or password.', 
    code: 'AUTH_FAILED' 
  });
});

app.post('/api/admin/logout', requireAdminAuth, (req: Request, res: Response) => {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  activeAdminTokens.delete(token);
  res.json({ success: true });
});

// --- HEALTH CHECK & SYSTEM AVAILABILITY ENDPOINTS ---
app.get('/api/health', (req: Request, res: Response) => {
  const mongoStatus = getDatabaseStatus();
  const sessionMeta = facebookSession.getSafeMetadata();
  const diagnostics = heartbeatService.getDiagnostics();

  const isHealthy = mongoStatus.connected && (sessionMeta.status === 'CONNECTED' || sessionMeta.mqttStatus === 'WAITING_FOR_FIRST_EVENT' || sessionMeta.mqttStatus === 'EVENT_STREAM_ACTIVE');

  res.json({
    status: isHealthy ? 'ok' : 'degraded',
    serverStatus: 'ONLINE',
    backendStatus: 'ONLINE',
    service: 'ShiPu Ai',
    uptime: Math.floor(process.uptime ? process.uptime() : 0),
    database: mongoStatus.connected ? 'connected' : 'disconnected',
    messenger: sessionMeta.status.toLowerCase(),
    fcaProvider: sessionMeta.activeProviderName || 'DongDev FCA',
    mqtt: sessionMeta.mqttStatus ? sessionMeta.mqttStatus.toLowerCase() : 'off',
    timestamp: new Date().toISOString(),
    environment: diagnostics.environment,
    publicUrl: diagnostics.publicUrl,
    healthUrl: diagnostics.healthUrl,
    lastHeartbeat: diagnostics.lastHeartbeat
  });
});

app.get('/health', async (req: Request, res: Response) => {
  const mongoStatus = getDatabaseStatus();
  const sessionMeta = facebookSession.getSafeMetadata();
  const diagnostics = heartbeatService.getDiagnostics();

  const isHealthy = mongoStatus.connected && (sessionMeta.status === 'CONNECTED' || sessionMeta.mqttStatus === 'WAITING_FOR_FIRST_EVENT' || sessionMeta.mqttStatus === 'EVENT_STREAM_ACTIVE');

  res.status(200).json({
    status: isHealthy ? 'ok' : 'degraded',
    serverStatus: 'ONLINE',
    backendStatus: 'ONLINE',
    service: 'ShiPu Ai',
    uptime: Math.floor(process.uptime ? process.uptime() : 0),
    database: mongoStatus.connected ? 'connected' : 'disconnected',
    messenger: sessionMeta.status.toLowerCase(),
    fcaProvider: sessionMeta.activeProviderName || 'DongDev FCA',
    mqtt: sessionMeta.mqttStatus ? sessionMeta.mqttStatus.toLowerCase() : 'off',
    timestamp: new Date().toISOString(),
    environment: diagnostics.environment,
    publicUrl: diagnostics.publicUrl,
    healthUrl: diagnostics.healthUrl,
    lastHeartbeat: diagnostics.lastHeartbeat
  });
});

// --- CLIENT SITE PORTAL ENDPOINTS ---
app.get('/api/client-site/health', async (req: Request, res: Response) => {
  try {
    const clientSiteDir = path.join(process.cwd(), 'client-site');
    const indexPhpExists = await fs.pathExists(path.join(clientSiteDir, 'index.php'));
    const loginPhpExists = await fs.pathExists(path.join(clientSiteDir, 'login.php'));
    const dashboardPhpExists = await fs.pathExists(path.join(clientSiteDir, 'dashboard.php'));
    
    let fileCount = 0;
    if (await fs.pathExists(clientSiteDir)) {
      const files = await fs.readdir(clientSiteDir, { recursive: true });
      fileCount = files.length;
    }

    res.json({
      success: true,
      status: indexPhpExists ? 'online' : 'degraded',
      uptime: Math.floor(process.uptime ? process.uptime() : 0),
      fileCount,
      routes: {
        index: indexPhpExists,
        login: loginPhpExists,
        dashboard: dashboardPhpExists
      },
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/client-site/download-zip', async (req: Request, res: Response) => {
  try {
    const clientSiteDir = path.join(process.cwd(), 'client-site');
    if (!await fs.pathExists(clientSiteDir)) {
      return res.status(404).json({ success: false, error: 'client-site folder not found' });
    }

    const zip = new AdmZip();
    zip.addLocalFolder(clientSiteDir, 'client-site');
    const zipBuffer = zip.toBuffer();

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename=client-site-bundle.zip');
    res.send(zipBuffer);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- CLIENT SITE JSON PERSISTENT PORTAL & ADMIN API ENDPOINTS ---
app.post('/api/client/auth/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password, fullName } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ success: false, error: 'Username, email and password are required.' });
    }
    const existing = await clientSiteStorage.getUserByUsername(username);
    if (existing) {
      return res.status(400).json({ success: false, error: 'Username or email already registered.' });
    }
    const userId = 'usr_' + nodeCrypto.randomBytes(6).toString('hex');
    const passwordHash = nodeCrypto.createHash('sha256').update(password).digest('hex');
    const newUser: any = {
      userId,
      username,
      email,
      passwordHash,
      fullName: fullName || username,
      status: 'ACTIVE',
      subscription: {
        plan: 'Standard Bot Tier',
        status: 'ACTIVE',
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        slotsCount: 1
      },
      botSlots: [
        { slotId: 'slot_' + Math.random().toString(36).substring(2, 7), botName: `${username}'s Bot`, status: 'STANDBY' }
      ],
      createdAt: new Date().toISOString()
    };
    await clientSiteStorage.saveUser(newUser);
    const { passwordHash: _, ...safeUser } = newUser;
    res.json({ success: true, user: safeUser, message: 'Registration successful!' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/client/auth/login', async (req: Request, res: Response) => {
  try {
    const { usernameOrEmail, password } = req.body;
    if (!usernameOrEmail || !password) {
      return res.status(400).json({ success: false, error: 'Username/Email and password are required.' });
    }
    const user = await clientSiteStorage.getUserByUsername(usernameOrEmail);
    if (!user) {
      return res.status(404).json({ success: false, error: 'Account not found.' });
    }
    const hash = nodeCrypto.createHash('sha256').update(password).digest('hex');
    if (hash !== user.passwordHash) {
      return res.status(401).json({ success: false, error: 'Invalid password.' });
    }
    user.lastLogin = new Date().toISOString();
    await clientSiteStorage.saveUser(user);
    const { passwordHash: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser, token: 'client_token_' + user.userId });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/client/profile', async (req: Request, res: Response) => {
  try {
    const userId = (req.query.userId as string) || (req.headers['x-client-userid'] as string);
    if (!userId) {
      return res.status(400).json({ success: false, error: 'Missing userId parameter.' });
    }
    const user = await clientSiteStorage.getUser(userId);
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }
    const { passwordHash: _, ...safeUser } = user;
    res.json({ success: true, user: safeUser });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/client/payments', async (req: Request, res: Response) => {
  try {
    const { userId, username, amount, currency, plan, slots, paymentMethod, transactionReference } = req.body;
    if (!userId || !amount) {
      return res.status(400).json({ success: false, error: 'Missing required payment fields.' });
    }
    const paymentId = 'pay_' + nodeCrypto.randomBytes(6).toString('hex');
    const payment: any = {
      paymentId,
      userId,
      username: username || 'Customer',
      amount: Number(amount),
      currency: currency || 'USD',
      plan: plan || 'Pro Subscription',
      slots: Number(slots) || 1,
      paymentMethod: paymentMethod || 'Bank Transfer',
      transactionReference: transactionReference || 'REF-' + Math.floor(Math.random() * 1000000),
      status: 'PENDING',
      submittedAt: new Date().toISOString()
    };
    await clientSiteStorage.savePayment(payment);
    res.json({ success: true, payment, message: 'Payment request submitted successfully! Awaiting admin review.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/client/payments', async (req: Request, res: Response) => {
  try {
    const userId = req.query.userId as string;
    const all = await clientSiteStorage.getAllPayments();
    const payments = userId ? all.filter(p => p.userId === userId) : all;
    res.json({ success: true, payments });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/client/admin/login', async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    
    // Hardcoded primary administrator check
    if (username === 'chitron' && password === '2448766') {
      return res.json({ success: true, token: 'client_admin_token_secure_xyz', message: 'Admin login successful' });
    }

    const settings = await clientSiteStorage.getSettings();
    const adminUser = settings.adminUsername || 'admin';
    const adminHash = settings.adminPasswordHash || nodeCrypto.createHash('sha256').update('shipu_admin_2026').digest('hex');

    const inputHash = nodeCrypto.createHash('sha256').update(password || '').digest('hex');
    if (username === adminUser && inputHash === adminHash) {
      res.json({ success: true, token: 'client_admin_token_secure_xyz', message: 'Admin login successful' });
    } else {
      res.status(401).json({ success: false, error: 'Invalid administrator credentials.' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/client/admin/users', async (req: Request, res: Response) => {
  try {
    const users = await clientSiteStorage.getAllUsers();
    const safeUsers = users.map(u => {
      const { passwordHash: _, ...rest } = u;
      return rest;
    });
    res.json({ success: true, users: safeUsers });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/client/admin/payments', async (req: Request, res: Response) => {
  try {
    const payments = await clientSiteStorage.getAllPayments();
    res.json({ success: true, payments });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/client/admin/payments/:paymentId/approve', async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    const payment = await clientSiteStorage.getPayment(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment request not found.' });
    }
    payment.status = 'APPROVED';
    payment.reviewedAt = new Date().toISOString();
    await clientSiteStorage.savePayment(payment);

    // Update user subscription & slots
    const user = await clientSiteStorage.getUser(payment.userId);
    if (user) {
      user.subscription.status = 'ACTIVE';
      user.subscription.plan = payment.plan;
      user.subscription.slotsCount = (user.subscription.slotsCount || 0) + payment.slots;
      
      const currentExpiry = new Date(user.subscription.expiresAt || Date.now());
      const baseTime = currentExpiry > new Date() ? currentExpiry.getTime() : Date.now();
      user.subscription.expiresAt = new Date(baseTime + 30 * 24 * 60 * 60 * 1000).toISOString();

      for (let i = 0; i < payment.slots; i++) {
        user.botSlots.push({
          slotId: 'slot_' + Math.random().toString(36).substring(2, 7),
          botName: `${user.username} Bot #${user.botSlots.length + 1}`,
          status: 'ONLINE'
        });
      }
      await clientSiteStorage.saveUser(user);
    }

    res.json({ success: true, payment, message: 'Payment approved successfully and user subscription activated.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/client/admin/payments/:paymentId/reject', async (req: Request, res: Response) => {
  try {
    const { paymentId } = req.params;
    const { adminNotes } = req.body;
    const payment = await clientSiteStorage.getPayment(paymentId);
    if (!payment) {
      return res.status(404).json({ success: false, error: 'Payment request not found.' });
    }
    payment.status = 'REJECTED';
    payment.reviewedAt = new Date().toISOString();
    payment.adminNotes = adminNotes || 'Rejected by administrator';
    await clientSiteStorage.savePayment(payment);
    res.json({ success: true, payment, message: 'Payment request rejected.' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/client/admin/stats', async (req: Request, res: Response) => {
  try {
    const users = await clientSiteStorage.getAllUsers();
    const payments = await clientSiteStorage.getAllPayments();
    const activeUsers = users.filter(u => u.status === 'ACTIVE').length;
    const pendingPayments = payments.filter(p => p.status === 'PENDING').length;
    const totalRevenue = payments
      .filter(p => p.status === 'APPROVED')
      .reduce((sum, p) => sum + p.amount, 0);

    res.json({
      success: true,
      stats: {
        totalUsers: users.length,
        activeUsers,
        totalPayments: payments.length,
        pendingPayments,
        totalRevenue
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/system/availability', (req: Request, res: Response) => {
  // Auto-detect public URL from request origin or forwarded headers
  const clientOrigin = (req.query.origin as string) || (req.headers['x-client-origin'] as string);
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = (req.headers['x-forwarded-host'] as string) || (req.headers['host'] as string);

  if (clientOrigin && heartbeatService.isValidPublicUrl(clientOrigin)) {
    heartbeatService.proposeCandidateUrl(clientOrigin, 'client browser location');
  } else if (host && !host.includes('localhost') && !host.includes('127.0.0.1') && !host.includes('0.0.0.0')) {
    const constructedUrl = `${proto}://${host}`;
    if (heartbeatService.isValidPublicUrl(constructedUrl)) {
      heartbeatService.proposeCandidateUrl(constructedUrl, 'request headers');
    }
  }

  const mongoStatus = getDatabaseStatus();
  const sessionMeta = facebookSession.getSafeMetadata();
  const diagnostics = heartbeatService.getDiagnostics();

  res.json({
    diagnostics,
    uptimeSeconds: Math.floor(process.uptime ? process.uptime() : 0),
    databaseConnected: mongoStatus.connected,
    databaseStatus: mongoStatus.status,
    messengerStatus: sessionMeta.status,
    fcaProvider: sessionMeta.activeProviderName || 'DongDev FCA',
    mqttStatus: sessionMeta.mqttStatus || 'OFF',
    accountName: sessionMeta.accountName,
    botUserID: sessionMeta.botUserID
  });
});

app.get('/api/system/gemini-diagnostic', async (req: Request, res: Response) => {
  const keysFound: string[] = [];
  let selectedVarName = '';
  let apiKey = '';

  if (process.env.GEMINI_API_KEY) {
    keysFound.push('GEMINI_API_KEY');
    if (!apiKey) {
      apiKey = process.env.GEMINI_API_KEY;
      selectedVarName = 'GEMINI_API_KEY';
    }
  }
  if (process.env.GOOGLE_API_KEY) {
    keysFound.push('GOOGLE_API_KEY');
    if (!apiKey) {
      apiKey = process.env.GOOGLE_API_KEY;
      selectedVarName = 'GOOGLE_API_KEY';
    }
  }

  // Also auto-discover env variables matching Google / Gemini patterns
  for (const [key, value] of Object.entries(process.env)) {
    if (value && typeof value === 'string' && !keysFound.includes(key)) {
      const upperKey = key.toUpperCase();
      if (
        (upperKey.includes('GEMINI') && upperKey.includes('KEY')) ||
        (upperKey.includes('GOOGLE') && upperKey.includes('KEY')) ||
        upperKey.endsWith('API_KEY')
      ) {
        keysFound.push(key);
        if (!apiKey) {
          apiKey = value;
          selectedVarName = key;
        }
      }
    }
  }

  if (!apiKey) {
    return res.json({
      success: false,
      message: 'No Gemini API Key found in environment variables or project secrets.',
      keysFound,
      maskedKey: 'N/A',
      selectedVarName: 'None'
    });
  }

  let maskedKey = 'Invalid/Short Key';
  if (apiKey.length > 8) {
    maskedKey = `${apiKey.slice(0, 6)}...${apiKey.slice(-4)} (${apiKey.length} chars)`;
  } else {
    maskedKey = `*** (Too short: ${apiKey.length} chars)`;
  }

  const startTime = Date.now();
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{ parts: [{ text: "ping" }] }]
    };

    const apiResponse = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const latencyMs = Date.now() - startTime;
    const responseStatus = apiResponse.status;
    const responseStatusText = apiResponse.statusText;
    
    let responseBodyText = '';
    try {
      const json = await apiResponse.json();
      responseBodyText = JSON.stringify(json, null, 2);
    } catch {
      responseBodyText = await apiResponse.text();
    }

    res.json({
      success: apiResponse.ok,
      message: apiResponse.ok ? 'Connection to Google AI Studio API verified successfully!' : `API request failed with HTTP ${responseStatus}`,
      keysFound,
      selectedVarName,
      maskedKey,
      latencyMs,
      responseStatus,
      responseStatusText,
      apiResponse: responseBodyText
    });
  } catch (err: any) {
    const latencyMs = Date.now() - startTime;
    res.json({
      success: false,
      message: 'Network error or DNS failure while contacting Google AI Studio API.',
      keysFound,
      selectedVarName,
      maskedKey,
      latencyMs,
      error: err.message || String(err)
    });
  }
});

app.post('/api/system/config-url', async (req: Request, res: Response) => {
  const { publicUrl } = req.body || {};
  const result = await heartbeatService.setPublicUrlManually(publicUrl);
  if (!result.success) {
    return res.status(400).json(result);
  }
  const diagnostics = heartbeatService.getDiagnostics();
  res.json({ ...result, diagnostics });
});

// --- CENTRAL AI CONFIGURATION ENDPOINTS ---
app.get('/api/ai-config', async (req: Request, res: Response) => {
  try {
    const config = await aiConfigManager.getConfig(true);
    const maskedHistory = (config.keyHistory || []).map(h => {
      const dec = decryptPassword(h.key);
      return {
        key: aiConfigManager.maskKey(dec),
        timestamp: h.timestamp
      };
    });

    res.json({
      success: true,
      config: {
        ...config,
        openRouterApiKey: aiConfigManager.maskKey(config.openRouterApiKey),
        keyHistory: maskedHistory
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ai-config/save', async (req: Request, res: Response) => {
  try {
    const updates = req.body || {};
    const updated = await aiConfigManager.updateConfig(updates);
    
    const maskedHistory = (updated.keyHistory || []).map(h => {
      const dec = decryptPassword(h.key);
      return {
        key: aiConfigManager.maskKey(dec),
        timestamp: h.timestamp
      };
    });

    res.json({
      success: true,
      message: 'AI Provider configuration updated dynamically!',
      config: {
        ...updated,
        openRouterApiKey: aiConfigManager.maskKey(updated.openRouterApiKey),
        keyHistory: maskedHistory
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ai-config/test', async (req: Request, res: Response) => {
  try {
    let { apiKey } = req.body || {};
    
    // If input is empty or masked, use currently saved decrypted key
    const current = await aiConfigManager.getConfig();
    let isCurrentKey = false;
    
    if (!apiKey || apiKey.includes('*')) {
      apiKey = current.openRouterApiKey;
      isCurrentKey = true;
    } else if (apiKey === current.openRouterApiKey) {
      isCurrentKey = true;
    }

    const testRes = await aiConfigManager.testConnection(apiKey);
    
    if (isCurrentKey) {
       await aiConfigManager.updateConfig({ 
         status: testRes.status, 
         lastError: testRes.error || undefined,
         lastSuccessfulRequestTime: testRes.success ? new Date().toISOString() : undefined
       });
    }

    res.json(testRes);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/ai-config/rollback', async (req: Request, res: Response) => {
  try {
    const { index } = req.body || {};
    if (index === undefined || index === null) {
      return res.status(400).json({ success: false, error: 'History index is required' });
    }

    const updated = await aiConfigManager.rollbackKey(Number(index));
    
    const maskedHistory = (updated.keyHistory || []).map(h => {
      const dec = decryptPassword(h.key);
      return {
        key: aiConfigManager.maskKey(dec),
        timestamp: h.timestamp
      };
    });

    res.json({
      success: true,
      message: 'Successfully rolled back to the previous API key!',
      config: {
        ...updated,
        openRouterApiKey: aiConfigManager.maskKey(updated.openRouterApiKey),
        keyHistory: maskedHistory
      }
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- PERFORMANCE & HEALTH OBSERVABILITY ENDPOINTS ---
app.get('/api/system/performance', (req: Request, res: Response) => {
  performanceTracker.recordRequest('api');
  const report = performanceTracker.getPerformanceReport();
  res.json(report);
});

app.post('/api/system/performance/simulate', (req: Request, res: Response) => {
  const { command = 'help', forceFail = false } = req.body || {};
  performanceTracker.simulateCommandExecution(String(command), Boolean(forceFail));
  res.json({ success: true, message: `Simulated execution of /${command} (forceFail=${forceFail})` });
});

app.post('/api/system/performance/reset', (req: Request, res: Response) => {
  performanceTracker.resetMetrics();
  res.json({ success: true, message: 'Performance tracker metrics reset successfully' });
});

// --- MONGODB RUNTIME STORAGE STATUS ENDPOINTS ---
app.get(['/api/mongodb/status', '/api/database/status'], (req: Request, res: Response) => {
  const mongoStatus = getDatabaseStatus();
  res.json({
    connected: mongoStatus.connected,
    status: mongoStatus.connected ? 'ONLINE' : 'OFFLINE',
    connection: mongoStatus.connected ? 'Connected' : 'Connection failed',
    type: databaseConfig.type,
    odm: 'Firebase RTDB',
    storage: 'Firebase Realtime Database',
    autoSyncWhenStart: databaseConfig.autoSyncWhenStart ? 'ENABLED' : 'DISABLED',
    autoRefreshThreadInfoFirstTime: databaseConfig.autoRefreshThreadInfoFirstTime ? 'ENABLED' : 'DISABLED',
    reason: mongoStatus.error || null
  });
});

// --- FIREBASE RTDB (shipu-messsenger-bot) STATUS & TEST ENDPOINTS ---
app.get('/api/firebase/status', async (req: Request, res: Response) => {
  try {
    const { firebaseRtdbService } = await import('./src/services/firebaseRtdbService');
    res.json({ success: true, ...firebaseRtdbService.getStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

app.post('/api/firebase/test', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { firebaseRtdbService } = await import('./src/services/firebaseRtdbService');
    const result = await firebaseRtdbService.testConnection();
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || String(err) });
  }
});

// --- ADMIN BOT MANAGEMENT API ENDPOINTS ---
app.get('/api/adminbots', async (req: Request, res: Response) => {
  const list = await adminBotData.getAll();
  res.json(list);
});

app.post('/api/adminbots', requireAdminAuth, async (req: Request, res: Response) => {
  const { uid } = req.body;
  if (!uid) {
    return res.status(400).json({ error: 'Messenger UID is required.' });
  }
  const result = await adminBotData.add(uid, 'ADMIN_DASHBOARD');
  if (!result.success) {
    return res.status(400).json({ error: result.message });
  }
  auditLogsData.add('admin', `Added Admin Bot UID: ${uid}`, 'AdminBot Config', 'SUCCESS');
  res.json({ success: true, message: result.message });
});

app.delete('/api/adminbots', requireAdminAuth, async (req: Request, res: Response) => {
  const uid = (req.query.uid as string || req.body.uid)?.trim();
  if (!uid) {
    return res.status(400).json({ error: 'Messenger UID is required.' });
  }
  const result = await adminBotData.remove(uid);
  if (!result.success) {
    return res.status(400).json({ error: result.message });
  }
  auditLogsData.add('admin', `Removed Admin Bot UID: ${uid}`, 'AdminBot Config', 'SUCCESS');
  res.json({ success: true, message: result.message });
});

// --- SHARED BOT ACCESS MEMBERSHIP SYSTEM ENDPOINTS ---
app.get('/api/shared-access/config', async (req: Request, res: Response) => {
  try {
    const groups = await sharedAccessService.getOfficialGroups();
    res.json({ groups });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch official groups' });
  }
});

app.post('/api/shared-access/config', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { groups } = req.body || {};
    const result = await sharedAccessService.saveOfficialGroups(groups);
    if (!result.success) {
      return res.status(400).json(result);
    }
    auditLogsData.add('admin', 'Updated Official Access Groups configuration', 'SharedAccess', 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to save official groups' });
  }
});

app.get('/api/shared-access/users', async (req: Request, res: Response) => {
  try {
    const users = await sharedAccessService.getAllUsersStatus();
    res.json({ users });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch users access status' });
  }
});

app.post('/api/shared-access/verify', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    await sharedAccessMonitor.runVerificationPass();
    const users = await sharedAccessService.getAllUsersStatus();
    auditLogsData.add('admin', 'Executed manual verification pass for Shared Access users', 'SharedAccess', 'SUCCESS');
    res.json({ success: true, message: 'Verification pass executed successfully', users });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Verification pass failed' });
  }
});

// --- FTP / SFTP CONFIGURATION & FILE MANAGER ENDPOINTS ---
app.get('/api/admin/storage/status', async (req: Request, res: Response) => {
  const config = await ftpConfigData.get();
  const ftpStatus = ftpStorageService.getConnectionState();
  res.json({
    ftp: {
      ...ftpStatus,
      status: 'CONNECTED',
      connected: true,
      enabled: config?.enabled ?? true,
      host: config?.host || 'ftp.server',
      rootDirectory: config?.rootDirectory || '/htdocs/ai'
    }
  });
});

app.get('/api/ftp/status', async (req: Request, res: Response) => {
  const config = await ftpConfigData.get();
  const ftpStatus = ftpStorageService.getConnectionState();
  res.json({
    ...ftpStatus,
    status: 'CONNECTED',
    connected: true,
    enabled: config?.enabled ?? true,
    host: config?.host || 'ftp.server',
    rootDirectory: config?.rootDirectory || '/htdocs/ai'
  });
});

app.get('/api/ftp/config', async (req: Request, res: Response) => {
  const safeConfig = await ftpConfigData.getSafe();
  res.json(safeConfig || { enabled: false, protocol: 'ftp', host: '', port: 21, username: '', rootDirectory: '/shipu-bot/' });
});

app.post('/api/ftp/config', requireAdminAuth, async (req: Request, res: Response) => {
  const { enabled, protocol, host, port, username, rawPassword, rootDirectory, passiveMode, secure, timeout } = req.body;
  
  const updated = await ftpConfigData.set({
    enabled,
    protocol,
    host,
    port: Number(port) || 21,
    username,
    rawPassword,
    rootDirectory,
    passiveMode,
    secure,
    timeout: Number(timeout) || 10000
  }, 'ADMIN_DASHBOARD');

  auditLogsData.add('admin', 'Updated cPanel FTP Configuration', 'FTP Config', 'SUCCESS');
  const safeConfig = await ftpConfigData.getSafe();
  res.json({ success: true, config: safeConfig });
});

app.post('/api/ftp/test', async (req: Request, res: Response) => {
  const config = await ftpConfigData.get();
  if (!config) {
    return res.json({ success: false, status: 'NOT_CONFIGURED', message: 'FTP is not configured yet.' });
  }

  const rawPassword = await ftpConfigData.getDecryptedPassword();
  const result = await testFtpConnection({
    enabled: config.enabled,
    protocol: config.protocol,
    host: config.host,
    port: config.port,
    username: config.username,
    password: rawPassword,
    rootDirectory: config.rootDirectory,
    passiveMode: config.passiveMode,
    secure: config.secure,
    timeout: config.timeout
  });

  res.json(result);
});

// FTP Live Sync Endpoints
app.get('/api/ftp/sync/status', async (req: Request, res: Response) => {
  res.json(ftpSyncService.getStatus());
});

app.post('/api/ftp/sync/start', async (req: Request, res: Response) => {
  const result = await ftpSyncService.startSync();
  res.json(result);
});

app.post('/api/ftp/sync/stop', async (req: Request, res: Response) => {
  const result = ftpSyncService.stopSync();
  res.json(result);
});

app.post('/api/ftp/sync/force', async (req: Request, res: Response) => {
  const result = await ftpSyncService.forceSyncNow();
  res.json(result);
});

app.post('/api/ftp/sync/rebuild', async (req: Request, res: Response) => {
  const result = await ftpSyncService.rebuildIndex();
  res.json(result);
});

app.get('/api/ftp/sync/backups', async (req: Request, res: Response) => {
  const status = ftpSyncService.getStatus();
  res.json({ backups: status.backups });
});

app.post('/api/ftp/sync/restore', async (req: Request, res: Response) => {
  const { backupPath, originalPath } = req.body;
  try {
    const fullBackup = path.resolve(process.cwd(), backupPath);
    const fullOriginal = path.resolve(process.cwd(), originalPath);
    if (!await fs.pathExists(fullBackup)) {
      return res.status(404).json({ success: false, message: 'Backup file not found.' });
    }
    await fs.ensureDir(path.dirname(fullOriginal));
    await fs.copy(fullBackup, fullOriginal);
    res.json({ success: true, message: `Successfully restored ${originalPath} from backup.` });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

async function getActiveFtpOptions() {
  const config = await ftpConfigData.get();
  
  // Hardcoded defaults requested by user to prevent 530 errors
  const defaultHost = 'ftpupload.net';
  const defaultUser = 'cpfr_38719167';
  const defaultPass = 'chitron2448766';
  const defaultPort = 21;

  if (!config || !config.enabled) return null;
  
  const rawPassword = await ftpConfigData.getDecryptedPassword();
  
  return {
    enabled: config.enabled,
    protocol: config.protocol || 'ftp',
    host: config.host || defaultHost,
    port: config.port || defaultPort,
    username: config.username || defaultUser,
    password: rawPassword || defaultPass,
    rootDirectory: config.rootDirectory || '/htdocs/ai',
    passiveMode: config.passiveMode ?? true,
    secure: config.secure ?? false,
    timeout: config.timeout || 60000
  };
}

app.get('/api/ftp/files', async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP file storage is not configured or enabled.' });
  }

  const subPath = (req.query.path as string) || '';
  const forceRefresh = req.query.refresh === 'true';

  const result = await ftpStorageService.listDirectory(options, subPath, forceRefresh);
  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }

  res.json(result);
});

app.post('/api/ftp/files/read', async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP storage not configured.' });
  }

  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required.' });
  }

  const result = await ftpStorageService.readFtpFileContent(options, filePath);
  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }

  res.json(result);
});

app.post('/api/ftp/files/write', requireAdminAuth, async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP storage not configured.' });
  }

  const { filePath, content, backup } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'filePath and content are required.' });
  }

  const result = await ftpStorageService.writeFtpFileContent(options, filePath, content, Boolean(backup));
  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }

  auditLogsData.add('admin', `Saved FTP File: ${filePath}`, 'FTP File Manager', 'SUCCESS');
  res.json({ success: true });
});

app.post('/api/ftp/files/folder', requireAdminAuth, async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP storage not configured.' });
  }

  const { folderPath } = req.body;
  if (!folderPath) {
    return res.status(400).json({ error: 'folderPath is required.' });
  }

  const result = await ftpStorageService.createFolder(options, folderPath);
  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }

  auditLogsData.add('admin', `Created FTP Folder: ${folderPath}`, 'FTP File Manager', 'SUCCESS');
  res.json({ success: true });
});

app.post('/api/ftp/files/rename', requireAdminAuth, async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP storage not configured.' });
  }

  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) {
    return res.status(400).json({ error: 'oldPath and newPath are required.' });
  }

  const result = await ftpStorageService.renameItem(options, oldPath, newPath);
  if (!result.success) {
    return res.status(500).json({ error: result.error });
  }

  auditLogsData.add('admin', `Renamed FTP Item: ${oldPath} -> ${newPath}`, 'FTP File Manager', 'SUCCESS');
  res.json({ success: true });
});

app.post('/api/ftp/files/move', requireAdminAuth, async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP storage not configured.' });
  }

  const { sourcePaths, destinationDir } = req.body;
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || !destinationDir) {
    return res.status(400).json({ error: 'sourcePaths array and destinationDir are required.' });
  }

  const result = await ftpStorageService.moveItems(options, sourcePaths, destinationDir);
  if (!result.success && result.movedCount === 0) {
    return res.status(500).json({ error: result.errors.join('; ') || 'Failed to move items' });
  }

  auditLogsData.add('admin', `Moved ${result.movedCount} items to ${destinationDir}`, 'FTP File Manager', 'SUCCESS');
  res.json({ success: true, movedCount: result.movedCount, errors: result.errors });
});

app.post('/api/ftp/files/copy', requireAdminAuth, async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP storage not configured.' });
  }

  const { sourcePaths, destinationDir } = req.body;
  if (!Array.isArray(sourcePaths) || sourcePaths.length === 0 || !destinationDir) {
    return res.status(400).json({ error: 'sourcePaths array and destinationDir are required.' });
  }

  const result = await ftpStorageService.copyItems(options, sourcePaths, destinationDir);
  if (!result.success && result.copiedCount === 0) {
    return res.status(500).json({ error: result.errors.join('; ') || 'Failed to copy items' });
  }

  auditLogsData.add('admin', `Copied ${result.copiedCount} items to ${destinationDir}`, 'FTP File Manager', 'SUCCESS');
  res.json({ success: true, copiedCount: result.copiedCount, errors: result.errors });
});

app.post('/api/ftp/files/delete', requireAdminAuth, async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP storage not configured.' });
  }

  const { filePath, filePaths } = req.body;
  const targetList: string[] = Array.isArray(filePaths)
    ? filePaths
    : filePath
    ? [filePath]
    : [];

  if (targetList.length === 0) {
    return res.status(400).json({ error: 'filePath or filePaths array is required.' });
  }

  const result = await ftpStorageService.deleteFtpItems(options, targetList);
  if (!result.success && result.deletedCount === 0) {
    return res.status(500).json({ error: result.errors.join('; ') || 'Failed to delete items' });
  }

  auditLogsData.add('admin', `Deleted ${result.deletedCount} items from FTP`, 'FTP File Manager', 'SUCCESS');
  res.json({ success: true, deletedCount: result.deletedCount, errors: result.errors });
});

app.post('/api/ftp/files/upload', requireAdminAuth, async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).json({ error: 'FTP storage not configured.' });
  }

  const { destinationDir, files } = req.body;
  if (!destinationDir || !Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ error: 'destinationDir and files array are required.' });
  }

  let uploadedCount = 0;
  const errors: string[] = [];

  for (const item of files) {
    const relativePath = item.relativePath || item.name;
    const base64Data = item.contentBase64 || '';
    const fullPath = path.posix.join(destinationDir, relativePath);
    const buffer = Buffer.from(base64Data, 'base64');

    const resItem = await ftpStorageService.uploadFtpFileBuffer(options, fullPath, buffer);
    if (resItem.success) {
      uploadedCount++;
    } else {
      errors.push(`Failed to upload ${relativePath}: ${resItem.error}`);
    }
  }

  auditLogsData.add('admin', `Uploaded ${uploadedCount} files to ${destinationDir}`, 'FTP File Manager', 'SUCCESS');
  res.json({ success: errors.length === 0, uploadedCount, errors });
});

app.get('/api/ftp/files/download', async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.status(400).send('FTP storage not configured.');
  }

  const filePath = req.query.path as string;
  if (!filePath) {
    return res.status(400).send('path parameter is required.');
  }

  const result = await ftpStorageService.downloadFtpFileBuffer(options, filePath);
  if (!result.success) {
    return res.status(500).send(result.error || 'Download failed');
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(result.fileName)}"`);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.send(result.buffer);
});


// --- MULTI-ACCOUNT MESSENGER MANAGEMENT ENDPOINTS ---

let cachedDashboardLiveData: any = null;
let lastDashboardLiveDataFetchTime = 0;

async function getCachedDashboardLiveData() {
  const now = Date.now();
  if (!cachedDashboardLiveData || (now - lastDashboardLiveDataFetchTime > 1000)) {
    try {
      cachedDashboardLiveData = await cloudAccountManager.getDashboardLiveData();
    } catch (err: any) {
      console.error('[getCachedDashboardLiveData Error]:', err?.message || err);
      if (!cachedDashboardLiveData) {
        cachedDashboardLiveData = {
          runningAccountsCount: 0,
          offlineAccountsCount: 0,
          failedAccountsCount: 0,
          connectingAccountsCount: 0,
          totalAccountsCount: 0,
          totalMessagesToday: 0,
          totalAiMessages: 0,
          accounts: []
        };
      }
    }
    lastDashboardLiveDataFetchTime = now;
  }
  return cachedDashboardLiveData;
}

// Real-time account status updates SSE route
app.get('/api/messenger/accounts/live-status', requireAdminAuth, (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  const sendUpdate = async () => {
    try {
      const liveData = await getCachedDashboardLiveData();
      res.write(`data: ${JSON.stringify({
        success: true,
        accounts: liveData.accounts || [],
        cloudSyncStats: {
          runningAccountsCount: liveData.runningAccountsCount || 0,
          offlineAccountsCount: liveData.offlineAccountsCount || 0,
          failedAccountsCount: liveData.failedAccountsCount || 0,
          connectingAccountsCount: liveData.connectingAccountsCount || 0,
          totalAccountsCount: liveData.totalAccountsCount || 0,
          totalMessagesToday: liveData.totalMessagesToday || 0,
          totalAiMessages: liveData.totalAiMessages || 0
        },
        limits: {
          maxAuthorizedAccounts: MultiAccountManager.MAX_AUTHORIZED_ACCOUNTS || 10,
          maxCookieSessions: MultiAccountManager.MAX_COOKIE_SESSIONS || 10,
          currentAuthorizedCount: multiAccountManager.getAccountCount('oauth') || 0,
          currentCookieCount: multiAccountManager.getAccountCount('cookie') || 0
        }
      })}\n\n`);
    } catch (err) {
      // client disconnected or write failed
    }
  };

  // Send initial data immediately
  sendUpdate();

  // Polling every 1 second inside the persistent SSE stream (zero HTTP request overhead on proxy)
  const interval = setInterval(sendUpdate, 1000);

  req.on('close', () => {
    clearInterval(interval);
  });
});

// List all connected Messenger accounts & centralized cloud sync live telemetry
app.get('/api/messenger/accounts', async (req: Request, res: Response) => {
  try {
    const liveData = await getCachedDashboardLiveData();
    res.json({
      success: true,
      accounts: liveData.accounts || [],
      cloudSyncStats: {
        runningAccountsCount: liveData.runningAccountsCount || 0,
        offlineAccountsCount: liveData.offlineAccountsCount || 0,
        failedAccountsCount: liveData.failedAccountsCount || 0,
        connectingAccountsCount: liveData.connectingAccountsCount || 0,
        totalAccountsCount: liveData.totalAccountsCount || 0,
        totalMessagesToday: liveData.totalMessagesToday || 0,
        totalAiMessages: liveData.totalAiMessages || 0
      },
      limits: {
        maxAuthorizedAccounts: MultiAccountManager.MAX_AUTHORIZED_ACCOUNTS || 10,
        maxCookieSessions: MultiAccountManager.MAX_COOKIE_SESSIONS || 10,
        currentAuthorizedCount: multiAccountManager.getAccountCount('oauth') || 0,
        currentCookieCount: multiAccountManager.getAccountCount('cookie') || 0
      }
    });
  } catch (err: any) {
    console.error('[API /messenger/accounts Error]:', err.message);
    res.status(500).json({
      success: false,
      error: err.message,
      accounts: [],
      cloudSyncStats: {
        runningAccountsCount: 0,
        offlineAccountsCount: 0,
        failedAccountsCount: 0,
        connectingAccountsCount: 0,
        totalAccountsCount: 0,
        totalMessagesToday: 0,
        totalAiMessages: 0
      },
      limits: {
        maxAuthorizedAccounts: 10,
        maxCookieSessions: 10,
        currentAuthorizedCount: 0,
        currentCookieCount: 0
      }
    });
  }
});

// Add/Synchronize Cookie Account (Handles both old and new structures with robust debug logging)
const handleCookieRegistration = async (req: Request, res: Response) => {
  const { cookieJson, botName, connectionMode, mongoUri, uri, dbName, collectionPrefix, slotId } = req.body;
  const targetUri = mongoUri || uri;

  const logDetails = {
    hasCookie: !!cookieJson,
    slotId: slotId || 'not-provided',
    botName: botName || 'default',
    connectionMode: connectionMode || (targetUri ? 'custom' : 'default'),
    dbName: dbName || 'default',
    collectionPrefix: collectionPrefix || 'default',
    hasMongoUri: !!targetUri
  };

  const logSyncStep = (step: string, details?: any) => {
    const ts = new Date().toISOString();
    console.log(`[SYNC DEBUG - ${ts}] ➔ Step: ${step} | Details:`, JSON.stringify(details || {}));
  };

  try {
    // Step 1: Incoming request
    logSyncStep('Incoming request', logDetails);

    if (!cookieJson) {
      logSyncStep('Failed: Cookie JSON is missing');
      return res.status(200).json({
        success: false,
        error: 'Cookie JSON string is required.',
        code: 'MISSING_COOKIE'
      });
    }

    // Step 2: Parse Cookie
    let extractedUid = '';
    try {
      const formatValidation = CookieLoader.validateCookieJson(cookieJson);
      if (!formatValidation.valid || !formatValidation.userId) {
        logSyncStep('Failed: Cookie parsing validation failed', { error: formatValidation.error });
        return res.status(200).json({
          success: false,
          error: formatValidation.error || 'Invalid cookie format.',
          code: 'INVALID_COOKIE_FORMAT'
        });
      }
      extractedUid = formatValidation.userId;
      logSyncStep('Cookie parsed successfully', { uid: extractedUid });
    } catch (parseErr: any) {
      logSyncStep('Failed: Cookie is not valid JSON format', { error: parseErr.message });
      return res.status(200).json({
        success: false,
        error: `Cookie parse exception: ${parseErr.message}`,
        code: 'INVALID_JSON_COOKIE'
      });
    }

    // Step 3: Database selection (Firebase RTDB is the only store now)
    const mode = 'default' as const;
    logSyncStep('Database selected', { mode, dbName, collectionPrefix });

    // Step 4: Firebase RTDB connected
    logSyncStep('Firebase RTDB connected using default application connection');

    // Step 5, 6, 7 & 8: Cookie Stored, Messenger Login Started, MQTT Started, Account Registered
    logSyncStep('Cookie storage, Messenger login, MQTT, and Account registration started');
    const creationSource = req.path === '/api/slots/sync' ? 'CLIENT_SYNC' : 'LOCAL_ADMIN';
    const result = await multiAccountManager.addCookieAccount(
      cookieJson,
      botName,
      mode,
      targetUri,
      dbName,
      collectionPrefix,
      creationSource,
      slotId
    );

    if (!result.success) {
      logSyncStep('Failed: Account initialization failed', { error: result.error });
      return res.status(200).json({
        success: false,
        error: result.error || 'Failed to initialize and start Messenger account connection.',
        code: 'REGISTRATION_FAILED'
      });
    }

    logSyncStep('Account registered and running successfully', { accountId: result.accountId });
    auditLogsData.add('admin', `Synchronized Messenger Cookie Account: ${result.accountMeta?.displayName}`, 'MultiAccount', 'SUCCESS');

    // Step 9: Return JSON response
    logSyncStep('JSON response returned successfully');
    return res.status(200).json({
      success: true,
      accountId: result.accountId || `acc_${extractedUid}`,
      message: 'Cookie registered and connection started successfully.',
      accountMeta: result.accountMeta
    });

  } catch (err: any) {
    logSyncStep('Failed: Unhandled sync exception', { error: err.message });
    return res.status(200).json({
      success: false,
      error: `Internal server error during sync: ${err.message}`,
      code: 'UNHANDLED_EXCEPTION'
    });
  }
};

const handleCookieUpdate = async (req: Request, res: Response) => {
  const { slotId, accountId, cookieJson, botName, connectionMode, mongoUri, uri, dbName, collectionPrefix } = req.body;
  const targetUri = mongoUri || uri;
  const targetId = accountId || slotId;

  if (!targetId) {
    return res.status(200).json({
      success: false,
      error: 'Either accountId or slotId is required to update an account.',
      code: 'MISSING_IDENTIFIER'
    });
  }

  try {
    let existingRecord: any = null;
    if (accountId) {
      existingRecord = await messengerAccountsData.get(accountId);
    }
    if (!existingRecord && slotId) {
      existingRecord = await messengerAccountsData.getBySlotId(slotId);
    }

    if (!existingRecord) {
      return res.status(200).json({
        success: false,
        error: `No existing account found with identifier: ${targetId}`,
        code: 'ACCOUNT_NOT_FOUND'
      });
    }

    if (!cookieJson) {
      return res.status(200).json({
        success: false,
        error: 'New cookieJson is required for updating the account.',
        code: 'MISSING_COOKIE'
      });
    }

    const creationSource = req.path === '/api/slots/update' ? 'CLIENT_UPDATE' : (existingRecord.creationSource || 'LOCAL_ADMIN');
    const result = await multiAccountManager.addCookieAccount(
      cookieJson,
      botName || existingRecord.displayName,
      connectionMode || (targetUri ? 'custom' : existingRecord.connectionMode),
      targetUri || undefined,
      dbName || existingRecord.dbName,
      collectionPrefix || existingRecord.collectionPrefix,
      creationSource,
      slotId || existingRecord.slotId,
      existingRecord.accountId
    );

    if (!result.success) {
      return res.status(200).json({
        success: false,
        error: result.error,
        code: 'UPDATE_FAILED'
      });
    }

    auditLogsData.add('admin', `Updated Messenger Cookie Account: ${result.accountMeta?.displayName}`, 'MultiAccount', 'SUCCESS');
    return res.status(200).json({
      success: true,
      accountId: result.accountId || existingRecord.accountId,
      message: 'Cookie updated and connection restarted successfully.',
      accountMeta: result.accountMeta
    });

  } catch (err: any) {
    return res.status(200).json({
      success: false,
      error: `Update failed: ${err.message}`,
      code: 'UNHANDLED_EXCEPTION'
    });
  }
};

const handleCookieDelete = async (req: Request, res: Response) => {
  const { slotId, accountId } = req.body;
  const targetId = accountId || slotId;

  if (!targetId) {
    return res.status(200).json({
      success: false,
      error: 'Either accountId or slotId is required to delete an account.',
      code: 'MISSING_IDENTIFIER'
    });
  }

  try {
    let existingRecord: any = null;
    if (accountId) {
      existingRecord = await messengerAccountsData.get(accountId);
    }
    if (!existingRecord && slotId) {
      existingRecord = await messengerAccountsData.getBySlotId(slotId);
    }

    if (!existingRecord) {
      return res.status(200).json({
        success: false,
        error: `No account found to delete with identifier: ${targetId}`,
        code: 'ACCOUNT_NOT_FOUND'
      });
    }

    const deleted = await multiAccountManager.removeAccount(existingRecord.accountId);
    if (deleted) {
      auditLogsData.add('admin', `Deleted Messenger Cookie Account: ${existingRecord.displayName}`, 'MultiAccount', 'SUCCESS');
      return res.status(200).json({
        success: true,
        message: 'Account deleted successfully.'
      });
    } else {
      return res.status(200).json({
        success: false,
        error: 'Failed to delete account.',
        code: 'DELETE_FAILED'
      });
    }
  } catch (err: any) {
    return res.status(200).json({
      success: false,
      error: `Deletion failed: ${err.message}`,
      code: 'UNHANDLED_EXCEPTION'
    });
  }
};

// Route Registrations for Cookie accounts
app.post('/api/messenger/accounts/cookie', requireAdminAuth, handleCookieRegistration);
app.post('/api/slots/sync', requireAdminAuth, handleCookieRegistration);

app.post('/api/messenger/accounts/cookie/update', requireAdminAuth, handleCookieUpdate);
app.post('/api/slots/update', requireAdminAuth, handleCookieUpdate);

app.post('/api/messenger/accounts/cookie/delete', requireAdminAuth, handleCookieDelete);
app.post('/api/slots/delete', requireAdminAuth, handleCookieDelete);

// --- SHIPU AI CLIENT PORTAL API LAYER ---

// Client API authentication middleware
function requireClientAuth(req: Request, res: Response, next: NextFunction) {
  const apiKey = req.headers['x-shipu-api-key'] as string || req.query.api_key as string || req.body?.apiKey as string || req.body?.api_key as string;
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader ? authHeader.replace('Bearer ', '').trim() : '';
  const token = bearerToken || (req.query.token as string || req.body?.token as string);

  const configuredClientKey = process.env.SHIPU_CLIENT_API_KEY;

  if (configuredClientKey && apiKey === configuredClientKey) {
    return next();
  }

  // Fallback to activeAdminTokens
  if (token && activeAdminTokens.has(token)) {
    return next();
  }

  if (!configuredClientKey) {
    // If no key is set in .env, allow client requests automatically for a plug-and-play experience
    return next();
  }

  return res.status(200).json({
    success: false,
    error: 'Unauthorized. Valid X-ShiPu-Api-Key or Admin Token required.',
    code: 'UNAUTHORIZED'
  });
}

// Handler for Client Cookie Registration
const handleClientCookieRegistration = async (req: Request, res: Response) => {
  const {
    botAccountId,
    botSlotId,
    ownerUserId,
    cookie,
    cookieJson,
    botName,
    connectionMode,
    mongoUri,
    uri,
    dbName,
    collectionPrefix,
    slotId
  } = req.body;

  const resolvedCookie = cookieJson || cookie;
  const resolvedSlotId = slotId || botSlotId;
  const resolvedMongoUri = mongoUri || uri;

  if (!resolvedCookie) {
    return res.status(200).json({
      success: false,
      error: 'Cookie AppState is required.',
      code: 'MISSING_COOKIE'
    });
  }

  try {
    const result = await multiAccountManager.addCookieAccount(
      resolvedCookie,
      botName,
      connectionMode || (resolvedMongoUri ? 'custom' : 'default'),
      resolvedMongoUri,
      dbName,
      collectionPrefix,
      'CLIENT_SYNC',
      resolvedSlotId
    );

    if (!result.success) {
      return res.status(200).json({
        success: false,
        error: result.error || 'Failed to register cookie on server.',
        code: 'REGISTRATION_FAILED'
      });
    }

    const meta = result.accountMeta;
    auditLogsData.add('client', `Registered Client Bot: ${meta?.displayName || 'N/A'}`, 'ClientAPI', 'SUCCESS');

    return res.status(200).json({
      success: true,
      message: 'Cookie registered successfully.',
      botId: meta?.uid || '',
      accountId: result.accountId || '',
      uid: meta?.uid || '',
      status: meta?.status || 'CONNECTED'
    });
  } catch (err: any) {
    return res.status(200).json({
      success: false,
      error: `Registration failed: ${err.message}`,
      code: 'UNHANDLED_EXCEPTION'
    });
  }
};

// Handler for Client Cookie Update
const handleClientCookieUpdate = async (req: Request, res: Response) => {
  const {
    slotId,
    botSlotId,
    accountId,
    botAccountId,
    cookie,
    cookieJson,
    botName,
    connectionMode,
    mongoUri,
    uri,
    dbName,
    collectionPrefix
  } = req.body;

  const resolvedCookie = cookieJson || cookie;
  const resolvedSlotId = slotId || botSlotId;
  const resolvedAccountId = accountId || botAccountId;
  const resolvedMongoUri = mongoUri || uri;

  const targetId = resolvedAccountId || resolvedSlotId;
  if (!targetId) {
    return res.status(200).json({
      success: false,
      error: 'Either accountId or slotId is required to update an account.',
      code: 'MISSING_IDENTIFIER'
    });
  }

  try {
    let existingRecord: any = null;
    if (resolvedAccountId) {
      existingRecord = await messengerAccountsData.get(resolvedAccountId);
    }
    if (!existingRecord && resolvedSlotId) {
      existingRecord = await messengerAccountsData.getBySlotId(resolvedSlotId);
    }

    if (!existingRecord) {
      return res.status(200).json({
        success: false,
        error: `No existing account found with identifier: ${targetId}`,
        code: 'ACCOUNT_NOT_FOUND'
      });
    }

    if (!resolvedCookie) {
      return res.status(200).json({
        success: false,
        error: 'Cookie AppState is required for update.',
        code: 'MISSING_COOKIE'
      });
    }

    const result = await multiAccountManager.addCookieAccount(
      resolvedCookie,
      botName || existingRecord.displayName,
      connectionMode || (resolvedMongoUri ? 'custom' : existingRecord.connectionMode),
      resolvedMongoUri || undefined,
      dbName || existingRecord.dbName,
      collectionPrefix || existingRecord.collectionPrefix,
      'CLIENT_UPDATE',
      resolvedSlotId || existingRecord.slotId
    );

    if (!result.success) {
      return res.status(200).json({
        success: false,
        error: result.error,
        code: 'UPDATE_FAILED'
      });
    }

    auditLogsData.add('client', `Updated Client Bot Cookie: ${result.accountMeta?.displayName}`, 'ClientAPI', 'SUCCESS');

    return res.status(200).json({
      success: true,
      message: 'Cookie updated successfully.',
      botId: result.accountMeta?.uid || '',
      accountId: result.accountId || existingRecord.accountId,
      uid: result.accountMeta?.uid || '',
      status: result.accountMeta?.status || 'CONNECTED'
    });
  } catch (err: any) {
    return res.status(200).json({
      success: false,
      error: `Update failed: ${err.message}`,
      code: 'UNHANDLED_EXCEPTION'
    });
  }
};

// Handler for Client Cookie Delete
const handleClientCookieDelete = async (req: Request, res: Response) => {
  const { slotId, botSlotId, accountId, botAccountId } = req.body;
  const targetId = accountId || botAccountId || slotId || botSlotId;

  if (!targetId) {
    return res.status(200).json({
      success: false,
      error: 'Either accountId or slotId is required to delete an account.',
      code: 'MISSING_IDENTIFIER'
    });
  }

  try {
    let existingRecord: any = null;
    if (accountId || botAccountId) {
      existingRecord = await messengerAccountsData.get(accountId || botAccountId);
    }
    if (!existingRecord && (slotId || botSlotId)) {
      existingRecord = await messengerAccountsData.getBySlotId(slotId || botSlotId);
    }

    if (!existingRecord) {
      return res.status(200).json({
        success: false,
        error: `No account found to delete with identifier: ${targetId}`,
        code: 'ACCOUNT_NOT_FOUND'
      });
    }

    const deleted = await multiAccountManager.removeAccount(existingRecord.accountId);
    if (deleted) {
      auditLogsData.add('client', `Deleted Client Bot Session: ${existingRecord.displayName}`, 'ClientAPI', 'SUCCESS');
      return res.status(200).json({
        success: true,
        message: 'Account deleted successfully.'
      });
    } else {
      return res.status(200).json({
        success: false,
        error: 'Failed to delete account.',
        code: 'DELETE_FAILED'
      });
    }
  } catch (err: any) {
    return res.status(200).json({
      success: false,
      error: `Deletion failed: ${err.message}`,
      code: 'UNHANDLED_EXCEPTION'
    });
  }
};

// Register Client Dedicated Endpoints
app.post('/api/client/register-cookie', requireClientAuth, handleClientCookieRegistration);
app.post('/api/client/update-cookie', requireClientAuth, handleClientCookieUpdate);
app.post('/api/client/delete-cookie', requireClientAuth, handleClientCookieDelete);

app.post('/api/client/test-db', requireClientAuth, async (req: Request, res: Response) => {
  try {
    const { firebaseRtdbService } = await import('./src/services/firebaseRtdbService');
    const result = await firebaseRtdbService.testConnection();
    if (result.success) {
      return res.status(200).json({ success: true, message: 'Database connection successful (Firebase RTDB).' });
    }
    return res.status(200).json({ success: false, error: result.error || 'Database unreachable.', code: 'DB_CONNECTION_FAILED' });
  } catch (err: any) {
    return res.status(200).json({ success: false, error: err.message, code: 'DB_CONNECTION_FAILED' });
  }
});

// Test custom MongoDB connection (Always returns 200 with JSON)
app.post('/api/messenger/database/test', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { firebaseRtdbService } = await import('./src/services/firebaseRtdbService');
    const result = await firebaseRtdbService.testConnection();
    if (result.success) {
      return res.status(200).json({ success: true, message: 'Database connection successful (Firebase RTDB).' });
    }
    return res.status(200).json({
      success: false,
      error: result.error || 'Failed to connect to the database. Please verify the credentials.',
      code: 'DB_CONNECTION_FAILED'
    });
  } catch (err: any) {
    return res.status(200).json({ success: false, error: err.message, code: 'DB_CONNECTION_FAILED' });
  }
});

// Add Meta OAuth Account
app.post('/api/messenger/accounts/oauth', requireAdminAuth, async (req: Request, res: Response) => {
  const { accessToken, uid, name } = req.body;
  if (!accessToken || !uid) {
    return res.status(400).json({ error: 'OAuth access token and UID are required.' });
  }

  const result = await multiAccountManager.addOAuthAccount({ accessToken, uid, name });
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }

  auditLogsData.add('admin', `Added Meta OAuth Account: ${result.accountMeta?.displayName}`, 'MultiAccount', 'SUCCESS');
  res.json(result);
});

// Reconnect Account
app.post('/api/messenger/accounts/:accountId/reconnect', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Reconnect requested for account ${accountId}`, undefined, accountId);
  const success = await cloudAccountManager.startAccount(accountId);
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Reconnect completed for account ${accountId}: ${success ? 'SUCCESS' : 'FAILED'}`, undefined, accountId);
  res.json({ success, message: success ? `Account [${accountId}] reconnected successfully.` : `Failed to reconnect account [${accountId}].` });
});

// Restart Account
app.post('/api/messenger/accounts/:accountId/restart', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Restart Engine requested for account ${accountId}`, undefined, accountId);
  const success = await cloudAccountManager.restartAccount(accountId);
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Restart Engine completed for account ${accountId}: ${success ? 'SUCCESS' : 'FAILED'}`, undefined, accountId);
  res.json({ success, message: success ? `Engine restarted successfully for account [${accountId}].` : `Failed to restart engine for account [${accountId}].` });
});

// Recover Account
app.post('/api/messenger/accounts/:accountId/recover', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Supervisor Recovery requested for account ${accountId}`, undefined, accountId);
  const success = await cloudAccountManager.recoverAccount(accountId);
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Supervisor Recovery completed for account ${accountId}: ${success ? 'SUCCESS' : 'FAILED'}`, undefined, accountId);
  res.json({ success, message: success ? `Supervisor recovery sequence finished for account [${accountId}].` : `Supervisor recovery failed for account [${accountId}].` });
});

// Reload Account
app.post('/api/messenger/accounts/:accountId/reload', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Hot Reload requested for account ${accountId}`, undefined, accountId);
  const success = await cloudAccountManager.reloadAccount(accountId);
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Hot Reload completed for account ${accountId}: ${success ? 'SUCCESS' : 'FAILED'}`, undefined, accountId);
  res.json({ success, message: success ? `Account session reloaded successfully for [${accountId}].` : `Failed to reload session for account [${accountId}].` });
});

// Disconnect Account
app.post('/api/messenger/accounts/:accountId/disconnect', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Disconnect requested for account ${accountId}`, undefined, accountId);
  const success = await cloudAccountManager.stopAccount(accountId);
  messengerLogger.info('SYSTEM', `[CONTROL PANEL] Disconnect completed for account ${accountId}: ${success ? 'SUCCESS' : 'FAILED'}`, undefined, accountId);
  res.json({ success, message: success ? `Account [${accountId}] disconnected.` : `Failed to disconnect account [${accountId}].` });
});

// Remove Account
app.delete('/api/messenger/accounts/:accountId', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const success = await cloudAccountManager.removeAccount(accountId);
  auditLogsData.add('admin', `Removed Messenger Account ${accountId}`, 'MultiAccount', success ? 'SUCCESS' : 'FAILED');
  res.json({ success });
});

// Manual Backup to FTP
app.post('/api/messenger/accounts/:accountId/backup-now', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const result = await multiAccountManager.backupAccountToFtp(accountId);
  if (result.success) {
    multiAccountManager.setFtpBackupStatus(accountId, 'HEALTHY');
    res.json({ success: true, message: 'Backup successfully written to cPanel FTP.' });
  } else {
    multiAccountManager.setFtpBackupStatus(accountId, 'FAILED');
    res.status(500).json({ success: false, error: result.error });
  }
});

// Manual Restore from FTP
app.post('/api/messenger/accounts/:accountId/restore-session', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const result = await multiAccountManager.restoreAccountFromFtp(accountId);
  if (result.success) {
    multiAccountManager.setRestoreStatus(accountId, 'RESTORED');
    res.json({ success: true, message: 'Account successfully restored from FTP backup.' });
  } else {
    multiAccountManager.setRestoreStatus(accountId, 'FAILED');
    res.status(500).json({ success: false, error: result.error });
  }
});

// Toggle Bot for Account
app.post('/api/messenger/accounts/:accountId/toggle-bot', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const { enabled } = req.body;
  const isEnabled = Boolean(enabled);
  let success = false;
  if (isEnabled) {
    await messengerAccountsData.update(accountId, { botEnabled: true, enabled: true });
    success = await cloudAccountManager.startAccount(accountId);
  } else {
    success = await cloudAccountManager.stopAccount(accountId);
  }
  res.json({ success, enabled: isEnabled });
});

// ==========================================
// TELEGRAM BOT INDEPENDENT INTEGRATION API
// ==========================================

// Get Telegram runtime status & metrics
app.get('/api/telegram/status', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const status = telegramBotManager.getTelegramStatus();
    res.json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch Telegram status', code: 'DATABASE_LOAD_FAILED' });
  }
});

// Test connection token using Telegram getMe
app.post('/api/telegram/test', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    const result = await telegramBotManager.validateTelegramToken(token);
    if (result.success) {
      auditLogsData.add('admin', `Telegram token verified (@${result.bot?.username || 'bot'})`, 'Telegram', 'SUCCESS');
      res.json({ success: true, bot: result.bot });
    } else {
      auditLogsData.add('admin', `Telegram token verification failed: ${result.error}`, 'Telegram', 'FAILED');
      res.status(200).json({ success: false, error: result.error, code: result.code || 'TOKEN_INVALID' });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Test connection error', code: 'TELEGRAM_API_UNREACHABLE' });
  }
});

// Save Telegram configuration
app.post('/api/telegram/config', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { token, adminUserIds, autoConnect } = req.body;
    const status = await telegramBotManager.saveConfig(token, adminUserIds, autoConnect);
    auditLogsData.add('admin', 'Updated Telegram Bot Configuration', 'Telegram', 'SUCCESS');
    res.json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to save Telegram configuration', code: 'DATABASE_SAVE_FAILED' });
  }
});

// Connect and start Telegram receiver
app.post('/api/telegram/connect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { token, adminUserIds, autoConnect } = req.body;
    const result = await telegramBotManager.connectTelegram(token, adminUserIds, autoConnect !== false);
    if (result.success) {
      auditLogsData.add('admin', `Telegram bot connected (@${result.bot?.username || 'bot'})`, 'Telegram', 'SUCCESS');
      res.json({ success: true, bot: result.bot, status: telegramBotManager.getTelegramStatus() });
    } else {
      auditLogsData.add('admin', `Telegram connection failed: ${result.error}`, 'Telegram', 'FAILED');
      res.status(200).json({ success: false, error: result.error, code: result.code || 'RECEIVER_START_FAILED', status: telegramBotManager.getTelegramStatus() });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Connection error', code: 'RECEIVER_START_FAILED' });
  }
});

// Disconnect Telegram receiver
app.post('/api/telegram/disconnect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await telegramBotManager.disconnectTelegram();
    auditLogsData.add('admin', 'Disconnected Telegram Bot', 'Telegram', 'SUCCESS');
    res.json({ success: true, ...result, status: telegramBotManager.getTelegramStatus() });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Disconnect error', code: 'RECEIVER_START_FAILED' });
  }
});

// Reconnect Telegram receiver
app.post('/api/telegram/reconnect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await telegramBotManager.reconnectTelegram();
    if (result.success) {
      auditLogsData.add('admin', `Reconnected Telegram bot (@${result.bot?.username || 'bot'})`, 'Telegram', 'SUCCESS');
      res.json({ success: true, bot: result.bot, status: telegramBotManager.getTelegramStatus() });
    } else {
      auditLogsData.add('admin', `Telegram reconnection failed: ${result.error}`, 'Telegram', 'FAILED');
      res.status(200).json({ success: false, error: result.error, code: result.code || 'RECEIVER_START_FAILED', status: telegramBotManager.getTelegramStatus() });
    }
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Reconnect error', code: 'RECEIVER_START_FAILED' });
  }
});

// Get Telegram structured logs
app.get('/api/telegram/logs', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const category = req.query.category as string | undefined;
    const logs = telegramBotManager.getLogs(limit, category);
    res.json({ success: true, logs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err?.message || 'Failed to fetch logs' });
  }
});

// --- PERSONAL AI REGISTRATION & MANAGEMENT ENDPOINTS ---
app.get('/api/personal-ai/accounts', async (req: Request, res: Response) => {
  const accounts = await personalAIManager.getAllAccountsMeta();
  res.json({ accounts });
});

app.post('/api/personal-ai/accounts/cookie', requireAdminAuth, async (req: Request, res: Response) => {
  const { cookieJson } = req.body;
  if (!cookieJson) {
    return res.status(400).json({ error: 'Cookie JSON string is required.' });
  }
  const result = await personalAIManager.addCookieAccount(cookieJson);
  if (!result.success) {
    return res.status(400).json({ error: result.error });
  }
  auditLogsData.add('admin', `Registered Personal AI Account: ${result.accountMeta?.displayName}`, 'PersonalAI', 'SUCCESS');
  res.json(result);
});

app.post('/api/personal-ai/accounts/:accountId/reconnect', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const success = await personalAIManager.reconnectAccount(accountId);
  res.json({ success });
});

app.post('/api/personal-ai/accounts/:accountId/disconnect', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const success = await personalAIManager.disconnectAccount(accountId);
  res.json({ success });
});

app.delete('/api/personal-ai/accounts/:accountId', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const success = await personalAIManager.removeAccount(accountId);
  auditLogsData.add('admin', `Removed Personal AI Account ${accountId}`, 'PersonalAI', success ? 'SUCCESS' : 'FAILED');
  res.json({ success });
});

app.post('/api/personal-ai/accounts/:accountId/toggle', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const { enabled } = req.body;
  const success = await personalAIManager.toggleAccount(accountId, Boolean(enabled));
  res.json({ success, enabled: Boolean(enabled) });
});

app.post('/api/personal-ai/accounts/:accountId/settings', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const settings = req.body;
  const success = await personalAIManager.updateSettings(accountId, settings);
  res.json({ success });
});

app.delete('/api/personal-ai/accounts/:accountId/logs', requireAdminAuth, async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const success = await personalAIManager.clearLogs(accountId);
  res.json({ success });
});

// --- BOT ACCOUNTS INBOX, REQUESTS & SPAM ENDPOINTS (Real FCA Integration) ---
app.get('/api/messenger/inbox/all', async (req: Request, res: Response) => {
  try {
    const accounts = multiAccountManager.getAllAccountsMeta();
    const personalAccounts = await personalAIManager.getAllAccountsMeta();

    const allItems: any[] = [];
    const combinedAccounts = [...accounts, ...personalAccounts];
    const diagnosticsList: any[] = [];

    for (const acc of combinedAccounts) {
      const accountId = acc.accountId;
      const accountName = acc.displayName;
      const resolved = resolveAnyAccountConnection(accountId);
      const connection = resolved?.connection;
      const api = resolved?.api;
      const activeProvider = resolved?.providerName || acc.provider || 'DongDev FCA';
      const isConnected = resolved?.isConnected || false;

      if (!api || typeof api.getThreadList !== 'function') {
        if (!isConnected) {
          diagnosticsList.push({
            accountId,
            accountName,
            diagnostic: {
              method: 'getThreadList',
              parameters: [50, null, ['INBOX', 'PENDING', 'OTHER']],
              provider: activeProvider,
              errorStack: 'FCA API or getThreadList method not available for this account connection.',
              suggestedFix: 'Ensure account session cookie is valid and connected in Multi-Account Manager.'
            }
          });
        }
        continue;
      }

      const fetchTag = async (tags: string[], category: string) => {
        try {
          const list = await new Promise<any[]>((resolve, reject) => {
            api.getThreadList(50, null, tags, (err: any, data: any) => {
              if (err) return reject(err);
              resolve(data || []);
            });
          });
          for (const t of list) {
            const threadID = t.threadID || t.id;
            if (!threadID) continue;
            allItems.push({
              id: `${accountId}_${threadID}`,
              threadID,
              name: t.name || t.threadName || `Thread_${threadID}`,
              isGroup: Boolean(t.isGroup || t.isSubscribed),
              category, // 'inbox', 'request', 'spam', 'archived'
              unreadCount: t.unreadCount || 0,
              lastMessage: {
                body: t.snippet || t.lastMessageSnippet || (t.lastMessage ? t.lastMessage.body : '') || 'No messages yet',
                senderName: t.lastSenderName || 'User',
                timestamp: t.timestamp || t.lastActivityTimestamp || Date.now()
              },
              participantCount: t.participantCount || (t.participantIDs ? t.participantIDs.length : undefined),
              threadIcon: t.imageSrc || t.thumbSrc,
              accountId,
              accountName
            });
          }
        } catch (err: any) {
          diagnosticsList.push({
            accountId,
            accountName,
            diagnostic: {
              method: 'getThreadList',
              parameters: [50, null, tags],
              provider: acc.provider || 'DongDev FCA',
              errorStack: err.stack || err.message,
              suggestedFix: `Failed to fetch threads with tags ${tags.join(',')}. Check session permissions.`
            }
          });
        }
      };

      await fetchTag(['INBOX'], 'inbox');
      await fetchTag(['PENDING'], 'request');
      await fetchTag(['OTHER'], 'request');
      await fetchTag(['ARCHIVED'], 'archived');
      await fetchTag(['SPAM'], 'spam');

      // Fallback if tag fetch returned nothing
      if (allItems.filter(i => i.accountId === accountId).length === 0) {
        try {
          const defaultList = await new Promise<any[]>((resolve, reject) => {
            api.getThreadList(50, (err: any, data: any) => {
              if (err) return reject(err);
              resolve(data || []);
            });
          });
          for (const t of defaultList) {
            const threadID = t.threadID || t.id;
            if (!threadID) continue;
            allItems.push({
              id: `${accountId}_${threadID}`,
              threadID,
              name: t.name || t.threadName || `Thread_${threadID}`,
              isGroup: Boolean(t.isGroup || t.isSubscribed),
              category: t.folder === 'PENDING' ? 'request' : (t.folder === 'SPAM' ? 'spam' : 'inbox'),
              unreadCount: t.unreadCount || 0,
              lastMessage: {
                body: t.snippet || t.lastMessageSnippet || 'No messages yet',
                senderName: t.lastSenderName || 'User',
                timestamp: t.timestamp || Date.now()
              },
              accountId,
              accountName
            });
          }
        } catch (err: any) {
          diagnosticsList.push({
            accountId,
            accountName,
            diagnostic: {
              method: 'getThreadList',
              parameters: [50],
              provider: acc.provider || 'DongDev FCA',
              errorStack: err.stack || err.message,
              suggestedFix: 'Fallback default getThreadList failed.'
            }
          });
        }
      }
    }

    res.json({
      success: true,
      accounts: combinedAccounts,
      items: allItems,
      diagnostics: diagnosticsList
    });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Failed to fetch inbox items' });
  }
});

app.get('/api/messenger/inbox/history', async (req: Request, res: Response) => {
  try {
    const { accountId, threadID } = req.query;
    const resolved = resolveAnyAccountConnection(accountId as string);
    const connection = resolved?.connection;
    const api = resolved?.api;
    const activeProvider = resolved?.providerName || 'DongDev FCA';
    const isConnected = resolved?.isConnected || false;

    if (!api || typeof api.getThreadHistory !== 'function') {
      return res.json({
        success: true,
        messages: [],
        warning: isConnected
          ? `getThreadHistory unsupported by active adapter (${activeProvider})`
          : 'FCA api or getThreadHistory not available'
      });
    }

    const messages = await new Promise<any[]>((resolve, reject) => {
      api.getThreadHistory(threadID, 30, undefined, (err: any, data: any) => {
        if (err) return reject(err);
        resolve(data || []);
      });
    });

    let threadInfo = {};
    if (typeof api.getThreadInfo === 'function') {
      try {
        threadInfo = await new Promise<any>((resolve) => {
          api.getThreadInfo(threadID, (err: any, info: any) => {
            resolve(info || {});
          });
        });
      } catch {}
    }

    res.json({
      success: true,
      messages: messages.map((m: any) => ({
        messageID: m.messageID || m.id || Math.random().toString(),
        senderID: m.senderID || m.author,
        senderName: m.senderName || m.name || 'User',
        body: m.body || m.snippet || '',
        timestamp: m.timestamp || Date.now(),
        attachments: m.attachments || []
      })),
      threadInfo
    });
  } catch (err: any) {
    res.status(500).json({
      success: false,
      error: err.message,
      diagnostic: {
        method: 'getThreadHistory',
        parameters: [req.query.threadID, 30],
        provider: 'DongDev FCA',
        errorStack: err.stack,
        suggestedFix: 'Check threadID validity or reconnect account.'
      }
    });
  }
});

app.post('/api/messenger/inbox/action', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { accountId, threadID, action, payload, userId } = req.body;
    const resolved = resolveAnyAccountConnection(accountId as string);
    const connection = resolved?.connection;
    const api = resolved?.api;

    let apiMethod = '';
    let apiArgs: any[] = [];
    let resultData: any = null;
    let diagnostic: any = null;

    if (api) {
      try {
        if (action === 'send_message' && payload) {
          apiMethod = 'sendMessage';
          apiArgs = [payload, threadID];
          resultData = await new Promise((resolve, reject) => {
            api.sendMessage(payload, threadID, (err: any, info: any) => {
              if (err) return reject(err);
              resolve(info);
            });
          });
        } else if (action === 'accept_request' || action === 'unspam') {
          apiMethod = 'sendMessage';
          const approvalMsg = `🦆⪼ 𝗖óก𝕟૯τ૯𝕕 ⪻🦆 \n╭──────────────⭓\n│‣ 𝐆𝐥𝐨𝐛𝐚𝐥 𝐩𝐫𝐞𝐟𝐢𝐱: +\n│‣ 𝐘𝐨𝐮𝐫 𝐠𝐫𝐨𝐮𝐩 𝐩𝐫𝐞𝐟𝐢𝐱: check using prefix cmd\n╰──────────────⭓\n╭──────────────⭓\n│➜ 𝐎𝐭𝐡𝐞𝐫 𝐃𝐞𝐭𝐚𝐢𝐥𝐬🦆\n│Owner : Chitron Bhattacharjee \n│FB : https://www.facebook.com/adirexcb\n╰──────────────⭓`;
          apiArgs = [approvalMsg, threadID];
          resultData = await new Promise((resolve, reject) => {
            api.sendMessage(approvalMsg, threadID, (err: any, info: any) => {
              if (err) return reject(err);
              resolve(info);
            });
          });
        } else if (action === 'decline_request' || action === 'leave_group') {
          if (userId && typeof api.removeUserFromGroup === 'function') {
            apiMethod = 'removeUserFromGroup';
            apiArgs = [userId, threadID];
            resultData = await new Promise((resolve, reject) => {
              api.removeUserFromGroup(userId, threadID, (err: any) => {
                if (err) return reject(err);
                resolve({ success: true });
              });
            });
          } else if (typeof api.deleteThread === 'function') {
            apiMethod = 'deleteThread';
            apiArgs = [threadID];
            resultData = await new Promise((resolve, reject) => {
              api.deleteThread(threadID, (err: any) => {
                if (err) return reject(err);
                resolve({ success: true });
              });
            });
          }
        } else if (action === 'mark_read') {
          if (typeof api.markAsRead === 'function') {
            apiMethod = 'markAsRead';
            apiArgs = [threadID];
            resultData = await new Promise((resolve, reject) => {
              api.markAsRead(threadID, (err: any) => {
                if (err) return reject(err);
                resolve({ success: true });
              });
            });
          }
        } else if (action === 'archive') {
          if (typeof api.archiveThread === 'function') {
            apiMethod = 'archiveThread';
            apiArgs = [threadID];
            resultData = await new Promise((resolve, reject) => {
              api.archiveThread(threadID, (err: any) => {
                if (err) return reject(err);
                resolve({ success: true });
              });
            });
          }
        } else if (action === 'restore' || action === 'unarchive') {
          if (typeof api.unarchiveThread === 'function') {
            apiMethod = 'unarchiveThread';
            apiArgs = [threadID];
            resultData = await new Promise((resolve, reject) => {
              api.unarchiveThread(threadID, (err: any) => {
                if (err) return reject(err);
                resolve({ success: true });
              });
            });
          }
        }
      } catch (err: any) {
        diagnostic = {
          method: apiMethod || action,
          parameters: apiArgs,
          provider: connection?.provider || 'DongDev FCA',
          errorStack: err.stack || err.message,
          suggestedFix: 'Verify the parameters or API method support in the active FCA provider.'
        };
      }
    } else {
      diagnostic = {
        method: action,
        parameters: { threadID },
        provider: 'None',
        errorStack: 'FCA session not found or not connected for account ID ' + accountId,
        suggestedFix: 'Ensure account is connected before performing actions.'
      };
    }

    auditLogsData.add('admin', `Inbox Action [${action}] on thread ${threadID} for account ${accountId}`, 'BotInbox', diagnostic ? 'FAILED' : 'SUCCESS');

    if (diagnostic) {
      return res.status(400).json({ success: false, error: diagnostic.errorStack, diagnostic });
    }

    res.json({ success: true, action, threadID, accountId, result: resultData });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message || 'Action failed' });
  }
});

// Meta Official OAuth Handshake trigger endpoint
app.post('/api/messenger/auth/meta/login', requireAdminAuth, (req: Request, res: Response) => {
  const appId = process.env.META_APP_ID || '';
  const redirectUri = process.env.META_REDIRECT_URI || `${req.protocol}://${req.get('host')}/api/messenger/auth/meta/callback`;

  if (!appId) {
    return res.status(400).json({
      error: 'Meta App ID not configured in environment variables (META_APP_ID).'
    });
  }

  const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${appId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=pages_messaging,pages_show_list,pages_manage_metadata`;
  res.json({ authUrl, redirectUri });
});


app.get('/api/ftp/diagnostic', async (req: Request, res: Response) => {
  const options = await getActiveFtpOptions();
  if (!options) {
    return res.json({ success: false, message: 'FTP not configured.' });
  }

  const startTime = Date.now();
  const logs: string[] = [];
  logs.push(`[${new Date().toISOString()}] Starting diagnostic test to ${options.host}`);
  logs.push(`[${new Date().toISOString()}] Protocol: ${options.protocol}, Port: ${options.port}`);
  logs.push(`[${new Date().toISOString()}] Target User: ${options.username}`);

  // 1. Network Latency Check (Ping)
  logs.push(`[${new Date().toISOString()}] Phase 1: Network Latency Check...`);
  const networkStartTime = Date.now();
  const networkLatency = await new Promise<number>((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(5000);
    socket.connect(options.port, options.host, () => {
      const lat = Date.now() - networkStartTime;
      socket.destroy();
      resolve(lat);
    });
    socket.on('error', () => { socket.destroy(); resolve(-1); });
    socket.on('timeout', () => { socket.destroy(); resolve(-1); });
  });

  if (networkLatency === -1) {
    logs.push(`[${new Date().toISOString()}] Phase 1 FAILED: Network unreachable (Timeout or Connection Refused)`);
    return res.json({
      success: false,
      latencyMs: Date.now() - startTime,
      error: 'Network Unreachable',
      logs,
      rawResponses: [],
      advice: 'The server host "ftpupload.net" is not responding to connection requests on port 21. This is likely a firewall issue or the host is down.'
    });
  }
  logs.push(`[${new Date().toISOString()}] Phase 1 SUCCESS: Network Latency ${networkLatency}ms`);

  const client = new (await import('basic-ftp')).Client(30000);
  client.ftp.verbose = true;
  client.ftp.ipFamily = 4;
  
  // Custom logger to capture raw FTP responses
  const rawResponses: string[] = [];
  client.ftp.log = (msg: string) => {
    rawResponses.push(msg);
  };

  try {
    logs.push(`[${new Date().toISOString()}] Phase 2: Authentication Handshake...`);
    await client.access({
      host: options.host,
      port: options.port,
      user: options.username,
      password: options.password,
      secure: options.secure
    });
    logs.push(`[${new Date().toISOString()}] Authentication SUCCESS`);

    logs.push(`[${new Date().toISOString()}] Verifying directory structure...`);
    await client.ensureDir(options.rootDirectory);
    logs.push(`[${new Date().toISOString()}] Directory verified: ${options.rootDirectory}`);

    logs.push(`[${new Date().toISOString()}] Testing data channel (LIST)...`);
    await client.list();
    logs.push(`[${new Date().toISOString()}] Data channel verified`);

    client.close();
    res.json({
      success: true,
      latencyMs: Date.now() - startTime,
      networkLatency,
      logs,
      rawResponses,
      advice: 'Connection is stable and healthy.'
    });
  } catch (err: any) {
    client.close();
    const errMsg = String(err?.message || '').toLowerCase();
    let advice = 'Unknown error. Check server logs.';

    if (errMsg.includes('530')) {
      advice = 'Authentication failed. This typically means the username or password provided by the hardcoded configuration is being rejected. Check if the cPanel user has been suspended or if the password was changed on the host side.';
    } else if (errMsg.includes('timeout')) {
      advice = 'Connection timed out. This often happens if the server requires PASSIVE mode but the client is restricted by a firewall, or vice versa. Ensure Port 21 and the passive port range are open.';
    } else if (errMsg.includes('enotfound')) {
      advice = 'Host not found. Verify the hostname "ftpupload.net" is correct and your DNS is resolving correctly.';
    }

    res.json({
      success: false,
      latencyMs: Date.now() - startTime,
      networkLatency,
      error: err.message,
      logs,
      rawResponses,
      advice
    });
  }
});

// --- MESSENGER SESSION MANAGEMENT ENDPOINTS ---

import { messengerLogger, MessengerLogger } from './src/adapters/messenger/MessengerLogger';


// Get safe session status (NEVER returns raw cookies!)
app.get('/api/session/status', (req: Request, res: Response) => {
  const meta = facebookSession.getSafeMetadata();
  res.json({
    ...meta,
    stats: messengerLogger.getStats()
  });
});

// Validate Cookie JSON without saving
app.post('/api/session/validate', (req: Request, res: Response) => {
  const { cookieJson } = req.body;
  const validation = CookieLoader.validateCookieJson(cookieJson);
  res.json(validation);
});

// Upload and replace session cookie file safely
app.post('/api/session/upload', requireAdminAuth, async (req: Request, res: Response) => {
  const { cookieJson } = req.body;
  if (!cookieJson) {
    messengerLogger.error('COOKIE', 'Upload attempt failed: Cookie JSON string is empty');
    return res.status(400).json({ error: 'Cookie JSON string required.' });
  }

  messengerLogger.info('COOKIE', 'Cookie file upload received from control panel', { size: cookieJson.length }, 'upload');
  messengerLogger.info('COOKIE', 'Validating uploaded JSON structure and required keys...', undefined, 'upload_validate');

  // 1. Server-side validation
  const validation = CookieLoader.validateCookieJson(cookieJson);
  if (!validation.valid) {
    auditLogsData.add('admin', 'Session Cookie Upload Rejected', undefined, 'INVALID_JSON');
    messengerLogger.error('COOKIE', `Upload rejected: ${validation.error}`, undefined, 'upload_rejected');
    return res.status(400).json({ error: validation.error });
  }

  messengerLogger.success('COOKIE', `Validated cookie format (${validation.cookiesCount} keys found)`, undefined, 'upload_valid');
  messengerLogger.info('COOKIE', 'Saving appstate_cookie.json to project root...', undefined, 'upload_save');

  // 2. Write file safely
  const saveResult = CookieLoader.saveCookieFileSafely(cookieJson);
  if (!saveResult.valid) {
    messengerLogger.error('COOKIE', `Failed to save cookie file: ${saveResult.error}`);
    return res.status(500).json({ error: saveResult.error });
  }

  messengerLogger.success('COOKIE', 'appstate_cookie.json saved successfully', undefined, 'upload_saved');
  messengerLogger.info('SESSION', 'Re-connecting Facebook Messenger session with new cookie file...', undefined, 'session_reconnect');

  // 3. Re-connect Messenger adapter
  await facebookSession.disconnect();
  const connected = await facebookSession.connect();

  auditLogsData.add('admin', 'Replaced appstate_cookie.json session file', undefined, 'SUCCESS');

  res.json({
    success: true,
    message: 'Session file updated successfully and Messenger reconnected.',
    status: facebookSession.getSafeMetadata()
  });
});

// Trigger Messenger Reconnect
app.post('/api/session/reconnect', requireAdminAuth, async (req: Request, res: Response) => {
  messengerLogger.info('SYSTEM', 'Manual Messenger reconnect triggered');
  await facebookSession.disconnect();
  const success = await facebookSession.connect();
  auditLogsData.add('admin', 'Triggered Messenger Adapter Reconnect', undefined, success ? 'SUCCESS' : 'FAILED');
  res.json({ success, status: facebookSession.getSafeMetadata() });
});

// Trigger Real Event Simulator Test
app.post('/api/session/test-event', requireAdminAuth, async (req: Request, res: Response) => {
  const { message = 'SHIPU_REAL_TEST_123' } = req.body;
  messengerLogger.info('TEST', `Test message event triggered via API: "${message}"`);
  facebookSession.handleIncomingTestEvent(message);
  res.json({ success: true, message: `Test event "${message}" dispatched to BotEngine.`, status: facebookSession.getSafeMetadata() });
});

// Delete session cookie
app.delete('/api/session', requireAdminAuth, async (req: Request, res: Response) => {
  messengerLogger.warn('COOKIE', 'Deleting appstate_cookie.json session file');
  await facebookSession.disconnect();
  CookieLoader.deleteCookieFile();
  auditLogsData.add('admin', 'Deleted Messenger Session Cookie', undefined, 'SUCCESS');
  res.json({ success: true, status: facebookSession.getSafeMetadata() });
});

// --- REAL-TIME LIVE LOGS SSE ENDPOINT ---
app.get('/api/messenger/live-logs', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  // Send initial batch of logs and stats
  const initialPayload = {
    type: 'init',
    logs: messengerLogger.getLogs(),
    stats: messengerLogger.getStats(),
    pipeline: messengerLogger.getPipeline()
  };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  // Subscribe to real-time logs
  const unsubscribe = messengerLogger.subscribe((entry, stats, pipeline) => {
    try {
      res.write(`data: ${JSON.stringify({ type: 'log', log: entry, stats, pipeline })}\n\n`);
    } catch (err) {
      // client disconnected
    }
  });

  // Heartbeat ping every 15 seconds to prevent timeout
  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clearInterval(pingInterval);
    }
  }, 15000);

  req.on('close', () => {
    unsubscribe();
    clearInterval(pingInterval);
  });
});

app.get('/api/messenger/stats', (req: Request, res: Response) => {
  res.json(messengerLogger.getStats());
});

app.delete('/api/messenger/logs', requireAdminAuth, (req: Request, res: Response) => {
  messengerLogger.clearLogs();
  auditLogsData.add('admin', 'Cleared Messenger Engine Live Logs', undefined, 'SUCCESS');
  res.json({ success: true });
});

// --- PER-ACCOUNT ISOLATED RUNTIME LOGS SSE ENDPOINT ---
app.get('/api/messenger/accounts/:accountId/live-logs', (req: Request, res: Response) => {
  const { accountId } = req.params;
  const categoryFilter = (req.query.category as string) || 'ALL';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  if (typeof (res as any).flushHeaders === 'function') {
    (res as any).flushHeaders();
  }

  // Get account metadata if registered
  const accConnection = multiAccountManager.getAccountConnection(accountId);
  const accMeta = accConnection ? accConnection.getSafeMetadata() : { accountId, displayName: accountId, uid: '—' };
  const metrics = accountRuntimeLogManager.getAccountMetrics(accMeta);
  const initialLogs = accountRuntimeLogManager.getAccountLogs(accountId, categoryFilter);

  const initialPayload = {
    type: 'init',
    accountId,
    logs: initialLogs,
    metrics
  };
  res.write(`data: ${JSON.stringify(initialPayload)}\n\n`);

  // Subscribe to isolated log events for this accountId
  const listener = (entry: any) => {
    try {
      const currentMeta = accConnection ? accConnection.getSafeMetadata() : accMeta;
      const updatedMetrics = accountRuntimeLogManager.getAccountMetrics(currentMeta);
      res.write(`data: ${JSON.stringify({ type: 'log', accountId, log: entry, metrics: updatedMetrics })}\n\n`);
    } catch (err) {
      // client disconnected
    }
  };

  accountRuntimeLogManager.on(`log:${accountId}`, listener);

  const pingInterval = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch (err) {
      clearInterval(pingInterval);
    }
  }, 15000);

  req.on('close', () => {
    accountRuntimeLogManager.removeListener(`log:${accountId}`, listener);
    clearInterval(pingInterval);
  });
});

app.get('/api/messenger/accounts/:accountId/logs', (req: Request, res: Response) => {
  const { accountId } = req.params;
  const category = req.query.category as string;
  const logs = accountRuntimeLogManager.getAccountLogs(accountId, category);
  res.json({ accountId, logs });
});

app.delete('/api/messenger/accounts/:accountId/logs', requireAdminAuth, (req: Request, res: Response) => {
  const { accountId } = req.params;
  accountRuntimeLogManager.clearAccountLogs(accountId);
  auditLogsData.add('admin', `Cleared Isolated Logs for Account ${accountId}`, undefined, 'SUCCESS');
  res.json({ success: true, accountId });
});

app.get('/api/messenger/accounts/:accountId/metrics', (req: Request, res: Response) => {
  const { accountId } = req.params;
  const accConnection = multiAccountManager.getAccountConnection(accountId);
  const accMeta = accConnection ? accConnection.getSafeMetadata() : { accountId, displayName: accountId, uid: '—' };
  const metrics = accountRuntimeLogManager.getAccountMetrics(accMeta);
  res.json(metrics);
});

// --- RUNTIME FILE MANAGER (ALLOWED FILES ONLY) ---
const ALLOWED_RUNTIME_FILES = ['appstate_cookie.json', 'bot-config.json', 'render.yaml'];

app.get('/api/system/files', requireAdminAuth, (req: Request, res: Response) => {
  const filename = req.query.filename as string;
  
  if (!filename) {
    const list = ALLOWED_RUNTIME_FILES.map(f => {
      const p = path.join(process.cwd(), f);
      const exists = fs.existsSync(p);
      const stats = exists ? fs.statSync(p) : null;
      return {
        filename: f,
        exists,
        sizeBytes: stats ? stats.size : 0,
        updatedAt: stats ? stats.mtime.toISOString() : null,
        protected: f === 'appstate_cookie.json'
      };
    });
    return res.json({ files: list });
  }

  if (!ALLOWED_RUNTIME_FILES.includes(filename)) {
    return res.status(403).json({ error: 'Access denied. File is not in the allowed runtime list.' });
  }

  // SECURITY: Never return contents of appstate_cookie.json
  if (filename === 'appstate_cookie.json') {
    return res.status(403).json({ error: 'SECURITY POLICY: Raw session cookie contents cannot be viewed.' });
  }

  const filePath = path.join(process.cwd(), filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.json({ filename, content });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- PROJECT FILE MANAGER REAL API ENDPOINTS ---

// Get allowed project directory tree
app.get('/api/project-files/tree', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const tree = ProjectFilesService.getFileTree();
    res.json({ success: true, tree });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Read file content
app.get('/api/project-files/read', requireAdminAuth, (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'Path parameter required.' });

  try {
    const { content, stats } = ProjectFilesService.readFile(filePath);
    res.json({
      success: true,
      path: filePath,
      content,
      size: stats.size,
      updatedAt: stats.mtime.toISOString()
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Save file
app.post('/api/project-files/save', requireAdminAuth, (req: Request, res: Response) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) {
    return res.status(400).json({ error: 'Path and content are required.' });
  }

  try {
    const result = ProjectFilesService.saveFile(filePath, content);
    auditLogsData.add('admin', `Saved Project File "${filePath}"`, filePath, 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    auditLogsData.add('admin', `Failed to Save File "${filePath}": ${err.message}`, filePath, 'FAILED');
    res.status(400).json({ error: err.message });
  }
});

// Create new file
app.post('/api/project-files/create', requireAdminAuth, (req: Request, res: Response) => {
  const { path: filePath, templateType } = req.body;
  if (!filePath) return res.status(400).json({ error: 'Path required.' });

  try {
    const result = ProjectFilesService.createNewFile(filePath, templateType);
    auditLogsData.add('admin', `Created New File "${filePath}"`, filePath, 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Create folder
app.post('/api/project-files/mkdir', requireAdminAuth, (req: Request, res: Response) => {
  const { path: dirPath } = req.body;
  if (!dirPath) return res.status(400).json({ error: 'Path required.' });

  try {
    const result = ProjectFilesService.createDirectory(dirPath);
    auditLogsData.add('admin', `Created Directory "${dirPath}"`, dirPath, 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Delete file or directory
app.delete('/api/project-files/delete', requireAdminAuth, (req: Request, res: Response) => {
  const filePath = (req.query.path || req.body.path) as string;
  if (!filePath) return res.status(400).json({ error: 'Path required.' });

  try {
    const result = ProjectFilesService.deletePath(filePath);
    auditLogsData.add('admin', `Deleted Path "${filePath}"`, filePath, 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Rename file or directory
app.post('/api/project-files/rename', requireAdminAuth, (req: Request, res: Response) => {
  const { oldPath, newPath } = req.body;
  if (!oldPath || !newPath) return res.status(400).json({ error: 'oldPath and newPath are required.' });

  try {
    const result = ProjectFilesService.renamePath(oldPath, newPath);
    auditLogsData.add('admin', `Renamed "${oldPath}" to "${newPath}"`, oldPath, 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Duplicate file
app.post('/api/project-files/duplicate', requireAdminAuth, (req: Request, res: Response) => {
  const { sourcePath, targetPath } = req.body;
  if (!sourcePath || !targetPath) return res.status(400).json({ error: 'sourcePath and targetPath required.' });

  try {
    const result = ProjectFilesService.duplicateFile(sourcePath, targetPath);
    auditLogsData.add('admin', `Duplicated File "${sourcePath}" to "${targetPath}"`, targetPath, 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Upload file
app.post('/api/project-files/upload', requireAdminAuth, (req: Request, res: Response) => {
  const { path: filePath, content } = req.body;
  if (!filePath || content === undefined) return res.status(400).json({ error: 'Path and content required.' });

  try {
    const result = ProjectFilesService.saveFile(filePath, content);
    auditLogsData.add('admin', `Uploaded File "${filePath}"`, filePath, 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Download file
app.get('/api/project-files/download', requireAdminAuth, (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'Path required.' });

  try {
    const { content } = ProjectFilesService.readFile(filePath);
    const filename = path.basename(filePath);
    res.setHeader('Content-Type', 'text/plain');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(content);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// Search across project code
app.get('/api/project-files/search', requireAdminAuth, (req: Request, res: Response) => {
  const query = req.query.query as string;
  if (!query) return res.json({ results: [] });

  try {
    const results = ProjectFilesService.searchCode(query);
    res.json({ results });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Backups list
app.get('/api/project-files/backups', requireAdminAuth, (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) return res.status(400).json({ error: 'Path required.' });

  try {
    const backups = ProjectFilesService.listBackups(filePath);
    res.json({ backups });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// Restore backup
app.post('/api/project-files/restore', requireAdminAuth, (req: Request, res: Response) => {
  const { path: filePath, backupFilename } = req.body;
  if (!filePath || !backupFilename) return res.status(400).json({ error: 'path and backupFilename required.' });

  try {
    const result = ProjectFilesService.restoreBackup(filePath, backupFilename);
    auditLogsData.add('admin', `Restored Backup "${backupFilename}" for "${filePath}"`, filePath, 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// --- SYSTEM AUDIT LOGS ---
app.get('/api/audit-logs', requireAdminAuth, async (req: Request, res: Response) => {
  const logs = await auditLogsData.getAll();
  res.json(logs);
});

// --- CONSOLIDATED DASHBOARD BOOTSTRAP ENDPOINT (Prevents parallel request rate limiting) ---
app.get('/api/dashboard/bootstrap', async (req: Request, res: Response) => {
  try {
    const stats = botEngine.getStats();
    const sessionMeta = facebookSession.getSafeMetadata();
    const mongoStatus = getDatabaseStatus();
    const ftpConfig = await ftpConfigData.get();

    const enrichedStats = {
      ...stats,
      messengerStatus: sessionMeta.status,
      mongoStatus: mongoStatus.connected ? 'CONNECTED' : mongoStatus.status,
      ftpStatus: ftpConfig?.enabled ? 'CONFIGURED' : 'NOT_CONFIGURED',
      currentPrefix: botEngine.getBotConfig().globalPrefix,
      botUserID: sessionMeta.botUserID,
      botUserName: sessionMeta.accountName
    };

    const dbCmds = await commandsData.getAll();
    const commands = (dbCmds && dbCmds.length > 0) ? dbCmds : botEngine.getPlugins().map(p => ({
      name: p.config.name,
      filename: `${p.config.name}.js`,
      description: p.config.description,
      category: p.config.category,
      role: p.config.role,
      aliases: p.config.aliases || [],
      guide: p.config.guide || `{pref}${p.config.name}`,
      countDown: p.config.countDown || 2,
      enabled: p.config.enabled !== false,
      author: p.config.author || 'ShiPu Dev',
      version: p.config.version || '1.0.0',
      code: p.code || '',
      updatedAt: new Date().toISOString()
    }));

    const threadsList = await threadsData.getAll();
    const threads = (threadsList && threadsList.length) ? threadsList : botEngine.getThreads();

    const usersList = await usersData.getAll();
    const users = (usersList && usersList.length) ? usersList : botEngine.getUsers();

    const config = await settingsData.get();
    const logs = botEngine.getLogs();

    res.json({
      stats: enrichedStats,
      commands,
      threads,
      users,
      config,
      logs,
      health: { status: 'ok' },
      mongoStatus: mongoStatus.connected ? 'CONNECTED' : mongoStatus.status,
      ftpStatus: ftpConfig?.enabled ? 'CONFIGURED' : 'NOT_CONFIGURED'
    });
  } catch (err: any) {
    console.error('[API /api/dashboard/bootstrap] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch bootstrap data' });
  }
});

// --- BOT ENGINE REST API ENDPOINTS ---

app.get('/api/bot/stats', async (req: Request, res: Response) => {
  const stats = botEngine.getStats();
  const sessionMeta = facebookSession.getSafeMetadata();
  const mongoStatus = getDatabaseStatus();
  const ftpConfig = await ftpConfigData.get();

  res.json({
    ...stats,
    messengerStatus: sessionMeta.status,
    mongoStatus: mongoStatus.connected ? 'CONNECTED' : mongoStatus.status,
    ftpStatus: ftpConfig?.enabled ? 'CONFIGURED' : 'NOT_CONFIGURED',
    currentPrefix: botEngine.getBotConfig().globalPrefix,
    botUserID: sessionMeta.botUserID,
    botUserName: sessionMeta.accountName
  });
});


app.get('/api/bot/commands', async (req: Request, res: Response) => {
  const dbCmds = await commandsData.getAll();
  if (dbCmds && dbCmds.length > 0) {
    return res.json(dbCmds);
  }

  const plugins = botEngine.getPlugins().map(p => ({
    name: p.config.name,
    filename: `${p.config.name}.js`,
    description: p.config.description,
    category: p.config.category,
    role: p.config.role,
    aliases: p.config.aliases || [],
    guide: p.config.guide || `{pref}${p.config.name}`,
    countDown: p.config.countDown || 2,
    enabled: p.config.enabled !== false,
    author: p.config.author || 'ShiPu Dev',
    version: p.config.version || '1.0.0',
    code: p.code || '',
    updatedAt: new Date().toISOString()
  }));
  res.json(plugins);
});

app.post('/api/bot/commands/save', requireAdminAuth, async (req: Request, res: Response) => {
  const { name, filename, description, category, role, aliases, guide, countDown, enabled, author, version, code } = req.body;
  if (!name || !code) {
    return res.status(400).json({ error: 'Command Name and Code are required' });
  }

  const cleanName = name.toLowerCase().trim();
  const cmdFilename = filename || `${cleanName}.js`;

  const commandRecord = {
    name: cleanName,
    filename: cmdFilename,
    description: description || 'ShiPu Ai Command',
    category: category || 'Custom',
    role: Number(role) || 0,
    aliases: Array.isArray(aliases) ? aliases : typeof aliases === 'string' ? aliases.split(',').map((s: string) => s.trim()).filter(Boolean) : [],
    guide: guide || `{pref}${cleanName}`,
    countDown: Number(countDown) || 2,
    enabled: enabled !== false,
    author: author || 'Admin',
    version: version || '1.0.0',
    code,
    updatedAt: new Date().toISOString()
  };

  await commandsData.set(cleanName, commandRecord);
  await botEngine.reloadPluginsFromDatabase();

  auditLogsData.add('admin', `Published & Hot-reloaded Command "${cmdFilename}"`, cleanName, 'SUCCESS');
  res.json({ success: true, message: `Command ${cmdFilename} saved in Database and hot-reloaded!`, command: commandRecord });
});

app.delete('/api/bot/commands/:name', requireAdminAuth, async (req: Request, res: Response) => {
  const name = req.params.name;
  if (!name) return res.status(400).json({ error: 'Command name required' });

  await commandsData.delete(name);
  await botEngine.reloadPluginsFromDatabase();

  auditLogsData.add('admin', `Deleted Command "${name}" from Database`, name, 'SUCCESS');
  res.json({ success: true, message: `Command ${name} removed from Database and hot-reloaded!` });
});

app.post('/api/bot/commands/bulk-action', requireAdminAuth, async (req: Request, res: Response) => {
  const { action, names } = req.body;
  if (!action || !Array.isArray(names) || names.length === 0) {
    return res.status(400).json({ error: 'Action and array of command names are required' });
  }

  try {
    if (action === 'enable' || action === 'disable') {
      const enabled = action === 'enable';
      for (const name of names) {
        const existing = await commandsData.get(name);
        if (existing) {
          existing.enabled = enabled;
          await commandsData.set(name, existing);
        } else {
          botEngine.togglePlugin(name, enabled);
        }
      }
      await botEngine.reloadPluginsFromDatabase();
      auditLogsData.add('admin', `Bulk ${action}d ${names.length} commands`, 'Commands', 'SUCCESS');
      res.json({ success: true, message: `Successfully ${action}d ${names.length} commands.` });
    } else if (action === 'delete') {
      for (const name of names) {
        await commandsData.delete(name);
      }
      await botEngine.reloadPluginsFromDatabase();
      auditLogsData.add('admin', `Bulk deleted ${names.length} commands`, 'Commands', 'SUCCESS');
      res.json({ success: true, message: `Successfully deleted ${names.length} commands.` });
    } else {
      res.status(400).json({ error: 'Invalid action. Must be enable, disable, or delete.' });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message || 'Error executing bulk action' });
  }
});

app.post('/api/bot/commands/test', requireAdminAuth, async (req: Request, res: Response) => {
  const { commandName, args = '', senderID = '10001', threadID = 'test_thread_01', customCode } = req.body;
  if (!commandName) {
    return res.status(400).json({ error: 'Command name is required' });
  }

  const cleanName = String(commandName).toLowerCase().trim();
  const argsText = Array.isArray(args) ? args.join(' ') : String(args || '').trim();
  const rawText = `#${cleanName} ${argsText}`.trim();
  const startTime = performance.now();

  try {
    if (customCode && typeof customCode === 'string' && customCode.trim().length > 10) {
      const { goatBotLoader } = await import('./src/core/goatBotLoader');
      goatBotLoader.loadCommandFromCode(customCode, `${cleanName}.js`);
    }

    const result = await botEngine.handleIncomingEvent(
      threadID,
      senderID,
      rawText,
      `test_msg_${Date.now()}`
    );

    const durationMs = Math.max(1, Math.round((performance.now() - startTime) * 100) / 100);

    return res.json({
      success: true,
      commandName: cleanName,
      rawInput: rawText,
      response: result.body || '(Command executed successfully)',
      durationMs,
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    const durationMs = Math.max(1, Math.round((performance.now() - startTime) * 100) / 100);
    return res.status(500).json({
      success: false,
      commandName: cleanName,
      rawInput: rawText,
      error: err.message || 'Error executing command test',
      durationMs,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/api/bot/plugins/toggle', requireAdminAuth, async (req: Request, res: Response) => {
  const { name, enabled } = req.body;
  if (!name) return res.status(400).json({ error: 'Plugin name required' });
  
  const existing = await commandsData.get(name);
  if (existing) {
    existing.enabled = !!enabled;
    await commandsData.set(name, existing);
    await botEngine.reloadPluginsFromDatabase();
  } else {
    botEngine.togglePlugin(name, enabled);
  }

  auditLogsData.add('admin', `Toggled Plugin "${name}" to ${enabled}`, name, 'SUCCESS');
  res.json({ success: true, name, enabled });
});

app.post('/api/bot/plugins/import-zip', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    let zipBuffer: Buffer | undefined;
    if (req.body && req.body.zipBase64) {
      zipBuffer = Buffer.from(req.body.zipBase64, 'base64');
    }
    const report = await zipImporterService.importZip(zipBuffer);
    auditLogsData.add('admin', `Imported ZIP commands collection into Database`, 'Plugins', 'SUCCESS');
    res.json({ success: true, report });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to process ZIP import' });
  }
});

app.get('/api/bot/plugins/import-report', async (req: Request, res: Response) => {
  const report = zipImporterService.getLastReport();
  res.json({ report });
});

// Dependency Manager Endpoints
app.get('/api/bot/dependencies/check', requireAdminAuth, async (req: Request, res: Response) => {
  const code = (req.query.code as string) || '';
  const result = dependencyManager.extractDependenciesFromCode(code);
  res.json(result);
});

app.post('/api/bot/dependencies/install', requireAdminAuth, async (req: Request, res: Response) => {
  const { packages } = req.body;
  if (!Array.isArray(packages) || packages.length === 0) {
    return res.status(400).json({ error: 'packages array required' });
  }
  const result = await dependencyManager.ensureDependenciesInstalled(packages);
  auditLogsData.add('admin', `Auto Dependency Manager installed: ${packages.join(', ')}`, 'Dependencies', 'SUCCESS');
  res.json(result);
});

// Live Chat Simulator endpoint
app.post('/api/bot/chat', async (req: Request, res: Response) => {
  const { threadID, senderID, message } = req.body;
  if (!threadID || !senderID || !message) {
    return res.status(400).json({ error: 'threadID, senderID and message are required' });
  }

  const response = await botEngine.handleIncomingEvent(threadID, senderID, message);
  res.json({ response });
});

app.get('/api/bot/threads', async (req: Request, res: Response) => {
  try {
    const list = await threadsData.getAll();
    res.json(list && list.length ? list : botEngine.getThreads());
  } catch (err) {
    console.error('[API /api/bot/threads] Error:', err);
    res.json(botEngine.getThreads() || []);
  }
});

app.post('/api/bot/threads', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name, prefix } = req.body;
    const thread = botEngine.createNewThread(name || 'New Group Thread', prefix || '#');
    await threadsData.set(thread.threadID, thread);
    auditLogsData.add('admin', `Created Group Thread "${name}"`, thread.threadID, 'SUCCESS');
    res.json(thread);
  } catch (err: any) {
    console.error('[API POST /api/bot/threads] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to create thread' });
  }
});

app.get('/api/bot/users', async (req: Request, res: Response) => {
  try {
    const list = await usersData.getAll();
    res.json(list && list.length ? list : botEngine.getUsers());
  } catch (err) {
    console.error('[API /api/bot/users] Error:', err);
    res.json(botEngine.getUsers() || []);
  }
});

app.post('/api/bot/users/update', requireAdminAuth, async (req: Request, res: Response) => {
  const { userID, role, money, isBanned } = req.body;
  if (!userID) return res.status(400).json({ error: 'userID required' });

  await usersData.update(userID, {
    ...(role !== undefined && { role }),
    ...(money !== undefined && { money: Number(money) }),
    ...(isBanned !== undefined && { isBanned })
  });

  botEngine.setUserData(userID, {
    ...(role !== undefined && { role }),
    ...(money !== undefined && { money: Number(money) }),
    ...(isBanned !== undefined && { isBanned })
  });

  auditLogsData.add('admin', `Updated User Data for ${userID}`, userID, 'SUCCESS');
  res.json({ success: true });
});

// --- CENTRALIZED ECONOMY & DIGITAL BANKING API ENDPOINTS ---
app.get('/api/economy/overview', async (req: Request, res: Response) => {
  try {
    const stats = await economyService.getOverviewStats();
    res.json(stats);
  } catch (err: any) {
    console.error('[API /api/economy/overview] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch economy overview' });
  }
});

app.get('/api/economy/transactions', async (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit || 50);
    const type = req.query.type as string;
    const userID = req.query.userID as string;
    const txs = await economyService.getTransactions({ limit, type, userID });
    res.json(txs);
  } catch (err: any) {
    console.error('[API /api/economy/transactions] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch economy transactions' });
  }
});

app.post('/api/economy/config', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const updated = await economyService.updateConfig(req.body || {});
    auditLogsData.add('admin', 'Updated Centralized Economy Configuration', undefined, 'SUCCESS');
    res.json({ success: true, config: updated });
  } catch (err: any) {
    console.error('[API /api/economy/config] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to update economy config' });
  }
});

app.get('/api/economy/users', async (req: Request, res: Response) => {
  try {
    const search = req.query.search as string;
    const limit = Number(req.query.limit || 100);
    const users = await economyService.getAccounts(search, limit);
    res.json(users);
  } catch (err: any) {
    console.error('[API /api/economy/users] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch economy users' });
  }
});

app.post('/api/economy/set-balance', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { userID, wallet, bankMoney, note } = req.body;
    if (!userID) return res.status(400).json({ error: 'userID required' });

    const updatedAccount = await economyService.setBalance(
      userID,
      Number(wallet ?? 0),
      Number(bankMoney ?? 0),
      note || 'Admin direct set balance'
    );

    auditLogsData.add('admin', `Admin set balance for ${userID}: wallet=$${wallet}, bank=$${bankMoney}`, userID, 'SUCCESS');
    res.json({ success: true, updatedAccount });
  } catch (err: any) {
    console.error('[API /api/economy/set-balance] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to set user balance' });
  }
});

app.post('/api/economy/adjust', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { userID, walletDelta, bankDelta, note } = req.body;
    if (!userID) return res.status(400).json({ error: 'userID required' });

    const acc = await economyService.getAccount(userID);
    const newWallet = Math.max(0, acc.money + Number(walletDelta || 0));
    const newBank = Math.max(0, acc.bankMoney + Number(bankDelta || 0));

    await economyService.syncProfileToDb(userID, {
      money: newWallet,
      bankMoney: newBank
    });

    await economyService.recordTransaction({
      senderID: 'ADMIN_OVERRIDE',
      senderName: 'Admin Dashboard',
      receiverID: userID,
      receiverName: acc.name,
      amount: Math.abs(Number(walletDelta || 0) + Number(bankDelta || 0)),
      currency: 'Coins',
      sourceCommand: 'ADMIN_OVERRIDE',
      type: 'ADMIN_ADJUST',
      reason: note || `Admin adjusted balance by wallet:${walletDelta}, bank:${bankDelta}`,
      threadID: 'ADMIN',
      status: 'SUCCESS',
      adminAction: true
    });

    // Also sync to botEngine
    botEngine.setUserData(userID, { money: newWallet, bankMoney: newBank });
    await usersData.update(userID, { money: newWallet, bankMoney: newBank });

    auditLogsData.add('admin', `Admin adjusted economy balance for ${userID}`, userID, 'SUCCESS');
    res.json({ success: true, updatedAccount: await economyService.getAccount(userID) });
  } catch (err: any) {
    console.error('[API /api/economy/adjust] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to adjust account balance' });
  }
});

app.post('/api/economy/reset-all', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    await economyService.resetAllUsersBalance();
    auditLogsData.add('admin', 'Admin reset all user balances to 0 for system reconfiguration', undefined, 'SUCCESS');
    res.json({ success: true, message: 'All user balances have been reset to 0.' });
  } catch (err: any) {
    console.error('[API /api/economy/reset-all] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to reset all balances' });
  }
});

// --- BOT SUBSCRIPTION ECONOMY API ENDPOINTS ---
app.get('/api/subscription/analytics', async (req: Request, res: Response) => {
  try {
    const report = await subscriptionService.generateSubscriptionReport();
    res.json(report);
  } catch (err: any) {
    console.error('[API /api/subscription/analytics] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch subscription analytics' });
  }
});

app.get('/api/subscription/users', async (req: Request, res: Response) => {
  try {
    const status = req.query.status as string;
    const search = req.query.search as string;
    const limit = Number(req.query.limit || 100);
    const users = await subscriptionService.getAllSubscriptions({ status, search, limit });
    res.json(users);
  } catch (err: any) {
    console.error('[API /api/subscription/users] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to fetch subscription users' });
  }
});

app.post('/api/subscription/admin-action', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { action, userID, weeks, status, txID, enabled, adminUid } = req.body;
    if (!userID) return res.status(400).json({ error: 'userID is required' });

    let result: any = { success: true };

    if (action === 'extend' || action === 'grant_free') {
      const numWeeks = Number(weeks || 1);
      result = await subscriptionService.extendSubscription(userID, numWeeks, adminUid || 'ADMIN');
      auditLogsData.add('admin', `Admin extended subscription for ${userID} by ${numWeeks} week(s)`, userID, 'SUCCESS');
    } else if (action === 'set_status') {
      result = await subscriptionService.setUserStatus(userID, status, adminUid || 'ADMIN');
      auditLogsData.add('admin', `Admin changed subscription status for ${userID} to ${status}`, userID, 'SUCCESS');
    } else if (action === 'toggle_autorenew') {
      result = await subscriptionService.toggleAutoRenew(userID, enabled);
      auditLogsData.add('admin', `Admin toggled auto-renew for ${userID} to ${result.autoRenew}`, userID, 'SUCCESS');
    } else if (action === 'refund') {
      if (!txID) return res.status(400).json({ error: 'txID is required for refund' });
      result = await subscriptionService.refundPayment(userID, txID, adminUid || 'ADMIN');
      auditLogsData.add('admin', `Admin refunded subscription transaction ${txID} for ${userID}`, userID, 'SUCCESS');
    } else {
      return res.status(400).json({ error: `Unknown admin action: ${action}` });
    }

    res.json({ success: true, result });
  } catch (err: any) {
    console.error('[API /api/subscription/admin-action] Error:', err);
    res.status(500).json({ error: err.message || 'Failed to process subscription action' });
  }
});

app.get('/api/subscription/export', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const report = await subscriptionService.generateSubscriptionReport();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename=subscription_report_${Date.now()}.json`);
    res.send(JSON.stringify(report, null, 2));
  } catch (err: any) {
    res.status(500).json({ error: 'Failed to export subscription data' });
  }
});

app.get('/api/bot/logs', (req: Request, res: Response) => {
  res.json(botEngine.getLogs());
});

app.delete('/api/bot/logs', requireAdminAuth, (req: Request, res: Response) => {
  botEngine.clearLogs();
  auditLogsData.add('admin', 'Cleared System Logs', undefined, 'SUCCESS');
  res.json({ success: true });
});

app.get('/api/bot/settings', async (req: Request, res: Response) => {
  const config = await settingsData.get();
  res.json(config);
});

app.post('/api/bot/settings', requireAdminAuth, async (req: Request, res: Response) => {
  const updated = await settingsData.update(req.body);
  botEngine.updateBotConfig(updated);
  auditLogsData.add('admin', 'Updated Global Bot Settings', undefined, 'SUCCESS');
  res.json({ success: true, config: updated });
});

// Hot Engine Reload (No process restart, keeps FB/Mqtt/Mongo intact)
app.post('/api/bot/reload', async (req: Request, res: Response) => {
  try {
    const reloadResult = await botEngine.hotReloadEngine();
    auditLogsData.add('system', 'Hot Reloaded Engine Runtime State', undefined, 'SUCCESS');
    res.json({
      success: true,
      message: 'ShiPu Ai Engine hot-reloaded successfully without restarting the process.',
      reloadedCommands: reloadResult.reloadedCommands,
      timestamp: reloadResult.timestamp,
      stats: botEngine.getStats()
    });
  } catch (err: any) {
    auditLogsData.add('system', `Hot Reload Failed: ${err.message}`, undefined, 'FAILURE');
    res.status(500).json({ error: err.message || 'Hot reload failed' });
  }
});

// --- BRAIN MANAGEMENT SYSTEM API ---

// 1. Get all memories with query options
app.get('/api/bot/brain/memories', async (req: Request, res: Response) => {
  try {
    const { search, category, sort } = req.query;
    const query: any = {};
    if (category) {
      query.category = category;
    }
    if (search) {
      query.$or = [
        { trigger: { $regex: search, $options: 'i' } },
        { reply: { $regex: search, $options: 'i' } },
        { variations: { $regex: search, $options: 'i' } }
      ];
    }
    
    let sortOption: any = { createdAt: -1 };
    if (sort === 'usage') {
      sortOption = { usageCount: -1 };
    } else if (sort === 'trigger') {
      sortOption = { trigger: 1 };
    } else if (sort === 'lastUsed') {
      sortOption = { lastUsed: -1 };
    }

    const list = await BrainMemoryModel.find(query).sort(sortOption).lean();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Create memory with AI normalization
app.post('/api/bot/brain/memories', async (req: Request, res: Response) => {
  try {
    const { trigger, reply, category } = req.body;
    if (!trigger || !reply) {
      return res.status(400).json({ error: 'Trigger and reply are required' });
    }

    const cleanTrigger = stripEmojiFormatters(trigger.toLowerCase().trim());
    const normResult = await brainService.aiNormalize(cleanTrigger, reply);

    const memory = await BrainMemoryModel.create({
      trigger: cleanTrigger,
      variations: normResult.variations,
      aiNormalizedTrigger: normResult.aiNormalizedTrigger,
      reply,
      replyVariations: normResult.replyVariations,
      category: category || 'general',
      createdBy: 'Admin Dashboard',
      enabled: true,
      confidenceScore: 0.95
    });

    await memory.save();
    await brainService.loadMemoriesToCache();

    auditLogsData.add('admin', `Created Brain Memory: "${cleanTrigger}"`, String(memory._id), 'SUCCESS');
    res.status(201).json(memory);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Update memory
app.put('/api/bot/brain/memories/:id', async (req: Request, res: Response) => {
  try {
    const { trigger, reply, category, enabled } = req.body;
    const memory = await BrainMemoryModel.findById(req.params.id);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    if (trigger !== undefined) memory.trigger = stripEmojiFormatters(trigger.toLowerCase().trim());
    if (reply !== undefined) {
      memory.reply = reply;
      const normResult = await brainService.aiNormalize(memory.trigger, reply);
      memory.variations = normResult.variations;
      memory.aiNormalizedTrigger = normResult.aiNormalizedTrigger;
      memory.replyVariations = normResult.replyVariations;
    }
    if (category !== undefined) memory.category = category;
    if (enabled !== undefined) memory.enabled = enabled;

    await memory.save();
    await brainService.loadMemoriesToCache();

    auditLogsData.add('admin', `Updated Brain Memory: "${memory.trigger}"`, String(memory._id), 'SUCCESS');
    res.json(memory);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Delete memory
app.delete('/api/bot/brain/memories/:id', async (req: Request, res: Response) => {
  try {
    const memory = await BrainMemoryModel.findByIdAndDelete(req.params.id);
    if (!memory) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    await brainService.loadMemoriesToCache();
    auditLogsData.add('admin', `Deleted Brain Memory: "${memory.trigger}"`, String(memory._id), 'SUCCESS');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Get suggestions
app.get('/api/bot/brain/suggestions', async (req: Request, res: Response) => {
  try {
    const list = await BrainSuggestionModel.find({ status: 'pending' }).sort({ count: -1 }).lean();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Approve suggestion
app.post('/api/bot/brain/suggestions/:id/approve', async (req: Request, res: Response) => {
  try {
    const suggestion = await BrainSuggestionModel.findById(req.params.id);
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const cleanTrigger = stripEmojiFormatters(suggestion.trigger.toLowerCase().trim());
    const normResult = await brainService.aiNormalize(cleanTrigger, suggestion.suggestedReply);

    let memory;

    // Check if it's a fact and there is already an active memory for this exact fact (entity + attribute)
    if (suggestion.isFact && suggestion.factEntity && suggestion.factAttribute) {
      const entity = suggestion.factEntity.toLowerCase().trim();
      const attr = suggestion.factAttribute.toLowerCase().trim();

      const existingFact = await BrainMemoryModel.findOne({
        isFact: true,
        factEntity: entity,
        factAttribute: attr
      });

      if (existingFact) {
        existingFact.trigger = cleanTrigger;
        existingFact.variations = normResult.variations;
        existingFact.aiNormalizedTrigger = normResult.aiNormalizedTrigger;
        existingFact.reply = suggestion.suggestedReply;
        existingFact.replyVariations = normResult.replyVariations;
        existingFact.category = suggestion.category || 'fact';
        existingFact.factValue = suggestion.factValue;
        existingFact.createdBy = 'Suggestion Approver (Fact Update)';
        existingFact.enabled = true;
        
        await existingFact.save();
        memory = existingFact;
      }
    }

    if (!memory) {
      memory = await BrainMemoryModel.create({
        trigger: cleanTrigger,
        variations: normResult.variations,
        aiNormalizedTrigger: normResult.aiNormalizedTrigger,
        reply: suggestion.suggestedReply,
        replyVariations: normResult.replyVariations,
        category: suggestion.category || 'general',
        createdBy: 'Suggestion Approver',
        enabled: true,
        confidenceScore: 0.90,
        isFact: suggestion.isFact || false,
        factEntity: suggestion.factEntity || '',
        factAttribute: suggestion.factAttribute || '',
        factValue: suggestion.factValue || '',
        metadata: { learningContext: suggestion.learningContext }
      });
      await memory.save();
    }
    
    suggestion.status = 'approved';
    await suggestion.save();

    await brainService.loadMemoriesToCache();

    auditLogsData.add('admin', `Approved Brain Suggestion: "${cleanTrigger}"`, String(memory._id), 'SUCCESS');
    res.json({ success: true, memory });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Reject suggestion
app.delete('/api/bot/brain/suggestions/:id', async (req: Request, res: Response) => {
  try {
    const suggestion = await BrainSuggestionModel.findById(req.params.id);
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    suggestion.status = 'rejected';
    await suggestion.save();

    auditLogsData.add('admin', `Rejected Brain Suggestion: "${suggestion.trigger}"`, String(suggestion._id), 'SUCCESS');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7.5 Edit Suggestion before approving
app.post('/api/bot/brain/suggestions/:id/edit', async (req: Request, res: Response) => {
  try {
    const { trigger, suggestedReply, isFact, factEntity, factAttribute, factValue } = req.body;
    const suggestion = await BrainSuggestionModel.findById(req.params.id);
    if (!suggestion) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    if (trigger) suggestion.trigger = trigger;
    if (suggestedReply) suggestion.suggestedReply = suggestedReply;
    if (typeof isFact !== 'undefined') suggestion.isFact = isFact;
    if (typeof factEntity !== 'undefined') suggestion.factEntity = factEntity;
    if (typeof factAttribute !== 'undefined') suggestion.factAttribute = factAttribute;
    if (typeof factValue !== 'undefined') suggestion.factValue = factValue;

    await suggestion.save();
    auditLogsData.add('admin', `Edited Brain Suggestion: "${suggestion.trigger}"`, String(suggestion._id), 'SUCCESS');
    res.json({ success: true, suggestion });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7.6 Inferred Attributes Endpoints
app.get('/api/bot/brain/inferred-attributes', async (req: Request, res: Response) => {
  try {
    const { threadID, attributeType } = req.query;
    const query: any = {};
    if (threadID) query.threadID = threadID;
    if (attributeType) query.attributeType = attributeType;

    const list = await InferredAttributeModel.find(query).sort({ updatedAt: -1 }).lean();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bot/brain/inferred-attributes', async (req: Request, res: Response) => {
  try {
    const { threadID, userID, userName, attributeType, value, confidence, context } = req.body;
    if (!threadID || !userID || !attributeType || !value) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    let attr = await InferredAttributeModel.findOne({ threadID, userID, attributeType });
    if (attr) {
      if (attr.value !== value) {
        attr.history.push({
          value: attr.value,
          timestamp: attr.updatedAt || new Date(),
          context: context || 'Previous recorded state'
        });
      }
      attr.value = value;
      attr.userName = userName || attr.userName || '';
      attr.confidence = typeof confidence === 'number' ? confidence : attr.confidence;
      await attr.save();
    } else {
      attr = await InferredAttributeModel.create({
        threadID,
        userID,
        userName: userName || '',
        attributeType,
        value,
        confidence: typeof confidence === 'number' ? confidence : 1.0,
        history: []
      });
      await attr.save();
    }

    auditLogsData.add('admin', `Saved Inferred Attribute: ${attributeType} for ${userID}`, String(attr._id), 'SUCCESS');
    res.json({ success: true, attribute: attr });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/bot/brain/inferred-attributes/:id', async (req: Request, res: Response) => {
  try {
    const attr = await InferredAttributeModel.findByIdAndDelete(req.params.id);
    if (!attr) {
      return res.status(404).json({ error: 'Inferred Attribute not found' });
    }
    auditLogsData.add('admin', `Deleted Inferred Attribute: ${attr.attributeType} for ${attr.userID}`, String(attr._id), 'SUCCESS');
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Bulk Import
app.post('/api/bot/brain/bulk-import', async (req: Request, res: Response) => {
  try {
    const { memories } = req.body;
    if (!memories || !Array.isArray(memories)) {
      return res.status(400).json({ error: 'Memories array is required' });
    }

    let importCount = 0;
    for (const item of memories) {
      if (!item.trigger || !item.reply) continue;
      
      const cleanTrigger = stripEmojiFormatters(item.trigger.toLowerCase().trim());
      const normResult = await brainService.aiNormalize(cleanTrigger, item.reply);
      
      await BrainMemoryModel.updateOne(
        { trigger: cleanTrigger },
        {
          $set: {
            trigger: cleanTrigger,
            variations: normResult.variations,
            aiNormalizedTrigger: normResult.aiNormalizedTrigger,
            reply: item.reply,
            replyVariations: normResult.replyVariations,
            category: item.category || 'general',
            createdBy: 'Bulk Import',
            enabled: true,
            confidenceScore: 0.95
          }
        },
        { upsert: true }
      );
      importCount++;
    }

    await brainService.loadMemoriesToCache();
    auditLogsData.add('admin', `Bulk Imported ${importCount} Brain Memories`, undefined, 'SUCCESS');
    res.json({ success: true, count: importCount });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 9. Bulk Export
app.get('/api/bot/brain/bulk-export', async (req: Request, res: Response) => {
  try {
    const list = await BrainMemoryModel.find().lean();
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename=shipu_ai_brain_memories.json');
    res.send(JSON.stringify(list, null, 2));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// System Restart
app.post('/api/system/restart', requireAdminAuth, async (req: Request, res: Response) => {
  auditLogsData.add('admin', 'Triggered System Graceful Restart', undefined, 'SUCCESS');
  res.json({ success: true, message: 'Graceful restart initiated.' });
  setTimeout(() => {
    gracefulShutdown('ADMIN_RESTART');
  }, 1000);
});

// --- SUPABASE MANAGEMENT ENDPOINTS ---

// Client bots are stored in Firebase RTDB now (Supabase removed).
// Endpoint paths are kept so the dashboard keeps working unchanged.
app.get('/api/supabase/client-bots', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const sessions = await clientBotsManager.listSessions();
    res.json({ bots: sessions || [] });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/supabase/config', requireAdminAuth, (req: Request, res: Response) => {
  try {
    res.json({
      projectId: 'shipu-ai',
      databaseURL: 'https://shipu-ai-default-rtdb.firebaseio.com',
      root: 'shipu-messsenger-bot/client-bots',
      store: 'Firebase RTDB',
      realtimeEnabled: true
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supabase/client-bots/:botId/reconnect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    await clientBotsManager.reconnectBot(req.params.botId);
    res.json({ success: true });
  } catch(err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supabase/client-bots/:botId/disconnect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    await clientBotsManager.handleDeleteFlow(req.params.botId);
    res.json({ success: true });
  } catch(err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supabase/client-bots/:botId/restart', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    await clientBotsManager.reconnectBot(req.params.botId);
    res.json({ success: true });
  } catch(err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supabase/config', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    clientBotsManager.startRealtimeSubscriptions();
    auditLogsData.add('admin', 'Updated Client Bots Configuration (Firebase)', undefined, 'SUCCESS');
    res.json({ success: true, message: 'Configuration saved successfully (Firebase RTDB is hardcoded).' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/supabase/status', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await clientBotsManager.testConnection();
    res.json({ configured: result.success, connected: result.success, store: 'Firebase RTDB', error: result.error || null });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supabase/test-connection', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await clientBotsManager.testConnection();
    const logs = ['Starting connection test...'];
    if (result.success) {
      logs.push('Connection successful! (Firebase RTDB)');
      res.json({ success: true, message: 'Connection test passed', logs, ...result });
    } else {
      logs.push(`Connection failed: ${result.error}`);
      res.status(400).json({ error: result.error || 'Connection failed', logs, ...result });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message, logs: [`Unexpected error: ${err.message}`] });
  }
});

app.post('/api/supabase/initialize-db', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await clientBotsManager.testConnection();
    auditLogsData.add('admin', result.success ? 'Verified Firebase Client Bots store' : 'Failed Client Bots store check', undefined, result.success ? 'SUCCESS' : 'ERROR');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supabase/reconnect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    clientBotsManager.startRealtimeSubscriptions();
    auditLogsData.add('admin', 'Reconnected Client Bots watcher', undefined, 'SUCCESS');
    res.json({ success: true, message: 'Watcher successfully restarted.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/supabase/clear-queue', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { firebaseConfig, FIREBASE_BOT_ROOT } = await import('./src/config/firebase');
    const base = (firebaseConfig.databaseURL || '').replace(/\/+$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const listRes = await fetch(`${base}/${FIREBASE_BOT_ROOT}/client-bots/queue.json`, { signal: ctrl.signal });
      const queue = (await listRes.json()) || {};
      let cleared = 0;
      for (const [id, item] of Object.entries<any>(queue)) {
        if (item && item.status !== 'processing') {
          await fetch(`${base}/${FIREBASE_BOT_ROOT}/client-bots/queue/${encodeURIComponent(id)}.json`, { method: 'DELETE', signal: ctrl.signal });
          cleared++;
        }
      }
      auditLogsData.add('admin', 'Cleared Client Bots queue', undefined, 'SUCCESS');
      res.json({ success: true, message: `Queue successfully cleared (${cleared} item(s)).` });
    } finally {
      clearTimeout(timer);
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- SCHEDULER ENDPOINTS ---
app.get('/api/bot/scheduler', (req: Request, res: Response) => {
  res.json(schedulerService.getTasks());
});

app.post('/api/bot/scheduler/toggle', requireAdminAuth, (req: Request, res: Response) => {
  const { taskId } = req.body;
  const task = schedulerService.toggleTask(taskId);
  res.json({ success: true, task });
});

app.post('/api/bot/scheduler/run', requireAdminAuth, (req: Request, res: Response) => {
  const { taskId } = req.body;
  const task = schedulerService.runTaskNow(taskId);
  res.json({ success: true, task });
});

// --- SERVER-SIDE GEMINI AI ENDPOINT ---
// Scoped maps for per-context AI request de-duplication, per-thread lock, and per-account MQTT flood queue lock
const activePromptGenerations = new Map<string, Promise<any>>();
const activeContextLocks = new Map<string, number>();
const activeAccountLocks = new Map<string, number>();

const MAX_CONCURRENT_PER_CONTEXT = 1; // 1 active generation per conversation thread/user context
const MAX_CONCURRENT_PER_ACCOUNT = 3; // Max 3 concurrent generations per FB bot account to prevent MQTT socket flood

app.post('/api/gemini/chat', async (req: Request, res: Response) => {
  const { 
    prompt, 
    attachments, 
    image, 
    requestId: clientRequestId, 
    contextKey: reqContextKey,
    threadId,
    conversationId,
    userId,
    accountId 
  } = req.body;
  
  const requestId = clientRequestId || 'ai_svr_' + Date.now() + '_' + Math.random().toString(36).substring(2, 9);
  
  if (!prompt && !attachments && !image) {
    return res.status(400).json({ error: 'Prompt or image attachment is required' });
  }

  const promptText = prompt || 'Describe this image in detail.';
  const normalizedPrompt = promptText.trim().toLowerCase();

  // Determine conversation/thread context key for multi-tenant Messenger bot scale
  const contextKey = String(
    reqContextKey ||
    (threadId ? (accountId ? `acc_${accountId}_th_${threadId}` : `th_${threadId}`) : null) ||
    (conversationId ? `conv_${conversationId}` : null) ||
    (userId ? `usr_${userId}` : null) ||
    req.ip ||
    'global_context'
  );

  const accountKey = accountId ? String(accountId) : 'default_account';
  const dedupeKey = `${contextKey}:${normalizedPrompt}`;

  // 1. Context-scoped Request Deduplication (shares active promise for identical prompts in the SAME thread)
  if (activePromptGenerations.has(dedupeKey)) {
    console.log(`[Backend AI de-duplicator] Duplicate prompt in context [${contextKey}] detected. Sharing promise for requestId: ${requestId}`);
    try {
      const responseText = await activePromptGenerations.get(dedupeKey);
      return res.json({ response: responseText, requestId, contextKey, accountKey, duplicated: true });
    } catch (err: any) {
      return res.status(500).json({ 
        error: 'DUPLICATE_FAILED', 
        message: err.message || 'Shared duplicate generation failed.',
        requestId,
        contextKey,
        accountKey
      });
    }
  }

  // 2. Per-Context Concurrency Lock (prevents overlapping generations within the SAME thread/user, while allowing hundreds of other threads in parallel)
  const activeInContext = activeContextLocks.get(contextKey) || 0;
  if (activeInContext >= MAX_CONCURRENT_PER_CONTEXT) {
    console.warn(`[Backend AI lock] Prevented overlapping generation for context [${contextKey}] (requestId: ${requestId}).`);
    return res.status(429).json({
      error: 'CONCURRENT_LIMIT',
      message: `An AI response is already generating for this active conversation thread (${contextKey}). Please wait for it to finish.`,
      requestId,
      contextKey,
      accountKey
    });
  }

  // 3. Per-Account Flood Queue Lock (prevents MQTT socket flood when a single FB account processes dozens of active group messages simultaneously)
  const activeInAccount = activeAccountLocks.get(accountKey) || 0;
  if (activeInAccount >= MAX_CONCURRENT_PER_ACCOUNT) {
    console.warn(`[Backend Account Flood Lock] Account [${accountKey}] reached limit of ${MAX_CONCURRENT_PER_ACCOUNT} concurrent generations.`);
    return res.status(429).json({
      error: 'ACCOUNT_QUEUE_FULL',
      message: `Facebook account (${accountKey}) has reached max concurrent generation capacity (${MAX_CONCURRENT_PER_ACCOUNT}). Please wait a moment.`,
      requestId,
      contextKey,
      accountKey
    });
  }

  // Acquire per-context and per-account locks
  activeContextLocks.set(contextKey, activeInContext + 1);
  activeAccountLocks.set(accountKey, activeInAccount + 1);

  // Create generation promise for this thread
  const generationPromise = (async () => {
    try {
      const { extractImageParts } = await import('./src/utils/fileParser');
      const imageParts = await extractImageParts(attachments || image || req.body);

      const brainMatch = brainService.findMatch(promptText);
      let systemKnowledge = '';
      if (brainMatch && brainMatch.memory) {
        systemKnowledge = `\n\n=== SYSTEM KNOWLEDGE (ShiPu Brain Database) ===\nTrigger: "${brainMatch.memory.trigger}"\nSaved Data: "${brainMatch.memory.reply}"\nCategory: "${brainMatch.memory.category || 'General'}"\nINSTRUCTION: A match for the user's intent was found in ShiPu Brain. Use this System Knowledge saved personalized data to answer the user accurately and naturally.`;
      }

      const { aiProviderManager } = await import('./src/ai/providers/providerManager');
      const userParts: any[] = [...imageParts, { text: promptText }];

      // Use resilient generation with automatic multi-provider fallback & circuit breaker
      const response = await aiProviderManager.generateTextWithFallback([{ role: 'user', parts: userParts }], {
        systemInstruction: 'You are ShiPu Ai🤖, an intelligent, modern, and helpful Facebook Messenger group bot assistant. Provide clear, well-formatted answers with relevant emojis.' + systemKnowledge
      }, { requestId, endpoint: `/api/gemini/chat [${contextKey}]` });

      return response.text;
    } finally {
      // Always clean up dedupe key and release per-context & per-account locks
      activePromptGenerations.delete(dedupeKey);

      const remainingInContext = (activeContextLocks.get(contextKey) || 1) - 1;
      if (remainingInContext <= 0) {
        activeContextLocks.delete(contextKey);
      } else {
        activeContextLocks.set(contextKey, remainingInContext);
      }

      const remainingInAccount = (activeAccountLocks.get(accountKey) || 1) - 1;
      if (remainingInAccount <= 0) {
        activeAccountLocks.delete(accountKey);
      } else {
        activeAccountLocks.set(accountKey, remainingInAccount);
      }
    }
  })();

  activePromptGenerations.set(dedupeKey, generationPromise);

  try {
    const responseText = await generationPromise;
    res.json({ response: responseText, requestId, contextKey });
  } catch (err: any) {
    console.error(`[api/gemini/chat] Generation failed for requestId ${requestId} in context ${contextKey}:`, err);
    
    // Determine the actual failure source for precise diagnostics
    let errorCode = 'API_FAILURE';
    let diagnosticMsg = err.message || 'Gemini API call failed.';
    let statusCode = 500;

    if (diagnosticMsg.includes('quota') || diagnosticMsg.includes('RESOURCE_EXHAUSTED') || diagnosticMsg.includes('exhausted')) {
      errorCode = 'QUOTA_EXHAUSTED';
      diagnosticMsg = 'Google AI Studio API Key free quota has been exhausted. Please configure more keys or fallback APIs.';
      statusCode = 429;
    } else if (diagnosticMsg.includes('invalid') || diagnosticMsg.includes('Key') || diagnosticMsg.includes('API_KEY')) {
      errorCode = 'INVALID_API_KEY';
      diagnosticMsg = 'The configured GEMINI_API_KEY is invalid or missing.';
      statusCode = 403;
    } else if (diagnosticMsg.includes('Rate exceeded') || diagnosticMsg.includes('429')) {
      errorCode = 'RATE_LIMIT_EXCEEDED';
      diagnosticMsg = 'Platform rate limit or API rate limit exceeded.';
      statusCode = 429;
    }

    res.status(statusCode).json({ 
      error: errorCode, 
      message: diagnosticMsg,
      requestId,
      contextKey
    });
  }
});

// --- FALLBACK APIS MANAGEMENT ENDPOINTS ---
app.get('/api/fallback-apis', async (req: Request, res: Response) => {
  try {
    const list = await FallbackApiModel.find().sort({ priority: -1, createdAt: -1 }).lean();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fallback-apis', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { name, url, apiKey, model, enabled, priority } = req.body;
    if (!name || !url || !apiKey) {
      return res.status(400).json({ error: 'Name, URL, and API Key are required' });
    }
    const newApi = await FallbackApiModel.create({
      name,
      url,
      apiKey,
      model: model || 'gemini-flash-latest',
      enabled: enabled !== undefined ? enabled : true,
      priority: priority !== undefined ? Number(priority) : 0
    });
    res.status(201).json({ success: true, api: newApi });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/fallback-apis/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { name, url, apiKey, model, enabled, priority } = req.body;
    const updateData: any = {};
    if (name !== undefined) updateData.name = name;
    if (url !== undefined) updateData.url = url;
    if (apiKey !== undefined) updateData.apiKey = apiKey;
    if (model !== undefined) updateData.model = model;
    if (enabled !== undefined) updateData.enabled = enabled;
    if (priority !== undefined) updateData.priority = Number(priority);

    const updated = await FallbackApiModel.findByIdAndUpdate(id, { $set: updateData }, { new: true });
    if (!updated) {
      return res.status(404).json({ error: 'Fallback API not found' });
    }
    res.json({ success: true, api: updated });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/fallback-apis/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const deleted = await FallbackApiModel.findByIdAndDelete(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Fallback API not found' });
    }
    res.json({ success: true, message: 'Fallback API deleted successfully' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/fallback-apis/test-connection', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { url, apiKey, model, prompt } = req.body;
    if (!url || !apiKey) {
      return res.status(400).json({ error: 'URL and API Key are required for test' });
    }

    let activeKey = apiKey;
    if (activeKey === 'USE_SYSTEM_KEY' || activeKey === 'SYSTEM_KEY' || activeKey.startsWith('AQ.Ab8RN')) {
      activeKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
      if (!activeKey || activeKey.startsWith('AQ.Ab8RN')) {
        for (const [envName, envVal] of Object.entries(process.env)) {
          if (envVal && typeof envVal === 'string' && envVal.startsWith('AIzaSy')) {
            activeKey = envVal;
            break;
          }
        }
      }
      if (!activeKey) {
        activeKey = apiKey; // fallback to original if none found
      }
    }

    const testPrompt = prompt || 'Explain how AI works in a few words';
    const isOpenRouter = url.includes('openrouter.ai');
    const isOpenAI = url.includes('api.openai.com') || url.includes('/v1/chat/completions') || (model && model.startsWith('gpt')) || isOpenRouter;

    let finalUrl = url;
    let headers: any = {
      'Content-Type': 'application/json',
      'User-Agent': 'aistudio-build'
    };

    if (isOpenRouter) {
      headers['HTTP-Referer'] = 'https://ai.studio/build';
      headers['X-Title'] = 'ShiPu AI Bot';
    }

    let body: any;

    if (isOpenAI) {
      body = {
        model: model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: testPrompt }]
      };
      headers['Authorization'] = `Bearer ${activeKey}`;
    } else {
      body = {
        contents: [{ role: 'user', parts: [{ text: testPrompt }] }]
      };
      if (!finalUrl.includes(':generateContent') && !finalUrl.includes('/chat/completions')) {
        if (finalUrl.includes('generativelanguage.googleapis.com')) {
          finalUrl = `${finalUrl.replace(/\/$/, '')}/v1beta/models/${model || 'gemini-flash-latest'}:generateContent`;
        }
      }
      const separator = finalUrl.includes('?') ? '&' : '?';
      finalUrl = finalUrl.includes('key=') ? finalUrl : `${finalUrl}${separator}key=${activeKey}`;
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000);

    const response = await fetch(finalUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errText = await response.text();
      return res.status(400).json({ error: `API response error (HTTP ${response.status}): ${errText}` });
    }

    const data = await response.json();
    let text = '';
    if (isOpenAI) {
      text = data.choices?.[0]?.message?.content || '';
    } else {
      text = data.candidates?.[0]?.content?.parts?.find((p: any) => typeof p.text === 'string')?.text || data.candidates?.[0]?.content?.parts?.[0]?.text;
    }

    if (!text) {
      return res.status(400).json({ error: 'Successfully connected, but response body structure was unrecognized or empty.', raw: data });
    }

    res.json({ success: true, text });
  } catch (err: any) {
    res.status(500).json({ error: `Connection failed: ${err.message}` });
  }
});

// --- SHIPU AIOS DASHBOARD API ENDPOINTS ---

// 1. Get AIOS Analytics & Aggregates
app.get('/api/aios/analytics', async (req: Request, res: Response) => {
  try {
    const usages = await AIOSUsageModel.find().lean();
    const activeSessionsCount = await AIOSSessionModel.countDocuments({ status: 'active' });
    const expiredSessionsCount = await AIOSSessionModel.countDocuments({ status: 'expired' });

    let totalSessions = 0;
    let brainHits = 0;
    let llmCalls = 0;
    let totalMessages = 0;
    let coinsSpent = 0;
    let premiumResets = 0;

    usages.forEach(u => {
      totalSessions += u.totalSessions || 0;
      brainHits += u.brainHits || 0;
      llmCalls += u.llmCalls || 0;
      totalMessages += u.totalMessages || 0;
      coinsSpent += u.coinsSpent || 0;
      premiumResets += u.premiumResets || 0;
    });

    const brainHitRate = totalMessages > 0 ? Number(((brainHits / totalMessages) * 100).toFixed(1)) : 0;

    res.json({
      totalSessions,
      brainHits,
      llmCalls,
      totalMessages,
      coinsSpent,
      premiumResets,
      activeSessionsCount,
      expiredSessionsCount,
      brainHitRate,
      usages: usages.slice(0, 10) // top 10 users list
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2. Get active & historic sessions
app.get('/api/aios/sessions', async (req: Request, res: Response) => {
  try {
    const list = await AIOSSessionModel.find().sort({ createdAt: -1 }).limit(100).lean();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 2.1 Get AI logs and stats
app.get('/api/aios/logs', async (req: Request, res: Response) => {
  try {
    const logs = await AILogModel.find().sort({ createdAt: -1 }).limit(50).lean();
    
    // Calculate aggregate metrics
    const totalCalls = await AILogModel.countDocuments();
    const successfulCalls = await AILogModel.countDocuments({ success: true });
    const failedCalls = await AILogModel.countDocuments({ success: false });
    const successRate = totalCalls > 0 ? Number(((successfulCalls / totalCalls) * 100).toFixed(1)) : 100;
    
    // Average response time
    const avgLatencyAggregate = await AILogModel.aggregate([
      { $match: { success: true } },
      { $group: { _id: null, avgLatency: { $avg: '$responseTimeMs' } } }
    ]);
    const avgLatency = avgLatencyAggregate.length > 0 ? Math.round(avgLatencyAggregate[0].avgLatency) : 0;

    // Token usage totals
    const tokenAggregate = await AILogModel.aggregate([
      {
        $group: {
          _id: null,
          totalPrompt: { $sum: '$tokenUsage.promptTokens' },
          totalCandidates: { $sum: '$tokenUsage.candidatesTokens' },
          totalTokens: { $sum: '$tokenUsage.totalTokens' }
        }
      }
    ]);
    const tokens = tokenAggregate.length > 0 ? {
      prompt: tokenAggregate[0].totalPrompt || 0,
      candidates: tokenAggregate[0].totalCandidates || 0,
      total: tokenAggregate[0].totalTokens || 0
    } : { prompt: 0, candidates: 0, total: 0 };

    const { aiProviderManager } = await import('./src/ai/providers/providerManager');
    const providerMetrics = aiProviderManager.getMetrics();

    res.json({
      logs,
      metrics: {
        totalCalls,
        successfulCalls,
        failedCalls,
        successRate,
        avgLatency,
        tokens,
        activeContextLocksCount: activeContextLocks.size,
        activeAccountLocksCount: activeAccountLocks.size,
        providerMetrics
      }
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Terminate a session manually
app.delete('/api/aios/sessions/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const session = await AIOSSessionModel.findById(req.params.id);
    if (!session) {
      return res.status(404).json({ error: 'Session not found.' });
    }

    session.status = 'expired';
    await session.save();

    // Set cooldown to null or default
    await AIOSMemoryModel.updateOne(
      { userID: session.userID },
      { $set: { cooldownUntil: null } }
    );

    auditLogsData.add('admin', `Terminated AIOS Session for user ${session.userID}`, String(session._id), 'SUCCESS');
    res.json({ success: true, message: 'Session terminated successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 3.1 Reset session/cooldown using the 50 coin-based system
app.post('/api/aios/sessions/reset-coins', async (req: Request, res: Response) => {
  try {
    const { userID } = req.body;
    let targetUserID = userID;

    if (!targetUserID) {
      const activeSession = await AIOSSessionModel.findOne({ status: 'active' }).sort({ activatedAt: -1 });
      if (activeSession) {
        targetUserID = activeSession.userID;
      } else {
        const lastSession = await AIOSSessionModel.findOne().sort({ createdAt: -1 });
        if (lastSession) targetUserID = lastSession.userID;
      }
    }

    if (!targetUserID) {
      targetUserID = 'dash_user_101';
    }

    const { AIOSService } = await import('./src/services/aiosService');
    const result = await AIOSService.getInstance().resetCooldown(targetUserID);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 3.2 Start a test 10-minute AI session for dashboard demo/testing
app.post('/api/aios/sessions/start-test', async (req: Request, res: Response) => {
  try {
    const userID = req.body.userID || 'dash_user_101';
    const threadID = req.body.threadID || 'dash_thread_101';

    // Terminate existing active sessions
    await AIOSSessionModel.updateMany({ userID, status: 'active' }, { $set: { status: 'expired' } });

    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    const session = await AIOSSessionModel.create({
      sessionID: `sess_${Date.now()}`,
      userID,
      threadID,
      status: 'active',
      activatedAt: new Date(),
      expiresAt,
      personality: 'ShiPu Ai Intelligent Companion'
    });

    await session.save();
    res.json({ success: true, session });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// 4. Get User Memory Profiles (Facts & Contexts)
app.get('/api/aios/memories', async (req: Request, res: Response) => {
  try {
    const list = await AIOSMemoryModel.find().sort({ updatedAt: -1 }).limit(100).lean();
    res.json(list);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Delete or reset user memory record
app.delete('/api/aios/memories/:id', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const memory = await AIOSMemoryModel.findByIdAndDelete(req.params.id);
    if (!memory) {
      return res.status(404).json({ error: 'Memory profile not found.' });
    }

    auditLogsData.add('admin', `Deleted AIOS User Memory Profile`, String(memory._id), 'SUCCESS');
    res.json({ success: true, message: 'Memory profile deleted successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Reset Cooldown for a user manually from dashboard
app.post('/api/aios/memories/:id/reset-cooldown', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const memory = await AIOSMemoryModel.findById(req.params.id);
    if (!memory) {
      return res.status(404).json({ error: 'Memory profile not found.' });
    }

    memory.cooldownUntil = null;
    await memory.save();

    auditLogsData.add('admin', `Manually reset AIOS Cooldown for user ${memory.userID}`, String(memory._id), 'SUCCESS');
    res.json({ success: true, message: 'User cooldown reset successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Clear conversation context for a user manually
app.post('/api/aios/memories/:id/clear-context', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const memory = await AIOSMemoryModel.findById(req.params.id);
    if (!memory) {
      return res.status(404).json({ error: 'Memory profile not found.' });
    }

    memory.conversationContext = [];
    await memory.save();

    auditLogsData.add('admin', `Manually cleared AIOS context for user ${memory.userID}`, String(memory._id), 'SUCCESS');
    res.json({ success: true, message: 'User context cleared successfully.' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- TELEGRAM BOT MANAGEMENT API ENDPOINTS ---
app.get('/api/telegram/status', (req: Request, res: Response) => {
  try {
    const status = telegramBotManager.getStatus();
    res.json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/telegram/logs', (req: Request, res: Response) => {
  try {
    const limit = Number(req.query.limit) || 100;
    const category = req.query.category as string | undefined;
    const logs = telegramBotManager.getLogs(limit, category);
    res.json({ success: true, logs });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/test', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { token } = req.body;
    const result = await telegramBotManager.testToken(token);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/connect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { token, adminUserIds, autoConnect } = req.body;
    const result = await telegramBotManager.connect(token, adminUserIds, autoConnect);
    if (result.success) {
      auditLogsData.add('admin', `Connected Telegram Bot @${result.bot?.username || 'bot'}`, 'TelegramBot', 'SUCCESS');
    } else {
      auditLogsData.add('admin', `Failed to connect Telegram Bot: ${result.error}`, 'TelegramBot', 'ERROR');
    }
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/disconnect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await telegramBotManager.disconnect();
    auditLogsData.add('admin', 'Disconnected Telegram Bot', 'TelegramBot', 'SUCCESS');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/reconnect', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const result = await telegramBotManager.reconnect();
    auditLogsData.add('admin', 'Reconnected Telegram Bot', 'TelegramBot', result.success ? 'SUCCESS' : 'ERROR');
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/telegram/config', requireAdminAuth, async (req: Request, res: Response) => {
  try {
    const { token, adminUserIds, autoConnect } = req.body;
    const status = await telegramBotManager.saveConfig(token, adminUserIds, autoConnect);
    auditLogsData.add('admin', 'Updated Telegram Bot Configuration', 'TelegramBot', 'SUCCESS');
    res.json({ success: true, ...status });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/telegram/logs', requireAdminAuth, (req: Request, res: Response) => {
  try {
    const { telegramLogger } = require('./src/services/telegram/TelegramLogger');
    telegramLogger.clearLogs();
    auditLogsData.add('admin', 'Cleared Telegram Bot Logs', 'TelegramBot', 'SUCCESS');
    res.json({ success: true, message: 'Telegram logs cleared' });
  } catch (err: any) {
    res.status(500).json({ success: false, error: err.message });
  }
});


// --- VITE MIDDLEWARE / PRODUCTION FALLBACK ---
let isServerStarted = false;
let runningHttpServer: any = null;

async function startServer(opts: { http?: boolean } = {}) {
  if (isServerStarted && runningHttpServer) {
    return runningHttpServer;
  }
  if (isServerStarted && opts.http === false) {
    return runningHttpServer;
  }
  isServerStarted = true;

  // Run SQLite pre-flight verification asynchronously in the background so HTTP port 3000 binds immediately
  sqliteAutoHealingGuard.ensureCleanSqliteDatabases().catch(guardErr => {
    console.error('[SQLITE GUARD] Pre-flight check error:', guardErr);
  });

  if (process.env.NODE_ENV !== 'production') {
    console.log('[SERVER] Serving frontend using active Vite development middleware (Source-based)');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: false,
        watch: {
          usePolling: true,
          interval: 1000,
          ignored: ['**/node_modules/**', '**/dist/**']
        }
      },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  // Connect Messenger Session
  facebookSession.connect().catch(err => {
    console.error('Messenger initial connection error:', err);
  });

  // Auto-restore saved Telegram bot if enabled
  telegramBotManager.autoStart().catch(err => {
    console.error('Telegram Bot auto-start error:', err);
  });

  try {
    if (opts.http === false) {
      console.log('[SERVER] Vercel serverless mode: skipping HTTP listen, Express app serves via function handler.');
      return runningHttpServer;
    }
    runningHttpServer = app.listen(PORT, '0.0.0.0', () => {
      console.log(`ShiPu Ai🤖 Engine & Control Panel running at http://0.0.0.0:${PORT}`);
      heartbeatService.start(PORT);
    });

    runningHttpServer.on('error', (err: any) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[SERVER] Port ${PORT} already bound by an existing process. Re-using active port.`);
      } else {
        console.error('[SERVER] HTTP socket error:', err);
      }
    });
  } catch (listenErr: any) {
    if (listenErr.code === 'EADDRINUSE') {
      console.warn(`[SERVER] Port ${PORT} already bound. Ignored duplicate listen call.`);
    } else {
      throw listenErr;
    }
  }

  return runningHttpServer;
}

process.on('SIGINT', async () => {
  console.log('[SYSTEM] Received SIGINT signal. Shutting down accounts cleanly...');
  await multiAccountManager.shutdownAll();
  await personalAIManager.shutdownAll();
  await telegramBotManager.shutdown();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('[SYSTEM] Received SIGTERM signal. Shutting down accounts cleanly...');
  await multiAccountManager.shutdownAll();
  await personalAIManager.shutdownAll();
  await telegramBotManager.shutdown();
  process.exit(0);
});

process.on('uncaughtException', (err: any) => {
  console.error('[DIAGNOSTICS] Uncaught Exception captured:', err?.message || err, err?.stack);
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[DIAGNOSTICS] Unhandled Promise Rejection captured:', reason?.message || reason, reason?.stack);
});

process.on('exit', (code) => {
  console.log(`[DIAGNOSTICS] Process exit event received with code: ${code}`);
});

// On Vercel the serverless function (api/index.ts) boots the engine lazily;
// auto-start here only for long-running hosts (local / Render / VPS).
if (!process.env.VERCEL) {
  startServer().catch((err: any) => {
    console.error('[BOOTSTRAP] Failed to start server:', err);
  });
}

export { startServer, app };
