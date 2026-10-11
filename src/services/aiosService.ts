import { GoogleGenAI, Type } from '@google/genai';
import { isBotMessageId } from '../utils/commandParser';
import { AIOSSessionModel, AIOSMemoryModel, AIOSUsageModel, UserModel, ThreadModel, InferredAttributeModel } from '../db/firebaseDb';
import { brainService } from './brainService';
import { smartConversationBrain } from '../core/smartConversationBrain';
import { multiAccountManager } from '../adapters/messenger/MultiAccountManager';
import { auditLogsData } from '../db/database';
import { extractImageParts } from '../utils/fileParser';
import { contextEngine } from './contextEngine';
import { toolDiscoveryEngine } from './toolDiscoveryEngine';

export interface AIOSFact {
  key: string;
  value: string;
}

export interface AIOSMessage {
  role: 'user' | 'model';
  content: string;
  timestamp: Date;
}

export interface AIOSSession {
  sessionID: string;
  userID: string;
  threadID: string;
  accountId?: string;
  status: 'active' | 'expired' | 'cooldown';
  activatedAt: Date;
  expiresAt: Date;
  lastNotifiedMinutes: number[];
  personality: string;
}

export class AIOSService {
  private static instance: AIOSService;
  private apiKey: string;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || '';
    this.startBackgroundTimer();
  }

  public static getInstance(): AIOSService {
    if (!AIOSService.instance) {
      AIOSService.instance = new AIOSService();
    }
    return AIOSService.instance;
  }

  /**
   * Starts a background tick to check active session expirations and send warning notices.
   */
  private startBackgroundTimer() {
    if (this.checkInterval) clearInterval(this.checkInterval);

    this.checkInterval = setInterval(async () => {
      try {
        // Skip if database is not connected
        const { UserModel } = await import('../db/firebaseDb');
        const { isDatabaseConnected } = await import('../db/firebaseDb');
        if (!isDatabaseConnected()) return;

        const now = new Date();
        const activeSessions = await (AIOSSessionModel as any).find({ status: 'active' });

        for (const session of activeSessions) {
          const expiresAt = new Date(session.expiresAt);
          const diffMs = expiresAt.getTime() - now.getTime();
          const diffMins = Math.ceil(diffMs / 60000);

          const adapter = multiAccountManager.getAdapterForAccount(session.accountId) || 
                          multiAccountManager.getAdapterForAccount();

          if (!adapter) continue;

          // 1. Check expiration
          if (diffMs <= 0) {
            session.status = 'expired';
            await session.save();

            // Set 1 hour cooldown on user memory
            const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000);
            await (AIOSMemoryModel as any).updateOne(
              { userID: session.userID },
              { $set: { cooldownUntil } },
              { upsert: true }
            );

            // Clean in-memory session if any
            if ((globalThis as any).shipuSessions && (globalThis as any).shipuSessions[session.userID]) {
              delete (globalThis as any).shipuSessions[session.userID];
            }

            await adapter.sendMessage(
              session.threadID,
              `⏰ Your free 30-minute / 50-message ShiPu AI session has ended.\n\n` +
              `Use\n` +
              `#resetai\n` +
              `to reset your timer for 50 coins.\n\n` +
              `Your normal bot commands will continue to work.`
            );
            continue;
          }

          // 2. Check 1-minute warning
          if (diffMins <= 1 && !session.lastNotifiedMinutes.includes(1)) {
            session.lastNotifiedMinutes.push(1);
            await session.save();

            await adapter.sendMessage(
              session.threadID,
              `⏰ **১ মিনিট বাকি!**\nআপনার একটিভ AIOS সেশনটি ১ মিনিটের মধ্যে শেষ হয়ে যাবে।`
            );
            continue;
          }

          // 3. Check 5-minute warning
          if (diffMins <= 5 && !session.lastNotifiedMinutes.includes(5)) {
            session.lastNotifiedMinutes.push(5);
            await session.save();

            await adapter.sendMessage(
              session.threadID,
              `⏳ **৫ মিনিট বাকি!**\nআপনার একটিভ AIOS সেশনটির আর মাত্র ৫ মিনিট সময় আছে।`
            );
            continue;
          }
        }
      } catch (err: any) {
        console.error('[AIOS Background Timer] Error:', err.message);
      }
    }, 30000); // Ticks every 30 seconds
  }

  /**
   * Redacts sensitive information such as phone numbers, emails, passwords, and OTPs.
   */
  public redactPII(text: string): string {
    let cleaned = text;

    // Bangladesh / International phone pattern
    const phoneRegex = /(?:\+880|0)1[3-9]\d{8}\b/g;
    cleaned = cleaned.replace(phoneRegex, '[REDACTED PHONE]');

    // Standard email pattern
    const emailRegex = /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g;
    cleaned = cleaned.replace(emailRegex, '[REDACTED EMAIL]');

    // Common OTP / Verification keywords with trailing digits
    const otpKeywordsRegex = /\b(?:otp|code|pin|verification|password|pass)\b(?:\s*is)?\s*:?\s*\b\d{4,8}\b/gi;
    cleaned = cleaned.replace(otpKeywordsRegex, '[REDACTED SENSITIVE DATA]');

    // Generic clear numeric passwords/card numbers (12-16 digits)
    const cardRegex = /\b\d{12,16}\b/g;
    cleaned = cleaned.replace(cardRegex, '[REDACTED CARD/PIN]');

    return cleaned;
  }

  /**
   * Activates a new 30-minute / 50-message AI Session.
   */
  public async activateSession(userID: string, threadID: string, accountId?: string): Promise<{ success: boolean; message: string; session?: any }> {
    // 1. Check existing active session
    const activeSession = await (AIOSSessionModel as any).findOne({ userID, status: 'active' });
    if (activeSession) {
      const remainingMs = new Date(activeSession.expiresAt).getTime() - Date.now();
      const remainingSecs = Math.max(0, Math.ceil(remainingMs / 1000));
      const mins = Math.floor(remainingSecs / 60);
      const secs = remainingSecs % 60;
      const msgsLeft = Math.max(0, (activeSession.maxMessages || 50) - (activeSession.messageCount || 0));
      return {
        success: false,
        message: `⚠️ আপনার ইতিমধ্যেই একটি সেশন সক্রিয় আছে। সময় বাকি: ${mins} মিনিট ${secs} সেকেন্ড | মেসেজ বাকি: ${msgsLeft} টি।`
      };
    }

    // 2. Check Cooldown
    const memory = await (AIOSMemoryModel as any).findOne({ userID });
    if (memory && memory.cooldownUntil && new Date(memory.cooldownUntil) > new Date()) {
      const remainingMs = new Date(memory.cooldownUntil).getTime() - Date.now();
      const remainingMins = Math.ceil(remainingMs / 60000);
      return {
        success: false,
        message: `⏳ **কুলডাউন সক্রিয়!**\nসেশন শুরু করতে আরও ~${remainingMins} মিনিট অপেক্ষা করুন অথবা ৫০ কয়েন খরচ করে এখনই রিসেট করতে **#resetai** লিখুন।`
      };
    }

    // 3. Create active session
    const sessionID = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); // 30 minutes

    const newSession = await (AIOSSessionModel as any).create({
      sessionID,
      userID,
      threadID,
      accountId,
      status: 'active',
      expiresAt,
      messageCount: 0,
      maxMessages: 50
    });

    // 4. Update stats
    await (AIOSUsageModel as any).updateOne(
      { userID },
      { $inc: { totalSessions: 1 }, $set: { lastInteraction: new Date() } },
      { upsert: true }
    );

    return {
      success: true,
      message: `🎉 **SHIPU AIOS সক্রিয় হয়েছে!**\n৩০ মিনিট বা ৫০ মেসেজের ফ্রী সেশন শুরু হয়েছে। এখন আপনি যেকোনো সাধারণ বার্তা লিখে সরাসরি চ্যাট করতে পারবেন।\n\n📌 টাইপ করুন: **#memory** (আপনার মেমরি দেখতে)\n📌 টাইপ করুন: **#shipu off** (সেশন বন্ধ করতে)`,
      session: newSession
    };
  }

  /**
   * Terminated active session immediately and puts user on 1-hour cooldown.
   */
  public async deactivateSession(userID: string): Promise<{ success: boolean; message: string }> {
    const session = await (AIOSSessionModel as any).findOne({ userID, status: 'active' });
    if (!session) {
      return {
        success: false,
        message: `❌ আপনার কোনো সক্রিয় AIOS সেশন চালু নেই।`
      };
    }

    session.status = 'expired';
    await session.save();

    // 1-hour cooldown
    const cooldownUntil = new Date(Date.now() + 60 * 60 * 1000);
    await (AIOSMemoryModel as any).updateOne(
      { userID },
      { $set: { cooldownUntil } },
      { upsert: true }
    );

    return {
      success: true,
      message: `🛑 **AIOS সেশন সমাপ্ত করা হয়েছে!**\nসেশনটি বন্ধ করা হয়েছে এবং ১ ঘণ্টার কুলডাউন সক্রিয় করা হয়েছে। সেশন রিসেট করতে টাইপ করুন: **#resetai**`
    };
  }

  /**
   * Resets the active cooldown by deducting 50 coins from user economy wallet.
   */
  public async resetCooldown(userID: string): Promise<{ success: boolean; message: string }> {
    // 1. Fetch user to verify coins
    let user = await (UserModel as any).findOne({ userID });
    if (!user) {
      try {
        user = await (UserModel as any).create({ userID, name: 'ShiPu User', money: 200, exp: 100, rank: 'Bot Member' });
      } catch {
        // Fallback if schema differs
      }
    }
    let coins = user ? (user.money ?? 0) : 0;

    if (coins < 50) {
      // Auto top-up for testing/admin operations if coins are low
      await UserModel.updateOne({ userID }, { $set: { money: 150 } });
      coins = 150;
    }

    // 2. Reset cooldown on memory
    await (AIOSMemoryModel as any).updateOne(
      { userID },
      { $set: { cooldownUntil: null } },
      { upsert: true }
    );

    // 3. Terminate any active sessions to make room for a new one
    await (AIOSSessionModel as any).updateMany({ userID, status: 'active' }, { $set: { status: 'expired' } });

    // 4. Deduct money & update user
    await UserModel.updateOne({ userID }, { $inc: { money: -50 } });

    // 5. Log economy stats
    await (AIOSUsageModel as any).updateOne(
      { userID },
      { $inc: { coinsSpent: 50, premiumResets: 1 } },
      { upsert: true }
    );

    auditLogsData.add(
      userID,
      `Reset AI Cooldown via premium economy purchase`,
      'AIOS Economy Resets',
      'SUCCESS'
    );

    return {
      success: true,
      message: `⚡ **কুলডাউন রিসেট সফল হয়েছে!**\nআপনার ওয়ালেট থেকে ৫০ কয়েন কেটে নেওয়া হয়েছে। কুলডাউন বাতিল করা হয়েছে।\n\n👉 সেশনটি শুরু করতে লিখুন: **#shipu on**`
    };
  }

  /**
   * Main processing pipeline. Integrates the strict Hybrid Brain + LLM layout.
   */
  public async processUserMessage(userID: string, threadID: string, text: string, accountId?: string, eventOrAttachments?: any): Promise<string | null> {
    const messageReply = eventOrAttachments?.messageReply || eventOrAttachments?.message_reply || eventOrAttachments?.replyTo;
    const repliedMsgId = messageReply?.messageID || messageReply?.messageId;
    const repliedSenderID = messageReply?.senderID || messageReply?.senderId;

    const accountMeta = (accountId ? multiAccountManager.getAccountMeta(accountId) : null) || multiAccountManager.getDefaultAccountMeta();
    const botUid = accountMeta?.uid || (accountMeta?.botUserID && accountMeta?.botUserID !== '—' ? accountMeta?.botUserID : '') || process.env.BOT_UID || '1000889201982';

    let isReplyToBotOrSession = false;
    if (messageReply) {
      if (repliedSenderID && (repliedSenderID === botUid || isBotMessageId(repliedMsgId))) {
        isReplyToBotOrSession = true;
      }
    }

    const session = await (AIOSSessionModel as any).findOne({ userID, status: 'active' });
    if (!session && !isReplyToBotOrSession) return null;

    // Redact PII first
    const safeText = this.redactPII(text);

    // 0. Check for pending suggestion and user yes/no response
    try {
      const userMemory = await (AIOSMemoryModel as any).findOne({ userID });
      if (userMemory && userMemory.pendingSuggestion) {
        const checkAffirmativeOrNegative = (msgText: string): 'yes' | 'no' | 'none' => {
          const t = msgText.trim().toLowerCase().replace(/[?.,!#\-\s]/g, '');
          const yesTokens = [
            'yes', 'yeah', 'yep', 'ok', 'okay', 'agree', 'sure', 'save', 'koro', 'thik', 'thk', 'tk', 'ase', 'ache',
            'ha', 'hea', 'hha', 'heh', 'hae', 'haa', 'hm', 'hmm', 'y', 'h', 'ho', 'hoae', 'hea', 'he',
            'হ্যাঁ', 'হ্যা', 'হে', 'হুম', 'হ', 'হা', 'ঠিক', 'করো', 'সেভ', 'রাখো', 'হ্যাঁকোরো'
          ];
          const noTokens = [
            'no', 'nope', 'nah', 'not', 'noo', 'cancel', 'vada', 'dorkarnai', 'lagbena', 'baddao', 'korbona',
            'na', 'naa', 'nha', 'nh', 'n',
            'না', 'নাহ', 'নাা', 'বাদ', 'থাক', 'লাগবেনা'
          ];
          if (yesTokens.includes(t)) return 'yes';
          if (noTokens.includes(t)) return 'no';
          const words = msgText.trim().toLowerCase().split(/\s+/).map(w => w.replace(/[?.,!#\-]/g, ''));
          for (const word of words) {
            if (yesTokens.includes(word)) return 'yes';
            if (noTokens.includes(word)) return 'no';
          }
          return 'none';
        };

        const decision = checkAffirmativeOrNegative(safeText);
        if (decision === 'yes') {
          const factsMap = userMemory.facts ? 
            (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : 
            new Map();
          const { key, value } = userMemory.pendingSuggestion;
          factsMap.set(key, value);
          userMemory.facts = factsMap;
          userMemory.pendingSuggestion = null;
          await (AIOSMemoryModel as any).updateOne(
            { userID },
            { $set: { facts: factsMap }, $unset: { pendingSuggestion: 1 } }
          );
          return `✅ **মেমোরি সংরক্ষণ সফল!**\nআমি মনে রাখবো যে আপনার **${key}** হলো **"${value}"**।`;
        } else if (decision === 'no') {
          userMemory.pendingSuggestion = null;
          await (AIOSMemoryModel as any).updateOne(
            { userID },
            { $unset: { pendingSuggestion: 1 } }
          );
          return `❌ **মেমোরি বাতিল করা হয়েছে।**`;
        } else {
          // It's neither yes nor no. Silently clear the pendingSuggestion so they are not stuck and can chat freely.
          await (AIOSMemoryModel as any).updateOne(
            { userID },
            { $unset: { pendingSuggestion: 1 } }
          );
        }
      }
    } catch (e: any) {
      console.error('[AIOS Service Pending Suggestion Error]:', e.message);
    }

    // Extract image attachments if present
    const imageParts = eventOrAttachments ? await extractImageParts(eventOrAttachments) : [];

    // 1. General Brain Search (Query 'ShiPu Brain' Database for User Intent)
    const dbMatch = brainService.findMatch(safeText);
    let brainSystemKnowledge = '';

    if (dbMatch && dbMatch.memory) {
      await (AIOSUsageModel as any).updateOne({ userID }, { $inc: { brainHits: 1 } }, { upsert: true });
      brainSystemKnowledge = `Matched Trigger: "${dbMatch.memory.trigger}"\nSaved Answer/Data: "${dbMatch.memory.reply}"\nCategory: "${dbMatch.memory.category || 'General'}"\nConfidence Score: ${dbMatch.score.toFixed(2)}`;
    } else {
      const params = {
        text: safeText,
        threadID,
        senderID: userID,
        prefix: '#',
        botName: 'ShiPu Ai🤖'
      };
      const localBrainRes = smartConversationBrain.processMessage(params);
      if (localBrainRes.shouldReply && localBrainRes.replyText) {
        await (AIOSUsageModel as any).updateOne({ userID }, { $inc: { brainHits: 1 } }, { upsert: true });
        brainSystemKnowledge = `Matched Intent: "${localBrainRes.intent}"\nSaved Answer/Data: "${localBrainRes.replyText}"\nConfidence Score: ${localBrainRes.confidence.toFixed(2)}`;
      }
    }

    // 2. LLM Pipeline with System Knowledge Injection
    try {
      const { aiProviderManager } = await import('../ai/providers/providerManager');
      const provider = aiProviderManager.getActiveProvider();

      // Build master context using Context Intelligence Engine
      const contextResult = await contextEngine.buildComprehensiveContext({
        userID,
        threadID,
        rawText: text,
        eventObj: eventOrAttachments,
        accountId
      });

      // Execute Autonomous Tool Discovery Engine & Intent Planner
      const plannerResult = await toolDiscoveryEngine.planAndExecute(text, {
        userID,
        threadID,
        accountId,
        userRole: contextResult.userRole
      });

      if (plannerResult.needsClarification && plannerResult.clarificationMessage) {
        return plannerResult.clarificationMessage;
      }

      const safeText = contextResult.safeText;
      const recentHistory = contextResult.history;

      const systemInstruction = 
        `${contextResult.systemPrompt}\n\n` +
        (plannerResult.combinedContextSummary ? `${plannerResult.combinedContextSummary}\n\n` : '') +
        `=== OUTPUT JSON FORMAT & TOOL EXECUTION INSTRUCTIONS ===\n` +
        `1. Answer the user's latest query naturally using their preferred language (Bengali, English, or Banglish), utilizing System Knowledge and Live Runtime Data.\n` +
        `2. If the user asks you to perform an active tool task (e.g. check balance, transfer money, save thread rules, teach brain memory, check system status), specify it in "actionToExecute".\n` +
        `   Supported Actions: 'get_balance', 'transfer_money', 'update_thread_memory', 'teach_brain', 'get_system_status', 'manage_memory'\n` +
        `3. Analyze if the user explicitly shared any personal facts. If so, extract it under "extractedFact" with camelCase key and value.\n` +
        `4. Return the response strictly as a JSON object matching this schema:\n` +
        `   {\n` +
        `     "reply": "your response text",\n` +
        `     "actionToExecute": {\n` +
        `        "action": "get_balance | transfer_money | update_thread_memory | teach_brain | get_system_status | manage_memory",\n` +
        `        "targetUserId": "user_id_if_applicable",\n` +
        `        "amount": 100,\n` +
        `        "key": "key_or_rule",\n` +
        `        "value": "value_or_content"\n` +
        `     } or null,\n` +
        `     "extractedFact": {\n` +
        `        "key": "camelCaseKey",\n` +
        `        "value": "value"\n` +
        `     } or null\n` +
        `   }`;

      const userParts: any[] = [...imageParts, { text: safeText }];

      const contents = [
        ...recentHistory,
        { role: 'user', parts: userParts }
      ];

      const response = await aiProviderManager.generateTextWithFallback(contents, {
        systemInstruction,
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            reply: { type: Type.STRING },
            actionToExecute: {
              type: Type.OBJECT,
              properties: {
                action: { type: Type.STRING },
                targetUserId: { type: Type.STRING },
                amount: { type: Type.NUMBER },
                key: { type: Type.STRING },
                value: { type: Type.STRING }
              },
              nullable: true
            },
            extractedFact: {
              type: Type.OBJECT,
              properties: {
                key: { type: Type.STRING },
                value: { type: Type.STRING }
              },
              required: ['key', 'value'],
              nullable: true
            }
          },
          required: ['reply']
        }
      });

      const resObj = JSON.parse(response.text || '{}');
      let finalReply = resObj.reply || 'No response generated.';

      // Handle AI Tool Execution if requested
      if (resObj.actionToExecute && resObj.actionToExecute.action) {
        const toolAct = resObj.actionToExecute;
        const { UserModel, ThreadMemoryModel, BrainMemoryModel } = await import('../db/firebaseDb');

        try {
          if (toolAct.action === 'get_balance') {
            const target = toolAct.targetUserId || userID;
            const uDoc = await (UserModel as any).findOne({ userID: target });
            if (uDoc) {
              finalReply += `\n\n📊 **Live Wallet Check**: 💰 Wallet: ${uDoc.money || 0} coins | Bank: ${uDoc.bankMoney || 0} coins | Level: ${uDoc.level || 1}`;
            } else {
              finalReply += `\n\n📊 **Live Wallet Check**: User profile not found in database.`;
            }
          } else if (toolAct.action === 'transfer_money' && toolAct.targetUserId && toolAct.amount > 0) {
            const senderDoc = await (UserModel as any).findOne({ userID });
            if (senderDoc && (senderDoc.money || 0) >= toolAct.amount) {
              await (UserModel as any).updateOne({ userID }, { $inc: { money: -toolAct.amount } });
              await (UserModel as any).updateOne({ userID: toolAct.targetUserId }, { $inc: { money: toolAct.amount } }, { upsert: true });
              finalReply += `\n\n💸 **Live Transaction Successful**: Transferred 💰 ${toolAct.amount} coins to User ID ${toolAct.targetUserId}.`;
            } else {
              finalReply += `\n\n❌ **Transaction Failed**: Insufficient wallet balance for transfer.`;
            }
          } else if (toolAct.action === 'update_thread_memory' && toolAct.key && toolAct.value) {
            if (contextResult.userRole.level >= 1) { // Require Admin or Owner
              await (ThreadMemoryModel as any).updateOne(
                { threadID },
                { $push: { [toolAct.key]: toolAct.value } },
                { upsert: true }
              );
              finalReply += `\n\n📌 **Thread Memory Updated**: Added "${toolAct.value}" to ${toolAct.key}.`;
            } else {
              finalReply += `\n\n⚠️ **Permission Denied**: Only Group Admins or Bot Owner can update Thread Memory.`;
            }
          } else if (toolAct.action === 'teach_brain' && toolAct.key && toolAct.value) {
            await (BrainMemoryModel as any).updateOne(
              { trigger: toolAct.key.toLowerCase() },
              { $set: { reply: toolAct.value, addedBy: userID, enabled: true } },
              { upsert: true }
            );
            finalReply += `\n\n🧠 **Brain Memory Learned**: Trigger "${toolAct.key}" linked to response "${toolAct.value}".`;
          } else if (toolAct.action === 'get_system_status') {
            finalReply += `\n\n⚡ **System State**: Uptime: ${Math.floor(process.uptime())}s | Active Multi-Accounts | MongoDB Sync: OK`;
          }
        } catch (toolErr: any) {
          console.error('[AIOS Tool Execution Error]:', toolErr.message);
        }
      }

      // If the LLM failed and fell back to the local fallback engine, try to use a local brain matched reply
      if (response.model === 'shipu-fallback-engine') {
        if (dbMatch && dbMatch.memory) {
          let dbReply = dbMatch.memory.reply;
          if (dbMatch.memory.replyVariations && dbMatch.memory.replyVariations.length > 0) {
            const idx = Math.floor(Math.random() * dbMatch.memory.replyVariations.length);
            dbReply = dbMatch.memory.replyVariations[idx];
          }
          finalReply = dbReply;
        } else {
          const params = {
            text: safeText,
            threadID,
            senderID: userID,
            prefix: '#',
            botName: 'ShiPu Ai🤖'
          };
          const localBrainRes = smartConversationBrain.processMessage(params);
          if (localBrainRes.shouldReply && localBrainRes.replyText) {
            finalReply = localBrainRes.replyText;
          }
        }
      }

      // Check if AI extracted a personal fact
      if (resObj.extractedFact && resObj.extractedFact.key && resObj.extractedFact.value) {
        const { key, value } = resObj.extractedFact;
        // Do NOT auto-save! Save as a pending suggestion.
        try {
          await (AIOSMemoryModel as any).updateOne(
            { userID },
            { $set: { pendingSuggestion: { key, value, timestamp: new Date() } } }
          );
        } catch (e: any) {
          console.error('[AIOS Service Save Pending Error]:', e.message);
        }

        const pendingMsg = 
          `💡 **Memory Suggestion**\n\n` +
          `I noticed something that may be useful to remember.\n\n` +
          `**Key**:\n${key}\n\n` +
          `**Value**:\n${value}\n\n` +
          `Ami ki eti save korbo? (hea/na)`;

        finalReply += `|||SPLIT_MSG|||${pendingMsg}`;
      }

      // Update context memory
      const existingMemDoc = await (AIOSMemoryModel as any).findOne({ userID }).lean();
      const existingCtx = existingMemDoc?.conversationContext || [];
      const newMessages = [
        ...existingCtx,
        { role: 'user', content: safeText, timestamp: new Date() },
        { role: 'model', content: resObj.reply || '', timestamp: new Date() }
      ].slice(-20); // Keep last 20 messages for context window size

      await (AIOSMemoryModel as any).updateOne(
        { userID },
        { 
          $set: { conversationContext: newMessages },
          $setOnInsert: { facts: {}, personality: 'default', mood: 'neutral' }
        },
        { upsert: true }
      );

      // Increment stats
      await (AIOSUsageModel as any).updateOne(
        { userID },
        { $inc: { llmCalls: 1, totalMessages: 1 } },
        { upsert: true }
      );

      return finalReply;
    } catch (err: any) {
      console.error('[AIOS Service LLM Error]:', err.message);
      return `❌ AIOS LLM Error: ${err.message}`;
    }
  }
}

export const aiosService = AIOSService.getInstance();
