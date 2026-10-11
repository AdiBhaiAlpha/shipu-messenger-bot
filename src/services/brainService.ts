import { isDatabaseConnected } from '../db/firebaseDb';
import { BrainMemoryModel, BrainSuggestionModel, InferredAttributeModel, UserModel } from '../db/firebaseDb';
import { GoogleGenAI, Type } from '@google/genai';

// Fuzzy Matching Helper Functions
export function getLevenshteinDistance(a: string, b: string): number {
  const tmp = [];
  let i, j, alen = a.length, blen = b.length;
  if (alen === 0) return blen;
  if (blen === 0) return alen;
  for (i = 0; i <= alen; i++) tmp[i] = [i];
  for (j = 0; j <= blen; j++) tmp[0][j] = j;
  for (i = 1; i <= alen; i++) {
    for (j = 1; j <= blen; j++) {
      tmp[i][j] = Math.min(
        tmp[i - 1][j] + 1,
        tmp[i][j - 1] + 1,
        tmp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return tmp[alen][blen];
}

export function getTokenSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/));
  const wordsB = new Set(b.split(/\s+/));
  const intersection = new Set([...wordsA].filter(x => wordsB.has(x)));
  const union = new Set([...wordsA, ...wordsB]);
  if (union.size === 0) return 0;
  return intersection.size / union.size;
}

export function stripEmojiFormatters(str: string): string {
  if (!str) return '';
  return str.normalize('NFC').replace(/[\uFE00-\uFE0F\u200B-\u200D\u200E\u200F]/g, '');
}

export function collapseRepeatingChars(str: string): string {
  if (!str) return '';
  const points = Array.from(str);
  const result: string[] = [];
  let count = 0;
  let last = '';
  for (const char of points) {
    if (char === last) {
      count++;
      if (count <= 2) result.push(char);
    } else {
      last = char;
      count = 1;
      result.push(char);
    }
  }
  return result.join('');
}

export function isEmojiOnly(text: string): boolean {
  if (!text) return false;
  const clean = stripEmojiFormatters(text.trim());
  const withoutEmoji = clean.replace(/[\p{Emoji}\p{Extended_Pictographic}\p{So}\s]/gu, '');
  return clean.length > 0 && withoutEmoji.length === 0;
}

export function containsEmoji(text: string): boolean {
  if (!text) return false;
  return /[\p{Emoji}\p{Extended_Pictographic}\p{So}]/u.test(text);
}

