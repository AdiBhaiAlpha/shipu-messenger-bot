import { firebaseConfig, FIREBASE_BOT_ROOT } from '../config/firebase';
import { aiConfigManager } from './aiConfigManager';
import { behaviourObserver } from './behaviourObserver';
import { openRouterService } from './openRouterService';
import { AIOSMemoryModel } from '../db/firebaseDb';

/**
 * Emotion State Machine + Self-Correction + Proactive Outreach +
 * Knowledge Ingestion + Multi-lang + Personality Evolution + Conflict Resolution.
 *
 * All free-model only. State persists in Firebase under
 *   shipu-messsenger-bot/emotion/{userID}
 *   shipu-messsenger-bot/style/{userID}
 *   shipu-messsenger-bot/feedback/{entryId}
 */

function baseUrl(): string {
  return (firebaseConfig.databaseURL || '').replace(/\/+$/, '');
}
function nodeUrl(p: string): string {
  return `${baseUrl()}/${FIREBASE_BOT_ROOT}/${p}.json`;
}
async function fbReq(url: string, init?: RequestInit): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    const text = await res.text();
    if (!res.ok) return null;
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  } catch { return null; }
  finally { clearTimeout(t); }
}

// ---------- 1. Emotion state machine ----------

export type Mood = 'happy' | 'sad' | 'angry' | 'excited' | 'neutral' | 'tired';

const MOOD_KEYWORDS: Record<Mood, RegExp> = {
  happy: /(happy|khushi|joy|😊|😄|🎉|love|valobasha|❤️)/i,
  sad: /(sad|dukkho|cry|😭|😢|miss|alone|depressed|vul)/i,
  angry: /(angry|rag|mad|gussa|😡|😠|hate|kharap|worst)/i,
  excited: /(excited|wow|omg|🔥|🚀|amazing|awesome)/i,
  tired: /(tired|thaka|sleepy|😴|exhausted|bore)/i,
  neutral: /.*/
};

export function detectMood(text: string): Mood {
  for (const m of ['angry', 'sad', 'excited', 'happy', 'tired'] as Mood[]) {
    if (MOOD_KEYWORDS[m].test(text)) return m;
  }
  return 'neutral';
}

export async function getUserMood(userID: string): Promise<Mood> {
  try {
    const r = await fbReq(nodeUrl(`emotion/${encodeURIComponent(userID)}`), { method: 'GET' });
    return (r && r.mood) || 'neutral';
  } catch { return 'neutral'; }
}

