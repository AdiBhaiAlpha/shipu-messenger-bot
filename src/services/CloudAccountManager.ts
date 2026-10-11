import { messengerAccountsData, MessengerAccountRecord, ftpConfigData } from '../db/database';
import { MultiAccountManager } from '../adapters/messenger/MultiAccountManager';
import { AccountConnection, SafeAccountMeta } from '../adapters/messenger/AccountConnection';
import { CookieLoader } from '../adapters/messenger/CookieLoader';
import { FCAFallbackManager } from '../adapters/messenger/fca/FCAFallbackManager';
import { FCAConnection } from '../adapters/messenger/fca/FCAProvider';
import { coerceAppState } from '../adapters/messenger/fca/normalizeAppState';
import { messengerLogger, MessengerLogger } from '../adapters/messenger/MessengerLogger';
import { decryptAuthState, encryptAuthState } from '../utils/crypto';
import { isDatabaseConnected } from '../db/firebaseDb';
import { listFtpFiles, readFtpFileContent, writeFtpFileContent } from './ftpService';

export interface CloudDashboardStats {
  runningAccountsCount: number;
  offlineAccountsCount: number;
  failedAccountsCount: number;
  connectingAccountsCount: number;
  totalAccountsCount: number;
  totalMessagesToday: number;
  totalAiMessages: number;
  accounts: SafeAccountMeta[];
}

export class CloudAccountManager {
  private static instance: CloudAccountManager;

  private isWatching = false;
  private isSupervisorRunning = false;
  private changeStream: any = null;
  private pollingInterval: NodeJS.Timeout | null = null;
  private supervisorInterval: NodeJS.Timeout | null = null;
  private fallbackManager = new FCAFallbackManager();

  // In-memory cache of account document checksums to detect remote updates
  private knownAccountState = new Map<string, { updatedAt: number; encryptedState: string; enabled: boolean }>();

  private constructor() {}

  public static getInstance(): CloudAccountManager {
    if (!CloudAccountManager.instance) {
      CloudAccountManager.instance = new CloudAccountManager();
    }
    return CloudAccountManager.instance;
  }

