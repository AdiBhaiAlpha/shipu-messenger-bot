import { firebaseConfig, FIREBASE_BOT_ROOT } from '../config/firebase';

/**
 * Behaviour Observer — Phase 1b.
 *
 * Captures every incoming message's human-style signals and stores them under
 * shipu-messsenger-bot/behaviour/{threadID}/{pushId}:
 *   - tone (greeting/question/laugh/sad/angry/love/short/chat)
   - emojis used (extracted)
   - bangla/latin script ratio (typing style)
   - word pairs (bigrams) for word-pair learning
   - sender, timestamp
 *
 * Also maintains a per-thread aggregate profile under
 * shipu-messsenger-bot/behaviour-profile/{threadID}:
 *   - emoji frequency, common bigrams, tone distribution, avg message length
 * Used later by AI prompts to mimic the group's natural style.
 *
 * Free, fire-and-forget, never blocks message handling.
 */

function baseUrl(): string {
  return (firebaseConfig.databaseURL || '').replace(/\/+$/, '');
}
function nodeUrl(p: string): string {
  return `${baseUrl()}/${FIREBASE_BOT_ROOT}/behaviour/${p}.json`;
}
function profileUrl(threadID: string): string {
  return `${baseUrl()}/${FIREBASE_BOT_ROOT}/behaviour-profile/${encodeURIComponent(threadID)}.json`;
}

async function fbReq(url: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return null;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
  finally { clearTimeout(t); }
}

const EMOJI_RE = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
const BANGLA_RE = /[\u0980-\u09FF]/g;

function classifyTone(text: string): string {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return 'empty';
  if (/^(hi|hello|hey|hola|hlw|assalam|salam|namaste|gm|gn)\b/.test(t)) return 'greeting';
  if (/\?$/.test(t) || /^(ki|kya|what|how|why|when|where|who|kivabe|kemne|keno)\b/.test(t)) return 'question';
  if (/(lol|haha|😂|🤣|lmao|rofl)/i.test(t)) return 'laugh';
  if (/(sad|dukkho|cry|😭|😢|miss|alone)/i.test(t)) return 'sad';
  if (/(angry|rag|mad|gussa|😡|😠|hate)/i.test(t)) return 'angry';
  if (/(love|valobasha|❤️|😘|😍)/i.test(t)) return 'love';
  if (t.length < 6) return 'short';
  return 'chat';
}

function extractEmojis(text: string): string[] {
  const m = text.match(EMOJI_RE);
  return m ? Array.from(new Set(m)) : [];
}

function banglaRatio(text: string): number {
  const total = text.replace(/\s/g, '').length || 1;
  const bn = (text.match(BANGLA_RE) || []).length;
  return Math.round((bn / total) * 100) / 100;
}

function bigrams(text: string): string[] {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length - 1; i++) {
    out.push(`${words[i]} ${words[i + 1]}`);
  }
  return out;
}

export interface BehaviourSignal {
  threadID: string;
  senderID: string;
  text: string;
  tone: string;
  emojis: string[];
  banglaRatio: number;
  length: number;
  bigrams: string[];
  timestamp: number;
}

export class BehaviourObserver {
  private static instance: BehaviourObserver;
  private static instance2: BehaviourObserver;
  private constructor() {}
  public static getInstance(): BehaviourObserver {
    if (!BehaviourObserver.instance) BehaviourObserver.instance = new BehaviourObserver();
    return BehaviourObserver.instance;
  }

  /** Fire-and-forget capture. Never throws, never blocks. */
  public observe(signal: Omit<BehaviourSignal, 'tone' | 'emojis' | 'banglaRatio' | 'length' | 'bigrams' | 'timestamp'> & { text: string }): void {
    const text = String(signal.text || '');
    const full: BehaviourSignal = {
      threadID: signal.threadID,
      senderID: signal.senderID,
      text: text.slice(0, 500),
      tone: classifyTone(text),
      emojis: extractEmojis(text),
      banglaRatio: banglaRatio(text),
      length: text.length,
      bigrams: bigrams(text).slice(0, 20),
      timestamp: Date.now()
    };
    // fire and forget
    this.persist(full).catch(() => {});
    this.updateProfile(full).catch(() => {});
  }

  private async persist(sig: BehaviourSignal): Promise<void> {
    const path = `${encodeURIComponent(sig.threadID)}/${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    await fbReq(nodeUrl(path), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sig)
    });
  }

  private async updateProfile(sig: BehaviourSignal): Promise<void> {
    const url = profileUrl(sig.threadID);
    const existing = await fbReq(url, { method: 'GET' });
    const prof: any = existing && typeof existing === 'object' ? existing : {
      threadID: sig.threadID,
      messageCount: 0,
      toneCounts: {},
      emojiCounts: {},
      bigramCounts: {},
      totalLength: 0,
      lastUpdated: 0
    };

    prof.messageCount = (prof.messageCount || 0) + 1;
    prof.toneCounts = prof.toneCounts || {};
    prof.toneCounts[sig.tone] = (prof.toneCounts[sig.tone] || 0) + 1;
    prof.emojiCounts = prof.emojiCounts || {};
    for (const e of sig.emojis) prof.emojiCounts[e] = (prof.emojiCounts[e] || 0) + 1;
    prof.bigramCounts = prof.bigramCounts || {};
    for (const b of sig.bigrams) prof.bigramCounts[b] = (prof.bigramCounts[b] || 0) + 1;
    prof.totalLength = (prof.totalLength || 0) + sig.length;
    prof.lastUpdated = Date.now();
    // cap bigram counts to top 200 to keep payload small
    const entries = Object.entries(prof.bigramCounts);
    if (entries.length > 200) {
      entries.sort((a: any, b: any) => b[1] - a[1]);
      prof.bigramCounts = Object.fromEntries(entries.slice(0, 200));
    }
    const emojiEntries = Object.entries(prof.emojiCounts);
    if (emojiEntries.length > 50) {
      emojiEntries.sort((a: any, b: any) => b[1] - a[1]);
      prof.emojiCounts = Object.fromEntries(emojiEntries.slice(0, 50));
    }

    await fbReq(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(prof)
    });
  }

  /** Fetch a compact style hint for prompting. */
  public async getStyleHint(threadID: string): Promise<string> {
    try {
      const prof: any = await fbReq(profileUrl(threadID), { method: 'GET' });
      if (!prof) return '';
      const topEmojis = Object.entries(prof.emojiCounts || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 5).map((e: any) => e[0]).join(' ');
      const topBigrams = Object.entries(prof.bigramCounts || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 8).map((e: any) => e[0]).join(', ');
      const avgLen = prof.messageCount ? Math.round(prof.totalLength / prof.messageCount) : 0;
      const tones = Object.entries(prof.toneCounts || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 3).map((e: any) => `${e[0]}:${e[1]}`).join(', ');
      return `Group style hint (mimic naturally): top emojis=${topEmojis || 'none'}, common phrases=${topBigrams || 'none'}, avg msg len=${avgLen}, tone mix=${tones || 'none'}.`;
    } catch { return ''; }
  }
}

export const behaviourObserver = BehaviourObserver.getInstance();
