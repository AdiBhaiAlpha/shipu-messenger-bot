import { AccountConnection, SafeAccountMeta } from './AccountConnection';
import { messengerAccountsData, MessengerAccountRecord, ftpConfigData } from '../../db/database';
import { CookieLoader } from './CookieLoader';
import { coerceAppState } from './fca/normalizeAppState';
import { FCAFallbackManager } from './fca/FCAFallbackManager';
import { messengerLogger, MessengerLogger } from './MessengerLogger';
import { encryptAuthState, decryptAuthState } from '../../utils/crypto';
import { IMessengerAdapter, MessengerAdapterImpl } from './MessengerAdapter';
import { writeFtpFileContent, readFtpFileContent } from '../../services/ftpService';
import { isDatabaseConnected } from '../../db/firebaseDb';

/**
 * Custom MongoDB URIs were removed with the MongoDB layer. Firebase RTDB is
 * the only database now, so this is a connectivity probe against it.
 * Kept (same name/signature) so existing call sites keep compiling.
 */
export async function testMongoConnection(_uri?: string): Promise<boolean> {
  return isDatabaseConnected();
}


export class MultiAccountManager {
  private static instance: MultiAccountManager;

  public static readonly MAX_AUTHORIZED_ACCOUNTS = Number(process.env.MAX_AUTHORIZED_ACCOUNTS) || 10;
  public static readonly MAX_COOKIE_SESSIONS = Number(process.env.MAX_COOKIE_SESSIONS) || 5;

  private accounts = new Map<string, AccountConnection>();
  private globalEventListeners: ((event: any) => void)[] = [];
  private fallbackManager = new FCAFallbackManager();
  private isInitialized = false;

  private mongoBackupStatuses = new Map<string, 'HEALTHY' | 'FAILED' | 'NOT_SAVED'>();
  private ftpBackupStatuses = new Map<string, 'HEALTHY' | 'FAILED' | 'NOT_SAVED'>();
  private persistentSessions = new Map<string, 'SAVED' | 'NOT_SAVED'>();
  private restoreStatuses = new Map<string, 'RESTORED' | 'FAILED' | 'NONE'>();

  public getMongoBackupStatus(accountId: string): 'HEALTHY' | 'FAILED' | 'NOT_SAVED' {
    return this.mongoBackupStatuses.get(accountId) || 'HEALTHY';
  }
  public getFtpBackupStatus(accountId: string): 'HEALTHY' | 'FAILED' | 'NOT_SAVED' {
    return this.ftpBackupStatuses.get(accountId) || 'NOT_SAVED';
  }
  public getPersistentSession(accountId: string): 'SAVED' | 'NOT_SAVED' {
    return this.persistentSessions.get(accountId) || 'SAVED';
  }
  public getRestoreStatus(accountId: string): 'RESTORED' | 'FAILED' | 'NONE' {
    return this.restoreStatuses.get(accountId) || 'NONE';
  }

  public setMongoBackupStatus(accountId: string, status: 'HEALTHY' | 'FAILED' | 'NOT_SAVED') {
    this.mongoBackupStatuses.set(accountId, status);
  }
  public setFtpBackupStatus(accountId: string, status: 'HEALTHY' | 'FAILED' | 'NOT_SAVED') {
    this.ftpBackupStatuses.set(accountId, status);
  }
  public setPersistentSession(accountId: string, status: 'SAVED' | 'NOT_SAVED') {
    this.persistentSessions.set(accountId, status);
  }
  public setRestoreStatus(accountId: string, status: 'RESTORED' | 'FAILED' | 'NONE') {
    this.restoreStatuses.set(accountId, status);
  }