  /**
   * 1. loadAccounts(): The bot starts by loading every ACTIVE account stored inside database.
   */
  public async loadAccounts(): Promise<void> {
    messengerLogger.info('CLOUD_SYNC', 'Starting Centralized Cloud Account Synchronization System...');
    
    const multiMgr = MultiAccountManager.getInstance();
    const isDbAvailable = isDatabaseConnected();
    let activeRecords: MessengerAccountRecord[] = [];

    const getFtpOptions = async () => {
      const config = await ftpConfigData.get();
      const defaultHost = 'ftpupload.net';
      const defaultUser = 'cpfr_38719167';
      const defaultPass = 'chitron2448766';
      const defaultPort = 21;
      const defaultRoot = '/htdocs';

      return {
        enabled: true,
        protocol: config?.protocol || 'ftp',
        host: config?.host || defaultHost,
        port: config?.port || defaultPort,
        username: config?.username || defaultUser,
        password: defaultPass,
        rootDirectory: config?.rootDirectory || defaultRoot,
        passiveMode: config?.passiveMode ?? true,
        secure: config?.secure ?? false,
        timeout: 30000
      };
    };

    if (isDbAvailable) {
      messengerLogger.info('CLOUD_SYNC', 'database is ONLINE. Synchronizing and repairing backups with FTP...');
      const records = await messengerAccountsData.getAll();
      messengerLogger.info('CLOUD_SYNC', `Found ${records.length} total Messenger account records in database.`);
      
      console.log('RECORDS FROM MONGODB:', JSON.stringify(records));
      
      if (records.length === 0) {
        messengerLogger.info('CLOUD_SYNC', 'No records found in database. Checking FTP.');
      }

      try {
        const ftpOptions = await getFtpOptions();
        const ftpFilesRes = await listFtpFiles(ftpOptions, '/settings');
        if (ftpFilesRes.success && ftpFilesRes.files) {
          const encFiles = ftpFilesRes.files.filter(f => f.name.startsWith('messenger_') && f.name.endsWith('.enc'));
          messengerLogger.info('CLOUD_SYNC', `Found ${encFiles.length} encrypted backups on FTP storage.`);

          for (const file of encFiles) {
            const fileRes = await readFtpFileContent(ftpOptions, `/settings/${file.name}`);
            if (fileRes.success && fileRes.content) {
              const decrypted = decryptAuthState(fileRes.content);
              if (decrypted) {
                try {
                  const backup = JSON.parse(decrypted);
                  const accountId = backup.accountId;
                  if (accountId) {
                    const existing = records.find(r => r.accountId === accountId);
                    const backupTime = backup.updatedAt || backup.updated_at || 0;
                    const existingTime = existing?.updatedAt || 0;

                    if (!existing) {
                      // Missing in database! Restore it!
                      messengerLogger.warn('CLOUD_SYNC', `Account ${accountId} missing in database. Restoring from FTP backup...`);
                      await messengerAccountsData.upsert({
                        accountId: backup.accountId,
                        uid: backup.uid,
                        slotId: backup.slotId,
                        displayName: backup.displayName,
                        authType: backup.authType,
                        provider: backup.provider,
                        encryptedAuthState: backup.encryptedAuthState,
                        authStateVersion: backup.authStateVersion || 1,
                        status: 'PENDING',
                        mqttStatus: 'OFF',
                        creationSource: backup.creationSource || 'LOCAL_ADMIN',
                        source: backup.source || 'admin',
                        botEnabled: backup.botEnabled ?? true,
                        connectionMode: backup.connectionMode,
                        encryptedMongoUri: backup.encryptedMongoUri,
                        dbName: backup.dbName,
                        collectionPrefix: backup.collectionPrefix,
                        lastValidatedAt: backup.lastValidatedAt
                      });
                      
                      const restoredRecord = await messengerAccountsData.get(accountId);
                      if (restoredRecord) {
                        records.push(restoredRecord);
                      }
                      multiMgr.setRestoreStatus(accountId, 'RESTORED');
                      multiMgr.setMongoBackupStatus(accountId, 'HEALTHY');
                      multiMgr.setFtpBackupStatus(accountId, 'HEALTHY');
                      multiMgr.setPersistentSession(accountId, 'SAVED');
                    } else if (backupTime > existingTime) {
                      // FTP backup is newer! Restore it!
                      messengerLogger.warn('CLOUD_SYNC', `FTP backup for ${accountId} is newer than database. Restoring newer session...`);
                      await messengerAccountsData.upsert({
                        accountId: backup.accountId,
                        uid: backup.uid,
                        slotId: backup.slotId,
                        displayName: backup.displayName,
                        authType: backup.authType,
                        provider: backup.provider,
                        encryptedAuthState: backup.encryptedAuthState,
                        authStateVersion: backup.authStateVersion || 1,
                        status: 'PENDING',
                        mqttStatus: 'OFF',
                        creationSource: backup.creationSource || 'LOCAL_ADMIN',
                        source: backup.source || 'admin',
                        botEnabled: backup.botEnabled ?? true,
                        connectionMode: backup.connectionMode,
                        encryptedMongoUri: backup.encryptedMongoUri,
                        dbName: backup.dbName,
                        collectionPrefix: backup.collectionPrefix,
                        lastValidatedAt: backup.lastValidatedAt
                      });
                      
                      const updatedRecord = await messengerAccountsData.get(accountId);
                      if (updatedRecord) {
                        const index = records.findIndex(r => r.accountId === accountId);
                        if (index !== -1) records[index] = updatedRecord;
                      }
                      multiMgr.setRestoreStatus(accountId, 'RESTORED');
                      multiMgr.setMongoBackupStatus(accountId, 'HEALTHY');
                      multiMgr.setFtpBackupStatus(accountId, 'HEALTHY');
                      multiMgr.setPersistentSession(accountId, 'SAVED');
                    } else if (existingTime > backupTime) {
                      // database record is newer! Repair/rewrite the stale FTP backup!
                      messengerLogger.info('CLOUD_SYNC', `database record for ${accountId} is newer than FTP. Repairing FTP backup...`);
                      await multiMgr.backupAccountToFtp(accountId);
                      multiMgr.setMongoBackupStatus(accountId, 'HEALTHY');
                      multiMgr.setFtpBackupStatus(accountId, 'HEALTHY');
                      multiMgr.setPersistentSession(accountId, 'SAVED');
                      multiMgr.setRestoreStatus(accountId, 'NONE');
                    } else {
                      // Both are in perfect sync!
                      multiMgr.setMongoBackupStatus(accountId, 'HEALTHY');
                      multiMgr.setFtpBackupStatus(accountId, 'HEALTHY');
                      multiMgr.setPersistentSession(accountId, 'SAVED');
                      multiMgr.setRestoreStatus(accountId, 'NONE');
                    }
                  }
                } catch (jsonErr) {}
              }
            }
          }

          // Generate FTP backup for accounts only on Mongo
          for (const record of records) {
            const hasFtpFile = encFiles.some(f => f.name === `messenger_${record.accountId}.enc`);
            if (!hasFtpFile && record.source !== 'client' && record.creationSource !== 'CLIENT_SYNC') {
              messengerLogger.warn('CLOUD_SYNC', `Account ${record.accountId} missing on FTP. Generating secondary backup...`);
              await multiMgr.backupAccountToFtp(record.accountId);
            }
          }
        } else {
          messengerLogger.error('CLOUD_SYNC', `FTP directory list failed: ${ftpFilesRes.error}. Running in database-only mode.`);
          for (const record of records) {
            multiMgr.setFtpBackupStatus(record.accountId, 'FAILED');
            multiMgr.setMongoBackupStatus(record.accountId, 'HEALTHY');
            multiMgr.setPersistentSession(record.accountId, 'SAVED');
          }
        }
      } catch (ftpErr: any) {
        messengerLogger.error('CLOUD_SYNC', `FTP sync error on startup: ${ftpErr.message}`);
        for (const record of records) {
          multiMgr.setFtpBackupStatus(record.accountId, 'FAILED');
        }
      }

      activeRecords = records.filter(r => (r.botEnabled ?? true) && (r.enabled ?? true) && r.loginStatus !== 'LOGGED_OUT' && r.status !== 'DISABLED' && r.source !== 'client' && r.creationSource !== 'CLIENT_SYNC');
    } else {
      messengerLogger.error('CLOUD_SYNC', 'database is OFFLINE during startup! Initiating cPanel FTP restore sequence...');
      
      try {
        const ftpOptions = await getFtpOptions();
        const ftpFilesRes = await listFtpFiles(ftpOptions, '/settings');
        if (ftpFilesRes.success && ftpFilesRes.files) {
          const encFiles = ftpFilesRes.files.filter(f => f.name.startsWith('messenger_') && f.name.endsWith('.enc'));
          for (const file of encFiles) {
            const fileRes = await readFtpFileContent(ftpOptions, `/settings/${file.name}`);
            if (fileRes.success && fileRes.content) {
              const decrypted = decryptAuthState(fileRes.content);
              if (decrypted) {
                try {
                  const backup = JSON.parse(decrypted);
                  const record: MessengerAccountRecord = {
                    accountId: backup.accountId,
                    uid: backup.uid,
                    slotId: backup.slotId,
                    displayName: backup.displayName,
                    authType: backup.authType,
                    provider: backup.provider,
                    encryptedAuthState: backup.encryptedAuthState,
                    authStateVersion: backup.authStateVersion || 1,
                    status: 'PENDING',
                    mqttStatus: 'OFF',
                    creationSource: backup.creationSource || 'LOCAL_ADMIN',
                    source: backup.source || 'admin',
                    botEnabled: backup.botEnabled ?? true,
                    enabled: backup.enabled ?? backup.botEnabled ?? true,
                    connectionMode: backup.connectionMode,
                    encryptedMongoUri: backup.encryptedMongoUri,
                    dbName: backup.dbName,
                    collectionPrefix: backup.collectionPrefix,
                    lastValidatedAt: backup.lastValidatedAt,
                    lastConnectedAt: backup.lastConnectedAt || 0,
                    lastDisconnectedAt: backup.lastDisconnectedAt || 0,
                    lastErrorCode: backup.lastErrorCode || '',
                    lastErrorAt: backup.lastErrorAt || 0,
                    reconnectCount: backup.reconnectCount || 0,
                    createdAt: backup.createdAt || Date.now(),
                    updatedAt: backup.updatedAt || Date.now()
                  };
                  
                  activeRecords.push(record);
                  multiMgr.setRestoreStatus(record.accountId, 'RESTORED');
                  multiMgr.setMongoBackupStatus(record.accountId, 'FAILED');
                  multiMgr.setFtpBackupStatus(record.accountId, 'HEALTHY');
                  multiMgr.setPersistentSession(record.accountId, 'SAVED');

                  messengerLogger.info('CLOUD_SYNC', `Loaded offline account ${record.accountId} from FTP backup in memory.`);
                } catch (e) {}
              }
            }
          }
        }
      } catch (ftpErr: any) {
        messengerLogger.error('CLOUD_SYNC', `FTP scan failed during database offline: ${ftpErr.message}`);
      }

      // Start the offline auto-restore polling loop once database becomes available again
      const restoreInterval = setInterval(async () => {
        if (isDatabaseConnected()) {
          messengerLogger.success('CLOUD_SYNC', 'database has reconnected! Restoring FTP session data to database...');
          clearInterval(restoreInterval);
          for (const record of activeRecords) {
            try {
              await messengerAccountsData.upsert(record);
              multiMgr.setMongoBackupStatus(record.accountId, 'HEALTHY');
              messengerLogger.info('CLOUD_SYNC', `Successfully saved restored account ${record.accountId} back to database.`);
            } catch (mongoSaveErr: any) {
              messengerLogger.error('CLOUD_SYNC', `Failed to save restored account ${record.accountId} to database: ${mongoSaveErr.message}`);
            }
          }
        }
      }, 15000);
    }

    messengerLogger.info('CLOUD_SYNC', `Booting ${activeRecords.length} enabled active account(s) ready for execution engine.`);

    for (const rec of activeRecords) {
      await this.syncStatus(rec.accountId, 'RESTORING', 'CONNECTING', {
        loginStatus: 'PENDING',
        lastRestoreAt: Date.now()
      });
    }

    // Concurrently boot accounts with controlled gap (max 2 at a time)
    const concurrency = 2;
    for (let i = 0; i < activeRecords.length; i += concurrency) {
      const batch = activeRecords.slice(i, i + concurrency);
      await Promise.all(batch.map(rec => this.startAccount(rec.accountId, rec)));
      if (i + concurrency < activeRecords.length) {
        await new Promise(res => setTimeout(res, 1000));
      }
    }

    // Initialize supervisor & change watcher
    this.startSupervisor();
    await this.watchDatabase();

    messengerLogger.success('CLOUD_SYNC', 'Synchronization completed. Cloud Account Manager engine active.');
  }

