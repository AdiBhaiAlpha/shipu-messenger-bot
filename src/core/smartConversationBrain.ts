import { parseCommand } from '../utils/commandParser';
import { messengerLogger } from '../adapters/messenger/MessengerLogger';
import { brainService, collapseRepeatingChars, stripEmojiFormatters } from '../services/brainService';
import { BrainMemoryModel } from '../db/firebaseDb';

export interface SmartBrainMessageParams {
  text: string;
  threadID: string;
  senderID: string;
  prefix: string;
  botName?: string;
  botUid?: string;
  threadName?: string;
  creatorName?: string;
  creatorFb?: string;
}

export interface SmartBrainResult {
  shouldReply: boolean;
  replyText: string;
  intent: string;
  confidence: number;
  language: 'BN' | 'BANGLISH' | 'EN' | 'MIXED';
  reason?: string;
}

interface ContextState {
  lastIntent: string;
  lastTimestamp: number;
  lastUserText: string;
}

interface IntentDefinition {
  id: string;
  aliases: string[]; // Normalized lowercased phrases
  patterns?: RegExp[];
  responses: {
    BN: string[];
    BANGLISH: string[];
    EN: string[];
  };
  emojis: string[];
  baseConfidence: number;
  requiresDirectMention?: boolean;
}

export class SmartConversationBrain {
  private static instance: SmartConversationBrain;

  // Short term context memory: `${threadID}_${senderID}` -> ContextState
  private contextMap = new Map<string, ContextState>();

  // Cooldown map: `${threadID}_${senderID}_${intent}` -> timestamp
  private cooldownMap = new Map<string, number>();

  // Admin / runtime toggles
  private enabled = true;
  private minConfidenceThreshold = 0.65;
  private cooldownMs = 15000; // 15 seconds per user-intent pair

  private intents: IntentDefinition[] = [];

  constructor() {
    this.initKnowledgeBase();

    // Context cleanup interval every 3 minutes
    if (typeof setInterval !== 'undefined') {
      setInterval(() => {
        const now = Date.now();
        for (const [key, ctx] of this.contextMap.entries()) {
          if (now - ctx.lastTimestamp > 180000) {
            this.contextMap.delete(key);
          }
        }
        for (const [key, time] of this.cooldownMap.entries()) {
          if (now - time > 120000) {
            this.cooldownMap.delete(key);
          }
        }
      }, 180000);
    }
  }

  public static getInstance(): SmartConversationBrain {
    if (!SmartConversationBrain.instance) {
      SmartConversationBrain.instance = new SmartConversationBrain();
    }
    return SmartConversationBrain.instance;
  }

  public setEnabled(flag: boolean) {
    this.enabled = flag;
  }

