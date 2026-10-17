import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';
import chokidar from 'chokidar';
import { ftpStorageService } from './ftpStorageService';
import { ftpConfigData } from '../db/database';
import { dependencyManager } from './dependencyManager';
import { goatBotLoader } from '../core/goatBotLoader';

export interface SyncLog {
  timestamp: string;
  module: string;
  file: string;
  action: string;
  result: 'SUCCESS' | 'FAILED' | 'REJECTED';
  durationMs: number;
  error?: string;
}

export class FtpSyncEngine {
  private static instance: FtpSyncEngine;
  private watcher: any = null;
  private isRunning: boolean = false;
  private fileHashes: Map<string, string> = new Map();
  private logs: SyncLog[] = [];
  private lastSyncTime: string | null = null;
  private uploadQueue: Set<string> = new Set();
  private downloadQueue: Set<string> = new Set();
  private syncInterval: any = null;

  private watchedPaths = [
    'commands',
    'events',
    'scripts',
    'plugins',
    'handlers',
    'assets',
    'config',
    'utils'
  ];

  private watchedFiles = [
    'package.json'
  ];

  private constructor() {
    this.ensureDirs();
  }

  public static getInstance(): FtpSyncEngine {
    if (!FtpSyncEngine.instance) {
      FtpSyncEngine.instance = new FtpSyncEngine();
    }
    return FtpSyncEngine.instance;
  }

  private ensureDirs() {
    // Vercel serverless filesystem is read-only except /tmp — never crash boot.
    try {
      fs.ensureDirSync(path.join(process.cwd(), 'backups'));
      for (const folder of this.watchedPaths) {
        fs.ensureDirSync(path.join(process.cwd(), folder));
      }
    } catch (err: any) {
      console.warn(`[FtpSyncEngine] Local directory setup skipped (read-only fs?): ${err?.message || err}`);
    }
  }

  public addLog(module: string, file: string, action: string, result: 'SUCCESS' | 'FAILED' | 'REJECTED', durationMs: number, error?: string) {
    const log: SyncLog = {
      timestamp: new Date().toISOString(),
      module,
      file,
      action,
      result,
      durationMs,
      error
    };
    this.logs.unshift(log);
    if (this.logs.length > 300) this.logs.pop();
    console.log(`[${module}] [${action}] ${file} -> ${result} (${durationMs}ms)${error ? ': ' + error : ''}`);
  }

  public getLogs(): SyncLog[] {
    return this.logs;
  }

  public getStatus() {
    return {
      isRunning: this.isRunning,
      lastSyncTime: this.lastSyncTime,
      uploadQueueSize: this.uploadQueue.size,
      downloadQueueSize: this.downloadQueue.size,
      watchedDirectories: this.watchedPaths,
      logsCount: this.logs.length
    };
  }

  public computeHash(content: string | Buffer): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Start Chokidar-based filesystem watcher and regular 60s validation sweeps
   */
  public async start(): Promise<{ success: boolean; message: string }> {
    if (this.isRunning) {
      return { success: true, message: 'FTP Sync Engine is already active.' };
    }

    const config = await ftpConfigData.get();
    if (!config || !config.enabled) {
      return { success: false, message: 'FTP is disabled or not configured.' };
    }

    this.isRunning = true;
    this.addLog('FTP Sync', 'All', 'START_ENGINE', 'SUCCESS', 0);

    // Initial check and index building
    await this.rebuildLocalIndex();

    // Setup Chokidar Watcher
    const targets = [...this.watchedPaths, ...this.watchedFiles].map(p => path.resolve(process.cwd(), p));
    
    this.watcher = chokidar.watch(targets, {
      persistent: true,
      ignoreInitial: true,
      ignorePermissionErrors: true,
      awaitWriteFinish: {
        stabilityThreshold: 1000,
        pollInterval: 100
      }
    });

    this.watcher
      .on('add', (filePath: string) => this.handleLocalFileEvent('ADD', filePath))
      .on('change', (filePath: string) => this.handleLocalFileEvent('MODIFY', filePath))
      .on('unlink', (filePath: string) => this.handleLocalFileEvent('DELETE', filePath));

    // Setup 60s Validation & Sync Loop
    this.syncInterval = setInterval(() => {
      const runWithRetry = async (attempt = 0) => {
        try {
          await this.performValidationSweep();
        } catch (err: any) {
          this.addLog('FTP Sync', 'All', 'SWEEP_ERROR', 'FAILED', 0, err.message);
          if (attempt < 3) {
            const delay = Math.min(5000 * Math.pow(2, attempt), 60000);
            setTimeout(() => runWithRetry(attempt + 1), delay);
          }
        }
      };
      runWithRetry().catch(() => {});
    }, 60000);

    // Run first sweep (with retry)
    setTimeout(() => {
      const run = async (a = 0) => {
        try { await this.performValidationSweep(); }
        catch (e: any) {
          if (a < 3) setTimeout(() => run(a + 1), 5000 * Math.pow(2, a));
        }
      };
      run().catch(() => {});
    }, 2000);

    return { success: true, message: 'Bi-Directional Live Sync Engine started (Chokidar Active).' };
  }