  public async backupAccountToFtp(accountId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const record = await messengerAccountsData.get(accountId);
      if (!record) {
        this.setFtpBackupStatus(accountId, 'FAILED');
        return { success: false, error: `Account record ${accountId} not found in MongoDB.` };
      }

      let rawCookie = '';
      try {
        rawCookie = decryptAuthState(record.encryptedAuthState);
      } catch (err) {
        rawCookie = record.encryptedAuthState;
      }

      // Last-known-good backup guard: Ensure cookie is valid before backing up to FTP
      const cookieValidation = CookieLoader.validateCookieJson(rawCookie);
      if (!cookieValidation.valid) {
        messengerLogger.error('CLOUD_SYNC', `[SESSION_BACKUP] accountId=${accountId} source=ftp backup_result=failed_invalid_cookie_payload (${cookieValidation.error})`);
        this.setFtpBackupStatus(accountId, 'FAILED');
        return { success: false, error: `Invalid cookie payload for backup: ${cookieValidation.error}` };
      }

      const payload = {
        accountId: record.accountId,
        uid: record.uid,
        slotId: record.slotId || '',
        displayName: record.displayName,
        authType: record.authType,
        provider: record.provider,
        cookie: rawCookie,
        encryptedAuthState: rawCookie,
        authStateVersion: record.authStateVersion || 1,
        status: record.status,
        mqttStatus: record.mqttStatus,
        loginStatus: record.loginStatus || 'PENDING',
        creationSource: record.creationSource,
        source: record.source,
        botEnabled: record.botEnabled ?? true,
        connectionMode: record.connectionMode,
        encryptedMongoUri: record.encryptedMongoUri,
        dbName: record.dbName || '',
        collectionPrefix: record.collectionPrefix || '',
        lastValidatedAt: record.lastValidatedAt,
        backupVersion: 3,
        updatedAt: record.updatedAt || Date.now()
      };

      const rawPayloadString = JSON.stringify(payload, null, 2);

      const config = await ftpConfigData.get();
      const defaultHost = 'ftpupload.net';
      const defaultUser = 'cpfr_38719167';
      const defaultPass = 'chitron2448766';
      const defaultPort = 21;
      const defaultRoot = '/htdocs';

      const options = {
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

      const sessionFtpPath = `/messenger-sessions/${accountId}/session.json`;
      const settingsFtpPath = `/settings/messenger_${accountId}.json`;
      messengerLogger.info('CLOUD_SYNC', `Backing up account ${accountId} to FTP at ${sessionFtpPath} and ${settingsFtpPath}...`);
      
      const res = await writeFtpFileContent(options, sessionFtpPath, rawPayloadString);
      await writeFtpFileContent(options, settingsFtpPath, rawPayloadString).catch(() => {});

      if (!res.success) {
        messengerLogger.error('CLOUD_SYNC', `FTP backup failed for ${accountId}: ${res.error}`);
        this.setFtpBackupStatus(accountId, 'FAILED');
        return { success: false, error: res.error || 'FTP write failed' };
      }

      messengerLogger.success('CLOUD_SYNC', `Successfully backed up account ${accountId} to FTP.`);
      this.setFtpBackupStatus(accountId, 'HEALTHY');
      this.setPersistentSession(accountId, 'SAVED');
      return { success: true };
    } catch (err: any) {
      messengerLogger.error('CLOUD_SYNC', `Unhandled error during FTP backup: ${err.message}`);
      this.setFtpBackupStatus(accountId, 'FAILED');
      return { success: false, error: err.message };
    }
  }

