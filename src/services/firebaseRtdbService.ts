import { firebaseConfig, FIREBASE_BOT_ROOT } from '../config/firebase';

/**
 * Firebase Realtime Database layer (REST, no extra npm dependency).
 *
 * Every path this service touches lives under FIREBASE_BOT_ROOT
 * ("shipu-messsenger-bot"), so existing data elsewhere in the database is
 * never read, overwritten, or deleted.
 *
 * Layout:
 *   shipu-messsenger-bot/
 *     messenger-accounts/{accountId}  -> messenger session records (encrypted auth state as stored)
 *     backups/mongo-{timestamp}       -> full MongoDB dumps copied over for migration
 *     meta/lastSync                   -> last successful sync marker
 *
 * All methods are best-effort: they log and return { success:false } instead
 * of throwing, so a locked/misconfigured database never crashes the bot.
 */

export interface RtdbResult {
  success: boolean;
  error?: string;
}

function baseUrl(): string {
  return (firebaseConfig.databaseURL || '').replace(/\/+$/, '');
}

function urlFor(path: string): string {
  const clean = String(path || '').replace(/^\/+/, '');
  return `${baseUrl()}/${FIREBASE_BOT_ROOT}/${clean}.json`;
}

async function rtdbFetch(path: string, init?: RequestInit): Promise<any> {
  const url = urlFor(path);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.error) detail = String(parsed.error).slice(0, 200);
      } catch {}
      throw new Error(`RTDB HTTP ${res.status}: ${detail}`);
    }
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(timer);
  }
}

class FirebaseRtdbService {
  private static instance: FirebaseRtdbService;
  private lastError = '';
  private lastSync = '';

  public static getInstance(): FirebaseRtdbService {
    if (!FirebaseRtdbService.instance) {
      FirebaseRtdbService.instance = new FirebaseRtdbService();
    }
    return FirebaseRtdbService.instance;
  }

  public getStatus() {
    return {
      configured: Boolean(baseUrl()),
      root: FIREBASE_BOT_ROOT,
      databaseURL: baseUrl() || 'NOT_CONFIGURED',
      lastError: this.lastError || null,
      lastSync: this.lastSync || null
    };
  }

  /** Connectivity probe. Succeeds only when rules allow reading our own root. */
  public async testConnection(): Promise<RtdbResult> {
    try {
      if (!baseUrl()) return { success: false, error: 'Firebase databaseURL is not configured.' };
      await rtdbFetch('meta/lastSync', { method: 'GET' });
      this.lastError = '';
      return { success: true };
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      return { success: false, error: this.lastError };
    }
  }

  // ---- Messenger sessions (durable copy; MongoDB stays the live store) ----

  public async saveSession(accountId: string, record: Record<string, any>): Promise<RtdbResult> {
    try {
      const safeId = encodeURIComponent(String(accountId));
      await rtdbFetch(`messenger-accounts/${safeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...record, _syncedAt: new Date().toISOString() })
      });
      this.lastSync = new Date().toISOString();
      try {
        await rtdbFetch('meta/lastSync', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.lastSync)
        });
      } catch {}
      return { success: true };
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      console.warn(`[FirebaseRTDB] saveSession(${accountId}) failed: ${this.lastError}`);
      return { success: false, error: this.lastError };
    }
  }

  public async getSessions(): Promise<{ success: boolean; sessions?: Record<string, any>; error?: string }> {
    try {
      const data = await rtdbFetch('messenger-accounts', { method: 'GET' });
      return { success: true, sessions: data || {} };
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      return { success: false, error: this.lastError };
    }
  }

  public async deleteSession(accountId: string): Promise<RtdbResult> {
    try {
      const safeId = encodeURIComponent(String(accountId));
      await rtdbFetch(`messenger-accounts/${safeId}`, { method: 'DELETE' });
      return { success: true };
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      return { success: false, error: this.lastError };
    }
  }

  // ---- Migration backups (MongoDB dumps copied under our own root) ----

  public async pushBackup(tag: string, payload: Record<string, any>): Promise<RtdbResult> {
    try {
      const safeTag = encodeURIComponent(String(tag));
      await rtdbFetch(`backups/${safeTag}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return { success: true };
    } catch (err: any) {
      this.lastError = err?.message || String(err);
      console.warn(`[FirebaseRTDB] pushBackup(${tag}) failed: ${this.lastError}`);
      return { success: false, error: this.lastError };
    }
  }

  /**
   * Startup restore: pull durable RTDB sessions into MongoDB when Mongo is
   * missing them (fresh deploy, wiped cluster, restart after outage).
   * Never overwrites a newer Mongo record.
   */
  public async restoreSessionsToMongo(): Promise<{ restored: number; skipped: number; error?: string }> {
    try {
      const { messengerAccountsData } = await import('../db/database');
      const remote = await this.getSessions();
      if (!remote.success) {
        return { restored: 0, skipped: 0, error: remote.error };
      }
      const sessions = remote.sessions || {};
      let restored = 0;
      let skipped = 0;
      for (const [accountId, rec] of Object.entries<any>(sessions)) {
        try {
          const existing = await messengerAccountsData.get(accountId);
          const remoteUpdated = (rec as any)?.updatedAt || 0;
          const localUpdated = (existing as any)?.updatedAt || 0;
          if (existing && localUpdated >= remoteUpdated) {
            skipped++;
            continue;
          }
          if (!rec || !(rec as any).uid || !(rec as any).encryptedAuthState) {
            skipped++;
            continue;
          }
          await messengerAccountsData.upsert({
            accountId,
            uid: (rec as any).uid,
            slotId: (rec as any).slotId || '',
            displayName: (rec as any).displayName || 'Facebook User',
            authType: (rec as any).authType || 'cookie',
            provider: (rec as any).provider || 'DongDev FCA',
            encryptedAuthState: (rec as any).encryptedAuthState,
            authStateVersion: (rec as any).authStateVersion || 1,
            status: 'PENDING',
            mqttStatus: 'OFF',
            creationSource: (rec as any).creationSource || 'LOCAL_ADMIN',
            botEnabled: (rec as any).botEnabled ?? true,
            lastValidatedAt: Date.now()
          });
          restored++;
        } catch {
          skipped++;
        }
      }
      if (restored > 0) {
        console.log(`[FirebaseRTDB] Restored ${restored} session(s) from RTDB to MongoDB (${skipped} skipped).`);
      }
      return { restored, skipped };
    } catch (err: any) {
      return { restored: 0, skipped: 0, error: err?.message || String(err) };
    }
  }
}

export const firebaseRtdbService = FirebaseRtdbService.getInstance();