  public isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Main entry point to evaluate incoming non-command text
   */
  public processMessage(params: SmartBrainMessageParams): SmartBrainResult {
    const defaultNoReply: SmartBrainResult = {
      shouldReply: false,
      replyText: '',
      intent: 'NONE',
      confidence: 0,
      language: 'EN',
      reason: 'No match or low confidence'
    };

    if (!this.enabled) {
      return { ...defaultNoReply, reason: 'Brain disabled' };
    }

    const { text, threadID, senderID, prefix, botUid } = params;

    // Layer 1: Self-event protection
    if (botUid && senderID === botUid) {
      return { ...defaultNoReply, reason: 'Self event' };
    }

    // Layer 2: Strict command exclusion
    const parsedCmd = parseCommand(text, prefix);
    if (parsedCmd.isCommand) {
      return { ...defaultNoReply, reason: 'Is prefixed command' };
    }

    if (!text || typeof text !== 'string' || !text.trim()) {
      return defaultNoReply;
    }

    // Layer 3: Text Normalization
    const rawTrimmed = text.trim();
    const normalized = this.normalizeText(rawTrimmed);
    if (!normalized.cleaned) {
      return defaultNoReply;
    }

    // Layer 4: Language Detection
    const language = this.detectLanguage(rawTrimmed);

    // Check Custom Brain DB memories cache first!
    const customMatch = brainService.findMatch(rawTrimmed);
    if (customMatch) {
      const { memory, score } = customMatch;
      
      // Update usage stats asynchronously
      BrainMemoryModel.updateOne(
        { _id: memory._id },
        {
          $inc: { usageCount: 1 },
          $set: { lastUsed: new Date() }
        }
      ).catch(err => console.error('[BrainService] Error updating stats:', err.message));

      let replyText = memory.reply;
      if (memory.replyVariations && memory.replyVariations.length > 0) {
        const idx = Math.floor(Math.random() * memory.replyVariations.length);
        replyText = memory.replyVariations[idx];
      }

      messengerLogger.info('SMART', `[SMART] Custom brain memory matched! Trigger: "${memory.trigger}", Confidence: ${score.toFixed(2)}`);
      
      return {
        shouldReply: true,
        replyText,
        intent: `DB_${memory.category.toUpperCase()}_${memory._id}`,
        confidence: score,
        language
      };
    }

    // Check for direct bot mention
    const isBotMentioned = this.checkBotMention(rawTrimmed, params.botName);

    // Layer 5, 6, 7 & 8: Intent Classification & Scoring
    const matched = this.classifyIntent(normalized.cleaned, rawTrimmed, isBotMentioned, threadID, senderID);

    if (!matched || matched.confidence < this.minConfidenceThreshold) {
      messengerLogger.info('SMART', `[SMART] No confident intent detected (Confidence: ${matched?.confidence.toFixed(2) || '0.00'})`);
      brainService.logMissedQuery(rawTrimmed);
      return defaultNoReply;
    }

    // Layer 9: Context Check & Contextual Adjustment
    const contextKey = `${threadID}_${senderID}`;
    const previousCtx = this.contextMap.get(contextKey);
    const now = Date.now();

    // Layer 12: Anti-repeat / Cooldown Check
    const cooldownKey = `${threadID}_${senderID}_${matched.intent.id}`;
    const lastTrigger = this.cooldownMap.get(cooldownKey) || 0;

    if (now - lastTrigger < this.cooldownMs) {
      messengerLogger.info('SMART', `[SMART] Cooldown active for user ${senderID} on intent ${matched.intent.id}`);
      return { ...defaultNoReply, reason: 'Intent cooldown active' };
    }

    // Layer 10: Response Selection & Dynamic Variables
    const rawReply = this.selectResponse(matched.intent, language, previousCtx);
    const formattedReply = this.fillTemplateVariables(rawReply, params);

    // Layer 11: Tone & Emoji Formatting
    const finalReply = this.applyEmojiAndTone(formattedReply, matched.intent, normalized.hasEmotionalEmoji);

    // Update Context & Cooldown
    this.contextMap.set(contextKey, {
      lastIntent: matched.intent.id,
      lastTimestamp: now,
      lastUserText: rawTrimmed
    });
    this.cooldownMap.set(cooldownKey, now);

    messengerLogger.info('SMART', `[SMART] Incoming non-command message`);
    messengerLogger.info('SMART', `[SMART] Language: ${language}`);
    messengerLogger.info('SMART', `[SMART] Normalized text: "${normalized.cleaned}"`);
    messengerLogger.info('SMART', `[SMART] Intent candidate: ${matched.intent.id}`);
    messengerLogger.info('SMART', `[SMART] Confidence: ${matched.confidence.toFixed(2)}`);
    messengerLogger.info('SMART', `[SMART] Reply generated`);

    return {
      shouldReply: true,
      replyText: finalReply,
      intent: matched.intent.id,
      confidence: matched.confidence,
      language
    };
  }

  public clearMemory() {
    this.contextMap.clear();
    this.cooldownMap.clear();
  }