  public async restoreAccountFromFtp(accountId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const config = await ftpConfigData.get();
      const defaultHost = 'ftpupload.net';
      const defaultUser = 'cpfr_38719167';
      const defaultPass = 'chitron2448766';
      const defaultPort = 21;
      const defaultRoot = '/htdocs';

      const options = {
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

      const candidatePaths = [
        `/messenger-sessions/${accountId}/session.json`,
        `/settings/messenger_${accountId}.json`,
        `/settings/messenger_${accountId}.enc`
      ];

      let res: { success: boolean; content?: string; error?: string } = { success: false };
      let isRawJson = true;

      for (const ftpPath of candidatePaths) {
        messengerLogger.info('CLOUD_SYNC', `Attempting to restore account ${accountId} from FTP at ${ftpPath}...`);
        res = await readFtpFileContent(options, ftpPath);
        if (res.success && res.content) {
          isRawJson = !ftpPath.endsWith('.enc');
          break;
        }
      }

      if (!res.success) {
        this.setRestoreStatus(accountId, 'FAILED');
        return { success: false, error: res.error || 'FTP read failed' };
      }

      let payload: any;
      if (isRawJson) {
        try {
          payload = JSON.parse(res.content);
        } catch (e: any) {
          const decrypted = decryptAuthState(res.content);
          try {
            payload = JSON.parse(decrypted);
          } catch (e2: any) {
            this.setRestoreStatus(accountId, 'FAILED');
            return { success: false, error: `Invalid JSON backup format: ${e.message}` };
          }
        }
      } else {
        const decrypted = decryptAuthState(res.content);
        if (!decrypted) {
          this.setRestoreStatus(accountId, 'FAILED');
          return { success: false, error: 'Decryption failed for FTP backup file.' };
        }
        try {
          payload = JSON.parse(decrypted);
        } catch (e: any) {
          this.setRestoreStatus(accountId, 'FAILED');
          return { success: false, error: `Invalid JSON backup format: ${e.message}` };
        }
      }

      let rawCookie = '';
      if (payload.cookie) {
        rawCookie = payload.cookie;
      } else if (payload.encryptedAuthState) {
        rawCookie = decryptAuthState(payload.encryptedAuthState);
      }

      if (!rawCookie) {
        this.setRestoreStatus(accountId, 'FAILED');
        return { success: false, error: 'AppState cookie not found in backup file.' };
      }

      const newlyEncryptedAuthState = encryptAuthState(rawCookie);

      await messengerAccountsData.upsert({
        accountId: payload.accountId,
        uid: payload.uid,
        slotId: payload.slotId,
        displayName: payload.displayName,
        authType: payload.authType,
        provider: payload.provider,
        encryptedAuthState: newlyEncryptedAuthState,
        authStateVersion: payload.authStateVersion,
        status: 'PENDING',
        mqttStatus: 'OFF',
        creationSource: payload.creationSource || 'LOCAL_ADMIN',
        source: payload.source || 'admin',
        botEnabled: payload.botEnabled ?? true,
        connectionMode: payload.connectionMode,
        encryptedMongoUri: payload.encryptedMongoUri,
        dbName: payload.dbName,
        collectionPrefix: payload.collectionPrefix,
        lastValidatedAt: payload.lastValidatedAt
      });

      const { cloudAccountManager } = await import('../../services/CloudAccountManager');
      await cloudAccountManager.reloadAccount(payload.accountId);

      this.setRestoreStatus(payload.accountId, 'RESTORED');
      this.setFtpBackupStatus(payload.accountId, 'HEALTHY');
      this.setMongoBackupStatus(payload.accountId, 'HEALTHY');
      this.setPersistentSession(payload.accountId, 'SAVED');

      return { success: true };
    } catch (err: any) {
      messengerLogger.error('CLOUD_SYNC', `Failed to restore account ${accountId}: ${err.message}`);
      this.setRestoreStatus(accountId, 'FAILED');
      return { success: false, error: err.message };
    }
  }

  private constructor() {}

  public static getInstance(): MultiAccountManager {
    if (!MultiAccountManager.instance) {
      MultiAccountManager.instance = new MultiAccountManager();
    }
    return MultiAccountManager.instance;
  }

  public registerGlobalEventListener(cb: (event: any) => void) {
    if (!this.globalEventListeners.includes(cb)) {
      this.globalEventListeners.push(cb);
    }
    for (const connection of this.accounts.values()) {
      connection.registerEventListener(cb);
    }
  }

  public async replaceCookie(
    accountId: string,
    cookieJson: string,
    botName?: string
  ): Promise<{ success: boolean; accountMeta?: SafeAccountMeta; error?: string }> {
    messengerLogger.info('AUTH', `[replaceCookie] Validating and replacing session for account ${accountId}...`);
    return this.addCookieAccount(
      cookieJson,
      botName,
      'default',
      undefined,
      undefined,
      undefined,
      'LOCAL_ADMIN',
      undefined,
      accountId
    );
  }

  public getGlobalEventListeners(): ((event: any) => void)[] {
    return this.globalEventListeners;
  }

  public addAccountConnection(accountId: string, connection: AccountConnection) {
    for (const listener of this.globalEventListeners) {
      connection.registerEventListener(listener);
    }
    this.accounts.set(accountId, connection);
  }

