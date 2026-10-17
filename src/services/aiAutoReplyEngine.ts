import { firebaseConfig, FIREBASE_BOT_ROOT } from '../config/firebase';
import { aiConfigManager } from './aiConfigManager';
import { openRouterService } from './openRouterService';
import { brainService } from './brainService';

/**
 * AI Auto-Reply Engine (free-model only).
 *
 * Decides whether Shipu (human persona) should reply to a normal chat message:
 *   - DM (threadID === senderID)  -> always reply
   - group message                -> reply if intent is new / not recently handled
   - cmd (prefix)                -> never reply with AI (handled by command router)
 *
 * Loop prevention: a per-thread "recent intent" set with TTL. If the same
 * intent (greeting, question, etc.) was already answered recently, ignore
 * the new one — so 3 users saying "hi" only gets ONE reply.
 *
 * State lives in Firebase under shipu-messsenger-bot/ai-state/{threadID}.
 */

function baseUrl(): string {
  return (firebaseConfig.databaseURL || '').replace(/\/+$/, '');
}

function nodeUrl(p: string): string {
  return `${baseUrl()}/${FIREBASE_BOT_ROOT}/ai-state/${p}.json`;
}

async function fbReq(url: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) throw new Error(`RTDB ${res.status}: ${text.slice(0, 120)}`);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  } finally {
    clearTimeout(t);
  }
}

const INTENT_TTL_MS = 5 * 60 * 1000; // same intent ignored for 5 min
const IDLE_ENGAGE_MS = 30 * 60 * 1000; // 30 min no-msg -> Shipu initiates
const MIN_REPLY_GAP_MS = 8 * 1000; // never reply twice within 8s in same thread

export interface ThreadAiState {
  lastReplyAt: number;
  lastIntent: string;
  lastIntentAt: number;
  recentIntents: Record<string, number>; // intent -> timestamp
  lastMessageAt: number;
  lastMessageBy: string;
  msgCountSinceReply: number;
  idleTimerSet: boolean;
  pendingIdleMessage?: string;
}

const DEFAULT_STATE: ThreadAiState = {
  lastReplyAt: 0,
  lastIntent: '',
  lastIntentAt: 0,
  recentIntents: {},
  lastMessageAt: 0,
  lastMessageBy: '',
  msgCountSinceReply: 0,
  idleTimerSet: false,
  pendingIdleMessage: null
};

function classifyIntent(text: string): string {
  const t = String(text || '').toLowerCase().trim();
  if (!t) return 'empty';
  if (/^(hi|hello|hey|hola|hlw|hlw?|assalam|salam|namaste|good (morning|evening|night)|gm|gn)\b/.test(t)) return 'greeting';
  if (/\?$/.test(t) || /^(ki|kya|what|how|why|when|where|who|kivabe|kemne|keno)\b/.test(t)) return 'question';
  if (/(lol|haha|😂|🤣|lmao|rofl)/i.test(t)) return 'laugh';
  if (/(sad|dukkho|cry|😭|😢|miss|alone)/i.test(t)) return 'sad';
  if (/(angry|rag|mad|gussa|😡|😠|hate)/i.test(t)) return 'angry';
  if (/(love|valobasha|❤️|😘|😍)/i.test(t)) return 'love';
  if (t.length < 6) return 'short';
  return 'chat';
}

export class AiAutoReplyEngine {
  private static instance: AiAutoReplyEngine;
  private cache = new Map<string, ThreadAiState>();
  private idleTimers = new Map<string, NodeJS.Timeout>();

  private constructor() {}
  public static getInstance(): AiAutoReplyEngine {
    if (!AiAutoReplyEngine.instance) AiAutoReplyEngine.instance = new AiAutoReplyEngine();
    return AiAutoReplyEngine.instance;
  }

  private async getState(threadID: string): Promise<ThreadAiState> {
    const cached = this.cache.get(threadID);
    if (cached) return cached;
    try {
      const remote = await fbReq(nodeUrl(encodeURIComponent(threadID)), { method: 'GET' });
      const st = remote && typeof remote === 'object' ? { ...DEFAULT_STATE, ...remote } : { ...DEFAULT_STATE };
      this.cache.set(threadID, st);
      return st;
    } catch {
      const st = { ...DEFAULT_STATE };
      this.cache.set(threadID, st);
      return st;
    }
  }