  /**
   * Layer 3: Text Normalization
   */
  private normalizeText(text: string): { cleaned: string; hasEmotionalEmoji: boolean } {
    let norm = stripEmojiFormatters(text).toLowerCase();

    // Check for emotional emojis or any unicode emoji
    const hasEmotionalEmoji = /[\p{Emoji}\p{Extended_Pictographic}\p{So}]/u.test(text);

    // Collapsing repeated characters safely using unicode code points
    norm = collapseRepeatingChars(norm);

    // Remove common inline punctuation directly (so "ke?mon" -> "kemon", "খাইছো?" -> "খাইছো")
    norm = norm.replace(/[?.,!:'"\-_]/gu, '');

    // Replace remaining non-letter/non-mark/non-number symbols with spaces (include \p{M} for Bangla vowel signs, \p{Emoji}, \p{Extended_Pictographic}, \p{So} for emojis)
    norm = norm.replace(/[^\p{L}\p{M}\p{N}\p{Emoji}\p{Extended_Pictographic}\p{So}\s]/gu, ' ').replace(/\s+/g, ' ').trim();

    // Common Banglish & typo dictionary replacements
    const typoMap: Record<string, string> = {
      'hlw': 'hello',
      'hlo': 'hello',
      'helo': 'hello',
      'helllo': 'hello',
      'hai': 'hi',
      'hii': 'hi',
      'hiii': 'hi',
      'kmn': 'kemon',
      'aso': 'acho',
      'accho': 'acho',
      'acho': 'acho',
      'tmr': 'tomar',
      'tomr': 'tomar',
      'tumar': 'tomar',
      'ur': 'your',
      'tmi': 'tumi',
      'basa': 'basha',
      'koi': 'kothai',
      'koi?': 'kothai',
      'koy': 'kothai',
      'gm': 'good morning',
      'gn': 'good night',
      'vlo': 'valo',
      'khbr': 'khobor',
      'tnx': 'thanks',
      'thx': 'thanks',
      'tnq': 'thank you',
      'wsp': 'what is up',
      'hru': 'how are you',
      'aslamu': 'assalamualaikum',
      'salam': 'assalamualaikum'
    };

    const words = norm.split(' ').map(w => typoMap[w] || w);
    const cleaned = words.join(' ');

    return { cleaned, hasEmotionalEmoji };
  }

  /**
   * Layer 4: Language Detection
   */
  private detectLanguage(text: string): 'BN' | 'BANGLISH' | 'EN' | 'MIXED' {
    const banglaCharRegex = /[\u0980-\u09FF]/;
    const englishCharRegex = /[a-zA-Z]/;

    const hasBangla = banglaCharRegex.test(text);
    const hasEnglish = englishCharRegex.test(text);

    if (hasBangla && !hasEnglish) return 'BN';
    if (!hasBangla && hasEnglish) {
      // Check if it looks like Banglish (common Banglish words)
      if (/\b(kmn|kemon|acho|aso|tomar|tmr|tumi|ki|korcho|koro|basa|khobor|khaicho|vlo)\b/i.test(text)) {
        return 'BANGLISH';
      }
      return 'EN';
    }
    if (hasBangla && hasEnglish) return 'MIXED';

    return 'BN';
  }

  /**
   * Check if bot is explicitly mentioned
   */
  private checkBotMention(text: string, botName?: string): boolean {
    const lower = text.toLowerCase();
    if (lower.includes('shipu') || lower.includes('bot') || lower.includes('assistant')) {
      return true;
    }
    if (botName && lower.includes(botName.toLowerCase())) {
      return true;
    }
    return false;
  }

  /**
   * Layer 5-8: Intent Classification
   */
  private classifyIntent(
    cleaned: string,
    rawText: string,
    isBotMentioned: boolean,
    threadID: string,
    senderID: string
  ): { intent: IntentDefinition; confidence: number } | null {

    // First: Guard against embedded mention sentences like "আজকে আমি hi বললাম" or " hello শব্দটা নিয়ে কথা বলছিলাম"
    if (this.isMetaSentence(rawText)) {
      return null;
    }

    let bestIntent: IntentDefinition | null = null;
    let maxScore = 0;

    const contextKey = `${threadID}_${senderID}`;
    const previousCtx = this.contextMap.get(contextKey);

    for (const intent of this.intents) {
      let score = 0;

      // 1. Exact alias match or full phrase match
      for (const alias of intent.aliases) {
        if (cleaned === alias) {
          score = Math.max(score, intent.baseConfidence + 0.15);
        } else if (cleaned.startsWith(alias + ' ') || cleaned.endsWith(' ' + alias)) {
          if (cleaned.length < alias.length + 12) {
            score = Math.max(score, intent.baseConfidence + 0.05);
          }
        } else if (cleaned.includes(` ${alias} `)) {
          // If phrase contains alias in middle, check length ratio to prevent embedded triggers
          if (cleaned.length < alias.length + 12) {
            score = Math.max(score, intent.baseConfidence - 0.1);
          }
        }
      }

      // 2. Pattern Regex match
      if (intent.patterns) {
        for (const pattern of intent.patterns) {
          if (pattern.test(rawText) || pattern.test(cleaned)) {
            score = Math.max(score, intent.baseConfidence + 0.1);
          }
        }
      }

      // Boost score if bot was explicitly mentioned
      if (score > 0 && isBotMentioned) {
        score += 0.15;
      }

      // Contextual continuation boost (e.g. asking "কে বানাইছে?" after asking "তোমার নাম কি?")
      if (previousCtx && Date.now() - previousCtx.lastTimestamp < 60000) {
        if (previousCtx.lastIntent === 'BOT_NAME' && intent.id === 'BOT_CREATOR') {
          if (cleaned.includes('ke') || cleaned.includes('who') || cleaned.includes('বানাইছে') || cleaned.includes('creator')) {
            score += 0.3;
          }
        }
      }

      // Cap max score at 1.0
      score = Math.min(score, 1.0);

      if (score > maxScore) {
        maxScore = score;
        bestIntent = intent;
      }
    }

    if (bestIntent && maxScore >= this.minConfidenceThreshold) {
      return { intent: bestIntent, confidence: maxScore };
    }

    return null;
  }

  /**
   * Guard against meta/referential sentences that mention a trigger word inside a discussion
   */
  private isMetaSentence(text: string): boolean {
    const lower = text.toLowerCase();
    const metaPatterns = [
      /শব্দটা নিয়ে/i,
      /কথা বলছিলাম/i,
      /আমি .+ বললাম/i,
      /নিয়ে কথা/i,
      /বললাম/i,
      /নিয়ে কথা/i,
      /talking about/i,
      /said earlier/i
    ];

    for (const pat of metaPatterns) {
      if (pat.test(lower)) return true;
    }

    return false;
  }

  /**
   * Layer 10: Response Selection
   */
  private selectResponse(
    intent: IntentDefinition,
    lang: 'BN' | 'BANGLISH' | 'EN' | 'MIXED',
    context?: ContextState
  ): string {
    let pool: string[] = [];

    if (lang === 'BN' || lang === 'MIXED') {
      pool = intent.responses.BN.length > 0 ? intent.responses.BN : intent.responses.EN;
    } else if (lang === 'BANGLISH') {
      pool = intent.responses.BANGLISH.length > 0 ? intent.responses.BANGLISH : intent.responses.BN;
    } else {
      pool = intent.responses.EN.length > 0 ? intent.responses.EN : intent.responses.BN;
    }

    if (!pool || pool.length === 0) {
      pool = intent.responses.BN;
    }

    // Avoid picking the exact last response if possible
    const randIdx = Math.floor(Math.random() * pool.length);
    return pool[randIdx];
  }

  /**
   * Dynamic variables replacement
   */
  private fillTemplateVariables(template: string, params: SmartBrainMessageParams): string {
    const botName = params.botName || 'ShiPu Ai';
    const prefix = params.prefix || '#';
    const creator = params.creatorName || 'চিত্রণ ভট্টাচার্য আদি';
    const creatorFb = params.creatorFb || 'facebook.com/ssfadi';
    const groupName = params.threadName || 'গ্রুপ';

    return template
      .replace(/\{botName\}/g, botName)
      .replace(/\{prefix\}/g, prefix)
      .replace(/\{creator\}/g, creator)
      .replace(/\{creatorFb\}/g, creatorFb)
      .replace(/\{groupName\}/g, groupName);
  }

  /**
   * Layer 11: Tone & Emoji Formatting
   */
  private applyEmojiAndTone(reply: string, intent: IntentDefinition, userHasEmoji: boolean): string {
    // If reply already contains emojis or intent has no emojis, return as is
    if (/[\u{1F300}-\u{1F9FF}]/u.test(reply) || !intent.emojis || intent.emojis.length === 0) {
      return reply;
    }

    // Select 1 emoji from intent emoji list
    const emoji = intent.emojis[Math.floor(Math.random() * intent.emojis.length)];
    return `${reply} ${emoji}`;
  }

  /**
   * Initialize Intent Knowledge Base
   */
  private initKnowledgeBase() {
    this.intents = [
      // 1. GREETING_SALAM
      {
        id: 'GREETING_SALAM',
        aliases: [
          'assalamualaikum', 'assalamu alaikum', 'আসসালামু আলাইকুম', 'সালাম', 'salam',
          'aslamu alaikum', 'আসসালামুআলাইকুম', 'আসসালামু অালাইকুম'
        ],
        patterns: [/^assalamu\s*alaikum/i, /^আসসালামু\s*আলাইকুম/i],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'ওয়ালাইকুম আসসালাম! 🌸 কেমন আছেন?',
            'ওয়ালাইকুম আসসালাম! 😊 আশা করি ভালো আছেন।',
            'ওয়ালাইকুম আসসালাম! 💙 আপনাকে কীভাবে সাহায্য করতে পারি?'
          ],
          BANGLISH: [
            'Walaikum Assalam! 🌸 Kmn achen?',
            'Walaikum Assalam! 😊 Asha kori valo achen.',
            'Walaikum Assalam! 💙 Kive sahajo krte pari?'
          ],
          EN: [
            'Walaikum Assalam! 🌸 How are you today?',
            'Walaikum Assalam! 😊 Hope you are doing great.',
            'Walaikum Assalam! 💙 How can I help you today?'
          ]
        },
        emojis: ['🌸', '😊', '💙']
      },

      // 2. GREETING_HI
      {
        id: 'GREETING_HI',
        aliases: [
          'hi', 'hii', 'hiii', 'hai', 'hlw', 'hlo', 'hello', 'heyy', 'heyyy',
          'হাই', 'হ্যালো', 'হেলো', 'হ্যালোও'
        ],
        patterns: [/^(hi+|hello+|hlw+|hlo+|হাই+|হ্যালো+)$/i],
        baseConfidence: 0.8,
        responses: {
          BN: [
            'হাই! 👋 কেমন আছো?',
            'হ্যালো! 😊 কী খবর?',
            'হাই! 🤖 ভালো আছো তো?'
          ],
          BANGLISH: [
            'Hai! 👋 Kmn acho?',
            'Hello! 😊 Ki khobor?',
            'Hi! 🤖 Valo acho to?'
          ],
          EN: [
            'Hello! 👋 How are you doing?',
            'Hi there! 😊 What is up?',
            'Hey! 🤖 How can I help you?'
          ]
        },
        emojis: ['👋', '😊', '🤖']
      },

      // 3. GOOD_MORNING
      {
        id: 'GOOD_MORNING',
        aliases: [
          'good morning', 'gm', 'গুড মর্নিং', 'শুভ সকাল', 'subho sokal', 'shuvo sokal'
        ],
        patterns: [/^good\s*morning/i, /^শুভ\s*সকাল/i],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'শুভ সকাল! ☀️ আজকের দিনটি আপনার অনেক সুন্দর কাটুক।',
            'গুড মর্নিং! ☀️ চমৎকার একটি দিনের শুভকামনা।',
            'শুভ সকাল! 🌅 কেমন আছো আজ সকালে?'
          ],
          BANGLISH: [
            'Shuvo Sokal! ☀️ Ajker din ta valo katuk.',
            'Good morning! ☀️ Chomotkar ekta diner suvokamona.',
            'Shuvo Sokal! 🌅 Kmn acho aj sokale?'
          ],
          EN: [
            'Good morning! ☀️ Wishing you a wonderful and pleasant day ahead.',
            'Good morning! 🌅 Have a productive and great day!',
            'Good morning! ☀️ How are you doing this morning?'
          ]
        },
        emojis: ['☀️', '🌅', '✨']
      },