  public async initializeAllAccountsFromDB(): Promise<void> {
    if (this.isInitialized) return;
    this.isInitialized = true;

    messengerLogger.info('SYSTEM', 'Initializing Centralized Multi-Account Session Manager via Cloud Synchronization...');

    // Step 1: Migrate legacy single appstate_cookie.json if present
    await this.migrateLegacyCookieFileIfNeeded();

    // Step 2: Delegate complete loading, database watching, and supervisor execution to CloudAccountManager
    const { cloudAccountManager } = await import('../../services/CloudAccountManager');
    await cloudAccountManager.loadAccounts();

    messengerLogger.success('SYSTEM', `Multi-Account Manager startup complete. ${this.accounts.size} active accounts loaded.`);
  }

  private async migrateLegacyCookieFileIfNeeded(): Promise<void> {
    if (!CookieLoader.exists()) return;

    const { parsedCookies, validation } = CookieLoader.loadSafeCookieFile();
    if (!validation.valid || !parsedCookies || !validation.userId) return;

    const existing = await messengerAccountsData.getByUid(validation.userId);
    if (!existing) {
      messengerLogger.info('SYSTEM', `Migrating legacy appstate_cookie.json for UID ${MessengerLogger.maskUid(validation.userId)} into MongoDB...`);

      const accountId = `acc_${validation.userId}`;
      const encryptedState = encryptAuthState(JSON.stringify(parsedCookies));

      await messengerAccountsData.upsert({
        accountId,
        uid: validation.userId,
        displayName: `Facebook User (${MessengerLogger.maskUid(validation.userId)})`,
        authType: 'cookie',
        provider: 'DongDev FCA',
        encryptedAuthState: encryptedState,
        authStateVersion: 1,
        status: 'VALIDATING',
        mqttStatus: 'OFF',
        botEnabled: true,
        lastValidatedAt: Date.now()
      });

      messengerLogger.success('SYSTEM', `Legacy cookie file successfully migrated to MongoDB account ${accountId}`);
    } else {
      // Check if disk cookie was refreshed/updated
      let currentDbCookie = '';
      try { currentDbCookie = decryptAuthState(existing.encryptedAuthState); } catch {}
      const diskCookies = JSON.stringify(parsedCookies);
      if (currentDbCookie !== diskCookies) {
        messengerLogger.info('SYSTEM', `Detected fresh appstate_cookie.json on disk for UID ${MessengerLogger.maskUid(validation.userId)}. Synchronizing database...`);
        const encryptedState = encryptAuthState(diskCookies);
        await messengerAccountsData.update(existing.accountId, {
          encryptedAuthState: encryptedState,
          status: 'PENDING',
          lastValidatedAt: Date.now()
        });
      }
    }
  }

  private async loadAndStartAccount(record: MessengerAccountRecord): Promise<void> {
    try {
      let connection = this.accounts.get(record.accountId);
      if (!connection) {
        connection = new AccountConnection(record);
        for (const listener of this.globalEventListeners) {
          connection.registerEventListener(listener);
        }
        this.accounts.set(record.accountId, connection);
      }

      if (record.botEnabled) {
        await connection.connect();
      } else {
        messengerLogger.info('SESSION', `Account [${record.accountId}] is disabled. Skipping automatic connection.`);
      }
    } catch (err: any) {
      messengerLogger.error('SYSTEM', `Failed to load account [${record.accountId}]: ${err.message}`);
    }
  }

  public async shutdownAll(): Promise<void> {
    messengerLogger.info('SYSTEM', 'Shutting down Multi-Account Session Manager cleanly...');
    for (const connection of this.accounts.values()) {
      try {
        await connection.disconnect();
      } catch {}
    }
  }

  public getAccountCount(authType?: 'cookie' | 'oauth'): number {
    if (!authType) return this.accounts.size;
    let count = 0;
    for (const connection of this.accounts.values()) {
      if (connection.authType === authType) count++;
    }
    return count;
  }