  /**
   * 2. watchDatabase(): Monitors the database for account changes via
   * intelligent polling (Firebase RTDB REST has no change streams).
   */
  public async watchDatabase(): Promise<void> {
    if (this.isWatching) return;
    this.isWatching = true;

    messengerLogger.info('CLOUD_SYNC', 'Starting database watcher (polling mode)...');
    this.fallbackToPolling();
  }


  private fallbackToPolling(): void {
    if (this.pollingInterval) return;

    messengerLogger.info('CLOUD_SYNC', 'Intelligent database Polling active (checking every 15 seconds)...');
    this.pollingInterval = setInterval(async () => {
      try {
        const records = await messengerAccountsData.getAll();
        const currentAccountIds = new Set<string>();

        for (const record of records) {
          if (record.source === 'client' || record.creationSource === 'CLIENT_SYNC') continue;
          currentAccountIds.add(record.accountId);
          const cached = this.knownAccountState.get(record.accountId);

          const isEnabled = (record.botEnabled ?? true) && (record.enabled ?? true);

          if (!cached) {
            // Brand new account document added!
            messengerLogger.info('CLOUD_SYNC', `Cloud Sync detected new account [${record.accountId}] (UID: ${MessengerLogger.maskUid(record.uid)})`);
            this.knownAccountState.set(record.accountId, {
              updatedAt: record.updatedAt,
              encryptedState: record.encryptedAuthState,
              enabled: isEnabled
            });

            if (isEnabled) {
              await this.startAccount(record.accountId);
            }
          } else {
            // Check if document auth state or enabled flag was modified (ignore pure heartbeat/status timestamp updates)
            const cookieChanged = cached.encryptedState !== record.encryptedAuthState;
            const enabledChanged = cached.enabled !== isEnabled;

            this.knownAccountState.set(record.accountId, {
              updatedAt: record.updatedAt,
              encryptedState: record.encryptedAuthState,
              enabled: isEnabled
            });

            if (cookieChanged || enabledChanged) {
              messengerLogger.info('CLOUD_SYNC', `Cloud Sync detected configuration update for account [${record.accountId}]`);

              if (!isEnabled) {
                messengerLogger.info('CLOUD_SYNC', `Account [${record.accountId}] was disabled in database. Stopping runtime...`);
                await this.stopAccount(record.accountId);
              } else if (cookieChanged) {
                messengerLogger.info('CLOUD_SYNC', `Cookie changed for account [${record.accountId}]. Re-authenticating...`);
                await this.reloadAccount(record.accountId, true);
              } else {
                await this.startAccount(record.accountId);
              }
            } else {
              const conn = MultiAccountManager.getInstance().getAccountConnection(record.accountId);
              if (conn) {
                conn.updateRecord(record);
              }
            }
          }
        }

        // Check for removed account documents
        for (const cachedAccountId of Array.from(this.knownAccountState.keys())) {
          if (!currentAccountIds.has(cachedAccountId)) {
            messengerLogger.info('CLOUD_SYNC', `Cloud Sync detected removal of account [${cachedAccountId}]`);
            this.knownAccountState.delete(cachedAccountId);
            await this.removeAccount(cachedAccountId);
          }
        }

      } catch (err: any) {
        messengerLogger.error('CLOUD_SYNC', `Polling error: ${err.message}`);
      }
    }, 15000);
  }

