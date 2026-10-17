import { firebaseConfig, FIREBASE_BOT_ROOT } from '../config/firebase';
import { isDatabaseConnected, getDatabaseStatus } from '../db/firebaseDb';
import { multiAccountManager } from '../adapters/messenger/MultiAccountManager';
import { aiConfigManager } from './aiConfigManager';
import { openRouterService } from './openRouterService';
import { ftpStorageService } from './ftpStorageService';
import { ftpConfigData } from '../db/database';

/**
 * Liveness + Error Aggregator (production hardening).
 *
 * /api/health/deep probes every subsystem and returns a structured report.
 * ErrorAggregator keeps the last N errors in memory for /api/errors.
 */

export interface ServiceProbe {
  name: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export interface DeepHealth {
  status: 'ok' | 'degraded' | 'down';
  uptime: number;
  timestamp: string;
  services: ServiceProbe[];
  recentErrors: number;
}

class ErrorAggregator {
  private static instance: ErrorAggregator;
  private errors: Array<{ ts: number; source: string; message: string; stack?: string }> = [];
  private readonly MAX = 200;
  private constructor() {}
  public static getInstance(): ErrorAggregator {
    if (!ErrorAggregator.instance) ErrorAggregator.instance = new ErrorAggregator();
    return ErrorAggregator.instance;
  }
  public record(source: string, err: any): void {
    const entry = {
      ts: Date.now(),
      source,
      message: (err && (err.message || String(err))) || 'unknown',
      stack: (err && err.stack) ? String(err.stack).slice(0, 2000) : undefined
    };
    this.errors.unshift(entry);
    if (this.errors.length > this.MAX) this.errors.length = this.MAX;
  }
  public recent(limit = 50): Array<{ ts: number; source: string; message: string; stack?: string }> {
    return this.errors.slice(0, limit);
  }
  public count(): number { return this.errors.length; }
  public clear(): void { this.errors = []; }
}

export const errorAggregator = ErrorAggregator.getInstance();

export class LivenessService {
  private static instance: LivenessService;
  private constructor() {}
  public static getInstance(): LivenessService {
    if (!LivenessService.instance) LivenessService.instance = new LivenessService();
    return LivenessService.instance;
  }

  public async probeAll(): Promise<DeepHealth> {
    const services: ServiceProbe[] = [];
    const start = Date.now();

    // DB
    {
      const t = Date.now();
      let ok = false; let detail = 'unknown';
      try {
        const st = getDatabaseStatus();
        ok = st.connected;
        detail = st.connected ? `${st.transport} ${st.status}` : (st.error || 'disconnected');
      } catch (e: any) { detail = e?.message || String(e); errorAggregator.record('db', e); }
      services.push({ name: 'database', ok, latencyMs: Date.now() - t, detail });
    }

    // AI
    {
      const t = Date.now();
      let ok = false; let detail = 'unknown';
      try {
        const cfg = await aiConfigManager.getConfig();
        ok = cfg.aiEnabled && !!cfg.openRouterApiKey;
        detail = ok ? `provider=${cfg.defaultProvider} model=${cfg.defaultModel} status=${cfg.status}` : 'disabled or no key';
      } catch (e: any) { detail = e?.message || String(e); errorAggregator.record('ai', e); }
      services.push({ name: 'ai', ok, latencyMs: Date.now() - t, detail });
    }

    // OpenRouter reachability (lightweight)
    {
      const t = Date.now();
      let ok = false; let detail = 'unknown';
      try {
        const cfg = await aiConfigManager.getConfig();
        if (!cfg.openRouterApiKey) { detail = 'no key'; }
        else {
          // HEAD-ish: use models endpoint with short timeout
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 8000);
          try {
            const r = await fetch('https://openrouter.ai/api/v1/models', {
              headers: { 'Authorization': `Bearer ${cfg.openRouterApiKey}` },
              signal: ctrl.signal
            });
            ok = r.status === 200 || r.status === 401; // 401 means reachable but bad key
            detail = `HTTP ${r.status}`;
          } finally { clearTimeout(timer); }
        }
      } catch (e: any) { detail = e?.message || String(e); errorAggregator.record('openrouter', e); }
      services.push({ name: 'openrouter', ok, latencyMs: Date.now() - t, detail });
    }

    // Messenger accounts
    {
      const t = Date.now();
      let ok = false; let detail = 'unknown';
      try {
        const metas = multiAccountManager.getAllAccountsMeta();
        const healthy = metas.filter(m => m.status === 'CONNECTED' || m.status === 'MQTT_LISTENING' || m.status === 'ONLINE' || m.status === 'AI_READY').length;
        ok = metas.length === 0 || healthy > 0;
        detail = `${metas.length} accounts, ${healthy} healthy`;
      } catch (e: any) { detail = e?.message || String(e); errorAggregator.record('messenger', e); }
      services.push({ name: 'messenger', ok, latencyMs: Date.now() - t, detail });
    }

    // FTP
    {
      const t = Date.now();
      let ok = false; let detail = 'unknown';
      try {
        const cfg = await ftpConfigData.get();
        if (!cfg || !cfg.enabled) { ok = true; detail = 'disabled'; }
        else {
          const st = ftpStorageService.getConnectionState();
          ok = !!st && (st as any).connected !== false;
          detail = (st as any)?.status || 'unknown';
        }
      } catch (e: any) { detail = e?.message || String(e); errorAggregator.record('ftp', e); }
      services.push({ name: 'ftp', ok, latencyMs: Date.now() - t, detail });
    }

    const allOk = services.every(s => s.ok);
    const anyOk = services.some(s => s.ok);
    const status: DeepHealth['status'] = allOk ? 'ok' : (anyOk ? 'degraded' : 'down');

    return {
      status,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      services,
      recentErrors: errorAggregator.count()
    };
  }
}

export const livenessService = LivenessService.getInstance();
