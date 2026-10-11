import fs from 'fs';
import path from 'path';

/**
 * Reader for the root `fca-config.json`.
 *
 * FCA itself loads this file, but it does NOT honour `mqtt.enabled` — that key
 * is silently dropped by FCA's option normalizer. Honouring it here means the
 * documented switch actually controls whether the realtime listener starts,
 * instead of being decoration that always connects.
 */

export interface FcaConfig {
  autoUpdate?: boolean;
  autoLogin?: boolean;
  mqtt?: {
    enabled?: boolean;
    reconnectInterval?: number;
  };
  [key: string]: any;
}

let cached: FcaConfig | null = null;

const DEFAULT_CONFIG: FcaConfig = {
  autoUpdate: false,
  autoLogin: false,
  mqtt: { enabled: true, reconnectInterval: 3600 }
};

export function loadFcaConfig(forceReload = false): FcaConfig {
  if (cached && !forceReload) return cached;

  const candidates = [
    path.join(process.cwd(), 'fca-config.json')
  ];

  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const parsed = JSON.parse(fs.readFileSync(candidate, 'utf-8'));
      cached = {
        ...DEFAULT_CONFIG,
        ...parsed,
        mqtt: { ...DEFAULT_CONFIG.mqtt, ...(parsed?.mqtt || {}) }
      };
      return cached;
    } catch {
      // fall through to the next candidate
    }
  }

  cached = { ...DEFAULT_CONFIG };
  return cached;
}

/** True when the realtime (MQTT) listener is enabled in fca-config.json. */
export function isMqttListenerEnabled(): boolean {
  return loadFcaConfig().mqtt?.enabled !== false;
}