  /**
   * 3. startAccount(): Validates cookie, authenticates, connects MQTT, registers in MultiAccountManager.
   */
  public async startAccount(accountId: string, preloadedRecord?: MessengerAccountRecord): Promise<boolean> {
    const multiMgr = MultiAccountManager.getInstance();
    let connection = multiMgr.getAccountConnection(accountId);

    // Verify duplicate startup prevention for already running/healthy accounts
    if (connection && connection.sessionState.authenticated && connection.getFcaApi() !== null && (connection.mqttStatus === 'EVENT_STREAM_ACTIVE' || connection.mqttStatus === 'LISTENING')) {
      messengerLogger.info('CLOUD_SYNC', `Account [${accountId}] is already running and healthy with active MQTT stream. Ignoring duplicate startup (NO-OP).`);
      return true;
    }

    // Re-use existing authenticated session if active
    if (connection && connection.sessionState.authenticated && connection.getFcaApi() !== null) {
      messengerLogger.info('CLOUD_SYNC', `[Account ${accountId}] Authenticated FCA session exists in memory. Ensuring MQTT transport is active (no re-login)...`);
      return connection.connect();
    }

    if (connection && (connection.sessionState.status === 'AUTH_INVALID' || connection.status === 'COOKIE_EXPIRED' || connection.status === 'AUTH_FAILED')) {
      messengerLogger.warn('CLOUD_SYNC', `[Account ${accountId}] Session is marked AUTH_INVALID. Automatic startup blocked. Manual cookie update required from admin.`);
      return false;
    }

    const record = preloadedRecord || await messengerAccountsData.get(accountId);
    if (!record) {
      messengerLogger.error('CLOUD_SYNC', `Cannot start account [${accountId}]: Document not found in database.`);
      return false;
    }

    if (!(record.botEnabled ?? true) || !(record.enabled ?? true)) {
      messengerLogger.info('CLOUD_SYNC', `Account [${accountId}] is disabled in database. Skipping startup.`);
      return false;
    }

    messengerLogger.info('CLOUD_SYNC', `[Cloud Sync] Initializing account [${accountId}] (UID: ${MessengerLogger.maskUid(record.uid)})...`);

    // Ensure bot database connection is active/pooled before startup
    try {
      const { dynamicDbManager } = await import('./DynamicDbManager');
      await dynamicDbManager.getBotConnection(record);
    } catch (dbErr: any) {
      messengerLogger.error('CLOUD_SYNC', `[Account ${accountId}] Failed to connect to bot database: ${dbErr.message}`);
      await this.syncStatus(accountId, 'DATABASE_OFFLINE', 'OFF', { loginStatus: 'FAILED', failureReason: `Database error: ${dbErr.message}` });
      return false;
    }

    // Step A: Decrypt cookie
    let cookieJson = '';
    try {
      cookieJson = this.decryptCookie(record.encryptedAuthState);
      messengerLogger.success('CLOUD_SYNC', `[Account ${accountId}] Cookie decrypted`);
    } catch (err: any) {
      messengerLogger.error('CLOUD_SYNC', `[Account ${accountId}] Cookie decryption failed: ${err.message}`);
      await this.syncStatus(accountId, 'COOKIE_EXPIRED', 'OFF', { loginStatus: 'FAILED', failureReason: 'Cookie decryption failed' });
      return false;
    }

    // Step B: Validate cookie JSON
    const valResult = this.validateCookie(cookieJson);
    if (!valResult.valid) {
      messengerLogger.error('CLOUD_SYNC', `[Account ${accountId}] Cookie validation failed: ${valResult.error}`);
      await this.syncStatus(accountId, 'COOKIE_EXPIRED', 'OFF', { loginStatus: 'FAILED', failureReason: valResult.error });
      return false;
    }
    messengerLogger.success('CLOUD_SYNC', `[Account ${accountId}] Cookie validated`);

    // Register known state before status sync so ChangeStream / polling knows this state
    const isEnabled = (record.botEnabled ?? true) && (record.enabled ?? true);
    this.knownAccountState.set(accountId, {
      updatedAt: Date.now(),
      encryptedState: record.encryptedAuthState,
      enabled: isEnabled
    });

    // Register AccountConnection if missing
    if (!connection) {
      connection = new AccountConnection(record);
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
      connection.updateRecord(record);
    }

    await this.syncStatus(accountId, 'AUTHENTICATING', 'CONNECTING', { loginStatus: 'PENDING' });

    // Step C: Connect & Authenticate via AccountConnection (one-time auth + MQTT listener)
    const connected = await connection.connect();
    if (connected) {
      messengerLogger.success('CLOUD_SYNC', `[Account ${accountId}] MQTT connected and registered`);
      await this.syncStatus(accountId, 'AI_READY', 'LISTENING', {
        loginStatus: 'LOGGED_IN',
        lastSuccessfulLogin: Date.now(),
        provider: connection.activeProviderName || record.provider
      });
      this.knownAccountState.set(accountId, {
        updatedAt: Date.now(),
        encryptedState: record.encryptedAuthState,
        enabled: isEnabled
      });
      messengerLogger.success('CLOUD_SYNC', `[Account ${accountId}] Database updated & status marked AI_READY`);
      return true;
    } else {
      messengerLogger.warn('CLOUD_SYNC', `[Account ${accountId}] Connection or authentication deferred`);
      return false;
    }
  }