  public async addCookieAccount(
    cookieJson: string,
    botName?: string,
    connectionMode: 'default' | 'custom' = 'default',
    mongoUri?: string,
    dbName?: string,
    collectionPrefix?: string,
    creationSource: string = 'ADMIN_DASHBOARD',
    slotId?: string,
    targetAccountId?: string
  ): Promise<{ success: boolean; accountMeta?: SafeAccountMeta; accountId?: string; error?: string }> {
    // 1. Validate JSON schema
    const formatValidation = CookieLoader.validateCookieJson(cookieJson);
    if (!formatValidation.valid || !formatValidation.userId) {
      return { success: false, error: formatValidation.error || 'Invalid cookie format.' };
    }

    const uid = formatValidation.userId;
    
    // Check if an account already exists with this Facebook UID to avoid unique index violation on MongoDB
    const existingByUid = await messengerAccountsData.getByUid(uid);
    const accountId = targetAccountId || (existingByUid ? existingByUid.accountId : (slotId || `acc_${uid}`));

    // Duplicate detection: check if this account already exists in MongoDB
    const existingDbRecord = existingByUid || await messengerAccountsData.get(accountId);
    if (existingDbRecord) {
      messengerLogger.info('AUTH', `Duplicate Facebook account detected for UID ${MessengerLogger.maskUid(uid)}. Re-authenticating and updating existing session...`);
    }

    // 2. Enforce MAX_COOKIE_SESSIONS limit
    const currentCookieCount = this.getAccountCount('cookie');
    const isExisting = this.accounts.has(accountId) || !!existingDbRecord;

    if (!isExisting && currentCookieCount >= MultiAccountManager.MAX_COOKIE_SESSIONS) {
      return {
        success: false,
        error: `Maximum cookie session accounts limit (${MultiAccountManager.MAX_COOKIE_SESSIONS}) reached. Delete an existing account before adding a new one.`
      };
    }

    // 3. Custom MongoDB mode was removed: Firebase RTDB is the only store.
    // A 'custom' request is served on the default Firebase connection instead.
    if (connectionMode === 'custom') {
      messengerLogger.info('AUTH', `Custom MongoDB mode removed; using default Firebase connection for account ${accountId}...`);
      connectionMode = 'default';
    }
    const encryptedMongoUri = '';

    // 4. Authenticate against Facebook FCA before saving
    messengerLogger.info('AUTH', `Testing Facebook authentication for UID ${MessengerLogger.maskUid(uid)}...`);
    let parsedCookies: any[];
    try {
      parsedCookies = coerceAppState(cookieJson);
    } catch (parseErr: any) {
      return {
        success: false,
        error: 'Cookie JSON could not be parsed. Export the appstate again from a logged-in facebook.com tab.'
      };
    }
    if (!parsedCookies || parsedCookies.length === 0) {
      return {
        success: false,
        error: 'Cookie JSON contains no usable cookies. Export the appstate again from a logged-in facebook.com tab.'
      };
    }
    const authResult = await this.fallbackManager.authenticate(parsedCookies);

    if (!authResult.connection) {
      return {
        success: false,
        error: authResult.failureReason || 'Facebook authentication failed for supplied cookies.'
      };
    }

    // 5. Encrypt auth state and persist in MongoDB
    const encrypted = encryptAuthState(JSON.stringify(parsedCookies));
    const displayName = botName || `Facebook User (${MessengerLogger.maskUid(uid)})`;

    await messengerAccountsData.upsert({
      accountId,
      uid,
      slotId: slotId || '',
      displayName,
      authType: 'cookie',
      provider: authResult.activeProviderName || 'DongDev FCA',
      encryptedAuthState: encrypted,
      authStateVersion: 1,
      status: 'PENDING', // MUST set status to PENDING
      mqttStatus: 'OFF',
      creationSource,
      source: creationSource === 'CLIENT_SYNC' ? 'client' : 'admin',
      botEnabled: true,
      lastValidatedAt: Date.now(),
      connectionMode,
      encryptedMongoUri,
      dbName: dbName || '',
      collectionPrefix: collectionPrefix || ''
    });

    // 5. Initialize isolated AccountConnection
    const updatedRecord = await messengerAccountsData.get(accountId);
    if (!updatedRecord) {
      return { success: false, error: 'Database record creation failed.' };
    }

    // Backup to FTP immediately
    const ftpBackupRes = await this.backupAccountToFtp(accountId);
    if (ftpBackupRes.success) {
      this.setFtpBackupStatus(accountId, 'HEALTHY');
    } else {
      this.setFtpBackupStatus(accountId, 'FAILED');
    }
    this.setMongoBackupStatus(accountId, 'HEALTHY');
    this.setPersistentSession(accountId, 'SAVED');

    // Durable copy in Firebase RTDB (shipu-messsenger-bot/messenger-accounts).
    // This is the restart-proof session store read back on every boot.
    try {
      const { firebaseRtdbService } = await import('../../services/firebaseRtdbService');
      const stored = await messengerAccountsData.get(accountId);
      if (stored) {
        const { ...record } = stored as any;
        await firebaseRtdbService.saveSession(accountId, record);
      }
    } catch (fbErr: any) {
      messengerLogger.warn('AUTH', `Firebase RTDB mirror failed for ${accountId}: ${fbErr?.message || fbErr}`);
    }

    if (this.accounts.has(accountId)) {
      await this.accounts.get(accountId)?.disconnect();
    }

    const connection = new AccountConnection(updatedRecord);
    for (const listener of this.globalEventListeners) {
      connection.registerEventListener(listener);
    }

    // Reuse already authenticated FCA connection from step 4 instead of repeating login.
    // connect() sees sessionState.authenticated and only (re)starts the MQTT
    // listener through the full state machine — no second Facebook login.
    connection.setFcaConnection(authResult.connection, authResult.activeProviderName);
    this.accounts.set(accountId, connection);
    await connection.connect();

    // 6. Register/update known state in CloudAccountManager so polling knows it is active
    try {
      const { cloudAccountManager } = await import('../../services/CloudAccountManager');
      cloudAccountManager.registerKnownAccount(accountId, {
        updatedAt: updatedRecord.updatedAt || Date.now(),
        encryptedAuthState: updatedRecord.encryptedAuthState,
        enabled: (updatedRecord.botEnabled ?? true) && (updatedRecord.enabled ?? true)
      });
    } catch (camErr: any) {
      messengerLogger.warn('AUTH', `Failed to register account with CloudAccountManager: ${camErr.message}`);
    }

    // 7. Backup locally to appstate_cookie.json if this is the primary account
    if (this.accounts.size === 1) {
      CookieLoader.saveCookieFileSafely(cookieJson);
    }

    return {
      success: true,
      accountId,
      accountMeta: connection.getSafeMetadata()
    };
  }

