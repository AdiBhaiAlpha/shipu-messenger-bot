import { botEngine } from '../core/botEngine';
import { FacebookSession } from '../adapters/messenger/FacebookSession';
import { getDatabaseStatus } from '../db/firebaseDb';
import { commandsData, threadsData, usersData, ftpConfigData } from '../db/database';

export class SystemStatusService {
  public static async getSystemStatus(facebookSession: FacebookSession) {
    const stats = botEngine.getStats();
    const sessionMeta = facebookSession.getSafeMetadata();
    const mongoStatus = getDatabaseStatus();
    const ftpConfig = await ftpConfigData.get();
    const commands = await commandsData.getAll();
    const threads = await threadsData.getAll();
    const users = await usersData.getAll();

    const isMessengerConnected = sessionMeta.status === 'CONNECTED';

    return {
      botStatus: stats.status,
      messengerStatus: sessionMeta.status,
      mongoStatus: mongoStatus.connected ? 'CONNECTED' : mongoStatus.status,
      ftpStatus: ftpConfig?.enabled ? 'CONFIGURED' : 'NOT_CONFIGURED',
      uptimeSeconds: Math.floor(process.uptime ? process.uptime() : 0),
      memoryUsageMB: Math.round(process.memoryUsage ? process.memoryUsage().heapUsed / 1024 / 1024 : 0),
      cpuLoadPercent: stats.cpuLoadPercent,
      loadedCommandsCount: commands.length,
      connectedThreadsCount: isMessengerConnected ? threads.length : 0,
      registeredUsersCount: users.length,
      botUserID: isMessengerConnected ? sessionMeta.botUserID : '—',
      botUserName: isMessengerConnected ? sessionMeta.accountName : '—',
      dataSources: {
        messenger: sessionMeta.sessionFileExists
          ? `appstate_cookie.json (${sessionMeta.cookiesCount || 0} keys parsed)`
          : 'appstate_cookie.json → missing',
        groups: 'Messenger Adapter',
        database: mongoStatus.connected ? 'MongoDB Atlas' : 'MongoDB Offline',
        fileStorage: ftpConfig?.enabled ? `cPanel FTP (${ftpConfig.host})` : 'FTP Not Configured',
        commands: ftpConfig?.enabled ? 'cPanel FTP Command Storage' : 'MongoDB Command Store'
      }
    };
  }
}