  public stop(): { success: boolean; message: string } {
    if (!this.isRunning) {
      return { success: true, message: 'FTP Sync Engine is not active.' };
    }

    this.isRunning = false;
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    this.addLog('FTP Sync', 'All', 'STOP_ENGINE', 'SUCCESS', 0);
    return { success: true, message: 'FTP Sync Engine stopped.' };
  }

  /**
   * Builds the SHA-256 index of all local files to prevent unnecessary syncs
   */
  public async rebuildLocalIndex(): Promise<number> {
    const startTime = Date.now();
    this.fileHashes.clear();
    let count = 0;

    for (const target of [...this.watchedPaths, ...this.watchedFiles]) {
      const fullPath = path.resolve(process.cwd(), target);
      if (!await fs.pathExists(fullPath)) continue;

      const stat = await fs.stat(fullPath);
      if (stat.isFile()) {
        const content = await fs.readFile(fullPath);
        this.fileHashes.set(target, this.computeHash(content));
        count++;
      } else if (stat.isDirectory()) {
        const walk = async (dir: string, base: string) => {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            const relative = path.join(base, entry.name).replace(/\\/g, '/');
            if (entry.isDirectory()) {
              if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'backups' && entry.name !== 'cache') {
                await walk(entryPath, relative);
              }
            } else if (entry.isFile()) {
              const content = await fs.readFile(entryPath);
              this.fileHashes.set(relative, this.computeHash(content));
              count++;
            }
          }
        };
        await walk(fullPath, target);
      }
    }

    this.addLog('FTP Sync', 'Index', 'REBUILD_INDEX', 'SUCCESS', Date.now() - startTime, `Indexed ${count} files`);
    return count;
  }

  /**
   * Handle changes originating from local filesystem
   */
  private async handleLocalFileEvent(action: 'ADD' | 'MODIFY' | 'DELETE', filePath: string) {
    const startTime = Date.now();
    const relPath = path.relative(process.cwd(), filePath).replace(/\\/g, '/');
    
    // Ignore cache folders or non-project files
    if (relPath.includes('node_modules') || relPath.includes('.git') || relPath.includes('backups') || relPath.includes('cache/')) {
      return;
    }

    const config = await ftpConfigData.get();
    if (!config || !config.enabled) return;

    if (action === 'DELETE') {
      this.fileHashes.delete(relPath);
      const res = await ftpStorageService.deleteFtpItems(config, [relPath]);
      if (res.success) {
        this.addLog('Watcher', relPath, 'DELETE_REMOTE', 'SUCCESS', Date.now() - startTime);
        this.handleLocalDeletionSideEffects(relPath);
      } else {
        const errMsg = res.errors && res.errors.length > 0 ? res.errors.join(', ') : 'Unknown delete error';
        this.addLog('Watcher', relPath, 'DELETE_REMOTE', 'FAILED', Date.now() - startTime, errMsg);
      }
      return;
    }

    try {
      if (!await fs.pathExists(filePath)) return;
      const stat = await fs.stat(filePath);
      if (stat.isDirectory()) return;

      const content = await fs.readFile(filePath);
      const newHash = this.computeHash(content);
      const prevHash = this.fileHashes.get(relPath);

      if (newHash === prevHash) {
        // No contents changed
        return;
      }

      this.fileHashes.set(relPath, newHash);
      this.uploadQueue.add(relPath);

      // Create local backup
      await this.createBackup(relPath);

      // Upload to FTP
      const res = await ftpStorageService.writeFtpFileContent(config, relPath, content.toString('utf8'), true);
      this.uploadQueue.delete(relPath);

      if (res.success) {
        this.addLog('Watcher', relPath, 'UPLOAD_REMOTE', 'SUCCESS', Date.now() - startTime);
        await this.handleReloadAndSideEffects(relPath, content);
      } else {
        this.addLog('Watcher', relPath, 'UPLOAD_REMOTE', 'FAILED', Date.now() - startTime, res.error);
      }
    } catch (err: any) {
      this.uploadQueue.delete(relPath);
      this.addLog('Watcher', relPath, 'LOCAL_EVENT_ERROR', 'FAILED', Date.now() - startTime, err.message);
    }
  }

  private handleLocalDeletionSideEffects(relPath: string) {
    if (relPath.startsWith('commands/')) {
      const name = path.basename(relPath, path.extname(relPath));
      goatBotLoader.unloadCommand(name);
      this.addLog('Command Loader', relPath, 'UNLOAD_DELETED_COMMAND', 'SUCCESS', 0);
    }
  }

  /**
   * Version-controlled secure backup creation
   */
  public async createBackup(filePath: string): Promise<string | null> {
    try {
      const fullPath = path.resolve(process.cwd(), filePath);
      if (!await fs.pathExists(fullPath)) return null;

      const stat = await fs.stat(fullPath);
      if (stat.isDirectory()) return null;

      const content = await fs.readFile(fullPath);
      const ext = path.extname(filePath);
      const baseName = path.basename(filePath, ext);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFile = `${baseName}.${timestamp}${ext}.bak`;
      const backupPath = path.join(process.cwd(), 'backups', backupFile);

      await fs.writeFile(backupPath, content);
      return backupPath;
    } catch (err: any) {
      this.addLog('Backup', filePath, 'CREATE_BACKUP_ERROR', 'FAILED', 0, err.message);
      return null;
    }
  }

  /**
   * Trigger clean hot-reload, dependency check, syntax verification and cache updates
   */
  public async handleReloadAndSideEffects(relPath: string, buffer: Buffer) {
    const startTime = Date.now();
    const code = buffer.toString('utf8');

    // 1. Syntax Validation
    if (relPath.endsWith('.js') || relPath.endsWith('.ts')) {
      try {
        new Function(code);
      } catch (syntaxErr: any) {
        this.addLog('Validation', relPath, 'SYNTAX_CHECK', 'REJECTED', Date.now() - startTime, `Syntax Error: ${syntaxErr.message}`);
        return false;
      }
    }

    // 2. Dependency Scan & Auto-install
    if (relPath.endsWith('.js') || relPath.endsWith('.ts')) {
      try {
        const { requiredPackages } = dependencyManager.extractDependenciesFromCode(code);
        if (requiredPackages && requiredPackages.length > 0) {
          const installRes = dependencyManager.ensurePackagesInstalledSync(requiredPackages);
          if (installRes.installed && installRes.installed.length > 0) {
            this.addLog('Dependency', relPath, 'AUTO_INSTALL', 'SUCCESS', Date.now() - startTime, `Installed: ${installRes.installed.join(', ')}`);
          }
        }
      } catch (depErr: any) {
        this.addLog('Dependency', relPath, 'AUTO_INSTALL', 'FAILED', Date.now() - startTime, depErr.message);
      }
    }

    // 3. Hot Reload Command
    if (relPath.startsWith('commands/')) {
      const cmdName = path.basename(relPath, path.extname(relPath));
      try {
        const fullPath = path.resolve(process.cwd(), relPath);

        // Deep clearance of all forms of cached modules
        delete require.cache[require.resolve(fullPath)];
        delete require.cache[fullPath];

        // Unload command from loader memory
        goatBotLoader.unloadCommand(cmdName);

        // Re-read file fresh to load
        const loaded = goatBotLoader.loadCommandFromCode(code, relPath);
        if (loaded) {
          // Register the command in loader memory
          goatBotLoader.registerLoadedCommand(loaded.module, loaded.summary);
          this.addLog('Command Loader', relPath, 'HOT_RELOAD', 'SUCCESS', Date.now() - startTime, `Command "${cmdName}" refreshed successfully`);
          return true;
        } else {
          this.addLog('Command Loader', relPath, 'HOT_RELOAD', 'FAILED', Date.now() - startTime, 'Could not parse/register command module');
          return false;
        }
      } catch (err: any) {
        this.addLog('Command Loader', relPath, 'HOT_RELOAD_ERROR', 'FAILED', Date.now() - startTime, err.message);
        return false;
      }
    }

    return true;
  }

  /**
   * Bi-directional continuous verification sweep (runs every 60 seconds)
   */
  public async performValidationSweep(): Promise<{ success: boolean; repaired: number }> {
    const startTime = Date.now();
    const config = await ftpConfigData.get();
    if (!config || !config.enabled) {
      return { success: false, repaired: 0 };
    }

    let repairedCount = 0;

    try {
      // 1. Fetch remote files from watched directories
      const remoteFilesMap = new Map<string, any>();
      
      // Also check root for watched files like package.json
      const rootRes = await ftpStorageService.listDirectory(config, '/', true);
      if (rootRes.success && rootRes.files) {
        for (const file of rootRes.files) {
          if (file.type === 'file') {
            const rel = file.relativePath.replace(/^\/+/, '');
            if (this.watchedFiles.includes(rel)) {
              remoteFilesMap.set(rel, file);
            }
          }
        }
      }

      // Check each watched directory
      for (const folder of this.watchedPaths) {
        const folderRes = await ftpStorageService.listDirectory(config, folder, true);
        if (folderRes.success && folderRes.files) {
          for (const item of folderRes.files) {
            if (item.type === 'file') {
              const rel = item.relativePath.replace(/^\/+/, '');
              remoteFilesMap.set(rel, item);
            } else if (item.type === 'directory') {
              // Simple one-level deep scan for subdirectories in watched paths
              const subRes = await ftpStorageService.listDirectory(config, item.relativePath, true);
              if (subRes.success && subRes.files) {
                for (const subItem of subRes.files) {
                  if (subItem.type === 'file') {
                    remoteFilesMap.set(subItem.relativePath.replace(/^\/+/, ''), subItem);
                  }
                }
              }
            }
          }
        }
      }

      // 2. Scan local files
      const localFilesMap = new Map<string, { mtime: Date; size: number; path: string }>();
      for (const target of [...this.watchedPaths, ...this.watchedFiles]) {
        const fullPath = path.resolve(process.cwd(), target);
        if (!await fs.pathExists(fullPath)) continue;

        const stat = await fs.stat(fullPath);
        if (stat.isFile()) {
          localFilesMap.set(target, { mtime: stat.mtime, size: stat.size, path: fullPath });
        } else {
          const walk = async (dir: string, base: string) => {
            const entries = await fs.readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
              const resPath = path.join(dir, entry.name);
              const relative = path.join(base, entry.name).replace(/\\/g, '/');
              if (entry.isDirectory()) {
                if (entry.name !== 'node_modules' && entry.name !== '.git' && entry.name !== 'backups' && entry.name !== 'cache') {
                  await walk(resPath, relative);
                }
              } else if (entry.isFile()) {
                const st = await fs.stat(resPath);
                localFilesMap.set(relative, { mtime: st.mtime, size: st.size, path: resPath });
              }
            }
          };
          await walk(fullPath, target);
        }
      }

      // 3. Bi-directional Comparison and Conflict Resolution (Heuristics: newest modification time wins)
      for (const [filePath, localInfo] of localFilesMap.entries()) {
        const remoteInfo = remoteFilesMap.get(filePath);

        if (!remoteInfo) {
          // Exists locally but missing on FTP -> Sync upload
          this.uploadQueue.add(filePath);
          try {
            const content = await fs.readFile(localInfo.path);
            const res = await ftpStorageService.writeFtpFileContent(config, filePath, content.toString('utf8'), false);
            if (res.success) {
              this.fileHashes.set(filePath, this.computeHash(content));
              repairedCount++;
              this.addLog('FTP Sync', filePath, 'SWEEP_UPLOAD_NEW', 'SUCCESS', Date.now() - startTime);
            }
          } catch {}
          this.uploadQueue.delete(filePath);
        } else {
          // Exists on both sides -> Compare modifications & sizes
          const localTime = localInfo.mtime.getTime();
          const remoteTime = remoteInfo.modifiedAt ? new Date(remoteInfo.modifiedAt).getTime() : 0;
          
          // Allow 3s window tolerance for transfer duration skew
          if (remoteTime > localTime + 3000) {
            // FTP remote is newer -> Download to local
            this.downloadQueue.add(filePath);
            const dlRes = await ftpStorageService.downloadFtpFileBuffer(config, filePath);
            this.downloadQueue.delete(filePath);

            if (dlRes.success && dlRes.buffer) {
              await this.createBackup(filePath);
              await fs.ensureDir(path.dirname(localInfo.path));
              await fs.writeFile(localInfo.path, dlRes.buffer);
              
              this.fileHashes.set(filePath, this.computeHash(dlRes.buffer));
              repairedCount++;
              this.addLog('FTP Sync', filePath, 'SWEEP_DOWNLOAD_UPDATE', 'SUCCESS', Date.now() - startTime);
              await this.handleReloadAndSideEffects(filePath, dlRes.buffer);
            }
          } else if (localTime > remoteTime + 3000) {
            // Local is newer -> Upload to FTP
            this.uploadQueue.add(filePath);
            try {
              const content = await fs.readFile(localInfo.path);
              const res = await ftpStorageService.writeFtpFileContent(config, filePath, content.toString('utf8'), true);
              if (res.success) {
                this.fileHashes.set(filePath, this.computeHash(content));
                repairedCount++;
                this.addLog('FTP Sync', filePath, 'SWEEP_UPLOAD_UPDATE', 'SUCCESS', Date.now() - startTime);
              }
            } catch {}
            this.uploadQueue.delete(filePath);
          }
        }
      }

      // Check for remote files that are not present locally
      for (const [filePath, remoteInfo] of remoteFilesMap.entries()) {
        const isWatched = this.watchedPaths.some(p => filePath.startsWith(p + '/')) || this.watchedFiles.includes(filePath);
        if (!isWatched) continue;

        if (!localFilesMap.has(filePath)) {
          // Missing locally -> Download from FTP
          this.downloadQueue.add(filePath);
          const dlRes = await ftpStorageService.downloadFtpFileBuffer(config, filePath);
          this.downloadQueue.delete(filePath);

          if (dlRes.success && dlRes.buffer) {
            const destPath = path.resolve(process.cwd(), filePath);
            await fs.ensureDir(path.dirname(destPath));
            await fs.writeFile(destPath, dlRes.buffer);

            this.fileHashes.set(filePath, this.computeHash(dlRes.buffer));
            repairedCount++;
            this.addLog('FTP Sync', filePath, 'SWEEP_DOWNLOAD_NEW', 'SUCCESS', Date.now() - startTime);
            await this.handleReloadAndSideEffects(filePath, dlRes.buffer);
          }
        }
      }

      this.lastSyncTime = new Date().toISOString();
      if (repairedCount > 0) {
        this.addLog('FTP Sync', 'Sweep', 'VALIDATION_REPAIR', 'SUCCESS', Date.now() - startTime, `Repaired ${repairedCount} file skews`);
      }
      return { success: true, repaired: repairedCount };
    } catch (err: any) {
      const errMsg = err?.message || '';
      if (errMsg.includes('530') || errMsg.includes('authentication') || errMsg.includes('login')) {
        this.addLog('FTP Sync', 'Sweep', 'VALIDATION_SWEEP', 'REJECTED', Date.now() - startTime, 'FTP authentication failed (530). Check credentials in settings.');
      } else {
        this.addLog('FTP Sync', 'Sweep', 'VALIDATION_SWEEP', 'FAILED', Date.now() - startTime, errMsg);
      }
      return { success: false, repaired: 0 };
    }
  }
}

export const ftpSyncEngine = FtpSyncEngine.getInstance();
(globalThis as any).ftpSyncEngine = ftpSyncEngine;
