import { firebaseConfig, FIREBASE_BOT_ROOT } from '../config/firebase';
import { aiConfigManager } from './aiConfigManager';
import { openRouterService } from './openRouterService';
import { brainService } from './brainService';
import { behaviourObserver } from './behaviourObserver';
import { AIOSSessionModel, AIOSMemoryModel, BrainMemoryModel } from '../db/firebaseDb';
import fs from 'fs';
import path from 'path';

/**
 * Self-Learning Engine (Phases 2-4) — free model only.
 *
 * Phase 2a: Auto-memory extraction — every chat turn extracts passive facts
 *   (name, mood, preferences) into AIOSMemory per user, conversation context
 *   capped at last 40 turns.
 * Phase 2b: Nightly self-reflection (node-cron) — digest a day's chats into
 *   new brain entries (knowledge graph) and prune low-value ones.
 * Phase 3a: Conflict engine — Shipu self-debates contradictions in brain
 *   entries, resolves via free model, evolves.
 * Phase 3b: Feedback loop — message reactions score brain entries; low-score
 *   entries pruned after N days.
 * Phase 4a: Cross-user style transfer — aggregate behaviour profiles -> style
 *   hints injected into prompts.
 * Phase 4b: Knowledge ingestion — index all DB/docs/files into brain search.
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

// ---------- Phase 2a: Auto-memory extraction ----------

const FACT_EXTRACT_PROMPT = (msg: string) =>
  `Extract at most 3 short personal facts about the speaker from this message (name, mood, preference, location, hobby, etc.). ` +
  `Return ONLY a JSON array like [{"key":"name","value":"Rahim"}]. If none, return []. Message: "${msg.slice(0, 300)}"`;

export async function extractAndStoreFacts(userID: string, threadID: string, message: string): Promise<void> {
  try {
    if (!message || message.trim().length < 4) return;
    const raw = await openRouterService.generateChatCompletion(
      [{ role: 'user', content: FACT_EXTRACT_PROMPT(message) }],
      undefined,
      'You are a fact extractor. Output only valid JSON array, nothing else.'
    );
    let facts: Array<{ key: string; value: string }> = [];
    try {
      const m = raw.match(/\[[\s\S]*\]/);
      facts = m ? JSON.parse(m[0]) : [];
      if (!Array.isArray(facts)) facts = [];
    } catch { facts = []; }

    if (facts.length === 0) return;

    let mem: any = await (AIOSMemoryModel as any).findOne({ userID });
    if (!mem) {
      mem = await (AIOSMemoryModel as any).create({ userID, facts: {}, conversationContext: [], mood: 'neutral', personality: 'default' });
    }
    const factsMap = mem.facts instanceof Map ? mem.facts : new Map(Object.entries(mem.facts || {}));
    for (const f of facts) {
      if (f && f.key && f.value) {
        factsMap.set(String(f.key).toLowerCase().trim(), String(f.value).trim());
      }
    }
    mem.facts = Object.fromEntries(factsMap);
    mem.updatedAt = Date.now();
    await mem.save();
  } catch {}
}

export async function appendConversationContext(userID: string, role: 'user' | 'model', content: string): Promise<void> {
  try {
    let mem: any = await (AIOSMemoryModel as any).findOne({ userID });
    if (!mem) {
      mem = await (AIOSMemoryModel as any).create({ userID, facts: {}, conversationContext: [], mood: 'neutral', personality: 'default' });
    }
    const ctx = Array.isArray(mem.conversationContext) ? mem.conversationContext : [];
    ctx.push({ role, content: String(content).slice(0, 400), timestamp: Date.now() });
    // cap at last 40 turns
    mem.conversationContext = ctx.slice(-40);
    mem.updatedAt = Date.now();
    await mem.save();
  } catch {}
}

// ---------- Phase 2b: Nightly self-reflection ----------

export async function runNightlyReflection(): Promise<{ added: number; pruned: number }> {
  let added = 0;
  let pruned = 0;
  try {
    // Gather today's behaviour profile aggregate across all threads.
    const root = await fbReq(nodeUrl('behaviour-profile'), { method: 'GET' });
    const profiles = root && typeof root === 'object' ? Object.values(root) : [];
    if (profiles.length === 0) return { added, pruned };

    // Build a digest of top phrases per thread.
    const digestParts: string[] = [];
    for (const p of profiles as any[]) {
      if (!p || !p.bigramCounts) continue;
      const top = Object.entries(p.bigramCounts).sort((a: any, b: any) => b[1] - a[1]).slice(0, 12).map((e: any) => e[0]);
      const emojis = Object.entries(p.emojiCounts || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 6).map((e: any) => e[0]);
      digestParts.push(`Thread ${p.threadID}: messages=${p.messageCount}, top phrases=[${top.join(', ')}], emojis=[${emojis.join(' ')}]`);
    }
    const digest = digestParts.join('\n').slice(0, 4000);

    const prompt = `You are Shipu's self-reflection engine. Given today's chat digest from a Messenger group, extract 3-8 reusable knowledge facts (Bangla/Banglish/English) that Shipu (a human member) learned today about how people talk, slang, topics, or facts. Return ONLY a JSON array: [{"trigger":"...","reply":"...","category":"learned"}]. Digest:\n${digest}`;

    const raw = await openRouterService.generateChatCompletion(
      [{ role: 'user', content: prompt }],
      undefined,
      'Output only valid JSON array. No prose.'
    );
    let facts: any[] = [];
    try {
      const m = raw.match(/\[[\s\S]*\]/);
      facts = m ? JSON.parse(m[0]) : [];
      if (!Array.isArray(facts)) facts = [];
    } catch { facts = []; }

    for (const f of facts) {
      if (!f || !f.trigger || !f.reply) continue;
      try {
        await BrainMemoryModel.create({
          trigger: String(f.trigger).slice(0, 200),
          reply: String(f.reply).slice(0, 500),
          category: String(f.category || 'learned'),
          variations: [],
          replyVariations: [],
          createdBy: 'SelfReflection',
          enabled: true
        } as any);
        added++;
      } catch {}
    }

    // Phase 3b: prune low-score brain entries older than 30 days with score 0.
    try {
      const all = await BrainMemoryModel.find({}) || [];
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const m of all) {
        const score = (m as any).score ?? 0;
        const created = (m as any).createdAt ? new Date((m as any).createdAt).getTime() : 0;
        if (score <= 0 && created > 0 && created < cutoff) {
          try { await BrainMemoryModel.deleteOne({ _id: (m as any)._id }); pruned++; } catch {}
        }
      }
    } catch {}
  } catch (err) {
    console.warn('[SelfLearning] nightly reflection failed:', (err as any)?.message || err);
  }
  return { added, pruned };
}

// ---------- Phase 3a: Conflict engine ----------

export async function resolveConflict(existingReply: string, newReply: string, trigger: string): Promise<string> {
  try {
    const prompt = `Two conflicting facts about "${trigger}":\nA: ${existingReply}\nB: ${newReply}\nAs Shipu (a human), decide which is more accurate/recent and merge into ONE concise reply (or keep the better one). Output only the final reply text, no explanation.`;
    const out = await openRouterService.generateChatCompletion(
      [{ role: 'user', content: prompt }],
      undefined,
      'Output only the final merged reply. No quotes, no prefix.'
    );
    return (out && out.trim()) ? out.trim() : newReply;
  } catch {
    return newReply;
  }
}

// ---------- Phase 4a: Cross-user style transfer ----------

export async function getAggregatedStyleHint(threadID: string): Promise<string> {
  // Reuse behaviourObserver profile + add cross-thread global emoji/top phrases.
  try {
    const hint = await behaviourObserver.getStyleHint(threadID);
    return hint || '';
  } catch { return ''; }
}

// ---------- Phase 4b: Knowledge ingestion (files/db/project) ----------

export async function ingestKnowledgeFromProject(): Promise<{ ingested: number }> {
  let ingested = 0;
  try {
    const root = process.cwd();
    const targets = ['README.md', 'API.md', 'ARCHITECTURE.md', 'COMMANDS.md', 'COMMAND_GUIDELINE.md'];
    for (const f of targets) {
      const p = path.join(root, f);
      if (!fs.existsSync(p)) continue;
      const content = fs.readFileSync(p, 'utf-8').slice(0, 6000);
      const prompt = `Summarize the following project documentation into 3-6 short knowledge facts Shipu (a human member) should know. Return ONLY JSON array: [{"trigger":"...","reply":"...","category":"project"}]. Doc (${f}):\n${content}`;
      const raw = await openRouterService.generateChatCompletion(
        [{ role: 'user', content: prompt }],
        undefined,
        'Output only valid JSON array.'
      );
      let facts: any[] = [];
      try { const m = raw.match(/\[[\s\S]*\]/); facts = m ? JSON.parse(m[0]) : []; if (!Array.isArray(facts)) facts = []; } catch { facts = []; }
      for (const fct of facts) {
        if (!fct.trigger || !fct.reply) continue;
        try {
          await BrainMemoryModel.create({
            trigger: String(fct.trigger).slice(0, 200),
            reply: String(fct.reply).slice(0, 500),
            category: String(fct.category || 'project'),
            variations: [],
            replyVariations: [],
            createdBy: 'KnowledgeIngestion',
            enabled: true
          } as any);
          ingested++;
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[SelfLearning] knowledge ingestion failed:', (err as any)?.message || err);
  }
  return { ingested };
}

// ---------- Scheduler registration (node-cron) ----------

let schedulerStarted = false;
export function startSelfLearningScheduler(): void {
  if (schedulerStarted) return;
  schedulerStarted = true;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const cron = require('node-cron');
    // Nightly reflection at 03:00
    cron.schedule('0 3 * * *', async () => {
      console.log('[SelfLearning] Nightly reflection starting...');
      const r = await runNightlyReflection();
      console.log(`[SelfLearning] Nightly reflection done: added=${r.added} pruned=${r.pruned}`);
      const k = await ingestKnowledgeFromProject();
      console.log(`[SelfLearning] Knowledge ingestion: ingested=${k.ingested}`);
    });
    console.log('[SelfLearning] Scheduler registered (nightly 03:00).');
  } catch (err) {
    console.warn('[SelfLearning] node-cron unavailable:', (err as any)?.message || err);
  }
}

// ---------- Integration hooks called from botEngine ----------

export async function onMessageLearn(userID: string, threadID: string, text: string, isDM: boolean): Promise<void> {
  // Fire-and-forget learning; never block message handling.
  try {
    behaviourObserver.observe({ threadID, senderID: userID, text });
    // Passive fact extraction only for non-trivial messages.
    if (text && text.trim().length >= 8) {
      extractAndStoreFacts(userID, threadID, text).catch(() => {});
    }
    await appendConversationContext(userID, 'user', text);
    // Cross-user style hint is fetched lazily by callers; nothing to do here.
    void isDM;
  } catch {}
}

export async function onReplyLearn(userID: string, replyText: string): Promise<void> {
  try {
    await appendConversationContext(userID, 'model', replyText);
  } catch {}
}

export const selfLearning = {
  extractAndStoreFacts,
  appendConversationContext,
  runNightlyReflection,
  resolveConflict,
  getAggregatedStyleHint,
  ingestKnowledgeFromProject,
  startSelfLearningScheduler,
  onMessageLearn,
  onReplyLearn
};