export async function updateUserMood(userID: string, text: string): Promise<Mood> {
  const detected = detectMood(text);
  const prev = await getUserMood(userID);
  // smooth: new mood overrides only if detected != neutral, else keep
  const next = detected !== 'neutral' ? detected : prev;
  try {
    await fbReq(nodeUrl(`emotion/${encodeURIComponent(userID)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mood: next, lastText: text.slice(0, 200), updatedAt: Date.now() })
    });
  } catch {}
  // persist into AIOSMemory too
  try {
    let mem: any = await (AIOSMemoryModel as any).findOne({ userID });
    if (mem) { mem.mood = next; await mem.save(); }
  } catch {}
  return next;
}

export function moodToneHint(mood: Mood): string {
  switch (mood) {
    case 'sad': return 'The user seems sad — be warm, gentle, supportive, like a caring friend.';
    case 'angry': return 'The user seems angry — stay calm, de-escalate, be understanding, do not argue.';
    case 'excited': return 'The user is excited — match their energy, be enthusiastic.';
    case 'happy': return 'The user is happy — be cheerful and playful.';
    case 'tired': return 'The user seems tired — be soft, brief, comforting.';
    default: return 'Be natural and friendly.';
  }
}

// ---------- 2. Self-correction loop ----------

export async function recordFeedback(entryId: string, positive: boolean): Promise<void> {
  try {
    const url = nodeUrl(`feedback/${encodeURIComponent(entryId)}`);
    const existing = await fbReq(url, { method: 'GET' });
    const score = (existing?.score || 0) + (positive ? 1 : -1);
    const count = (existing?.count || 0) + 1;
    await fbReq(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ score, count, updatedAt: Date.now() })
    });
  } catch {}
}

export async function getFeedbackScore(entryId: string): Promise<number> {
  try {
    const r = await fbReq(nodeUrl(`feedback/${encodeURIComponent(entryId)}`), { method: 'GET' });
    return r?.score || 0;
  } catch { return 0; }
}

// ---------- 3. Proactive outreach (idle user DM) ----------

export async function proactiveOutreach(
  sendFn: (threadID: string, text: string) => Promise<void>
): Promise<number> {
  let sent = 0;
  try {
    // Find users whose last message was > 2 hours ago and mood is sad/tired.
    const mems = await (AIOSMemoryModel as any).find({}) || [];
    const arr = Array.isArray(mems) ? mems : [];
    const now = Date.now();
    for (const m of arr) {
      if (!m || !m.userID) continue;
      const last = m.updatedAt ? new Date(m.updatedAt).getTime() : 0;
      if (!last || now - last < 2 * 60 * 60 * 1000) continue;
      const mood = m.mood || 'neutral';
      if (mood !== 'sad' && mood !== 'tired') continue;
      const prompt = mood === 'sad'
        ? 'A friend has been quiet for a while and seemed sad last time. Send ONE short, warm, caring DM message (Bengali/Banglish) checking on them. No AI mention.'
        : 'A friend has been quiet and seemed tired. Send ONE short, gentle check-in DM (Bengali/Banglish). No AI mention.';
      const text = await openRouterService.generateChatCompletion(
        [{ role: 'user', content: prompt }],
        undefined,
        'You are Shipu, a real human friend. Output only the message text.'
      );
      if (text && text.trim()) {
        await sendFn(m.userID, text.trim());
        sent++;
      }
    }
  } catch (err) {
    console.warn('[ProactiveOutreach] failed:', (err as any)?.message || err);
  }
  return sent;
}

// ---------- 4. Knowledge ingestion from web ----------

export async function ingestFromUrl(url: string): Promise<{ ingested: number }> {
  let ingested = 0;
  try {
    const r = await fetch(url);
    const html = await r.text();
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .slice(0, 6000);
    const prompt = `Summarize the following web page into 3-6 short knowledge facts Shipu (a human) should know. Return ONLY JSON array: [{"trigger":"...","reply":"...","category":"web"}]. Content:\n${text}`;
    const raw = await openRouterService.generateChatCompletion(
      [{ role: 'user', content: prompt }],
      undefined,
      'Output only valid JSON array.'
    );
    let facts: any[] = [];
    try { const m = raw.match(/\[[\s\S]*\]/); facts = m ? JSON.parse(m[0]) : []; if (!Array.isArray(facts)) facts = []; } catch { facts = []; }
    const { brainService } = await import('./brainService');
    for (const f of facts) {
      if (!f.trigger || !f.reply) continue;
      try {
        const { BrainMemoryModel } = await import('../db/firebaseDb');
        await (BrainMemoryModel as any).create({
          trigger: String(f.trigger).slice(0, 200),
          reply: String(f.reply).slice(0, 500),
          category: String(f.category || 'web'),
          variations: [],
          replyVariations: [],
          createdBy: 'WebIngestion',
          enabled: true
        });
        ingested++;
      } catch {}
    }
  } catch (err) {
    console.warn('[WebIngest] failed:', (err as any)?.message || err);
  }
  return { ingested };
}

// ---------- 5. Multi-language auto-detect ----------

export type Lang = 'bn' | 'bn-lat' | 'en';

export function detectLanguage(text: string): Lang {
  const t = String(text || '');
  const bnChars = (t.match(/[\u0980-\u09FF]/g) || []).length;
  const total = t.replace(/\s/g, '').length || 1;
  if (bnChars / total > 0.3) return 'bn';
  // Banglish heuristic: common bengali words in latin
  if (/\b(ami|tumi|koro|ki|na|ha|bhai|apni|amar|tomar|kichu|valo)\b/i.test(t)) return 'bn-lat';
  return 'en';
}

export async function getUserLang(userID: string): Promise<Lang> {
  try {
    const r = await fbReq(nodeUrl(`lang/${encodeURIComponent(userID)}`), { method: 'GET' });
    return (r && r.lang) || 'bn-lat';
  } catch { return 'bn-lat'; }
}

export async function updateUserLang(userID: string, text: string): Promise<Lang> {
  const lang = detectLanguage(text);
  try {
    await fbReq(nodeUrl(`lang/${encodeURIComponent(userID)}`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang, updatedAt: Date.now() })
    });
  } catch {}
  try {
    let mem: any = await (AIOSMemoryModel as any).findOne({ userID });
    if (mem) { mem.language = lang; await mem.save(); }
  } catch {}
  return lang;
}

export function langInstruction(lang: Lang): string {
  switch (lang) {
    case 'bn': return 'Reply in Bengali (Bangla script).';
    case 'bn-lat': return 'Reply in Banglish (Bengali words written in Latin script), natural chat style.';
    case 'en': return 'Reply in English.';
  }
}

// ---------- 6. Personality evolution ----------

export async function evolvePersonality(userID: string): Promise<string> {
  try {
    let mem: any = await (AIOSMemoryModel as any).findOne({ userID });
    if (!mem) return 'default';
    const mood = mem.mood || 'neutral';
    const current = mem.personality || 'default';
    // Drift: if consistently sad -> 'caring'; angry -> 'calm'; happy -> 'playful'
    let next = current;
    if (mood === 'sad') next = 'caring';
    else if (mood === 'angry') next = 'calm';
    else if (mood === 'happy' || mood === 'excited') next = 'playful';
    else if (mood === 'tired') next = 'soft';
    if (next !== current) {
      mem.personality = next;
      await mem.save();
    }
    return next;
  } catch { return 'default'; }
}

// ---------- 7. Conflict resolution between users ----------

export async function mediateConflict(userA: string, userB: string, topic: string, context: string): Promise<string> {
  try {
    const prompt = `Two group members are in a disagreement.\nUser A (${userA}) vs User B (${userB}) about: "${topic}".\nRecent context: ${context.slice(0, 1500)}\nAs Shipu (a real human member of this group), mediate calmly: acknowledge both sides, de-escalate, suggest a fair resolution, keep it short and natural. Do not take sides. Reply in the group's language.`;
    const out = await openRouterService.generateChatCompletion(
      [{ role: 'user', content: prompt }],
      undefined,
      'You are Shipu, a real human mediator in a Messenger group. Reply naturally, concisely.'
    );
    return (out && out.trim()) ? out.trim() : 'Ei toh bhai, shobai shantite thako, ektu relax koro. 😊';
  } catch {
    return 'Ei toh bhai, shobai shantite thako, ektu relax koro. 😊';
  }
}

// ---------- Integration: called from botEngine for every message ----------

export async function onMessageEnrich(userID: string, threadID: string, text: string, isDM: boolean): Promise<{
  mood: Mood;
  lang: Lang;
  personality: string;
  styleHint: string;
}> {
  const mood = await updateUserMood(userID, text);
  const lang = await updateUserLang(userID, text);
  const personality = await evolvePersonality(userID);
  const styleHint = await behaviourObserver.getStyleHint(threadID);
  return { mood, lang, personality, styleHint };
}

export const emotionEngine = {
  detectMood,
  getUserMood,
  updateUserMood,
  moodToneHint,
  recordFeedback,
  getFeedbackScore,
  proactiveOutreach,
  ingestFromUrl,
  detectLanguage,
  getUserLang,
  updateUserLang,
  langInstruction,
  evolvePersonality,
  mediateConflict,
  onMessageEnrich
};