  public async addOAuthAccount(tokenData: { accessToken: string; uid: string; name?: string }): Promise<{ success: boolean; accountMeta?: SafeAccountMeta; error?: string }> {
    if (!tokenData.accessToken || !tokenData.uid) {
      return { success: false, error: 'Meta OAuth token and UID are required.' };
    }

    const uid = tokenData.uid;
    const accountId = `oauth_${uid}`;

    const currentOAuthCount = this.getAccountCount('oauth');
    const isExisting = this.accounts.has(accountId);

    if (!isExisting && currentOAuthCount >= MultiAccountManager.MAX_AUTHORIZED_ACCOUNTS) {
      return {
        success: false,
        error: `Maximum authorized Meta OAuth accounts limit (${MultiAccountManager.MAX_AUTHORIZED_ACCOUNTS}) reached.`
      };
    }

    const encrypted = encryptAuthState(JSON.stringify(tokenData));
    const displayName = tokenData.name || `Meta Page/User (${MessengerLogger.maskUid(uid)})`;

    await messengerAccountsData.upsert({
      accountId,
      uid,
      displayName,
      authType: 'oauth',
      provider: 'Official Meta Graph API',
      encryptedAuthState: encrypted,
      authStateVersion: 1,
      status: 'AUTHENTICATED',
      mqttStatus: 'OFF',
      creationSource: 'LOCAL_ADMIN',
      botEnabled: true,
      lastValidatedAt: Date.now()
    });

    const updatedRecord = await messengerAccountsData.get(accountId);
    if (!updatedRecord) return { success: false, error: 'Database record creation failed.' };

    if (this.accounts.has(accountId)) {
      await this.accounts.get(accountId)?.disconnect();
    }

    const connection = new AccountConnection(updatedRecord);
    for (const listener of this.globalEventListeners) {
      connection.registerEventListener(listener);
    }

    this.accounts.set(accountId, connection);
    await connection.connect();

    return {
      success: true,
      accountMeta: connection.getSafeMetadata()
    };
  }