  /**
   * 4. stopAccount(): Gracefully stops MQTT, logs out, clears listeners, frees memory.
   */
  public async stopAccount(accountId: string): Promise<boolean> {
    messengerLogger.info('CLOUD_SYNC', `Stopping account [${accountId}] safely...`);
    const multiMgr = MultiAccountManager.getInstance();

    await multiMgr.disconnectAccount(accountId);

    try {
      const { dynamicDbManager } = await import('./DynamicDbManager');
      await dynamicDbManager.disconnectBotDb(accountId);
    } catch (err: any) {
      messengerLogger.error('CLOUD_SYNC', `Error disconnecting database for stopped account [${accountId}]: ${err.message}`);
    }

    await this.syncStatus(accountId, 'DISABLED', 'OFF', {
      loginStatus: 'LOGGED_OUT',
      lastDisconnectedAt: Date.now()
    });

    this.knownAccountState.delete(accountId);
    messengerLogger.success('CLOUD_SYNC', `Account [${accountId}] stopped, listeners removed, memory freed.`);
    return true;
  }

  /**
   * 5. restartAccount(): Stops and restarts account.
   */
  public async restartAccount(accountId: string): Promise<boolean> {
    messengerLogger.info('CLOUD_SYNC', `Restarting account [${accountId}]...`);
    await this.stopAccount(accountId);
    await new Promise(res => setTimeout(res, 1000));
    return this.startAccount(accountId);
  }