  private async saveState(threadID: string, st: ThreadAiState): Promise<void> {
    this.cache.set(threadID, st);
    try {
      await fbReq(nodeUrl(encodeURIComponent(threadID)), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(st)
      });
    } catch {}
  }

  /**
   * Decide whether Shipu should reply. Returns:
   *   { reply: true, reason, intent }  -> generate + send reply
   *   { reply: false, reason }         -> skip
   */
  public async shouldReply(params: {
    threadID: string;
    senderID: string;
    text: string;
    isDM: boolean;
    isCommand: boolean;
    isSelf: boolean;
  }): Promise<{ reply: boolean; reason: string; intent: string }> {
    const { threadID, senderID, text, isDM, isCommand, isSelf } = params;

    if (isSelf) return { reply: false, reason: 'self-message', intent: '' };
    if (isCommand) return { reply: false, reason: 'command-priority', intent: '' };
    if (!text || !text.trim()) return { reply: false, reason: 'empty', intent: '' };

    const intent = classifyIntent(text);
    const now = Date.now();
    const st = await this.getState(threadID);

    // DM: always reply (but respect min gap to avoid spam).
    if (isDM) {
      if (now - st.lastReplyAt < MIN_REPLY_GAP_MS) {
        return { reply: false, reason: 'dm-min-gap', intent };
      }
      return { reply: true, reason: 'dm', intent };
    }

    // Group: dedup same intent within TTL.
    const lastSameIntent = st.recentIntents[intent] || 0;
    if (lastSameIntent && (now - lastSameIntent) < INTENT_TTL_MS) {
      // Same intent answered recently -> ignore (loop prevention).
      st.msgCountSinceReply++;
      await this.saveState(threadID, st);
      return { reply: false, reason: `intent-dedup:${intent}`, intent };
    }

    // Min gap between any two replies in the same thread.
    if (now - st.lastReplyAt < MIN_REPLY_GAP_MS) {
      st.msgCountSinceReply++;
      await this.saveState(threadID, st);
      return { reply: false, reason: 'min-gap', intent };
    }

    // Decide probability: not every message gets a reply (human-like).
    // Greetings/questions -> high chance; short/laugh -> low; chat -> medium.
    let prob = 0.55;
    if (intent === 'greeting') prob = 0.85;
    else if (intent === 'question') prob = 0.95;
    else if (intent === 'short') prob = 0.25;
    else if (intent === 'laugh') prob = 0.35;
    else if (intent === 'sad' || intent === 'angry' || intent === 'love') prob = 0.9;
    // If nobody replied for a while, be more present.
    if (now - st.lastReplyAt > 10 * 60 * 1000) prob = Math.min(1, prob + 0.2);

    if (Math.random() > prob) {
      st.msgCountSinceReply++;
      await this.saveState(threadID, st);
      return { reply: false, reason: `prob-skip:${intent}`, intent };
    }

    return { reply: true, reason: `intent:${intent}`, intent };
  }

  /**
   * Record that Shipu replied (update state + reset idle timer).
   */
  public async recordReply(threadID: string, intent: string, senderID: string): Promise<void> {
    const now = Date.now();
    const st = await this.getState(threadID);
    st.lastReplyAt = now;
    st.lastIntent = intent;
    st.lastIntentAt = now;
    st.recentIntents[intent] = now;
    // prune old intents
    for (const k of Object.keys(st.recentIntents)) {
      if (now - st.recentIntents[k] > INTENT_TTL_MS * 2) delete st.recentIntents[k];
    }
    st.lastMessageAt = now;
    st.lastMessageBy = senderID;
    st.msgCountSinceReply = 0;
    await this.saveState(threadID, st);
    this.resetIdleTimer(threadID);
  }

  /**
   * Record any incoming message (for idle-engagement tracking).
   */
  public async recordMessage(threadID: string, senderID: string): Promise<void> {
    const st = await this.getState(threadID);
    st.lastMessageAt = Date.now();
    st.lastMessageBy = senderID;
    st.msgCountSinceReply++;
    await this.saveState(threadID, st);
    this.resetIdleTimer(threadID);
  }

  private resetIdleTimer(threadID: string): void {
    const existing = this.idleTimers.get(threadID);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(async () => {
      try {
        await this.idleEngage(threadID);
      } catch {}
    }, IDLE_ENGAGE_MS);
    if (typeof (timer as any)?.unref === 'function') (timer as any).unref();
    this.idleTimers.set(threadID, timer);
  }

  /**
   * Idle engagement: 30 min no message -> Shipu initiates a natural message.
   */
  private async idleEngage(threadID: string): Promise<void> {
    const st = await this.getState(threadID);
    const now = Date.now();
    if (now - st.lastMessageAt < IDLE_ENGAGE_MS - 1000) return; // someone spoke
    if (now - st.lastReplyAt < IDLE_ENGAGE_MS - 1000) return; // Shipu spoke recently

    // Don't engage in DMs? Actually DMs always reply already; idle engage only groups.
    if (threadID === st.lastMessageBy) return; // single-user DM, skip auto

    const prompt = 'The group has been quiet for 30 minutes. As a real human member of this group, send ONE short, natural, casual message to re-engage people (in Bengali/Banglish/English mix). Do not mention you are an AI. Do not repeat greetings you used before. Be varied.';

    try {
      const cfg = await aiConfigManager.getConfig();
      const text = await openRouterService.generateChatCompletion(
        [{ role: 'user', content: prompt }],
        undefined,
        'You are Shipu, a real human in a Messenger group. Reply with only the message text, no quotes, no prefix.'
      );
      if (text && text.trim()) {
        // Caller (botEngine) is responsible for actually sending; store pending.
        st.pendingIdleMessage = text.trim();
        await this.saveState(threadID, st);
      }
    } catch {}
  }

  /** Consume a pending idle message (if any) so botEngine can send it. */
  public async consumePendingIdle(threadID: string): Promise<string | null> {
    const st = await this.getState(threadID);
    const msg = (st as any).pendingIdleMessage || null;
    if (msg) {
      (st as any).pendingIdleMessage = null;
      await this.saveState(threadID, st);
    }
    return msg;
  }
}

export const aiAutoReplyEngine = AiAutoReplyEngine.getInstance();