  public async reconnectAccount(accountId: string): Promise<boolean> {
    const connection = this.accounts.get(accountId);
    if (!connection) return false;
    return connection.connect();
  }

  public async disconnectAccount(accountId: string): Promise<boolean> {
    const connection = this.accounts.get(accountId);
    if (!connection) return false;
    await connection.disconnect();
    return true;
  }

  public async removeAccount(accountId: string): Promise<boolean> {
    const connection = this.accounts.get(accountId);
    if (connection) {
      await connection.disconnect();
      this.accounts.delete(accountId);
    }

    const deleted = await messengerAccountsData.delete(accountId);

    // Remove the durable Firebase copy as well (best-effort).
    try {
      const { firebaseRtdbService } = await import('../../services/firebaseRtdbService');
      await firebaseRtdbService.deleteSession(accountId);
    } catch {}

    // If deleting the last remaining account, remove root appstate_cookie.json
    if (this.accounts.size === 0) {
      CookieLoader.deleteCookieFile();
    }

    return deleted;
  }

  public async toggleBotForAccount(accountId: string, enabled: boolean): Promise<boolean> {
    const connection = this.accounts.get(accountId);
    if (!connection) return false;

    connection.botEnabled = enabled;
    await messengerAccountsData.update(accountId, { botEnabled: enabled });

    if (!enabled) {
      await connection.disconnect();
    } else {
      await connection.connect();
    }

    return true;
  }

  public getAllAccountsMeta(): SafeAccountMeta[] {
    const list: SafeAccountMeta[] = [];
    for (const connection of this.accounts.values()) {
      list.push(connection.getSafeMetadata());
    }
    return list;
  }

  public getAccountConnection(accountIdOrUid?: string): AccountConnection | null {
    if (!accountIdOrUid) {
      // Default to first active account
      return this.accounts.values().next().value || null;
    }

    if (this.accounts.has(accountIdOrUid)) {
      return this.accounts.get(accountIdOrUid)!;
    }

    for (const connection of this.accounts.values()) {
      if (connection.uid === accountIdOrUid || connection.accountId === accountIdOrUid) {
        return connection;
      }
    }

    return null;
  }

  public getAdapterForAccount(accountIdOrUid?: string): IMessengerAdapter {
    const connection = this.getAccountConnection(accountIdOrUid);
    const mockSession = {
      getFcaApi: () => connection?.getFcaApi(),
      getSafeMetadata: () => connection?.getSafeMetadata() || {
        status: 'NOT_CONFIGURED',
        accountName: '—',
        botUserID: '—',
        reconnectAttempts: 0,
        sessionFileExists: false,
        sessionValid: false
      }
    } as any;

    return new MessengerAdapterImpl(mockSession);
  }

  public getAccountMeta(accountIdOrUid?: string): SafeAccountMeta | null {
    const connection = this.getAccountConnection(accountIdOrUid);
    return connection ? connection.getSafeMetadata() : null;
  }

  // --- Backward compatibility helpers for existing single-account routes ---
  public getDefaultAccountMeta(): any {
    const connection = this.getAccountConnection();
    if (!connection) {
      return {
        status: 'NOT_CONFIGURED',
        mqttStatus: 'OFF',
        accountName: '—',
        botUserID: '—',
        reconnectAttempts: 0,
        sessionFileExists: false,
        sessionValid: false,
        activeProviderName: 'DongDev FCA'
      };
    }

    const meta = connection.getSafeMetadata();
    return {
      status: meta.status === 'MQTT_LISTENING' ? 'CONNECTED' : meta.status,
      mqttStatus: meta.mqttStatus,
      accountName: meta.displayName,
      botUserID: meta.uid,
      connectedAt: meta.connectedAt,
      reconnectAttempts: meta.reconnectCount,
      sessionFileExists: true,
      sessionValid: true,
      activeProviderName: meta.activeProviderName
    };
  }

  public onGlobalEvent(listener: (event: any) => void): void {
    this.registerGlobalEventListener(listener);
  }

  public getAccount(accountIdOrUid?: string): AccountConnection | null {
    return this.getAccountConnection(accountIdOrUid);
  }
}

export const multiAccountManager = MultiAccountManager.getInstance();