  /**
   * 6. reloadAccount(): Hot reloads config or updates cookie session.
   */
  public async reloadAccount(accountId: string, forceReauth = false): Promise<boolean> {
    messengerLogger.info('CLOUD_SYNC', `Hot-reloading configuration for account [${accountId}]...`);
    
    const record = await messengerAccountsData.get(accountId);
    if (!record) return false;

    const multiMgr = MultiAccountManager.getInstance();
    const connection = multiMgr.getAccountConnection(accountId);

    const cookieChanged = connection ? connection.encryptedAuthState !== record.encryptedAuthState : true;

    if (forceReauth || cookieChanged) {
      // Safely disconnect previous database before reconnecting
      try {
        const { dynamicDbManager } = await import('./DynamicDbManager');
        await dynamicDbManager.disconnectBotDb(accountId);
      } catch (err: any) {
        messengerLogger.error('CLOUD_SYNC', `Error disconnecting database during reload for account [${accountId}]: ${err.message}`);
      }

      if (connection) {
        // Clear cached session state and stop old listener so fresh authentication occurs cleanly
        connection.resetSession();
      }
    } else if (connection) {
      connection.updateRecord(record);
    }

    return this.startAccount(accountId, record);
  }

  /**
   * 7. validateCookie(): Validates appstate cookie format.
   */
  public validateCookie(cookieJson: string): { valid: boolean; error?: string; userId?: string } {
    return CookieLoader.validateCookieJson(cookieJson);
  }

  /**
   * 8. decryptCookie(): Decrypts cookie string from encrypted state.
   */
  public decryptCookie(encryptedState: string): string {
    return decryptAuthState(encryptedState);
  }