      // 4. GOOD_NIGHT
      {
        id: 'GOOD_NIGHT',
        aliases: [
          'good night', 'gn', 'গুড নাইট', 'শুভ রাত্রি', 'subho ratri', 'shuvo ratri'
        ],
        patterns: [/^good\s*night/i, /^শুভ\s*রাত্রি/i],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'শুভ রাত্রি! 🌙 মিষ্টি স্বপ্ন দেখো।',
            'গুড নাইট! 😴 শান্তিতে ঘুমাও।',
            'শুভ রাত্রি! 🌌 কাল আবার কথা হবে।'
          ],
          BANGLISH: [
            'Shuvo Ratri! 🌙 Mishti shopno dekho.',
            'Good night! 😴 Shantite ghumao.',
            'Shuvo Ratri! 🌌 Kal abar kotha hobe.'
          ],
          EN: [
            'Good night! 🌙 Have a peaceful sleep and sweet dreams.',
            'Good night! 😴 Rest well for tomorrow.',
            'Good night! 🌌 See you tomorrow!'
          ]
        },
        emojis: ['🌙', '😴', '🌌']
      },

      // 5. GOOD_EVENING
      {
        id: 'GOOD_EVENING',
        aliases: [
          'good evening', 'শুভ সন্ধ্যা', 'shuvo sondha'
        ],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'শুভ সন্ধ্যা! 🌆 আপনার সন্ধ্যাটি সুন্দর হোক।',
            'গুড ইভনিং! 🌆 কেমন কাটছে আপনার সন্ধ্যা?'
          ],
          BANGLISH: [
            'Shuvo Sondha! 🌆 Apnar sondha ta valo katuk.',
            'Good evening! 🌆 Kmn katche sondha?'
          ],
          EN: [
            'Good evening! 🌆 Hope you are having a relaxed evening.',
            'Good evening! 🌆 How was your day?'
          ]
        },
        emojis: ['🌆', '✨']
      },

      // 6. HOW_ARE_YOU
      {
        id: 'HOW_ARE_YOU',
        aliases: [
          'kmn acho', 'kemon acho', 'kmn aso', 'kemon aso', 'how are you', 'hru',
          'কেমন আছো', 'কেমন আছেন', 'কেমন আছিস', 'কেমন আছেন সবাই', 'kmn accho'
        ],
        patterns: [/kmn\s*acho/i, /kemon\s*acho/i, /ke?mon\s*a[cs]h?o/i, /how\s*are\s*you/i],
        baseConfidence: 0.8,
        responses: {
          BN: [
            'আমি আলহামদুলিল্লাহ ভালো আছি! 🤖 তুমি কেমন আছো?',
            'আমি সবসময় চাঙ্গা আছি! 😊 তোমার দিনকাল কেমন চলছে?',
            'সব মিলিয়ে খুব ভালো আছি! 💙 তোমার খবর কী?'
          ],
          BANGLISH: [
            'Ami Alhamdulillah valo achi! 🤖 Tumi kmn acho?',
            'Ami shob somoy valo achi! 😊 Tomar dinkal kmn cholche?',
            'Sob miliye khub valo achi! 💙 Tomar khobor ki?'
          ],
          EN: [
            'I am doing great, thank you! 🤖 How are you doing today?',
            'I am fully active and functioning well! 😊 How about you?',
            'Doing awesome! 💙 How is your day going?'
          ]
        },
        emojis: ['🤖', '😊', '💙']
      },

      // 7. WHAT_IS_UP / KHOBOR
      {
        id: 'WHAT_IS_UP',
        aliases: [
          'ki khbr', 'ki khobor', 'what is up', "what's up", 'wsp', 'কী খবর', 'কি খবর'
        ],
        patterns: [/ki\s*khobor/i, /what'?s?\s*up/i],
        baseConfidence: 0.8,
        responses: {
          BN: [
            'এইতো ভালো! 🤖 গ্রুপে সবার সাথে কথা বলছি। তোমার কী খবর?',
            'সব আলহামদুলিল্লাহ চমৎকার! 😊 তোমার কী খবর বলো?'
          ],
          BANGLISH: [
            'Eito valo! 🤖 Groupe sobar sathe kotha bolchi. Tomar ki khobor?',
            'Sob Alhamdulillah chomotkar! 😊 Tomar ki khobor bolo?'
          ],
          EN: [
            'All good here! 🤖 Just managing group conversations. What is up with you?',
            'Everything is going great! 😊 What is new with you?'
          ]
        },
        emojis: ['🤖', '😊']
      },

      // 8. WHAT_ARE_YOU_DOING
      {
        id: 'WHAT_ARE_YOU_DOING',
        aliases: [
          'ki koro', 'ki korteso', 'ki korcho', 'কী করো', 'কি করতেছ', 'কি করতেছো', 'what are you doing'
        ],
        patterns: [/ki\s*ko?r[ct]eso/i, /what\s*are\s*you\s*doing/i],
        baseConfidence: 0.8,
        responses: {
          BN: [
            'আমি গ্রুপের নতুন মেসেজগুলোর উত্তর দিচ্ছি! 🤖',
            'এইতো, তোমাদের সুন্দর কথাবার্তা শুনছি আর শিখছি! 😊'
          ],
          BANGLISH: [
            'Ami grouper notun messager uttor dichi! 🤖',
            'Eito, tomeder kotha sunchi r sikhchi! 😊'
          ],
          EN: [
            'I am actively monitoring and assisting in this Messenger group! 🤖',
            'Just waiting for your queries and keeping things organized! 😊'
          ]
        },
        emojis: ['🤖', '😊']
      },

      // 9. HAVE_YOU_EATEN
      {
        id: 'HAVE_YOU_EATEN',
        aliases: [
          'khaicho', 'kheyecho', 'khaichos', 'খাইছো', 'খেয়েছো', 'খাইছ', 'খাইছস', 'did you eat', 'have you eaten'
        ],
        patterns: [/khai[cs]ho?/i, /kheye[cs]ho/i, /did\s*you\s*eat/i],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'আমি তো একটা AI Bot, তাই আমার খাবার খাওয়া লাগে না 😄 তবে তুমি খেয়েছো তো?',
            'আমার খাবার হলো বিদ্যুৎ আর ইন্টারনেট ডাটা! ⚡ তোমার খাওয়া হয়েছে?'
          ],
          BANGLISH: [
            'Ami to ekta AI Bot, tai amar khabar khawa lage na 😄 Tobe tumi kheyecho to?',
            'Amar khabar holo electricity r internet data! ⚡ Tomar khawa hoyeche?'
          ],
          EN: [
            'As an AI bot, I do not eat real food! 😄 Did you have your meal?',
            'I feed on code and internet data! ⚡ Hope you enjoyed your meal.'
          ]
        },
        emojis: ['😄', '⚡']
      },

      // 10. BOT_NAME
      {
        id: 'BOT_NAME',
        aliases: [
          'tomar nam ki', 'tmr nam ki', 'what is your name', 'ur name', 'তোমার নাম কি', 'তোমার নাম কী'
        ],
        patterns: [/tomar\s*nam\s*ki/i, /what\s*is\s*your\s*name/i],
        baseConfidence: 0.9,
        responses: {
          BN: [
            'আমার নাম {botName} 🤖 — এই গ্রুপের Messenger Assistant।',
            'আমি {botName}! তোমাদের যেকোনো সাহায্যে আমি প্রস্তুত। 😊'
          ],
          BANGLISH: [
            'Amar nam {botName} 🤖 — ei grouper Messenger Assistant.',
            'Ami {botName}! Tomader sahajje ami prostut. 😊'
          ],
          EN: [
            'My name is {botName} 🤖 — your smart Messenger assistant for this group.',
            'I am {botName}! Glad to assist you in this group. 😊'
          ]
        },
        emojis: ['🤖', '😊']
      },

      // 11. BOT_CREATOR
      {
        id: 'BOT_CREATOR',
        aliases: [
          'tomar creator ke', 'who created you', 'who made you', 'ke banaiche', 'তোমাকে কে বানিয়েছে',
          'কে বানাইছে তোমাকে', 'creator ke', 'tomar malik ke'
        ],
        patterns: [/creator\s*ke/i, /who\s*(created|made)\s*you/i, /কে\s*বানাইছে/i],
        baseConfidence: 0.9,
        responses: {
          BN: [
            'আমার creator ও maintainer হলেন {creator}। 👨‍💻\nFacebook: {creatorFb}',
            'আমাকে বানিয়েছেন {creator}। 🚀'
          ],
          BANGLISH: [
            'Amar creator o maintainer holen {creator}. 👨‍💻\nFacebook: {creatorFb}',
            'Amake baniyechen {creator}. 🚀'
          ],
          EN: [
            'I was created and developed by {creator}. 👨‍💻\nFacebook profile: {creatorFb}',
            'My developer is {creator}. 🚀'
          ]
        },
        emojis: ['👨‍💻', '🚀']
      },

      // 12. BOT_IDENTITY
      {
        id: 'BOT_IDENTITY',
        aliases: [
          'tmi ke', 'tumi ke', 'who are you', 'are you a bot', 'tmi ki ai', 'তুমি কে', 'তুমি কি bot', 'তুমি কি AI'
        ],
        patterns: [/tumi\s*ke/i, /who\s*are\s*you/i, /are\s*you\s*a?\s*bot/i],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'আমি {botName} 🤖, একটি AI-powered গ্রুপ মেসেঞ্জার বট।',
            'আমি এই গ্রুপের ভার্চুয়াল অ্যাসিস্ট্যান্ট {botName}। 😊'
          ],
          BANGLISH: [
            'Ami {botName} 🤖, ekta AI-powered group messenger bot.',
            'Ami ei grouper virtual assistant {botName}. 😊'
          ],
          EN: [
            'I am {botName} 🤖, an intelligent AI Messenger assistant created for group automation.',
            'I am {botName}, your virtual assistant in this chat! 😊'
          ]
        },
        emojis: ['🤖', '😊']
      },

      // 13. BOT_CAPABILITIES
      {
        id: 'BOT_CAPABILITIES',
        aliases: [
          'ki korte paro', 'what can you do', 'ki ki paro', 'কি করতে পারো', 'কী কী পারো', 'কী করতে পারো'
        ],
        patterns: [/ki\s*korte\s*paro/i, /what\s*can\s*you\s*do/i],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'আমি গ্রুপের সাধারণ কথাবার্তা বুঝতে, বিভিন্ন command চালাতে এবং প্রয়োজনীয় তথ্য দিতে পারি।\nসকল Command দেখতে {prefix}help ব্যবহার করো! 🛠️',
            'আমি গ্রুপিং টাস্ক, কমান্ড এক্সিকিউশন, গান/এআই উত্তর এবং নোটিফিকেশন হ্যান্ডেল করতে পারি। লিস্ট দেখতে লেখো: {prefix}help'
          ],
          BANGLISH: [
            'Ami grouper kothabarta bujte, bivinno command chalate r tottho dite pari.\nSob command dekhte {prefix}help likho! 🛠️',
            'Ami group tools, command execution r smart chat handle kori. Dekhte type koro: {prefix}help'
          ],
          EN: [
            'I can execute useful group commands, respond to chat queries, manage group tasks, and provide information.\nType {prefix}help to see the full menu! 🛠️',
            'I manage group utilities, AI queries, and interactive commands. Use {prefix}help to view all commands!'
          ]
        },
        emojis: ['🛠️', '⚙️']
      },

      // 14. BOT_PREFIX / HOW_TO_USE
      {
        id: 'BOT_PREFIX',
        aliases: [
          'prefix ki', 'tomar prefix ki', 'how to use you', 'কিভাবে ব্যবহার করবো', 'prefix', 'প্রিফিক্স কি'
        ],
        patterns: [/prefix\s*ki/i, /how\s*to\s*use/i],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'এই গ্রুপে আমার কমান্ড prefix হলো: {prefix}\n\nউদাহরণ:\n{prefix}help\n{prefix}info\n{prefix}uptime',
            'আমাকে ব্যবহার করতে মেসেজের শুরুতে {prefix} প্রিফিক্স যোগ করো। যেমন: {prefix}help'
          ],
          BANGLISH: [
            'Ei groupe amar command prefix holo: {prefix}\n\nUdahorung:\n{prefix}help\n{prefix}info\n{prefix}uptime',
            'Amake use krte messager surute {prefix} add koro. Jmn: {prefix}help'
          ],
          EN: [
            'My command prefix for this group is: {prefix}\n\nExamples:\n{prefix}help\n{prefix}info\n{prefix}uptime',
            'To trigger any command, start your message with {prefix} (e.g. {prefix}help).'
          ]
        },
        emojis: ['📌', '⚙️']
      },

      // 15. WHERE_DO_YOU_LIVE
      {
        id: 'WHERE_DO_YOU_LIVE',
        aliases: [
          'tomar basa koi', 'where do you live', 'tumi kotha theke', 'তোমার বাসা কোথায়', 'তুমি কোথা থেকে', 'তোমার বাড়ি কোথায়'
        ],
        patterns: [/basa\s*ko?i/i, /where\s*do\s*you\s*live/i],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'আমার কোনো শারীরিক বাসা নেই! ☁️ আমি ক্লাউড সার্ভারে বসবাস করি।',
            'আমি ইন্টারনেটের ডিজিটাল ওয়ার্ল্ডে থাকি! 🚀'
          ],
          BANGLISH: [
            'Amar kono shariik basa nei! ☁️ Ami cloud server-e thaki.',
            'Ami internet er digital world-e thaki! 🚀'
          ],
          EN: [
            'I live in the digital cloud servers! ☁️ No physical home required.',
            'I reside inside the internet and Cloud Run containers! 🚀'
          ]
        },
        emojis: ['☁️', '🚀']
      },

      // 16. THANKS
      {
        id: 'THANKS',
        aliases: [
          'thanks', 'thank you', 'tnx', 'thx', 'ধন্যবাদ', 'থ্যাংকস', 'ধন্যবাদ তোমাকে'
        ],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'আপনাকে অনেক ধন্যবাদ! 😊',
            'স্বাগতম! যেকোনো প্রয়োজনে সবসময় পাশে আছি। 💙'
          ],
          BANGLISH: [
            'Apnake onek dhonnobad! 😊',
            'Welcome! Jekono proyojone ache. 💙'
          ],
          EN: [
            'You are most welcome! 😊 Happy to help!',
            'Anytime! Always glad to be of assistance. 💙'
          ]
        },
        emojis: ['😊', '💙', '🤝']
      },

      // 17. GOODBYE
      {
        id: 'GOODBYE',
        aliases: [
          'bye', 'goodbye', 'see you', 'take care', 'বাই', 'টাটা', 'tata', 'আল্লাহ হাফেজ'
        ],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'বাই! 👋 নিজের খেয়াল রেখো।',
            'আল্লাহ হাফেজ / টাটা! 💙 আবার কথা হবে।'
          ],
          BANGLISH: [
            'Bye! 👋 Nijer kheyal rekho.',
            'Allah Hafez / Tata! 💙 Abar kotha hobe.'
          ],
          EN: [
            'Goodbye! 👋 Take care and have a wonderful time.',
            'Bye! 💙 Talk to you soon!'
          ]
        },
        emojis: ['👋', '💙']
      },

      // 18. COMPLIMENT
      {
        id: 'COMPLIMENT',
        aliases: [
          'you are awesome', 'good bot', 'nice bot', 'তুমি অনেক ভালো', 'তুমি অস্থির', 'ভালো বট'
        ],
        baseConfidence: 0.8,
        responses: {
          BN: [
            'অনেক ধন্যবাদ প্রশংসা করার জন্য! 😊❤️',
            'শুনে খুব ভালো লাগলো! আপনার কথায় উৎসাহ পেলাম। 💙'
          ],
          BANGLISH: [
            'Onek dhonnobad prosongsa korar jonno! 😊❤️',
            'Sune khub valo laglo! 💙'
          ],
          EN: [
            'Thank you so much! 😊 You made my day!',
            'Appreciate the kind words! Always striving to be helpful. 💙'
          ]
        },
        emojis: ['😊', '❤️', '💙']
      },

      // 19. FUN_JOKE
      {
        id: 'FUN_JOKE',
        aliases: [
          'tell me a joke', 'হাসাও', 'জোকস বলো', 'একটা জোকস বলো', 'joke bolo'
        ],
        baseConfidence: 0.85,
        responses: {
          BN: [
            'শিক্ষক: বলতো পৃথিবী কেন ঘোরে?\nছাত্র: নিশ্চয়ই কারও মাথা ঘুরে গেছে স্যার! 😂',
            'প্রোগ্রামার: কেন ইন্টারনেট স্লো?\nসার্ভার: আমি একটু চা খেতে গেছিলাম! ☕😄'
          ],
          BANGLISH: [
            'Teacher: Bolo to prithibi keno ghore?\nStudent: Nishchoi karo matha ghure geche sir! 😂'
          ],
          EN: [
            'Why do programmers prefer dark mode? Because light attracts bugs! 😂'
          ]
        },
        emojis: ['😂', '😄']
      }
    ];
  }
}

export const smartConversationBrain = SmartConversationBrain.getInstance();