export function cleanForMatching(text: string): string {
  if (!text) return '';
  let norm = stripEmojiFormatters(text).toLowerCase();
  norm = collapseRepeatingChars(norm); // collapse repeating characters safely for unicode surrogates
  norm = norm.replace(/[?.,!:'"\-_()\[\]{}]/gu, ''); // strip punctuation
  norm = norm.replace(/[^\p{L}\p{M}\p{N}\p{Emoji}\p{Extended_Pictographic}\p{So}\s]/gu, ' ').replace(/\s+/g, ' ').trim(); // keep letters, numbers, marks, emojis, and symbols
  return norm;
}

export class BrainService {
  private static instance: BrainService;
  private memoryCache: any[] = [];
  private missedQueriesCache = new Map<string, { trigger: string; count: number; countMap: Map<string, number> }>();

  private constructor() {
    this.loadMemoriesToCache();
  }

  public static getInstance(): BrainService {
    if (!BrainService.instance) {
      BrainService.instance = new BrainService();
    }
    return BrainService.instance;
  }

  public async loadMemoriesToCache() {
    try {
      if (!isDatabaseConnected()) {
        console.warn('[BrainService] Database not connected, using empty cache for now.');
        this.memoryCache = [];
        return;
      }
      const memories = await BrainMemoryModel.find({ enabled: true }).lean();
      
      // Auto-clean any legacy triggers in MongoDB containing Variation Selector-16 (\uFE0F) or formatters
      for (const m of memories || []) {
        const cleanT = stripEmojiFormatters(m.trigger || '');
        const cleanVars = (m.variations || []).map((v: string) => stripEmojiFormatters(v || ''));
        const cleanNorm = (m.aiNormalizedTrigger || []).map((v: string) => stripEmojiFormatters(v || ''));

        const needsFix = cleanT !== m.trigger ||
          cleanVars.some((v: string, idx: number) => v !== m.variations?.[idx]) ||
          cleanNorm.some((v: string, idx: number) => v !== m.aiNormalizedTrigger?.[idx]);

        if (needsFix) {
          BrainMemoryModel.updateOne(
            { _id: m._id },
            { $set: { trigger: cleanT, variations: cleanVars, aiNormalizedTrigger: cleanNorm } }
          ).catch((err: any) => console.error('[BrainService] Auto-clean error:', err.message));
        }
      }

      this.memoryCache = (memories || []).map((m: any) => ({
        ...m,
        trigger: stripEmojiFormatters(m.trigger || ''),
        variations: (m.variations || []).map((v: string) => stripEmojiFormatters(v || '')),
        aiNormalizedTrigger: (m.aiNormalizedTrigger || []).map((v: string) => stripEmojiFormatters(v || ''))
      }));
      console.log(`[BrainService] Loaded ${this.memoryCache.length} active brain memories into cache.`);
    } catch (err: any) {
      console.error('[BrainService] Error loading memories to cache:', err.message);
      this.memoryCache = []; // Fallback to empty cache on error
    }
  }

  public getCache() {
    return this.memoryCache;
  }

  /**
   * Find matching memory using Fuzzy Match algorithms
   */
  public findMatch(inputText: string): { memory: any; score: number } | null {
    if (!inputText || typeof inputText !== 'string') return null;

    const rawNormalized = stripEmojiFormatters(inputText.trim().normalize('NFC').toLowerCase());
    if (!rawNormalized) return null;
    const rawNoSpace = rawNormalized.replace(/\s+/g, '');

    // 1. Direct exact match check on raw normalized input (handling variation selectors and whitespace)
    for (const mem of this.memoryCache) {
      if (mem.enabled === false) continue;
      const allRawTriggers = [
        mem.trigger,
        ...(mem.variations || []),
        ...(mem.aiNormalizedTrigger || [])
      ].map(c => stripEmojiFormatters((c || '').trim().normalize('NFC').toLowerCase())).filter(Boolean);

      if (allRawTriggers.includes(rawNormalized)) {
        return { memory: mem, score: 1.0 };
      }

      // Check without spaces for multi-emoji or whitespace variations (e.g. "🙂 💔" vs "🙂💔")
      if (containsEmoji(rawNormalized)) {
        const noSpaceTriggers = allRawTriggers.map(t => t.replace(/\s+/g, ''));
        if (noSpaceTriggers.includes(rawNoSpace)) {
          return { memory: mem, score: 1.0 };
        }
      }
    }

    // 2. Fuzzy match on cleaned input
    const cleanedInput = cleanForMatching(inputText);
    if (!cleanedInput) return null;
    const cleanedNoSpace = cleanedInput.replace(/\s+/g, '');

    let bestMatch: any = null;
    let maxScore = 0;

    for (const mem of this.memoryCache) {
      if (mem.enabled === false) continue;
      const candidates = [
        mem.trigger,
        ...(mem.variations || []),
        ...(mem.aiNormalizedTrigger || [])
      ].map(c => cleanForMatching(c || '')).filter(Boolean);

      for (const cand of candidates) {
        let score = 0;
        const candNoSpace = cand.replace(/\s+/g, '');

        if (cand === cleanedInput || (candNoSpace && candNoSpace === cleanedNoSpace)) {
          score = 1.0;
        } else {
          // Substring matching
          if (cleanedInput.includes(cand) || cand.includes(cleanedInput) || (candNoSpace && (cleanedNoSpace.includes(candNoSpace) || candNoSpace.includes(cleanedNoSpace)))) {
            const overlap = Math.min(cand.length, cleanedInput.length) / Math.max(cand.length, cleanedInput.length);
            score = Math.max(score, overlap * 0.85);
          }
          
          // Levenshtein similarity
          const dist = getLevenshteinDistance(cleanedInput, cand);
          const maxLen = Math.max(cleanedInput.length, cand.length);
          const levScore = maxLen > 0 ? 1 - dist / maxLen : 0;
          score = Math.max(score, levScore);

          // Token matching
          const tokenSim = getTokenSimilarity(cleanedInput, cand);
          score = Math.max(score, tokenSim);
        }

        if (score > maxScore) {
          maxScore = score;
          bestMatch = mem;
        }
      }
    }

    // Match threshold
    if (maxScore >= 0.70 && bestMatch) {
      return { memory: bestMatch, score: maxScore };
    }

    return null;
  }

  /**
   * AI normalization with fallback - generates 10-30 high-quality trigger variants
   */
  public async aiNormalize(trigger: string, reply: string): Promise<{
    variations: string[];
    aiNormalizedTrigger: string[];
    replyVariations: string[];
  }> {
    const fallbackVariations = this.generateFallbackVariations(trigger);
    const fallbackReplyVariations = [reply];

    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
      if (!apiKey) {
        return {
          variations: fallbackVariations,
          aiNormalizedTrigger: fallbackVariations,
          replyVariations: fallbackReplyVariations
        };
      }

      const prompt = `You are an expert NLP Engineer specializing in South Asian languages and Messenger chat patterns.
Your goal is to normalize the input trigger first, then generate a rich list of 10 to 30 high-quality, realistic trigger variations that real Messenger users actually type.

Input Trigger: "${trigger}"
Input Reply: "${reply}"

AI NORMALIZATION PROTOCOL:
Before generating variants, first normalize the text by:
1. Fixing spelling in Bengali and English.
2. Fixing Banglish.
3. Correcting Bengali typing mistakes and English typing mistakes.
4. Removing duplicate punctuation.
5. Trimming spaces.
6. Converting Unicode to normalized form.

VARIANT GENERATION RULES:
For the normalized trigger, generate 10 to 30 realistic variations including:
- Correct Bengali
- Correct English
- Banglish (Bengali phrases spelled with English letters)
- Common spelling mistakes
- Typing mistakes (swapped keys, missing letters, extra letters)
- Missing letters (e.g., kmon -> kmn, tomar -> tmr)
- Extra letters for elongation (e.g., kii, kee, keee)
- Messenger slang (e.g., tmr, kmn, hlw, bby, hbd, tc)
- Phonetic spellings
- Mixed Bangla + English (e.g., "তোমার creator কে")
- Upper/lower case variations (e.g., lowercase, sentence case)
- Punctuation variations (with and without "?", "!", etc.)
- Emoji-free normalized forms
- Unicode normalized forms

CRITICAL: Do NOT simply remove spaces or concatenate words blindly. The AI must intelligently generate realistic variations that real Messenger users actually type.
Ensure a minimum of 10 variants, and try to get 20 to 30 when possible. Every variant in the list MUST be unique.

EXAMPLES FOR GUIDANCE:

Example 1:
Original: "tomar creator ke?"
Generated Variations:
- tomar creator ke
- tomar creator ke?
- tomar creator k
- tmr creator ke
- tmr creator k
- tomar creator kto
- tomar creatr ke
- tomar createor ke
- creator ke
- who is your creator
- who made you
- who created you
- তোমার creator কে
- তোমার ক্রিয়েটর কে
- তোমার নির্মাতা কে
- তোমাকে কে বানিয়েছে
- কে বানিয়েছে তোমাকে
- কে তোমার creator

Example 2:
Original: "tomar nam ki?"
Generated Variations:
- tomar nam ki
- tmr nam ki
- tmr nam
- tomar naam ki
- tomar nam ki?
- what is your name
- who are you
- ur name
- your name
- নাম কি
- তোমার নাম কি
- তোর নাম কি
- আপনার নাম কি
- তোমার নাম
- তোমার নামটা কি

Response Requirements:
Return a JSON object containing two keys: "variations" (an array of generated trigger variants) and "replyVariations" (an array of reply variations).`;

      const { aiProviderManager } = await import('../ai/providers/providerManager');
      const provider = aiProviderManager.getActiveProvider();
      const response = await provider.generateText([{ role: 'user', parts: [{ text: prompt }] }], {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            variations: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING
              },
              description: "An array of 10 to 30 unique, realistic trigger variants reflecting correct Bengali, correct English, Banglish, common spelling mistakes, typing mistakes, Messenger slang, phonetic spellings, and mixed languages."
            },
            replyVariations: {
              type: Type.ARRAY,
              items: {
                type: Type.STRING
              },
              description: "An array of natural reply variations."
            }
          },
          required: ["variations", "replyVariations"]
        }
      });

      const responseText = response.text || '';
      const cleanJson = responseText.replace(/```json|```/gi, '').trim();
      const parsed = JSON.parse(cleanJson);
      
      const uniqueVars = Array.from(new Set([
        stripEmojiFormatters(trigger.toLowerCase().trim()),
        ...(parsed.variations || []).map((v: string) => stripEmojiFormatters(v.toLowerCase().trim()))
      ])).filter(Boolean);

      const uniqueReplies = Array.from(new Set([
        reply.trim(),
        ...(parsed.replyVariations || []).map((r: string) => r.trim())
      ])).filter(Boolean);

      return {
        variations: uniqueVars,
        aiNormalizedTrigger: uniqueVars,
        replyVariations: uniqueReplies
      };
    } catch (err: any) {
      console.warn('[BrainService] AI Normalizer fallback triggered:', err.message);
      return {
        variations: fallbackVariations,
        aiNormalizedTrigger: fallbackVariations,
        replyVariations: fallbackReplyVariations
      };
    }
  }

  private generateFallbackVariations(text: string): string[] {
    const clean = stripEmojiFormatters(text.toLowerCase().trim());
    const vars = new Set<string>([clean]);

    // Handle emoji triggers specifically
    if (containsEmoji(clean)) {
      const strippedSpace = clean.replace(/\s+/g, '');
      vars.add(strippedSpace);

      const emojiChars = Array.from(clean).filter(c => c.trim());
      if (emojiChars.length > 1) {
        vars.add(emojiChars.join(' '));
        for (const ec of emojiChars) {
          vars.add(ec);
        }
      }

      vars.add(clean + clean);
      vars.add(clean + clean + clean);
      vars.add(clean + '!');
      vars.add(clean + '?');
      vars.add(' ' + clean + ' ');
      vars.add(clean + ' ❤️');
    }

    const noPunct = clean.replace(/[?.,!:'"\-_]/gu, '');
    vars.add(noPunct);
    vars.add(noPunct + '?');
    vars.add(noPunct + '!');
    vars.add(noPunct.replace(/\s+/g, ''));
    
    // Messenger-style abbreviations / phonetic replacements
    let slang = noPunct
      .replace(/\btomar\b/g, 'tmr')
      .replace(/\bkemon\b/g, 'kmn')
      .replace(/\bacho\b/g, 'aso')
      .replace(/\bki\b/g, 'k')
      .replace(/\bke\b/g, 'k')
      .replace(/\bhello\b/g, 'hlw');
    vars.add(slang);
    vars.add(slang + '?');
    
    let slang2 = noPunct
      .replace(/\btmr\b/g, 'tomar')
      .replace(/\bkmn\b/g, 'kemon')
      .replace(/\baso\b/g, 'acho')
      .replace(/\bhello\b/g, 'hy');
    vars.add(slang2);
    vars.add(slang2 + '?');

    if (clean === 'hi' || clean === 'hello') {
      vars.add('hii'); vars.add('hiii'); vars.add('helo'); vars.add('hlw'); vars.add('hy');
    }
    if (clean.includes('kemon') || clean.includes('aso') || clean.includes('acho')) {
      vars.add('kmn aso'); vars.add('kmn acho'); vars.add('kemon acho'); vars.add('kemon aso');
    }
    
    // Ensure we always have at least 10 variants if possible by adding basic mutations
    const baseList = Array.from(vars);
    for (const v of baseList) {
      if (vars.size >= 15) break;
      vars.add(v.replace(/o/g, 'u')); // simple phonetic mapping e.g. tomar -> tumar
      vars.add(v.replace(/sh/g, 's')); // e.g. asho -> aso
      vars.add(v.replace(/ch/g, 's')); // e.g. acho -> aso / aso
    }

    return Array.from(vars).filter(Boolean);
  }

  /**
   * Log missing knowledge queries and cluster them to create suggestions
   */
  public async logMissedQuery(query: string) {
    const cleaned = cleanForMatching(query);
    const charLen = Array.from(cleaned).length;
    if (!cleaned || charLen < 1 || cleaned.split(/\s+/).length > 8) return;

    let matchedKey: string | null = null;
    for (const [key] of this.missedQueriesCache.entries()) {
      const dist = getLevenshteinDistance(cleaned, key);
      const maxLen = Math.max(cleaned.length, key.length);
      const score = maxLen > 0 ? 1 - dist / maxLen : 0;
      if (score >= 0.75) {
        matchedKey = key;
        break;
      }
    }

    if (matchedKey) {
      const group = this.missedQueriesCache.get(matchedKey)!;
      group.count++;
      group.countMap.set(query, (group.countMap.get(query) || 0) + 1);
      if (group.count >= 3) {
        await this.createSuggestionFromGroup(group);
      }
    } else {
      const countMap = new Map<string, number>();
      countMap.set(query, 1);
      this.missedQueriesCache.set(cleaned, {
        trigger: query,
        count: 1,
        countMap
      });
    }
  }

  private async createSuggestionFromGroup(group: any) {
    try {
      let bestTrigger = group.trigger;
      let maxCount = 0;
      for (const [phrase, cnt] of group.countMap.entries()) {
        if (cnt > maxCount) {
          maxCount = cnt;
          bestTrigger = phrase;
        }
      }

      const existing = await BrainSuggestionModel.findOne({ trigger: bestTrigger });
      if (existing) {
        if (existing.status === 'pending') {
          existing.count = group.count;
          await existing.save();
        }
        return;
      }

      let suggestedReply = 'I am ShiPu AI chatbot! Ask me anything. 😊';
      try {
        const { aiProviderManager } = await import('../ai/providers/providerManager');
        const provider = aiProviderManager.getActiveProvider();
        const prompt = `Formulate a concise and natural response to this common user input: "${bestTrigger}". Respond in the same language.`;
        const response = await provider.generateText([{ role: 'user', parts: [{ text: prompt }] }]);
        suggestedReply = (response.text || '').trim();
      } catch {
        // use fallback
      }

      await BrainSuggestionModel.updateOne(
        { trigger: bestTrigger },
        {
          $set: {
            suggestedReply,
            confidence: 0.85,
            count: group.count,
            status: 'pending'
          }
        },
        { upsert: true }
      );
    } catch (err: any) {
      console.error('[BrainService] Error creating suggestion:', err.message);
    }
  }

  // Sliding window of message history per thread for implicit Q&A adjacency detection
  private threadMessageHistory = new Map<string, Array<{
    messageID: string;
    senderID: string;
    body: string;
    timestamp: number;
  }>>();

  /**
   * Passive learning observer: intercepts incoming chat messages to extract conversational patterns & facts.
   */
  public async observeConversation(
    threadID: string,
    senderID: string,
    body: string,
    rawEvent: any,
    accountId?: string
  ): Promise<void> {
    try {
      if (!body || typeof body !== 'string') return;

      // Ignore if it looks like a command (starts with command prefix, e.g., # or / or !)
      const cleanBody = body.trim();
      if (cleanBody.startsWith('#') || cleanBody.startsWith('/') || cleanBody.startsWith('!')) {
        return;
      }

      // Run user attributes passive learning (non-blocking)
      this.passiveLearnUserAttributes(threadID, senderID, cleanBody, rawEvent).catch(err => {
        console.error('[PassiveLearning] Error in user attribute passive learning:', err.message);
      });

      // 1. Get thread history
      if (!this.threadMessageHistory.has(threadID)) {
        this.threadMessageHistory.set(threadID, []);
      }
      const history = this.threadMessageHistory.get(threadID)!;

      // Append current message to history
      const currentMessage = {
        messageID: rawEvent.messageID || `msg_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        senderID,
        body: cleanBody,
        timestamp: Date.now()
      };
      history.push(currentMessage);
      if (history.length > 15) {
        history.shift();
      }

      // 2. Identify Trigger & Reply candidate pairs
      let triggerText = '';
      let replyText = cleanBody;
      let isExplicitReply = false;

      // Check for explicit reply (messageReply or message_reply)
      const msgReply = rawEvent.messageReply || rawEvent.message_reply;
      if (msgReply && msgReply.body && typeof msgReply.body === 'string') {
        const replyClean = msgReply.body.trim();
        // Skip commands
        if (!replyClean.startsWith('#') && !replyClean.startsWith('/') && !replyClean.startsWith('!')) {
          triggerText = replyClean;
          isExplicitReply = true;
        }
      }

      // If not an explicit reply, check for conversational adjacency (implicit Q&A)
      if (!isExplicitReply && history.length >= 2) {
        const prevMsg = history[history.length - 2];
        const timeDiff = currentMessage.timestamp - prevMsg.timestamp;

        // Criteria for conversational adjacency:
        // - Sent by a different user
        // - Within 12 seconds
        // - Previous message was a question or contains query keywords
        const isDiffUser = prevMsg.senderID !== senderID;
        const isRecent = timeDiff <= 12000; // 12 seconds
        
        const isQuestion = 
          prevMsg.body.endsWith('?') ||
          /\b(?:ki|ke|kmon|kemon|kothay|kn|keno|who|what|where|how|gf|girlfriend|gfriend|name|nam|creator|maker)\b/gi.test(prevMsg.body);

        if (isDiffUser && isRecent && isQuestion) {
          triggerText = prevMsg.body;
        }
      }

      if (!triggerText || !replyText) return;

      // Redact PII to keep data secure
      const { aiosService } = await import('./aiosService');
      const safeTrigger = aiosService.redactPII(triggerText);
      const safeReply = aiosService.redactPII(replyText);

      // Skip empty or extremely short/long texts
      if (safeTrigger.length < 2 || safeReply.length < 2 || safeTrigger.length > 120 || safeReply.length > 250) {
        return;
      }

      // Skip if it is already in our permanent BrainMemory cache
      const exactMatch = this.findMatch(safeTrigger);
      if (exactMatch && exactMatch.score >= 0.85) {
        return;
      }

      // Also skip if we are already suggesting this trigger as a pending item
      const existingPending = await BrainSuggestionModel.findOne({ trigger: safeTrigger.toLowerCase().trim() });
      if (existingPending) {
        if (existingPending.status === 'pending') {
          existingPending.count = (existingPending.count || 1) + 1;
          await existingPending.save();
        }
        return;
      }

      // 3. Queue the pair through Gemini for Autonomous Intelligence Analysis
      this.analyzeAndStoreLearnedPair(safeTrigger, safeReply, senderID, threadID).catch(err => {
        console.error('[PassiveLearning] Error in background analysis:', err.message);
      });

    } catch (error: any) {
      console.error('[PassiveLearning] Error in observeConversation:', error.message);
    }
  }

  /**
   * Run background Gemini analysis to categorize, refine, extract facts, and check conflicts carefully.
   */
  private async analyzeAndStoreLearnedPair(
    trigger: string,
    reply: string,
    learnedFrom: string,
    sourceThread: string
  ): Promise<void> {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
      if (!apiKey) return;

      // 1. Run Gemini cognitive analysis to extract tone, polish the response, and discover facts.
      const prompt = `You are the Senior Cognitive Brain of SHIPU AI, an intelligent agent that learns from group chats.
We have captured a real-world trigger-reply exchange:
Linguistic Trigger (User A): "${trigger}"
Linguistic Reply (User B): "${reply}"

Your task is to analyze this exchange for two categories of learning:
1. "CONVERSATIONAL EXPRESSIONS": How humans express their thoughts, slang, greetings, or humor.
2. "FACTUAL KNOWLEDGE": Factual assertions like names, relationships, or attributes (e.g., "A's girlfriend is B", "User X is a student").

GUIDELINES:
- Clean and normalize the trigger.
- Refine and polish the reply to make it look like a highly natural, beautifully written chatbot response. Retain the humor, warmth, and style of the human reply, but remove random spammy letters, excessive typing typos, or inside noise.
- If it is a factual assertion, identify:
  - isFact: true
  - factEntity: The subject name (e.g., "alex", "chitron", "shipu") in lowercase.
  - factAttribute: The relationship or property (e.g., "girlfriend", "realname", "creator") in lowercase.
  - factValue: The target value (e.g., "sraboni", "chitron sen", "shipu ai team").
- If it is just general chat, set isFact: false, and category: 'general'.
- Output your reasoning in Bengali or English.

Return a JSON object matching this schema strictly:
{
  "isHighQuality": true/false (is this a meaningful pair to learn, or is it spam/garbage?),
  "isFact": true/false,
  "category": "general" or "admin" or "fact",
  "factEntity": "entity_name" or null,
  "factAttribute": "relationship_type" or null,
  "factValue": "value" or null,
  "refinedTrigger": "normalized clean trigger",
  "refinedReply": "polished natural reply",
  "reasoning": "Brief explanation of why you learned this"
}`;

      const { aiProviderManager } = await import('../ai/providers/providerManager');
      const provider = aiProviderManager.getActiveProvider();
      const response = await provider.generateText([{ role: 'user', parts: [{ text: prompt }] }], {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            isHighQuality: { type: Type.BOOLEAN },
            isFact: { type: Type.BOOLEAN },
            category: { type: Type.STRING },
            factEntity: { type: Type.STRING, nullable: true },
            factAttribute: { type: Type.STRING, nullable: true },
            factValue: { type: Type.STRING, nullable: true },
            refinedTrigger: { type: Type.STRING },
            refinedReply: { type: Type.STRING },
            reasoning: { type: Type.STRING }
          },
          required: [
            'isHighQuality',
            'isFact',
            'category',
            'refinedTrigger',
            'refinedReply',
            'reasoning'
          ]
        }
      });

      const text = response.text || '';
      const cleanJson = text.replace(/```json|```/gi, '').trim();
      const resObj = JSON.parse(cleanJson);
      
      if (!resObj.isHighQuality) {
        console.log('[PassiveLearning] Pair evaluated as low quality / spam, skipping.');
        return;
      }

      let conflictStatus = 'none';
      let conflictDetails = '';

      // 2. CAREFUL CONFLICT RESOLVER (Mandated by User: "tobe sikhbe newa data abar change korbe ba replace korbe khub chinta vabna kore")
      if (resObj.isFact && resObj.factEntity && resObj.factAttribute) {
        const entity = resObj.factEntity.toLowerCase().trim();
        const attr = resObj.factAttribute.toLowerCase().trim();
        const value = resObj.factValue ? resObj.factValue.toLowerCase().trim() : '';

        // Check if we have an existing memory or suggestion for this fact
        const existingMemories = await BrainMemoryModel.find({
          isFact: true,
          factEntity: entity,
          factAttribute: attr
        });

        if (existingMemories.length > 0) {
          const matchedMem = existingMemories[0];
          const oldVal = (matchedMem.factValue || '').toLowerCase().trim();

          if (oldVal && oldVal !== value) {
            const conflictPrompt = `We have discovered a potential FACT conflict in our database:
Subject: "${entity}"
Property: "${attr}"
Existing Fact Value: "${matchedMem.factValue}" (Trigger was: "${matchedMem.trigger}")
New Learned Value: "${resObj.factValue}" (New Trigger is: "${resObj.refinedTrigger}")

Your task is to analyze if the new fact conflicts with or replaces the old fact, or if we should issue a critical warning.
Explain your analysis and decide if this is:
1. A clear replacement (e.g., relationship status change, corrected error).
2. An addition (e.g., they have multiple attributes, or it's a sibling fact).
3. A high-conflict situation (could be a joke, sarcasm, or gossip).

Return a JSON object with:
{
  "action": "warn" or "update" or "keep_both",
  "explanation": "Detailed explanation of why we need to be careful and what the conflict is in Bengali."
}`;

            try {
              const conflictRes = await provider.generateText([{ role: 'user', parts: [{ text: conflictPrompt }] }], {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    action: { type: Type.STRING },
                    explanation: { type: Type.STRING }
                  },
                  required: ['action', 'explanation']
                }
              });

              const conflictClean = (conflictRes.text || '').replace(/```json|```/gi, '').trim();
              const confObj = JSON.parse(conflictClean);
              conflictStatus = 'warning';
              conflictDetails = confObj.explanation || 'Potential fact replacement conflict identified.';
            } catch (err: any) {
              conflictStatus = 'warning';
              conflictDetails = `Conflict detected: existing value "${matchedMem.factValue}" differs from new learned value "${resObj.factValue}".`;
            }
          }
        }
      }

      // 3. Save as a Suggestion in the Database
      await BrainSuggestionModel.updateOne(
        { trigger: resObj.refinedTrigger.toLowerCase().trim() },
        {
          $set: {
            suggestedReply: resObj.refinedReply,
            confidence: resObj.isFact ? 0.95 : 0.85,
            status: 'pending',
            category: resObj.category || (resObj.isFact ? 'fact' : 'general'),
            isFact: resObj.isFact || false,
            factEntity: resObj.factEntity || '',
            factAttribute: resObj.factAttribute || '',
            factValue: resObj.factValue || '',
            learningContext: `Learned from User ${learnedFrom} in thread ${sourceThread}. ${resObj.reasoning || ''}`,
            conflictStatus,
            conflictDetails
          },
          $inc: { count: 1 }
        },
        { upsert: true }
      );

      console.log(`[PassiveLearning] Created suggestion: "${resObj.refinedTrigger}" -> "${resObj.refinedReply}" (isFact: ${resObj.isFact}, conflict: ${conflictStatus})`);

    } catch (err: any) {
      console.error('[PassiveLearning] analyzeAndStoreLearnedPair Error:', err.message);
    }
  }

  /**
   * Passive learning of user attributes: Nicknames, Personal Relationships, and Communication Styles
   */
  public async passiveLearnUserAttributes(
    threadID: string,
    userID: string,
    body: string,
    rawEvent: any
  ): Promise<void> {
    try {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
      if (!apiKey) return;

      const cleanText = (body || '').trim();
      if (!cleanText || cleanText.length < 2) return;

      // Only proceed with analysis if:
      // 1. High-relevance keywords are found (for nicknames or relationships)
      // 2. OR a small random chance (3%) to evaluate/update their communication style
      const lowerText = cleanText.toLowerCase();
      const hasClues = /\b(?:girlfriend|gf|boyfriend|bf|relationship|relation|naam|nam|daknam|nickname|valobashi|love|biye|biyer|amar name|amake|amr name|shuncho|jan|babu|gfd|gfriend|crush)\b/i.test(lowerText) ||
                        /[\u0995-\u09B0]\b(?:নাম|ডাকনাম|প্রেম|প্রেমিকা|প্রেমিক|গার্লফ্রেন্ড|বয়ফ্রেন্ড|বিয়ে|ভালোবাসি|ভালবাসি|ক্রাশ)\b/i.test(lowerText);

      const isRandomStyleEvaluation = Math.random() < 0.03;

      if (!hasClues && !isRandomStyleEvaluation) {
        return;
      }

      // Find user name if possible
      const userDoc = await (UserModel as any).findOne({ userID }).lean();
      const userName = userDoc ? userDoc.name : '';

      // Run Gemini cognitive analysis to extract traits
      const prompt = `You are the Cognitive Profiler of SHIPU AI.
We are analyzing a message sent by a user in a group chat:
User ID: "${userID}"
User Name: "${userName || 'Unknown'}"
Thread ID: "${threadID}"
Message Body: "${cleanText}"

Analyze if this message explicitly or implicitly reveals:
1. The user's nickname or real name (e.g., "amr nam Shiplu", "amake shiplu dako").
2. A personal relationship (e.g., "Sraboni amr gf", "Alvi's girlfriend is Sraboni", "Alvi are Sraboni committed").
3. The user's communication style / personality (e.g., sarcastic, humorous, angry, romantic, formal, uses lots of emojis, uses heavy Banglish slang, very short tempered).

RULES:
- ONLY extract if there is concrete evidence in the text. Do not guess or hallucinate.
- For "communication_style", analyze the actual message body's tone, grammar, emoji density, and vocabulary.
- Return a JSON object containing an array "extractedTraits". Each trait must have:
  - attributeType: "relationship" or "nickname" or "communication_style"
  - value: The extracted value (e.g., "GF of Alvi", "Shiplu", "Sarcastic and playful with emojis")
  - confidence: A confidence float between 0.5 and 1.0 (highly confident is 0.9+)
  - context: The reasoning or quote from the message (written in beautiful Bengali)

Return JSON strictly matching this schema:
{
  "extractedTraits": [
    {
      "attributeType": "relationship" | "nickname" | "communication_style",
      "value": "string",
      "confidence": number,
      "context": "string"
    }
  ]
}`;

      const { aiProviderManager } = await import('../ai/providers/providerManager');
      const provider = aiProviderManager.getActiveProvider();
      
      const response = await provider.generateText([{ role: 'user', parts: [{ text: prompt }] }], {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            extractedTraits: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  attributeType: { type: Type.STRING },
                  value: { type: Type.STRING },
                  confidence: { type: Type.NUMBER },
                  context: { type: Type.STRING }
                },
                required: ['attributeType', 'value', 'confidence', 'context']
              }
            }
          },
          required: ['extractedTraits']
        }
      });

      const text = response.text || '';
      const cleanJson = text.replace(/```json|```/gi, '').trim();
      const resObj = JSON.parse(cleanJson);

      if (!resObj.extractedTraits || !Array.isArray(resObj.extractedTraits) || resObj.extractedTraits.length === 0) {
        return;
      }

      for (const trait of resObj.extractedTraits) {
        if (!['relationship', 'nickname', 'communication_style'].includes(trait.attributeType)) continue;
        if (!trait.value || typeof trait.value !== 'string' || trait.value.trim().length < 1) continue;

        const attrType = trait.attributeType as 'relationship' | 'nickname' | 'communication_style';
        const extractedValue = trait.value.trim();

        // Check if we have an existing record
        let existing = await (InferredAttributeModel as any).findOne({ threadID, userID, attributeType: attrType });

        if (existing) {
          // If the value is the same, we don't need to update it
          if (existing.value.toLowerCase().trim() === extractedValue.toLowerCase().trim()) {
            continue;
          }

          // Conflict/Replacement double-checking prompt (MANDATED: "খুব চিন্তা ভাবনা করে")
          const conflictPrompt = `We are about to update an inferred attribute for a user.
Attribute Type: "${attrType}"
User ID: "${userID}"
Current Value in Database: "${existing.value}"
New Proposed Value: "${extractedValue}"
Context of proposal (quoted text/reason): "${trait.context}"

Analyze if this new value is indeed a valid replacement/update (e.g., a change in relationship status, a corrected nickname, or a shift in communication style), or if we should reject this update because it's a joke, sarcasm, or gossip.
Return JSON:
{
  "shouldUpdate": true/false,
  "finalValue": "the resolved value",
  "reasoning": "explanation in Bengali"
}`;

          try {
            const conflictRes = await provider.generateText([{ role: 'user', parts: [{ text: conflictPrompt }] }], {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  shouldUpdate: { type: Type.BOOLEAN },
                  finalValue: { type: Type.STRING },
                  reasoning: { type: Type.STRING }
                },
                required: ['shouldUpdate', 'finalValue', 'reasoning']
              }
            });

            const conflictClean = (conflictRes.text || '').replace(/```json|```/gi, '').trim();
            const confObj = JSON.parse(conflictClean);

            if (confObj.shouldUpdate) {
              const oldVal = existing.value;
              
              if (!existing.history) {
                existing.history = [];
              }
              
              existing.history.push({
                value: oldVal,
                timestamp: existing.updatedAt || new Date(),
                context: trait.context || 'Dynamic passive learning update'
              });
              
              existing.value = confObj.finalValue || extractedValue;
              existing.confidence = Math.max(existing.confidence, trait.confidence || 0.85);
              await existing.save();
              console.log(`[PassiveLearning] Carefully UPDATED inferred attribute ${attrType} for user ${userID} to "${existing.value}" (Reasoning: ${confObj.reasoning})`);
            } else {
              console.log(`[PassiveLearning] Update rejected for ${attrType} of user ${userID} due to conflict resolver. Current: "${existing.value}", Proposed: "${extractedValue}"`);
            }
          } catch (err: any) {
            console.error('[PassiveLearning] Conflict resolution failed, skipping update:', err.message);
          }

        } else {
          // No existing record, safe to create
          const newAttr = await InferredAttributeModel.create({
            threadID,
            userID,
            userName: userName || '',
            attributeType: attrType,
            value: extractedValue,
            confidence: trait.confidence || 0.85,
            history: []
          });
          await newAttr.save();
          console.log(`[PassiveLearning] Created NEW inferred attribute ${attrType} for user ${userID}: "${extractedValue}"`);
        }
      }

    } catch (err: any) {
      console.error('[PassiveLearning] passiveLearnUserAttributes error:', err.message);
    }
  }
}

export const brainService = BrainService.getInstance();