  /**
   * 9. loginAccount(): Authenticates using FCAFallbackManager.
   */
  public async loginAccount(record: MessengerAccountRecord): Promise<{ success: boolean; connection?: FCAConnection; providerName?: string; error?: string }> {
    try {
      const cookieJson = this.decryptCookie(record.encryptedAuthState);
      // coerceAppState handles the object-export shape too; a bare JSON.parse
      // would hand FCA an object and fail on the first .map().
      const parsedCookies = coerceAppState(cookieJson);
      if (parsedCookies.length === 0) {
        return { success: false, error: 'Stored appstate contained no usable cookies. Re-import the cookie JSON.' };
      }

      const result = await this.fallbackManager.authenticate(parsedCookies);
      if (result.connection) {
        return {
          success: true,
          connection: result.connection,
          providerName: result.activeProviderName || record.provider
        };
      }

      return {
        success: false,
        error: result.failureReason || 'FCA Authentication failed across providers.'
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * 10. connectMqtt(): Connects MQTT listener.
   */
  public async connectMqtt(accountId: string): Promise<boolean> {
    const connection = MultiAccountManager.getInstance().getAccountConnection(accountId);
    if (!connection) return false;
    return connection.connect();
  }

  /**
   * 11. disconnectMqtt(): Disconnects MQTT listener.
   */
  public async disconnectMqtt(accountId: string): Promise<boolean> {
    const connection = MultiAccountManager.getInstance().getAccountConnection(accountId);
    if (!connection) return false;
    await connection.disconnect();
    return true;
  }

  /**
   * 12. syncStatus(): Updates database account status in real-time.
   */
  public async syncStatus(accountId: string, status: string, mqttStatus: string, extra: Partial<MessengerAccountRecord> = {}): Promise<void> {
    try {
      await messengerAccountsData.update(accountId, {
        status,
        mqttStatus,
        lastValidatedAt: Date.now(),
        ...extra
      });
      messengerLogger.info('CLOUD_SYNC', `[Account ${accountId}] Database updated: status=${status}, mqttStatus=${mqttStatus}`);
    } catch (err: any) {
      messengerLogger.error('CLOUD_SYNC', `Failed to sync status for ${accountId}: ${err.message}`);
    }
  }

  /**
   * 13. heartbeat(): Sends heartbeat and updates lastHeartbeat timestamp.
   */
  public async heartbeat(accountId: string): Promise<void> {
    const connection = MultiAccountManager.getInstance().getAccountConnection(accountId);
    if (connection) {
      connection.lastHeartbeat = Date.now();
      messengerLogger.info('SUPERVISOR', `Heartbeat received for account [${accountId}]`);
    }
    await messengerAccountsData.update(accountId, { lastHeartbeat: Date.now() });
  }

  /**
   * 14. recoverAccount(): Reconnects MQTT reusing existing session.
   * Never re-logs in with the same cookie on network/MQTT drop.
   */
  public async recoverAccount(accountId: string): Promise<boolean> {
    messengerLogger.warn('SUPERVISOR', `Starting automatic recovery sequence for account [${accountId}]...`);

    const connection = MultiAccountManager.getInstance().getAccountConnection(accountId);
    const record = (await messengerAccountsData.get(accountId)) || (connection ? connection.getRecord() : undefined);

    if (!record) {
      messengerLogger.error('SUPERVISOR', `Recovery aborted: Account [${accountId}] record not found.`);
      return false;
    }

    // Step 1: Reconnect MQTT reusing existing authenticated session
    if (connection && connection.sessionState.authenticated) {
      messengerLogger.info('SUPERVISOR', `[Recovery] Reconnecting MQTT listener reusing authenticated FCA session...`);
      await this.syncStatus(accountId, 'RECONNECTING', 'CONNECTING');
      const reconnected = await connection.connect();
      if (reconnected && (connection.status === 'CONNECTED' || connection.status === 'ONLINE' || connection.status === 'AI_READY' || connection.status === 'MQTT_LISTENING')) {
        messengerLogger.success('SUPERVISOR', `Recovery successful (MQTT reconnected with existing session).`);
        await this.syncStatus(accountId, 'AI_READY', 'LISTENING', { loginStatus: 'LOGGED_IN' });
        return true;
      }
    }

    // If session is explicitly marked AUTH_INVALID or in terminal error state
    if (connection && (connection.sessionState.status === 'AUTH_INVALID' || connection.status === 'COOKIE_EXPIRED' || connection.status === 'AUTH_FAILED' || connection.status === 'CHECKPOINT')) {
      messengerLogger.warn('SUPERVISOR', `Recovery stopped for account [${accountId}]: Session is marked AUTH_INVALID. Manual cookie replacement required from admin.`);
      return false;
    }

    // If connection exists but hasn't attempted login yet, try starting it once
    if (!connection || (!connection.sessionState.loginAttempted && !connection.sessionState.authenticated)) {
      messengerLogger.info('SUPERVISOR', `[Recovery] Attempting one-time startup for account [${accountId}]...`);
      return this.startAccount(accountId, record);
    }

    messengerLogger.error('SUPERVISOR', `Recovery aborted for account [${accountId}]: Saved session is inactive or invalid. Manual cookie update required.`);
    return false;
  }

  /**
   * Registers or updates an account in the supervisor's known account cache.
   */
  public registerKnownAccount(accountId: string, record: { updatedAt: number; encryptedAuthState: string; enabled: boolean }): void {
    this.knownAccountState.set(accountId, {
      updatedAt: record.updatedAt,
      encryptedState: record.encryptedAuthState,
      enabled: record.enabled
    });
  }

  /**
   * 15. removeAccount(): Removes account document and cleans up runtime.
   */
  public async removeAccount(accountId: string): Promise<boolean> {
    messengerLogger.info('CLOUD_SYNC', `Removing account [${accountId}] from system...`);
    const multiMgr = MultiAccountManager.getInstance();

    await multiMgr.removeAccount(accountId);
    this.knownAccountState.delete(accountId);

    messengerLogger.success('CLOUD_SYNC', `Account [${accountId}] removed from Cloud Account Manager.`);
    return true;
  }

  /**
   * Starts the Account Supervisor continuous monitoring loop.
   */
  private startSupervisor(): void {
    if (this.isSupervisorRunning) return;
    this.isSupervisorRunning = true;

    messengerLogger.info('SUPERVISOR', 'Account Supervisor started (health check interval: 20 seconds)...');

    this.supervisorInterval = setInterval(async () => {
      try {
        const records = await messengerAccountsData.getAll();
        const multiMgr = MultiAccountManager.getInstance();

        for (const record of records) {
          if (record.source === 'client' || record.creationSource === 'CLIENT_SYNC') continue;
          const isEnabled = (record.botEnabled ?? true) && (record.enabled ?? true);
          if (!isEnabled) continue;

          const connection = multiMgr.getAccountConnection(record.accountId);
          await this.heartbeat(record.accountId);

          if (!connection) {
            const isTerminalDbStatus = 
              record.status === 'COOKIE_EXPIRED' || 
              record.status === 'AUTH_FAILED' || 
              record.status === 'CHECKPOINT' || 
              record.status === 'REAUTH_REQUIRED' || 
              record.status === 'SECURITY_CHALLENGE' ||
              record.status === 'FAILED';

            if (isTerminalDbStatus) {
              continue;
            }

            messengerLogger.warn('SUPERVISOR', `Account [${record.accountId}] is active in DB but missing from memory. Starting...`);
            await this.startAccount(record.accountId);
            continue;
          }

          // Check terminal auth states or invalid sessions
          const isTerminalAuthFailure = 
            connection.sessionState.status === 'AUTH_INVALID' ||
            connection.status === 'COOKIE_EXPIRED' || 
            connection.status === 'AUTH_FAILED' || 
            connection.status === 'CHECKPOINT' || 
            connection.status === 'REAUTH_REQUIRED' || 
            connection.status === 'SECURITY_CHALLENGE';

          if (isTerminalAuthFailure) {
            continue;
          }

          // If connection is in temporary backoff or reconnecting, leave it to scheduleMqttReconnect
          if (connection.status === 'TEMPORARY_ERROR' || connection.status === 'RECONNECTING') {
            continue;
          }

          // If already authenticated with active MQTT stream, session is 100% healthy - skip recovery
          if (connection.sessionState.authenticated && connection.getFcaApi() !== null && (connection.mqttStatus === 'EVENT_STREAM_ACTIVE' || connection.mqttStatus === 'LISTENING')) {
            continue;
          }

          // Verify health metrics
          const isMqttHealthy = connection.mqttStatus === 'CONNECTED' || connection.mqttStatus === 'LISTENING' || connection.mqttStatus === 'EVENT_STREAM_ACTIVE' || connection.mqttStatus === 'MQTT_ACTIVE';
          const isStatusHealthy = connection.status === 'CONNECTED' || connection.status === 'ONLINE' || connection.status === 'MQTT_LISTENING' || connection.status === 'AUTHENTICATED' || connection.status === 'AI_READY';

          if (!isMqttHealthy || !isStatusHealthy) {
            messengerLogger.warn('SUPERVISOR', `Unhealthy state detected for account [${record.accountId}] (Status: ${connection.status}, MQTT: ${connection.mqttStatus}). Triggering recovery reusing session...`);
            
            // Trigger automatic recovery reusing existing FCA instance
            await this.recoverAccount(record.accountId);
          }
        }
      } catch (err: any) {
        messengerLogger.error('SUPERVISOR', `Supervisor check error: ${err.message}`);
      }
    }, 20000);
  }

  /**
   * Exposes live data formatted for the Admin Dashboard.
   */
  public async getDashboardLiveData(): Promise<CloudDashboardStats> {
    const multiMgr = MultiAccountManager.getInstance();
    const records = await messengerAccountsData.getAll();

    const accountsMeta: SafeAccountMeta[] = records.map(record => {
      const connection = multiMgr.getAccountConnection(record.accountId);
      if (connection) {
        return connection.getSafeMetadata();
      }

      // Fallback for offline/database-only records
      const reconnectsVal = record.retryCounter || record.reconnectCount || 0;
      return {
        accountId: record.accountId,
        uid: MessengerLogger.maskUid(record.uid),
        rawUid: record.uid,
        displayName: record.displayName || 'Facebook User',
        authType: record.authType || 'cookie',
        provider: record.provider || 'DongDev FCA',
        status: (record.status as any) || 'DISCONNECTED',
        mqttStatus: (record.mqttStatus as any) || 'OFF',
        loginStatus: record.loginStatus || 'LOGGED_OUT',
        creationSource: record.creationSource || 'ADMIN_DASHBOARD',
        lastHeartbeat: new Date(record.lastHeartbeat || Date.now()).toISOString(),
        lastSuccessfulLogin: record.lastSuccessfulLogin ? new Date(record.lastSuccessfulLogin).toISOString() : undefined,
        failureReason: record.failureReason,
        botEnabled: record.botEnabled ?? true,
        enabled: record.enabled ?? record.botEnabled ?? true,
        aiEnabled: record.aiEnabled ?? true,
        personalAiEnabled: record.personalAiEnabled ?? false,
        lastIncomingMessageAt: record.lastIncomingMessageAt ? new Date(record.lastIncomingMessageAt).toISOString() : undefined,
        lastOutgoingMessageAt: record.lastOutgoingMessageAt ? new Date(record.lastOutgoingMessageAt).toISOString() : undefined,
        stats: record.stats || {
          messagesToday: 0,
          aiMessages: 0,
          totalMessages: 0,
          reconnects: reconnectsVal,
          uptimeMs: 0
        },
        connectedAt: record.lastConnectedAt ? new Date(record.lastConnectedAt).toISOString() : undefined,
        lastValidatedAt: record.lastValidatedAt ? new Date(record.lastValidatedAt).toISOString() : undefined,
        lastErrorCode: record.lastErrorCode,
        reconnectCount: record.reconnectCount || 0,
        activeProviderName: record.provider || 'DongDev FCA',
        sessionDurationMs: 0
      };
    });

    let runningCount = 0;
    let offlineCount = 0;
    let failedCount = 0;
    let connectingCount = 0;
    let totalMessagesToday = 0;
    let totalAiMessages = 0;

    for (const acc of accountsMeta) {
      if (acc.status === 'CONNECTED' || acc.status === 'ONLINE' || acc.status === 'MQTT_LISTENING' || acc.status === 'AI_READY') {
        runningCount++;
      } else if (acc.status === 'CONNECTING' || acc.status === 'AUTHENTICATING' || acc.status === 'VALIDATING' || acc.status === 'MQTT_ACTIVE' || acc.status === 'RECONNECTING') {
        connectingCount++;
      } else if (acc.status === 'FAILED' || acc.status === 'CHECKPOINT' || acc.status === 'REAUTH_REQUIRED' || acc.status === 'AUTH_EXPIRED' || acc.status === 'COOKIE_EXPIRED' || acc.status === 'AUTH_FAILED') {
        failedCount++;
      } else {
        offlineCount++;
      }

      if (acc.stats) {
        totalMessagesToday += acc.stats.messagesToday || 0;
        totalAiMessages += acc.stats.aiMessages || 0;
      }
    }

    return {
      runningAccountsCount: runningCount,
      offlineAccountsCount: offlineCount,
      failedAccountsCount: failedCount,
      connectingAccountsCount: connectingCount,
      totalAccountsCount: accountsMeta.length,
      totalMessagesToday,
      totalAiMessages,
      accounts: accountsMeta
    };
  }

  public shutdown(): void {
    if (this.pollingInterval) clearInterval(this.pollingInterval);
    if (this.supervisorInterval) clearInterval(this.supervisorInterval);
    if (this.changeStream) {
      try { this.changeStream.close(); } catch {}
    }
    this.isWatching = false;
    this.isSupervisorRunning = false;
  }
}

export const cloudAccountManager = CloudAccountManager.getInstance();
