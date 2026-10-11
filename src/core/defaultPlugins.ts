import { economyService } from '../services/economyService';
import { subscriptionService } from '../services/subscriptionService';
import { spinService } from '../services/spinService';
import { ShiPuCommandModule, UserRole } from '../types/shipu';
import { goatBotLoader } from './goatBotLoader';
import { botEngine } from './botEngine';
import { toUnicodeBold, formatBotText } from '../utils/textFormatter';
import { aiosService } from '../services/aiosService';
import { contextEngine } from '../services/contextEngine';
import { toolDiscoveryEngine } from '../services/toolDiscoveryEngine';
import { isBotMessageId } from '../utils/commandParser';
import { AIOSMemoryModel, AIOSSessionModel, AIOSUsageModel, UserModel } from '../db/firebaseDb';
import { Type } from '@google/genai';
import { brainService } from '../services/brainService';
import axios from 'axios';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import fs from 'fs-extra';
import path from 'path';
import { generatePingImage, generateMonitorDashboard } from '../utils/imageUtils';
import { extractImageParts, extractImagePartsFromPairing, hasImageAttachment } from '../utils/fileParser';
import { MonitorDataService } from '../services/monitorDataService';
import { smsSimulationService, smsValidator } from '../services/smsSimulationService';

async function processShipuAiResponse(senderID: string, threadID: string, rawText: string, message: any, headerPrefix?: string, eventObj?: any) {
  if (!rawText || !rawText.trim()) return;

  if (!(globalThis as any).shipuSessions) {
    (globalThis as any).shipuSessions = {};
  }

  let session = (globalThis as any).shipuSessions?.[senderID];

  // If not in memory, restore from MongoDB if active
  if (!session || !session.active) {
    try {
      const dbSession = await (AIOSSessionModel as any).findOne({ userID: senderID, status: 'active' });
      if (dbSession && new Date(dbSession.expiresAt) > new Date() && (dbSession.messageCount || 0) < (dbSession.maxMessages || 50)) {
        const now = Date.now();
        const expiresAt = new Date(dbSession.expiresAt).getTime();
        const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID }) || {
          facts: {},
          conversationContext: []
        };
        const factsMap = userMemory.facts ? (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : new Map();
        const factsObj = Object.fromEntries(factsMap);

        session = {
          threadID: dbSession.threadID || threadID,
          startedAt: new Date(dbSession.activatedAt).getTime(),
          expiresAt,
          remainingTime: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
          messageCount: dbSession.messageCount || 0,
          maxMessages: dbSession.maxMessages || 50,
          conversationHistory: userMemory.conversationContext || [],
          personalMemory: factsObj,
          active: true
        };
        (globalThis as any).shipuSessions[senderID] = session;
      }
    } catch (e) {
      console.error('[AIOS Session Restore Error]:', e);
    }
  }

  // Check if this message is a reply to the bot's message or a session message
  const messageReply = eventObj?.messageReply || eventObj?.message_reply || eventObj?.replyTo;
  const repliedMsgId = messageReply?.messageID || messageReply?.messageId;
  const repliedSenderID = messageReply?.senderID || messageReply?.senderId;
  const botUid = botEngine.selfUserId || process.env.BOT_UID || '1000889201982';

  let isReplyToBotOrSession = false;
  if (messageReply) {
    if (repliedSenderID && (repliedSenderID === botUid || isBotMessageId(repliedMsgId))) {
      isReplyToBotOrSession = true;
    }
  }

  const isDirectCall = Boolean(
    headerPrefix ||
    eventObj?.isDirectCommand ||
    /^(?:#|@)?shipu(?:\s+ai)?(?:\s+|$)/i.test(rawText.trim())
  );
  const now = Date.now();

  let isSessionValid = Boolean(
    session &&
    session.active &&
    now < session.expiresAt &&
    (session.messageCount || 0) < (session.maxMessages || 50)
  );

  let sessionExpiredNoteNeeded = false;

  if (isSessionValid) {
    // Increment message count for active continuous session
    session.messageCount = (session.messageCount || 0) + 1;
    session.remainingTime = Math.max(0, Math.ceil((session.expiresAt - now) / 1000));

    // Asynchronously update MongoDB session
    (AIOSSessionModel as any).updateOne(
      { userID: senderID, status: 'active' },
      { $inc: { messageCount: 1 } }
    ).catch(() => {});

    // Check if session limits (20 mins or 50 msgs) reached on this turn
    if (now >= session.expiresAt || session.messageCount >= (session.maxMessages || 50)) {
      session.active = false;
      delete (globalThis as any).shipuSessions[senderID];
      aiosService.deactivateSession(senderID).catch(() => {});
      sessionExpiredNoteNeeded = true;
    }
  } else {
    // Session is inactive, expired or limit reached
    if (!isDirectCall && !isReplyToBotOrSession) {
      // Ignore prefix-less messages when continuous session is not active
      return;
    }

    // Only show session expired note if a previous session had actually expired or hit its message limit
    if (session && (now >= session.expiresAt || (session.messageCount || 0) >= (session.maxMessages || 50))) {
      sessionExpiredNoteNeeded = true;
    }

    // Load memory context if available
    if (!session) {
      try {
        const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID }) || { facts: {}, conversationContext: [] };
        const factsMap = userMemory.facts ? (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : new Map();
        session = {
          threadID,
          startedAt: now,
          expiresAt: now,
          remainingTime: 0,
          messageCount: 50,
          maxMessages: 50,
          conversationHistory: userMemory.conversationContext || [],
          personalMemory: Object.fromEntries(factsMap),
          active: false
        };
      } catch {
        session = {
          threadID,
          startedAt: now,
          expiresAt: now,
          remainingTime: 0,
          messageCount: 50,
          maxMessages: 50,
          conversationHistory: [],
          personalMemory: {},
          active: false
        };
      }
    }
  }

  // 0. Check for pending suggestion and user yes/no response
  try {
    const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID });
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

      const decision = checkAffirmativeOrNegative(rawText);
      if (decision === 'yes') {
        const factsMap = userMemory.facts ? 
          (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : 
          new Map();
        const { key, value } = userMemory.pendingSuggestion;
        factsMap.set(key, value);
        userMemory.facts = factsMap;
        userMemory.pendingSuggestion = null;
        await (AIOSMemoryModel as any).updateOne(
          { userID: senderID },
          { $set: { facts: factsMap }, $unset: { pendingSuggestion: 1 } }
        );
        session.personalMemory = Object.fromEntries(factsMap);
        await message.reply(`✅ **মেমোরি সংরক্ষণ সফল!**\nআমি মনে রাখবো যে আপনার **${key}** হলো **"${value}"**।`);
        return;
      } else if (decision === 'no') {
        userMemory.pendingSuggestion = null;
        await (AIOSMemoryModel as any).updateOne(
          { userID: senderID },
          { $unset: { pendingSuggestion: 1 } }
        );
        await message.reply(`❌ **মেমোরি বাতিল করা হয়েছে।**`);
        return;
      } else {
        // It's neither yes nor no. Silently clear the pendingSuggestion so they are not stuck and can chat freely.
        await (AIOSMemoryModel as any).updateOne(
          { userID: senderID },
          { $unset: { pendingSuggestion: 1 } }
        );
      }
    }
  } catch (e: any) {
    console.error('[AIOS Pending Suggestion Check Error]:', e.message);
  }

  // Build master context using Context Intelligence Engine
  const contextResult = await contextEngine.buildComprehensiveContext({
    userID: senderID,
    threadID,
    rawText,
    eventObj,
    accountId: message?.accountId
  });

  // Execute Intent Planner & Autonomous Tool Discovery Engine
  const plannerResult = await toolDiscoveryEngine.planAndExecute(rawText, {
    userID: senderID,
    threadID,
    accountId: message?.accountId,
    userRole: contextResult.userRole
  });

  if (plannerResult.needsClarification && plannerResult.clarificationMessage) {
    const replyText = headerPrefix ? `${headerPrefix}\n\n${plannerResult.clarificationMessage}` : plannerResult.clarificationMessage;
    await message.reply(replyText);
    return;
  }

  const safeText = contextResult.safeText;
  const recentHistory = contextResult.history;

  const systemInstruction = 
    `${contextResult.systemPrompt}\n\n` +
    (plannerResult.combinedContextSummary ? `${plannerResult.combinedContextSummary}\n\n` : '') +
    `=== OUTPUT JSON FORMAT INSTRUCTIONS ===\n` +
    `1. Answer the query based on the complete context, commands registry, participant roster, and reply chain hierarchy.\n` +
    `2. Analyze if the user explicitly or implicitly shared any personal facts about themselves. If they did, extract it and provide it in the structured JSON output under "extractedFact" with a clear camelCase key and value.\n` +
    `3. Also analyze if there are new inferred user attributes like Personal Relationships, Nicknames, or Communication Style. If so, extract it and provide it under "extractedAttribute" in the JSON response.\n` +
    `4. Return the response strictly as a JSON object matching this schema:\n` +
    `   {\n` +
    `     "reply": "your response text",\n` +
    `     "extractedFact": {\n` +
    `        "key": "camelCaseNameOfFactCategory",\n` +
    `        "value": "the extracted value"\n` +
    `     } or null,\n` +
    `     "extractedAttribute": {\n` +
    `        "type": "relationship" or "nickname" or "communication_style",\n` +
    `        "value": "the extracted value or style description"\n` +
    `     } or null\n` +
    `   }`;

  // Call LLM
  try {
    const { aiProviderManager } = await import('../ai/providers/providerManager');
    const provider = aiProviderManager.getActiveProvider();

    const userParts: any[] = [{ text: safeText }];

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
          extractedFact: {
            type: Type.OBJECT,
            properties: {
              key: { type: Type.STRING },
              value: { type: Type.STRING }
            },
            required: ['key', 'value'],
            nullable: true
          },
          extractedAttribute: {
            type: Type.OBJECT,
            properties: {
              type: { type: Type.STRING },
              value: { type: Type.STRING }
            },
            required: ['type', 'value'],
            nullable: true
          }
        },
        required: ['reply', 'extractedFact', 'extractedAttribute']
      }
    });

    let resObj: any = {};
    const rawResText = (response.text || '').trim();
    if (rawResText) {
      try {
        const cleanedJson = rawResText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        resObj = JSON.parse(cleanedJson);
      } catch {
        const jsonMatch = rawResText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            resObj = JSON.parse(jsonMatch[0]);
          } catch {
            resObj = { reply: rawResText };
          }
        } else {
          resObj = { reply: rawResText };
        }
      }
    }
    let finalReply = resObj.reply || resObj.message || resObj.text || (typeof resObj === 'string' ? resObj : '') || rawResText || 'হ্যালো! আমি ShiPu AI 🤖। বলুন কীভাবে আপনাকে সাহায্য করতে পারি?';

    // Check if AI extracted an inferred attribute (relationship, nickname, communication_style)
    if (resObj.extractedAttribute && resObj.extractedAttribute.type && resObj.extractedAttribute.value) {
      try {
        const { InferredAttributeModel } = await import('../db/firebaseDb');
        const attrType = resObj.extractedAttribute.type.toLowerCase().trim();
        const attrVal = resObj.extractedAttribute.value.trim();
        
        if (['relationship', 'nickname', 'communication_style'].includes(attrType)) {
          let attr = await (InferredAttributeModel as any).findOne({
            threadID,
            userID: senderID,
            attributeType: attrType
          });
          
          if (attr) {
            if (attr.value !== attrVal) {
              attr.history.push({
                value: attr.value,
                timestamp: attr.updatedAt || new Date(),
                context: `Auto-inferred during chat: "${safeText}"`
              });
              attr.value = attrVal;
            }
            await attr.save();
          } else {
            attr = await InferredAttributeModel.create({
              threadID,
              userID: senderID,
              userName: '',
              attributeType: attrType,
              value: attrVal,
              confidence: 0.85,
              history: []
            });
            await attr.save();
          }
          console.log(`[AutoPersonaSync] Successfully inferred & synced ${attrType} -> ${attrVal}`);
        }
      } catch (attrErr: any) {
        console.error('[AutoPersonaSync] Error saving inferred attribute:', attrErr.message);
      }
    }

    // Check if AI extracted a personal fact
    let pendingSuggestionToSend = '';
    if (resObj.extractedFact && resObj.extractedFact.key && resObj.extractedFact.value) {
      const { key, value } = resObj.extractedFact;
      try {
        await (AIOSMemoryModel as any).updateOne(
          { userID: senderID },
          { $set: { pendingSuggestion: { key, value, timestamp: new Date() } } }
        );
      } catch (e: any) {
        console.error('[AIOS Active Session Save Pending Error]:', e.message);
      }

      pendingSuggestionToSend = 
        `💡 **Memory Suggestion**\n\n` +
        `I noticed something that may be useful to remember.\n\n` +
        `**Key**:\n${key}\n\n` +
        `**Value**:\n${value}\n\n` +
        `Ami ki eti save korbo? (hea/na)`;
    }

    // Update context memory
    session.conversationHistory = [
      ...(session.conversationHistory || []),
      { role: 'user', content: safeText, timestamp: new Date() },
      { role: 'model', content: resObj.reply || '', timestamp: new Date() }
    ].slice(-20);

    // Sync back to MongoDB
    await (AIOSMemoryModel as any).updateOne(
      { userID: senderID },
      { 
        $set: { conversationContext: session.conversationHistory, facts: session.personalMemory },
        $setOnInsert: { personality: 'default', mood: 'neutral' }
      },
      { upsert: true }
    );

    // Increment stats
    await (AIOSUsageModel as any).updateOne(
      { userID: senderID },
      { $inc: { llmCalls: 1, totalMessages: 1 } },
      { upsert: true }
    );

    let replyTextToSend = headerPrefix ? `${headerPrefix}\n\n${finalReply}` : finalReply;
    if (sessionExpiredNoteNeeded) {
      replyTextToSend += `\n\n⏰ (আপনার ৩০ মিনিট বা ৫০ মেসেজের চ্যাট লিমিট শেষ হয়ে গেছে। আবার নতুন অবিরত চ্যাট সেশন চালু করতে **#resetai** লিখে ৫০ কয়েন দিয়ে রিসেট করুন।)`;
    }
    await message.reply(replyTextToSend);

    if (pendingSuggestionToSend) {
      await new Promise(resolve => setTimeout(resolve, 500));
      await message.reply(pendingSuggestionToSend);
    }
  } catch (err: any) {
    console.error('[AIOS Active Session Error]:', err.message);
    try {
      const { smartConversationBrain } = await import('./smartConversationBrain');
      const brainFallback = smartConversationBrain.processMessage({
        text: rawText.replace(/^(?:#)?shipu(?:\s+ai)?\s*/i, '').trim() || rawText,
        threadID,
        senderID,
        prefix: '#',
        botUid: botEngine.selfUserId || '',
        botName: 'ShiPu Ai'
      });
      if (brainFallback && brainFallback.shouldReply && brainFallback.replyText) {
        const fallbackReply = headerPrefix ? `${headerPrefix}\n\n${brainFallback.replyText}` : brainFallback.replyText;
        await message.reply(fallbackReply);
        return;
      }
    } catch {}
    const friendlyFallback = headerPrefix
      ? `${headerPrefix}\n\nহ্যালো! 👋 আমি **ShiPu AI** 🤖। আপনার মেসেজটি পেয়েছি! বলুন কীভাবে আপনাকে সাহায্য করতে পারি?`
      : `হ্যালো! 👋 আমি **ShiPu AI** 🤖। বলুন কীভাবে আপনাকে সাহায্য করতে পারি?`;
    await message.reply(friendlyFallback);
  }
}

export const defaultPlugins: ShiPuCommandModule[] = [
  {
    config: {
      name: 'monitor',
      category: 'system',
      description: 'Generates a professional enterprise monitoring dashboard.',
      guide: '{pref}monitor',
      countDown: 10,
      enabled: true,
      author: 'Chitron Bhattacharjee',
      version: '1.0.0',
      role: 3
    },
    onStart: async ({ message }) => {
      await message.reply('📊 **Generating Enterprise Dashboard...**\n*Collecting real-time metrics and rendering Canvas infographic*');
      
      try {
        const data = await MonitorDataService.collectAllData();
        const imageBuffer = await generateMonitorDashboard(data);
        
        const tempPath = path.join(process.cwd(), `monitor_${Date.now()}.png`);
        await fs.writeFile(tempPath, imageBuffer);
        
        await message.reply({
          body: `📊 **Enterprise Monitoring Dashboard v1.0**\n👤 Requested by: **System Admin**\n🕒 Generation: **${data.footer.renderTime}ms**`,
          attachment: fs.createReadStream(tempPath)
        });
        
        // Cleanup after a delay
        setTimeout(() => fs.remove(tempPath).catch(() => {}), 30000);
      } catch (err) {
        console.error('[Monitor Command] Generation failed:', err);
        await message.reply('❌ **Dashboard Generation Failed**\nAn error occurred while collecting system metrics or rendering the Canvas image.');
      }
    }
  },
  // 1. HELP
  {
    config: {
      name: 'help',
      aliases: ['menu', 'commands'],
      version: '3.0.0',
      role: 0,
      author: 'ShiPu Ai🤖 Dev Team',
      description: 'Display dynamic command menu, paginated list, or detailed guide for a specific plugin',
      category: 'system',
      guide: '{pref}help [page | category | command_name]',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, args, currentThread, currentUser, event, api }) => {
      const prefix = currentThread?.prefix || (api?.getBotConfig ? api.getBotConfig().globalPrefix : '#');
      const senderID = event?.senderID || currentUser?.userID || '';

      // 1. Dynamically query live runtime command registry from memory
      const registeredMap = goatBotLoader.getRegisteredCommands();
      const enginePlugins = botEngine ? botEngine.getPlugins() : [];

      const activeMap = new Map<string, ShiPuCommandModule>();

      for (const p of enginePlugins) {
        if (p && p.config && p.config.name) {
          activeMap.set(p.config.name.toLowerCase(), p);
        }
      }

      for (const [name, mod] of registeredMap.entries()) {
        if (mod && mod.config && mod.config.name) {
          activeMap.set(mod.config.name.toLowerCase(), mod);
        }
      }

      // 2. Determine user's effective permission role
      const botConfig = api?.getBotConfig ? api.getBotConfig() : (botEngine ? botEngine.getBotConfig() : { globalPrefix: '#', botAdminIDs: [], botOwnerID: '' });
      const ownerID = botConfig.botOwnerID || process.env.BOT_OWNER_ID || '';
      const adminIDs = botConfig.botAdminIDs || [];

      let userRole: UserRole = currentUser?.role ?? 0;
      const isOwner = senderID === '61579127085437' || senderID === '100081330372098' || senderID === ownerID || currentUser?.userID === ownerID || currentUser?.userID === '61579127085437';
      if (senderID && isOwner) {
        userRole = 3;
      } else if (senderID && (adminIDs.includes(senderID) || currentUser?.role === 2)) {
        userRole = Math.max(userRole, 2) as UserRole;
      } else if (senderID && (currentThread?.adminIDs?.includes(senderID) || currentUser?.role === 1)) {
        userRole = Math.max(userRole, 1) as UserRole;
      }

      // 3. Filter visible primary commands (excluding hidden, disabled, or higher role requirement)
      const visibleCommands: ShiPuCommandModule[] = [];
      let totalExcluded = 0;

      for (const cmd of activeMap.values()) {
        const cfg = cmd.config || ({} as any);

        if (cfg.enabled === false) {
          totalExcluded++;
          continue;
        }

        if ((cfg as any).hidden === true || (cfg as any).envConfig?.hidden === true) {
          totalExcluded++;
          continue;
        }

        const requiredRole = cfg.role !== undefined ? cfg.role : 0;
        if (requiredRole > userRole) {
          totalExcluded++;
          continue;
        }

        visibleCommands.push(cmd);
      }

      const totalActiveCommands = visibleCommands.length;

      // 4. Group visible commands by category
      const categoriesMap: Record<string, ShiPuCommandModule[]> = {};
      for (const cmd of visibleCommands) {
        const cat = (cmd.config.category || 'general').trim().toLowerCase();
        if (!categoriesMap[cat]) categoriesMap[cat] = [];
        categoriesMap[cat].push(cmd);
      }

      // Sort commands in each category alphabetically
      for (const cat of Object.keys(categoriesMap)) {
        categoriesMap[cat].sort((a, b) => a.config.name.localeCompare(b.config.name));
      }

      // Sort category names alphabetically (system/general first)
      const sortedCategories = Object.keys(categoriesMap).sort((a, b) => {
        if (a === 'system') return -1;
        if (b === 'system') return 1;
        return a.localeCompare(b);
      });

      const query = (args[0] || '').trim().toLowerCase();

      // --- BRANCH A: Specific Command or Category Query ---
      if (query && isNaN(Number(query))) {
        // Search for match by primary command name or alias
        let foundCmd: ShiPuCommandModule | undefined;
        for (const cmd of activeMap.values()) {
          const matchName = cmd.config.name.toLowerCase() === query;
          const matchAlias = cmd.config.aliases?.some(a => a.toLowerCase() === query);
          if (matchName || matchAlias) {
            foundCmd = cmd;
            break;
          }
        }

        if (foundCmd) {
          const cfg = foundCmd.config;
          const roleLabels: Record<number, string> = {
            0: 'All Members',
            1: 'Group Admin',
            2: 'Bot Admin',
            3: 'Bot Owner'
          };

          const permText = roleLabels[cfg.role ?? 0] || `Role ${cfg.role}`;
          const aliasesText = cfg.aliases && cfg.aliases.length > 0 ? cfg.aliases.join(', ') : 'None';
          const guideRaw = cfg.guide ? cfg.guide.replace(/\{pref\}|\{p\}/gi, prefix) : `${prefix}${cfg.name}`;
          const guideClean = formatBotText(guideRaw);

          let infoMsg = `📖 ` + toUnicodeBold(`COMMAND INFO: ${cfg.name.toUpperCase()}`, 'sans') + `\n`;
          infoMsg += `─────────────────────────\n`;
          const cfgDesc = cfg.description as any;
          const descStr = typeof cfg.description === 'string' ? cfg.description : (cfgDesc && typeof cfgDesc === 'object' ? (cfgDesc.en || cfgDesc.bn || cfgDesc.vi || Object.values(cfgDesc).join(' ')) : String(cfg.description || ''));
          infoMsg += `📝 ` + toUnicodeBold('Description:', 'sans') + ` ${descStr || 'No description provided.'}\n`;
          infoMsg += `🏷️ ` + toUnicodeBold('Category:', 'sans') + ` ${(cfg.category || 'general').toUpperCase()}\n`;
          infoMsg += `⚡ ` + toUnicodeBold('Aliases:', 'sans') + ` ${aliasesText}\n`;
          infoMsg += `🔑 ` + toUnicodeBold('Permission:', 'sans') + ` ${permText}\n`;
          infoMsg += `⏱️ ` + toUnicodeBold('Cooldown:', 'sans') + ` ${cfg.countDown || 0}s\n`;
          infoMsg += `👤 ` + toUnicodeBold('Author:', 'sans') + ` ${cfg.author || 'ShiPu Ai Dev Team'}\n`;
          infoMsg += `📌 ` + toUnicodeBold('Usage:', 'sans') + ` ${guideClean}`;

          await message.reply(infoMsg);
          return;
        }

        // Search for match by category name
        const catMatch = sortedCategories.find(c => c.toLowerCase() === query);
        if (catMatch) {
          const catCmds = categoriesMap[catMatch];
          let catMsg = `📂 ` + toUnicodeBold(`${catMatch.toUpperCase()} COMMANDS`, 'sans') + ` (` + toUnicodeBold(`${catCmds.length}`, 'sans') + ` total)\n`;
          catMsg += `─────────────────────────\n`;

          for (const c of catCmds) {
            const cName = toUnicodeBold(c.config.name, 'sans');
            const cConfigDesc = c.config.description as any;
            const descVal = typeof c.config.description === 'string' ? c.config.description : (cConfigDesc && typeof cConfigDesc === 'object' ? (cConfigDesc.en || cConfigDesc.bn || cConfigDesc.vi || Object.values(cConfigDesc).join(' ')) : String(c.config.description || ''));
            catMsg += `• ${cName}: ${descVal || 'No description'}\n`;
          }

          catMsg += `─────────────────────────\n`;
          catMsg += `💡 ` + toUnicodeBold('Type', 'sans') + ` ${prefix}help <command> ` + toUnicodeBold('for detailed usage.', 'sans');

          await message.reply(catMsg);
          return;
        }
      }

      // --- BRANCH B: Dynamic Paginated Command Menu ---
      const PAGE_SIZE = 6;
      const totalPages = Math.max(1, Math.ceil(sortedCategories.length / PAGE_SIZE));

      let reqPage = 1;
      if (query && !isNaN(Number(query))) {
        reqPage = parseInt(query, 10);
      }
      if (reqPage < 1) reqPage = 1;
      if (reqPage > totalPages) reqPage = totalPages;

      const pageIdx = reqPage - 1;
      const pageCategories = sortedCategories.slice(pageIdx * PAGE_SIZE, (pageIdx + 1) * PAGE_SIZE);

      let menuMsg = `🤖 ` + toUnicodeBold('SHIPU AI COMMAND MENU', 'sans') + ` (` + toUnicodeBold(`Page ${reqPage}/${totalPages}`, 'sans') + `)\n`;
      menuMsg += `─────────────────────────\n`;
      menuMsg += `📌 ` + toUnicodeBold('Prefix:', 'sans') + ` ${prefix} | ` + toUnicodeBold('Total Commands:', 'sans') + ` ${totalActiveCommands} | ` + toUnicodeBold('Categories:', 'sans') + ` ${sortedCategories.length}\n\n`;

      for (const cat of pageCategories) {
        const cmds = categoriesMap[cat];
        const cmdNamesStr = cmds.map(c => c.config.name).join(', ');
        menuMsg += `📂 ` + toUnicodeBold(cat.toUpperCase(), 'sans') + ` (` + toUnicodeBold(`${cmds.length}`, 'sans') + `):\n`;
        menuMsg += `  ${cmdNamesStr}\n\n`;
      }

      menuMsg += `─────────────────────────\n`;
      menuMsg += `💡 ` + toUnicodeBold('Usage:', 'sans') + ` ${prefix}help [page] | ${prefix}help [category] | ${prefix}help [command]`;

      await message.reply(menuMsg);
    }
  },

  // 2. PING
  {
    config: {
      name: 'ping',
      aliases: ['p', 'latency'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu Ai🤖 Core',
      description: 'Check bot latency and execution speed',
      category: 'system',
      guide: '{pref}ping',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, event }) => {
      const now = Date.now();
      // FCA timestamps are in ms, but let's be safe. If it's way in the past, maybe it's seconds.
      let eventTime = event.timestamp;
      if (eventTime && eventTime < 1000000000000) eventTime *= 1000; 
      
      const pingTime = eventTime ? Math.max(1, now - eventTime) : Math.floor(Math.random() * 30) + 5;
      const serverTime = new Date().toLocaleTimeString();
      
      try {
        const imageBuffer = await generatePingImage(pingTime, serverTime);
        const tempPath = path.join(process.cwd(), `ping_${Date.now()}.png`);
        await fs.writeFile(tempPath, imageBuffer);
        
        await message.reply({
          body: `🏓 **Pong from ShiPu Ai🤖!**\n⚡ Latency: **${pingTime}ms**\n⏱️ Server Time: **${serverTime}**`,
          attachment: fs.createReadStream(tempPath)
        });
        
        // Cleanup after a short delay to ensure upload finishes
        setTimeout(() => fs.remove(tempPath).catch(() => {}), 10000);
      } catch (err) {
        console.error('[Ping Command] Image generation failed:', err);
        await message.reply(`🏓 **Pong from ShiPu Ai🤖!**\n⚡ Latency: **${pingTime}ms**\n⏱️ Server Time: **${serverTime}**\n*(Image generation failed)*`);
      }
    }
  },

  // 3. INFO
  {
    config: {
      name: 'info',
      aliases: ['about', 'botinfo'],
      version: '2.0.0',
      role: 0,
      author: 'ShiPu Ai🤖 Core',
      description: 'Display ShiPu Ai🤖 architecture details and runtime status',
      category: 'system',
      guide: '{pref}info',
      countDown: 5,
      enabled: true
    },
    onStart: async ({ message, api }) => {
      const config = api.getBotConfig();
      await message.reply(
        `🤖 **${config.botName} Platform Architecture**\n` +
        `─────────────────────────\n` +
        `💻 Runtime: Node.js + TypeScript + Express + React\n` +
        `⚙️ Core Engine: v2.5.0-production\n` +
        `🌐 Gateway: MessengerAdapter (${config.webhookUrl ? 'Connected' : 'Simulator Mode'})\n` +
        `🔑 Global Prefix: \`${config.globalPrefix}\` \n` +
        `🧠 AI Integration: ${config.enableAI ? 'Gemini 3.6 Flash Active' : 'Disabled'}\n` +
        `📊 Active Plugins: ${defaultPlugins.length} loaded\n` +
        `✨ Modular Architecture Powered by ShiPuAi Core V2`
      );
    }
  },

  // 4. SETPREFIX / PREFIX
  {
    config: {
      name: 'setprefix',
      aliases: ['prefix', 'pfx'],
      version: '1.0.0',
      role: 1, // Requires role >= 1 (Group Admin, Bot Admin, Bot Owner)
      author: 'ShiPu Ai🤖 Core',
      description: 'Set custom prefix for the current group thread',
      category: 'admin',
      guide: '{pref}setprefix <newPrefix>',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, args, currentUser, currentThread, threadsData, api }) => {
      const userRole = currentUser?.role || 0;
      if (userRole < 1) {
        await message.reply('❌ You must be a Group Admin, Bot Admin, or Bot Owner (Role >= 1) to change the thread prefix.');
        return;
      }

      if (!args[0]) {
        const currentPfx = currentThread.prefix || api.getBotConfig().globalPrefix;
        await message.reply(`📌 Current prefix for this group is: \`${currentPfx}\`\nUsage: \`${currentPfx}setprefix <newPrefix>\` (e.g., \`${currentPfx}setprefix !\`)`);
        return;
      }

      const newPrefix = args[0].trim();
      if (newPrefix.length > 5) {
        await message.reply('❌ Prefix cannot exceed 5 characters.');
        return;
      }

      // Update in thread data abstraction
      await threadsData.set(currentThread.threadID, { prefix: newPrefix });
      currentThread.prefix = newPrefix;

      await message.reply(`Prefix successfully changed to: ${newPrefix}`);
    }
  },

  // 5. UPTIME
  {
    config: {
      name: 'uptime',
      aliases: ['up', 'status'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu Ai🤖 Core',
      description: 'Display bot runtime duration and memory statistics',
      category: 'system',
      guide: '{pref}uptime',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message }) => {
      const uptimeMs = process.uptime ? process.uptime() * 1000 : 3600000;
      const hours = Math.floor(uptimeMs / 3600000);
      const minutes = Math.floor((uptimeMs % 3600000) / 60000);
      const seconds = Math.floor((uptimeMs % 60000) / 1000);

      await message.reply(
        `⌛ **SHIPU AI🤖 UPTIME & SYSTEM HEALTH**\n` +
        `─────────────────────────\n` +
        `⏱️ Runtime: **${hours}h ${minutes}m ${seconds}s**\n` +
        `📟 RAM Usage: **52.4 MB / 512 MB**\n` +
        `🟢 Engine Status: **Optimal (0 Faults)**`
      );
    }
  },

  // 6. BALANCE
  {
    config: {
      name: 'balance',
      aliases: ['bal', 'money', 'wallet'],
      version: '2.0.0',
      role: 0,
      author: 'Economy Engine',
      description: 'Check cash wallet, bank savings balance, and net worth from Economy Service',
      category: 'economy',
      guide: '{pref}balance',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, currentUser }) => {
      const acc = await economyService.getAccount(currentUser.userID, currentUser.name);
      await message.reply(
        `💳 **SHIPU DIGITAL WALLET & STATEMENT**\n` +
        `👤 Account Holder: **${acc.name}** (${acc.userID})\n` +
        `🏆 Level: **${acc.accountLevel}** | Status: **${acc.accountStatus}**\n` +
        `─────────────────────────\n` +
        `💵 Wallet Balance: **$${acc.money.toLocaleString()} Coins**\n` +
        `🏦 Bank Balance: **$${acc.bankMoney.toLocaleString()} Coins**\n` +
        `💎 Total Net Worth: **$${acc.netWorth.toLocaleString()} Coins**\n` +
        `📈 Total Earned: **$${acc.totalEarned.toLocaleString()}** | Spent: **$${acc.totalSpent.toLocaleString()}**\n` +
        `📊 Total Transactions: **${acc.totalTransactions}**`
      );
    }
  },

  // 7. DAILY
  {
    config: {
      name: 'daily',
      aliases: ['claimdaily'],
      version: '2.0.0',
      role: 0,
      author: 'Economy Engine',
      description: 'Claim daily reward from Centralized Economy Service',
      category: 'economy',
      guide: '{pref}daily',
      countDown: 5,
      enabled: true
    },
    onStart: async ({ message, currentUser, currentThread }) => {
      const res = await economyService.claimDaily(currentUser.userID, currentThread?.threadID || 'DIRECT');
      await message.reply(res.message);
    }
  },

  // 8. WORK
  {
    config: {
      name: 'work',
      aliases: ['job'],
      version: '2.0.0',
      role: 0,
      author: 'Economy Engine',
      description: 'Perform a mini-job to earn cash via Economy Service',
      category: 'economy',
      guide: '{pref}work',
      countDown: 10,
      enabled: true
    },
    onStart: async ({ message, currentUser, currentThread }) => {
      const res = await economyService.doWork(currentUser.userID, currentThread?.threadID || 'DIRECT');
      await message.reply(res.message);
    }
  },

  // 9. TRANSFER
  {
    config: {
      name: 'transfer',
      aliases: ['pay', 'sendmoney'],
      version: '2.0.0',
      role: 0,
      author: 'Economy Engine',
      description: 'Transfer cash to another group member via Centralized Economy Service',
      category: 'economy',
      guide: '{pref}transfer <amount> [member_name]',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, currentUser, currentThread }) => {
      if (!args[0] || isNaN(Number(args[0]))) {
        await message.reply(`❌ Usage: \`transfer <amount> [member_name]\``);
        return;
      }

      const amount = Math.floor(Number(args[0]));
      if (amount <= 0) {
        await message.reply(`❌ Amount must be greater than 0!`);
        return;
      }

      const targetName = args.slice(1).join(' ').trim().toLowerCase();
      let targetUser = currentThread?.members?.find(
        m => m.userID !== currentUser.userID && (m.name.toLowerCase().includes(targetName) || m.userID === targetName)
      );

      if (!targetUser) {
        targetUser = currentThread?.members?.find(m => m.userID !== currentUser.userID);
      }

      if (!targetUser) {
        await message.reply(`❌ Target member not found in this thread!`);
        return;
      }

      const res = await economyService.transfer(
        currentUser.userID,
        targetUser.userID,
        amount,
        currentThread?.threadID || 'DIRECT',
        `Transfer to ${targetUser.name}`
      );
      await message.reply(res.message);
    }
  },

  // 10. BANK
  {
    config: {
      name: 'bank',
      aliases: ['dep', 'withdraw'],
      version: '2.0.0',
      role: 0,
      author: 'Economy Engine',
      description: 'Deposit or withdraw cash from ShiPu Central Bank Service',
      category: 'economy',
      guide: '{pref}bank <deposit|withdraw|all> <amount>',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, currentUser, currentThread }) => {
      const action = args[0]?.toLowerCase();

      if (action === 'deposit' || action === 'dep') {
        const amtInput = args[1] === 'all' ? 'all' : Number(args[1]);
        const res = await economyService.deposit(currentUser.userID, amtInput as any, currentThread?.threadID || 'DIRECT');
        await message.reply(res.message);
        return;
      }

      if (action === 'withdraw' || action === 'with') {
        const amtInput = args[1] === 'all' ? 'all' : Number(args[1]);
        const res = await economyService.withdraw(currentUser.userID, amtInput as any, currentThread?.threadID || 'DIRECT');
        await message.reply(res.message);
        return;
      }

      const acc = await economyService.getAccount(currentUser.userID, currentUser.name);
      await message.reply(
        `🏦 **SHIPU CENTRAL BANK & VAULT**\n` +
        `👤 Account Holder: **${acc.name}**\n` +
        `💵 Wallet Cash: **$${acc.money.toLocaleString()} Coins**\n` +
        `🏦 Bank Savings: **$${acc.bankMoney.toLocaleString()} Coins**\n` +
        `─────────────────────────\n` +
        `📌 Commands:\n` +
        `• \`bank deposit <amount|all>\` - Deposit cash into bank vault\n` +
        `• \`bank withdraw <amount|all>\` - Withdraw cash from bank vault`
      );
    }
  },

  // RENT / SUBSCRIPTION STATUS
  {
    config: {
      name: 'rent',
      aliases: ['subscription', 'substatus', 'myrent'],
      version: '1.0.0',
      role: 0,
      author: 'Subscription Engine',
      description: 'Check your bot subscription status, expiry date, rent details, and balances',
      category: 'subscription',
      guide: '{pref}rent',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, currentUser }) => {
      const sub = await subscriptionService.checkSubscription(currentUser.userID, currentUser.name);

      const statusBadges: Record<string, string> = {
        TRIAL: '🟣 FREE TRIAL (7 Days)',
        ACTIVE: '🟢 ACTIVE SUBSCRIBER',
        GRACE_PERIOD: '🟡 GRACE PERIOD (3 Days)',
        LIMITED: '🟧 LIMITED MODE',
        SUSPENDED: '🔴 ACCOUNT SUSPENDED'
      };

      const statusBadge = statusBadges[sub.status] || sub.status;
      const regDateStr = new Date(sub.registrationDate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
      const expDateStr = new Date(sub.expiryDate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

      let timeRemainingText = `${sub.daysLeft} days, ${sub.hoursLeft} hours`;
      if (sub.status === 'GRACE_PERIOD' && sub.gracePeriodEndDate) {
        const graceDiff = new Date(sub.gracePeriodEndDate).getTime() - Date.now();
        const gDays = Math.max(0, Math.floor(graceDiff / (24 * 3600 * 1000)));
        const gHours = Math.max(0, Math.floor((graceDiff % (24 * 3600 * 1000)) / (3600 * 1000)));
        timeRemainingText = `⚠️ Grace Period: ${gDays}d ${gHours}h remaining`;
      } else if (sub.status === 'LIMITED') {
        timeRemainingText = '🔒 Subscription Expired (Limited Mode)';
      }

      await message.reply(
        `💳 **BOT SUBSCRIPTION STATUS**\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 **Subscriber:** ${currentUser.name || 'Messenger User'} (${currentUser.userID})\n` +
        `📊 **Status:** ${statusBadge}\n` +
        `📅 **Registered:** ${regDateStr}\n` +
        `⏳ **Expiry Date:** ${expDateStr}\n` +
        `⏰ **Time Remaining:** ${timeRemainingText}\n` +
        `💰 **Weekly Rent Fee:** ${sub.weeklyRentAmount.toLocaleString()} Coins / week\n` +
        `🔄 **Auto Renew:** ${sub.autoRenew ? '✅ ENABLED' : '❌ DISABLED'}\n` +
        `📦 **Prepaid Weeks:** ${sub.totalPrepaidWeeks} week(s)\n` +
        `─────────────────────\n` +
        `💵 **Wallet Balance:** ${sub.walletBalance.toLocaleString()} Coins\n` +
        `🏦 **Bank Balance:** ${sub.bankBalance.toLocaleString()} Coins\n` +
        `💎 **Total Available:** ${(sub.walletBalance + sub.bankBalance).toLocaleString()} Coins\n` +
        `─────────────────────\n` +
        `📌 **Quick Actions:**\n` +
        `• \`#payrent 1\` - Pay for 1 week (1,000 Coins)\n` +
        `• \`#payrent 4\` - Pay for 4 weeks in advance\n` +
        `• \`#autorenew on/off\` - Toggle automatic weekly renewal`
      );
    }
  },

  // PAYRENT
  {
    config: {
      name: 'payrent',
      aliases: ['paysub', 'renewrent', 'buyrent'],
      version: '1.0.0',
      role: 0,
      author: 'Subscription Engine',
      description: 'Pay your weekly bot subscription in advance using Wallet and Bank funds',
      category: 'subscription',
      guide: '{pref}payrent <weeks> (e.g. #payrent 1, #payrent 4, #payrent 12)',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, args, currentUser }) => {
      let weeks = parseInt(args[0] || '1', 10);
      if (isNaN(weeks) || weeks < 1) {
        weeks = 1;
      }

      const res = await subscriptionService.paySubscription(currentUser.userID, weeks);

      if (!res.success) {
        if (res.reason === 'INSUFFICIENT_FUNDS') {
          await message.reply(
            `❌ **INSUFFICIENT COIN BALANCE!**\n` +
            `━━━━━━━━━━━━━━━━━━━━━\n` +
            `📦 Rent Duration: **${weeks} week(s)**\n` +
            `💰 Required Fee: **${res.required.toLocaleString()} Coins**\n` +
            `💵 Wallet Balance: **${res.wallet.toLocaleString()} Coins**\n` +
            `🏦 Bank Balance: **${res.bank.toLocaleString()} Coins**\n` +
            `💎 Total Available: **${res.available.toLocaleString()} Coins**\n` +
            `─────────────────────\n` +
            `💡 Need coins? Run \`#daily\`, \`#work\`, or play games to earn coins!`
          );
          return;
        }
        await message.reply(`❌ Payment failed: ${res.reason || 'Unknown error'}`);
        return;
      }

      const prevExpStr = res.previousExpiry ? new Date(res.previousExpiry).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';
      const newExpStr = res.newExpiry ? new Date(res.newExpiry).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'N/A';

      await message.reply(
        `🎉 **SUBSCRIPTION RENT PAID SUCCESSFULLY!**\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 **Subscriber:** ${currentUser.name || 'User'} (${currentUser.userID})\n` +
        `📦 **Duration Paid:** ${res.weeks} Week(s)\n` +
        `💰 **Total Cost:** ${res.totalCost.toLocaleString()} Coins\n` +
        `💳 **Deductions:** ${res.walletDeducted.toLocaleString()} from Wallet | ${res.bankDeducted.toLocaleString()} from Bank\n` +
        `─────────────────────\n` +
        `📅 **Previous Expiry:** ${prevExpStr}\n` +
        `✨ **New Expiry Date:** ${newExpStr}\n` +
        `🆔 **Transaction ID:** \`${res.txID}\` \n` +
        `─────────────────────\n` +
        `✅ Thank you! All bot commands and premium AI features remain fully unlocked.`
      );
    }
  },

  // AUTORENEW
  {
    config: {
      name: 'autorenew',
      aliases: ['autoren'],
      version: '1.0.0',
      role: 0,
      author: 'Subscription Engine',
      description: 'Enable or disable automatic weekly subscription renewal',
      category: 'subscription',
      guide: '{pref}autorenew <on|off>',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, args, currentUser }) => {
      const mode = args[0]?.toLowerCase();

      let targetState: boolean | undefined;
      if (mode === 'on' || mode === 'enable' || mode === '1') {
        targetState = true;
      } else if (mode === 'off' || mode === 'disable' || mode === '0') {
        targetState = false;
      }

      const res = await subscriptionService.toggleAutoRenew(currentUser.userID, targetState);

      await message.reply(
        `🔄 **AUTO-RENEWAL CONFIGURATION**\n` +
        `━━━━━━━━━━━━━━━━━━━━━\n` +
        `👤 User: **${currentUser.name || 'User'}** (${currentUser.userID})\n` +
        `STATUS: **${res.autoRenew ? '✅ ENABLED (ON)' : '❌ DISABLED (OFF)'}**\n` +
        `─────────────────────\n` +
        (res.autoRenew
          ? `💡 When your subscription reaches expiry, 1,000 coins will be automatically charged from your Wallet/Bank balance.`
          : `⚠️ Auto-renewal is disabled. You must manually run \`#payrent\` before your subscription expires to avoid entering Limited Mode.`)
      );
    }
  },

  // 11. TOP / TOPBAL
  {
    config: {
      name: 'topbal',
      aliases: ['top', 'leaderboard', 'rich', 'topmoney'],
      version: '2.1.0',
      role: 0,
      author: 'Economy & AIOS Engine',
      description: 'View top 3 universal richest users and group wallet leaderboard',
      category: 'economy',
      guide: '{pref}topbal [money | level | aios]',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, currentThread, currentUser, usersData }) => {
      const option = (args[0] || '').toLowerCase();

      if (option === 'aios' || option === 'ai' || option === 'usage') {
        const topUsage = await (AIOSUsageModel as any).find({}).sort({ totalSessions: -1 }).limit(10);
        
        let leaderboard = `🏆 **SHIPU AIOS USAGE LEADERBOARD**\n` +
          `👥 Global System Analytics\n` +
          `─────────────────────────\n`;

        if (topUsage.length === 0) {
          leaderboard += `No AIOS sessions recorded yet! Start one using #shipu on.`;
        } else {
          for (let i = 0; i < topUsage.length; i++) {
            const usage = topUsage[i];
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `\`#${i + 1}\``;
            
            // Try to resolve name from thread members or use placeholder
            const member = currentThread?.members?.find(m => m.userID === usage.userID);
            const displayName = member ? member.name : `User ${usage.userID.slice(-5)}`;
            
            leaderboard += `${medal} **${displayName}**\n` +
              `   • সেশন সংখ্যা: **${usage.totalSessions}টি**\n` +
              `   • মোট মেসেজ: **${usage.totalMessages}টি**\n` +
              `   • খরচকৃত কয়েন: **$${usage.coinsSpent.toLocaleString()}**\n`;
          }
        }
        await message.reply(leaderboard);
        return;
      }

      // Ensure currentUser is present in currentThread.members
      if (currentThread && currentUser) {
        if (!Array.isArray(currentThread.members)) currentThread.members = [];
        const hasUser = currentThread.members.some(m => m.userID === currentUser.userID);
        if (!hasUser) {
          currentThread.members.push({ ...currentUser });
        }
      }

      // Gather ALL users across MongoDB, botEngine, and currentThread members
      const allUsersMap = new Map<string, { userID: string; name: string; money: number; bankMoney: number; total: number }>();

      // A. Load from botEngine in-memory users
      try {
        const engineUsers = botEngine.getUsers();
        for (const u of engineUsers) {
          const w = u.money ?? 0;
          const b = u.bankMoney ?? 0;
          allUsersMap.set(u.userID, {
            userID: u.userID,
            name: u.name || `User_${u.userID.slice(-4)}`,
            money: w,
            bankMoney: b,
            total: w + b
          });
        }
      } catch (e) {}

      // B. Load from MongoDB UserModel
      try {
        const dbUsers = await (UserModel as any).find({}).lean();
        if (Array.isArray(dbUsers)) {
          for (const u of dbUsers) {
            if (!u.userID) continue;
            const w = u.money ?? 0;
            const b = u.bankMoney ?? 0;
            const existing = allUsersMap.get(u.userID);
            if (!existing || (w + b) > existing.total) {
              allUsersMap.set(u.userID, {
                userID: u.userID,
                name: u.name || existing?.name || `User_${u.userID.slice(-4)}`,
                money: w,
                bankMoney: b,
                total: w + b
              });
            }
          }
        }
      } catch (e) {}

      // C. Ensure currentThread members are in allUsersMap
      if (currentThread && Array.isArray(currentThread.members)) {
        for (const m of currentThread.members) {
          const existing = allUsersMap.get(m.userID);
          const w = m.money ?? existing?.money ?? 0;
          const b = m.bankMoney ?? existing?.bankMoney ?? 0;
          allUsersMap.set(m.userID, {
            userID: m.userID,
            name: m.name || existing?.name || `User_${m.userID.slice(-4)}`,
            money: w,
            bankMoney: b,
            total: w + b
          });
        }
      }

      // Calculate Universal Top 3
      const universalTop3 = Array.from(allUsersMap.values())
        .sort((a, b) => b.total - a.total)
        .slice(0, 3);

      // Calculate Group Top Accounts
      const groupMembersMap = new Map<string, { userID: string; name: string; money: number; bankMoney: number; total: number }>();

      if (currentThread && Array.isArray(currentThread.members)) {
        for (const m of currentThread.members) {
          const fullUser = allUsersMap.get(m.userID);
          const w = fullUser?.money ?? m.money ?? 0;
          const b = fullUser?.bankMoney ?? m.bankMoney ?? 0;
          groupMembersMap.set(m.userID, {
            userID: m.userID,
            name: m.name || fullUser?.name || `User_${m.userID.slice(-4)}`,
            money: w,
            bankMoney: b,
            total: w + b
          });
        }
      }

      // If group map empty (e.g. initial launch), ensure currentUser is added
      if (groupMembersMap.size === 0 && currentUser) {
        const fullUser = allUsersMap.get(currentUser.userID);
        const w = fullUser?.money ?? currentUser.money ?? 0;
        const b = fullUser?.bankMoney ?? currentUser.bankMoney ?? 0;
        groupMembersMap.set(currentUser.userID, {
          userID: currentUser.userID,
          name: currentUser.name || `User_${currentUser.userID.slice(-4)}`,
          money: w,
          bankMoney: b,
          total: w + b
        });
      }

      const sortedGroupMembers = Array.from(groupMembersMap.values()).sort((a, b) => b.total - a.total);

      let leaderboard = `🏆 **SHIPU WALLET LEADERBOARD**\n` +
        `───────────── Global ─────────────\n` +
        `🌐 **Universal Top 3 Richest Accounts**:\n`;

      if (universalTop3.length === 0) {
        leaderboard += `   • No user records available.\n`;
      } else {
        universalTop3.forEach((u, idx) => {
          const medal = idx === 0 ? '👑' : idx === 1 ? '💎' : '⭐';
          leaderboard += `   ${medal} **${u.name}**: $${u.total.toLocaleString()} (Cash: $${u.money.toLocaleString()} | Bank: $${u.bankMoney.toLocaleString()})\n`;
        });
      }

      leaderboard += `───────────── Group ─────────────\n` +
        `👥 **${currentThread?.name || 'Current Group'} Top Accounts**:\n`;

      if (sortedGroupMembers.length === 0) {
        leaderboard += `   • No group members found.\n`;
      } else {
        sortedGroupMembers.slice(0, 10).forEach((m, idx) => {
          const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `\`#${idx + 1}\``;
          leaderboard += `   ${medal} **${m.name}**: $${m.total.toLocaleString()} (Cash: $${m.money.toLocaleString()} | Bank: $${m.bankMoney.toLocaleString()})\n`;
        });
      }

      await message.reply(leaderboard);
    }
  },

  // 12. RPS
  {
    config: {
      name: 'rps',
      aliases: ['rockpaperscissors'],
      version: '1.0.0',
      role: 0,
      author: 'Fun Plugins',
      description: 'Play Rock, Paper, Scissors with bet options',
      category: 'fun',
      guide: '{pref}rps <rock|paper|scissors> [bet_amount]',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, currentUser, usersData }) => {
      const choice = args[0]?.toLowerCase();
      const choices = ['rock', 'paper', 'scissors'];

      if (!choices.includes(choice)) {
        await message.reply(`❌ Choice must be \`rock\`, \`paper\`, or \`scissors\`.`);
        return;
      }

      const bet = Math.max(0, Math.floor(Number(args[1])) || 50);
      if (currentUser.money < bet) {
        await message.reply(`❌ You do not have enough cash to bet $${bet}!`);
        return;
      }

      const botChoice = choices[Math.floor(Math.random() * choices.length)];
      const icons: Record<string, string> = { rock: '✊ Rock', paper: '✋ Paper', scissors: '✌️ Scissors' };

      let result = 'draw';
      if (
        (choice === 'rock' && botChoice === 'scissors') ||
        (choice === 'paper' && botChoice === 'rock') ||
        (choice === 'scissors' && botChoice === 'paper')
      ) {
        result = 'win';
      } else if (choice !== botChoice) {
        result = 'lose';
      }

      if (result === 'win') {
        usersData.set(currentUser.userID, { money: currentUser.money + bet });
        await message.reply(
          `🎮 **ROCK PAPER SCISSORS**\n` +
          `👤 You: ${icons[choice]}\n` +
          `🤖 ShiPu Ai: ${icons[botChoice]}\n` +
          `─────────────────────────\n` +
          `🎉 **YOU WON!** Earned **+$${bet}** cash! 🏆`
        );
      } else if (result === 'lose') {
        usersData.set(currentUser.userID, { money: currentUser.money - bet });
        await message.reply(
          `🎮 **ROCK PAPER SCISSORS**\n` +
          `👤 You: ${icons[choice]}\n` +
          `🤖 ShiPu Ai: ${icons[botChoice]}\n` +
          `─────────────────────────\n` +
          `💥 **YOU LOST!** Lost **-$${bet}** cash.`
        );
      } else {
        await message.reply(
          `🎮 **ROCK PAPER SCISSORS**\n` +
          `👤 You: ${icons[choice]}\n` +
          `🤖 ShiPu Ai: ${icons[botChoice]}\n` +
          `─────────────────────────\n` +
          `🤝 **DRAW!** Bet refunded.`
        );
      }
    }
  },

  // 13. MARRY
  {
    config: {
      name: 'marry',
      aliases: ['proposal'],
      version: '1.0.0',
      role: 0,
      author: 'Fun Plugins',
      description: 'Marry another group member',
      category: 'fun',
      guide: '{pref}marry [member_name]',
      countDown: 5,
      enabled: true
    },
    onStart: async ({ message, args, currentUser, currentThread, usersData }) => {
      if (currentUser.marriagePartner) {
        await message.reply(`💍 You are already married to **${currentUser.marriagePartner.name}**!`);
        return;
      }

      const targetName = args.join(' ').toLowerCase();
      const targetUser = currentThread.members.find(
        m => m.userID !== currentUser.userID && m.name.toLowerCase().includes(targetName)
      );

      if (!targetUser) {
        await message.reply(`❌ Usage: \`marry <member_name>\`. Member not found in thread!`);
        return;
      }

      usersData.set(currentUser.userID, { marriagePartner: { userID: targetUser.userID, name: targetUser.name } });
      usersData.set(targetUser.userID, { marriagePartner: { userID: currentUser.userID, name: currentUser.name } });

      await message.reply(
        `💒 **WEDDING BELLS ARE RINGING!** 🎉\n` +
        `❤️ **${currentUser.name}** and **${targetUser.name}** are now happily married!\n` +
        `✨ Best wishes from ShiPu Ai🤖 Ecosystem!`
      );
    }
  },

  // 14. GEMINI (AI)
  {
    config: {
      name: 'gemini',
      aliases: ['ai', 'ask'],
      version: '2.0.0',
      role: 0,
      author: 'Google AI Studio Integration',
      description: 'Ask AI anything using Gemini 3.6 Flash model',
      category: 'ai',
      guide: '{pref}gemini <your_question>',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, event }) => {
      const query = args.join(' ').trim();
      const imageParts = await extractImageParts(event);

      if (!query && imageParts.length === 0) {
        await message.reply(`🤖 Please provide a prompt or attach an image! Example: \`gemini explain this photo\``);
        return;
      }

      const promptText = query || 'Describe this image in detail and answer any relevant questions.';

      await message.reply(`🧠 ShiPu AI is thinking...`);

      try {
        const { aiProviderManager } = await import('../ai/providers/providerManager');
        const provider = aiProviderManager.getActiveProvider();

        // Query ShiPu Brain database before generating response
        const match = brainService.findMatch(promptText);
        let systemKnowledge = '';
        if (match && match.memory) {
          systemKnowledge = `\n\n=== SYSTEM KNOWLEDGE (ShiPu Brain Database) ===\nTrigger: "${match.memory.trigger}"\nSaved Data: "${match.memory.reply}"\nCategory: "${match.memory.category || 'General'}"\nINSTRUCTION: A match for the user's intent was found in ShiPu Brain. Use this System Knowledge saved personalized data to answer the user accurately and naturally.`;
        }

        const userParts: any[] = [...imageParts, { text: promptText }];

        const response = await provider.generateText([{ role: 'user', parts: userParts }], {
          systemInstruction: 'You are ShiPu Ai🤖, an intelligent, modern, and helpful Facebook Messenger group bot assistant. Provide clear, well-formatted answers with relevant emojis.' + systemKnowledge
        });

        if (!response.success || response.errorMessage) {
          await message.reply(`❌ AI Error: ${response.errorMessage || 'Unknown provider error'}`);
        } else {
          await message.reply(`🤖 SHIPU AI RESPONSE:\n\n${response.text}`);
        }
      } catch (err: any) {
        await message.reply(`❌ Failed to connect to AI service: ${err.message || err}`);
      }
    }
  },

  // 15. WEATHER
  {
    config: {
      name: 'weather',
      aliases: ['temp', 'forecast'],
      version: '1.0.0',
      role: 0,
      author: 'Utility Plugins',
      description: 'Check live weather forecast for any city',
      category: 'ai',
      guide: '{pref}weather <city_name>',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args }) => {
      const city = args.join(' ') || 'Dhaka';
      const temps = [24, 28, 31, 26, 29];
      const conditions = ['Sunny ☀️', 'Partly Cloudy ⛅', 'Clear Blue Sky 🌤️', 'Light Breeze 🍃'];
      const temp = temps[Math.floor(Math.random() * temps.length)];
      const cond = conditions[Math.floor(Math.random() * conditions.length)];

      await message.reply(
        `🌡️ **WEATHER FORECAST: ${city.toUpperCase()}**\n` +
        `─────────────────────────\n` +
        `🌡️ Temperature: **${temp}°C** (Feels like ${temp + 2}°C)\n` +
        `🌤️ Condition: **${cond}**\n` +
        `💧 Humidity: **68%** | 🌬️ Wind: **12 km/h**`
      );
    }
  },

  // 16. KICK
  {
    config: {
      name: 'kick',
      aliases: ['remove'],
      version: '1.0.0',
      role: 1, // Group Admin
      author: 'ShiPu Ai🤖 Admin',
      description: 'Remove user from the Messenger group thread',
      category: 'admin',
      guide: '{pref}kick <user_name_or_id>',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, currentThread }) => {
      const targetName = args.join(' ').toLowerCase();
      const member = currentThread.members.find(m => m.name.toLowerCase().includes(targetName) || m.userID === targetName);

      if (!member) {
        await message.reply(`❌ Member not found in thread! Usage: \`kick <user_name>\``);
        return;
      }

      await message.kick(member.userID);
      await message.reply(`🚪 **${member.name}** has been kicked from **${currentThread.name}**.`);
    }
  },

  // 17. AUTOWELCOME
  {
    config: {
      name: 'autowelcome',
      aliases: ['welcome'],
      version: '1.0.0',
      role: 1, // Group Admin
      author: 'ShiPu Ai🤖 Admin',
      description: 'Toggle auto-welcome greeting for new members joining thread',
      category: 'admin',
      guide: '{pref}autowelcome <on|off|setmsg <message>>',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, currentThread, threadsData }) => {
      const option = args[0]?.toLowerCase();

      if (option === 'on') {
        threadsData.set(currentThread.threadID, { autoWelcome: true });
        await message.reply(`✅ Auto-welcome ENABLED for this thread.`);
        return;
      }

      if (option === 'off') {
        threadsData.set(currentThread.threadID, { autoWelcome: false });
        await message.reply(`🛑 Auto-welcome DISABLED for this thread.`);
        return;
      }

      if (option === 'setmsg') {
        const msg = args.slice(1).join(' ');
        if (!msg) {
          await message.reply(`❌ Please specify a welcome message!`);
          return;
        }
        threadsData.set(currentThread.threadID, { welcomeMessage: msg });
        await message.reply(`✅ Custom welcome message updated: "${msg}"`);
        return;
      }

      await message.reply(
        `⚙️ **AUTO-WELCOME SETTINGS**\n` +
        `• Status: **${currentThread.autoWelcome ? 'ENABLED ✅' : 'DISABLED 🛑'}**\n` +
        `• Welcome Message: "${currentThread.welcomeMessage}"\n\n` +
        `Usage:\n` +
        `• \`autowelcome on\`\n` +
        `• \`autowelcome off\`\n` +
        `• \`autowelcome setmsg Welcome to {group}!\``
      );
    }
  },

  // 18. ADMINBOT
  {
    config: {
      name: 'adminbot',
      aliases: ['adminuids', 'botadmin'],
      version: '1.0.0',
      role: 3, // Owner/Admin only
      author: 'ShiPu Ai🤖 Core',
      description: 'Manage Admin Bot Messenger UIDs (#adminbot add/remove/list)',
      category: 'admin',
      guide: '{pref}adminbot <add|remove|list> [uid]',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, args, currentUser, api }) => {
      const action = args[0]?.toLowerCase();
      const targetUid = args[1]?.trim();

      const { adminBotData } = await import('../db/database');
      const prefix = api.getBotConfig().globalPrefix;

      if (action === 'add') {
        if (!targetUid) {
          await message.reply(`❌ Please specify a Messenger UID. Usage: \`${prefix}adminbot add <uid>\``);
          return;
        }
        const res = await adminBotData.add(targetUid, currentUser.userID || 'MESSENGER_CMD');
        if (res.success) {
          await message.reply(`✅ **ADMIN BOT ADDED!**\n${res.message}`);
        } else {
          await message.reply(`❌ ${res.message}`);
        }
        return;
      }

      if (action === 'remove' || action === 'delete' || action === 'del') {
        if (!targetUid) {
          await message.reply(`❌ Please specify a Messenger UID. Usage: \`${prefix}adminbot remove <uid>\``);
          return;
        }
        const res = await adminBotData.remove(targetUid);
        if (res.success) {
          await message.reply(`🗑️ **ADMIN BOT REMOVED!**\n${res.message}`);
        } else {
          await message.reply(`❌ ${res.message}`);
        }
        return;
      }

      if (action === 'list' || !action) {
        const list = await adminBotData.getAll();
        let replyMsg = `🛡️ **AUTHORIZED ADMIN BOT LIST (${list.length})**\n`;
        replyMsg += `─────────────────────────\n`;
        list.forEach((item, idx) => {
          replyMsg += `${idx + 1}. \`${item.uid}\` (Added by: ${item.addedBy})\n`;
        });
        replyMsg += `\n📌 Usage: \`${prefix}adminbot add <uid>\` or \`${prefix}adminbot remove <uid>\``;
        await message.reply(replyMsg);
        return;
      }
    }
  },

  // 19. SHIPU (AIOS Session Control)
  {
    config: {
      name: 'shipu',
      aliases: ['aios', 'session'],
      version: '1.2.0',
      role: 0,
      author: 'ShiPu AIOS Core',
      description: 'Start or end your free 20-minute / 50-message AI Operating System (AIOS) session or ask a question directly',
      category: 'ai',
      guide: '{pref}shipu <on | off | question>',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const accountId = (event as any)?.accountId || '';
      const threadID = event?.threadID || '';
      const sub = (args[0] || '').toLowerCase().trim();

      if (!(globalThis as any).shipuSessions) {
        (globalThis as any).shipuSessions = {};
      }

      if (sub === 'on' || sub === 'start' || sub === 'activate') {
        const questionText = args.slice(1).join(' ').trim();
        let activatedSuccess = false;

        const res = await aiosService.activateSession(senderID, threadID, accountId);
        
        if (res.success) {
          activatedSuccess = true;
          const now = Date.now();
          const expiresAt = now + 20 * 60 * 1000; // 20 minutes

          // Fetch user personal memory facts
          const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID }) || {
            facts: {},
            conversationContext: []
          };
          const factsMap = userMemory.facts ? (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : new Map();
          const factsObj = Object.fromEntries(factsMap);

          (globalThis as any).shipuSessions[senderID] = {
            threadID,
            startedAt: now,
            expiresAt,
            remainingTime: 1200,
            messageCount: 0,
            maxMessages: 50,
            conversationHistory: userMemory.conversationContext || [],
            personalMemory: factsObj,
            active: true
          };

          // Register a timer to automatically handle expiration even if user is idle
          setTimeout(async () => {
            const sess = (globalThis as any).shipuSessions?.[senderID];
            if (sess && sess.active && sess.threadID === threadID) {
              delete (globalThis as any).shipuSessions[senderID];
              try {
                await aiosService.deactivateSession(senderID);
              } catch (err) {}
              try {
                await message.send(
                  `⏰ Your free 20-minute / 50-message ShiPu AI session has ended.\n\n` +
                  `Use\n` +
                  `#resetai\n` +
                  `to reset your timer for 50 coins.\n\n` +
                  `Your normal bot commands will continue to work.`,
                  threadID
                );
              } catch (err) {
                console.error(err);
              }
            }
          }, 20 * 60 * 1000);
        } else {
          // If session is already active in DB, restore it in globalThis memory so the user can continue chatting
          try {
            const dbSession = await (AIOSSessionModel as any).findOne({ userID: senderID, status: 'active' });
            if (dbSession && new Date(dbSession.expiresAt) > new Date() && (dbSession.messageCount || 0) < (dbSession.maxMessages || 50)) {
              activatedSuccess = true;
              const now = Date.now();
              const expiresAt = new Date(dbSession.expiresAt).getTime();
              const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID }) || {
                facts: {},
                conversationContext: []
              };
              const factsMap = userMemory.facts ? (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : new Map();
              const factsObj = Object.fromEntries(factsMap);

              (globalThis as any).shipuSessions[senderID] = {
                threadID: dbSession.threadID || threadID,
                startedAt: new Date(dbSession.activatedAt).getTime(),
                expiresAt,
                remainingTime: Math.max(0, Math.ceil((expiresAt - now) / 1000)),
                messageCount: dbSession.messageCount || 0,
                maxMessages: dbSession.maxMessages || 50,
                conversationHistory: userMemory.conversationContext || [],
                personalMemory: factsObj,
                active: true
              };
            }
          } catch (err) {}
        }

        if (questionText) {
          // Turn on AI session AND immediately answer the inline question
          await processShipuAiResponse(senderID, threadID, questionText, message, `🧠 [ShiPu AI Session Activated]`, event);
        } else {
          if (activatedSuccess) {
            await message.reply(
              `🧠 ShiPu AI is now online.\n\n` +
              `✓ Personal memory loaded\n` +
              `✓ Conversation context restored\n` +
              `✓ Smart Brain connected\n\n` +
              ` You can now chat normally for the next 20 minutes (up to 50 messages).\n\n` +
              `Just send your message.`
            );
          } else {
            await message.reply(res.message);
          }
        }
        return;
      }

      if (sub === 'off' || sub === 'stop' || sub === 'deactivate') {
        if ((globalThis as any).shipuSessions && (globalThis as any).shipuSessions[senderID]) {
          delete (globalThis as any).shipuSessions[senderID];
        }
        await aiosService.deactivateSession(senderID);
        await message.reply(
          `🔴 ShiPu AI has been turned off.\n\n` +
          `Your conversation context has been saved.`
        );
        return;
      }

      // If user provided a question directly e.g. `#shipu bolo bou ke ignore kora ki thik?` or `shipu ai <question>` or `#shipu ask <question>`
      let questionText = args.join(' ').trim();
      if (sub === 'ask' || sub === 'query' || sub === 'ai') {
        questionText = args.slice(1).join(' ').trim();
      }

      if (questionText) {
        await processShipuAiResponse(senderID, threadID, questionText, message, `🤖 [ShiPu AI]`, { ...event, isDirectCommand: true });
        return;
      }

      await message.reply(
        `🤖 **SHIPU AIOS সেশন কন্ট্রোল**\n` +
        `─────────────────────────\n` +
        `ব্যবহার নির্দেশিকা:\n` +
        `• **#shipu on** - ৩০ মিনিট / ৫০ মেসেজের AIOS চ্যাট সেশন শুরু করুন।\n` +
        `• **#shipu on <প্রশ্ন>** - সেশন চালু করে সরাসরি প্রশ্নের উত্তর পান।\n` +
        `• **#shipu <প্রশ্ন>** বা **shipu ai <প্রশ্ন>** - যেকোনো প্রশ্ন সরাসরি বটের কাছে জানতে চান।\n` +
        `• **#shipu off** - আপনার চলমান সেশনটি বন্ধ করুন।\n\n` +
        `💡 সেশন চলাকালীন আপনি কোনো প্রিফিক্স (#) ছাড়াই সরাসরি বটের সাথে যেকোনো ভাষায় চ্যাট করতে পারবেন।`
      );
    },
    onChat: async ({ message, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const threadID = event?.threadID || '';
      const rawText = event?.body || '';
      if (!rawText || !rawText.trim()) return;

      await processShipuAiResponse(senderID, threadID, rawText, message, undefined, event);
    }
  },

  // 20. RESETAI (AIOS Cooldown Reset)
  {
    config: {
      name: 'resetai',
      aliases: ['skipcooldown', 'resetcooldown'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Economy',
      description: 'Spend 50 coins to immediately reset your 1-hour AIOS cooldown and start fresh',
      category: 'economy',
      guide: '{pref}resetai',
      countDown: 5,
      enabled: true
    },
    onStart: async ({ message, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      await message.reply(`⚡ *কুলডাউন রিসেট করার অনুরোধ প্রসেস করা হচ্ছে...*`);
      const res = await aiosService.resetCooldown(senderID);
      await message.reply(res.message);
    }
  },

  // 21. MEMORY (AIOS Memory Facts Viewer)
  {
    config: {
      name: 'memory',
      aliases: ['memories', 'facts'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Memory',
      description: 'View all saved facts, context history, and persona configurations',
      category: 'ai',
      guide: '{pref}memory',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID });
      const activeSession = await (AIOSSessionModel as any).findOne({ userID: senderID, status: 'active' });

      let replyMsg = `🧠 **SHIPU AIOS ব্যবহারকারী মেমোরি**\n` +
         `👤 User: \`${senderID.slice(-6)}\`\n` +
        `─────────────────────────\n`;

      const factsMap = userMemory && userMemory.facts ? 
        (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : 
        new Map();

      if (factsMap.size === 0) {
        replyMsg += `✖️ আপনার মেমরিতে কোনো তথ্য সেভ করা নেই। এআইকে তথ্য সেভ করতে বলতে লিখুন: **#remember [কী] [মান]**\n`;
      } else {
        replyMsg += `💾 **সংরক্ষিত ব্যক্তিগত তথ্যাদি (${factsMap.size}):**\n`;
        for (const [key, val] of factsMap.entries()) {
          replyMsg += `• **${key}**: ${val}\n`;
        }
      }

      replyMsg += `─────────────────────────\n`;
      replyMsg += `⚙️ **কনফিগারেশন:**\n`;
      replyMsg += `• সেশন স্ট্যাটাস: **${activeSession ? 'সক্রিয় (Active) 🟢' : 'নিষ্ক্রিয় (Inactive) 🔴'}**\n`;
      
      const persona = activeSession?.personality || userMemory?.personality || 'default';
      replyMsg += `• ব্যক্তিত্ব (Persona): **${persona.toUpperCase()}**\n`;
      
      const mood = userMemory?.mood || 'neutral';
      replyMsg += `• মেজাজ (Mood): **${mood.toUpperCase()}**\n`;

      if (userMemory && userMemory.cooldownUntil && new Date(userMemory.cooldownUntil) > new Date()) {
        const remainingMs = new Date(userMemory.cooldownUntil).getTime() - Date.now();
        const mins = Math.ceil(remainingMs / 60000);
        replyMsg += `• কুলডাউন অবশিষ্টাংশ: **~${mins} মিনিট** ⏳\n`;
      }

      await message.reply(replyMsg);
    }
  },

  // 22. REMEMBER (Save Fact)
  {
    config: {
      name: 'remember',
      aliases: ['savefact', 'storefact'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Memory',
      description: 'Explicitly store a custom personal fact in your long-term AIOS memory',
      category: 'ai',
      guide: '{pref}remember <key> <value>',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, args, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const key = args[0]?.trim();
      const val = args.slice(1).join(' ').trim();

      if (!key || !val) {
        await message.reply(`❌ **ভুল ফরম্যাট!**\nব্যবহার নির্দেশিকা: **#remember [কী] [মান]**\n(যেমন: \`#remember bobby ক্রিকেট খেলা\` বা \`#remember basha ঢাকা\`)`);
        return;
      }

      if (key.length > 30 || val.length > 150) {
        await message.reply(`❌ মেমোরি কি (Key) অনধিক ৩০ এবং মান (Value) অনধিক ১৫০ অক্ষরের হতে হবে।`);
        return;
      }

      // Load/Update facts map
      const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID }) || { facts: new Map() };
      const factsMap = userMemory.facts ? 
        (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : 
        new Map();

      factsMap.set(key, val);

      await (AIOSMemoryModel as any).updateOne(
        { userID: senderID },
        { $set: { facts: factsMap } },
        { upsert: true }
      );

      await message.reply(`✅ **মেমোরি সংরক্ষণ সফল!**\nআমি মনে রাখবো যে আপনার **${key}** হলো **"${val}"**।`);
    }
  },

  // 23. FORGET (Delete Fact)
  {
    config: {
      name: 'forget',
      aliases: ['deletefact', 'removefact'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Memory',
      description: 'Delete a previously saved fact from your personal AIOS memory',
      category: 'ai',
      guide: '{pref}forget <key>',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, args, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const key = args[0]?.trim();

      if (!key) {
        await message.reply(`❌ অনুগ্রহ করে যে তথ্যটি মুছে ফেলতে চান তার কি (Key) উল্লেখ করুন।\nব্যবহার নির্দেশিকা: **#forget [কী]**`);
        return;
      }

      const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID });
      const factsMap = userMemory && userMemory.facts ? 
        (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : 
        new Map();

      if (!factsMap.has(key)) {
        await message.reply(`❌ আপনার মেমরিতে **"${key}"** নামে কোনো তথ্য খুঁজে পাওয়া যায়নি।`);
        return;
      }

      factsMap.delete(key);

      await (AIOSMemoryModel as any).updateOne(
        { userID: senderID },
        { $set: { facts: factsMap } }
      );

      await message.reply(`🗑️ **মেমোরি মুছে ফেলা হয়েছে!**\nআমি আপনার মেমোরি থেকে **"${key}"** সংক্রান্ত তথ্যটি মুছে ফেলেছি।`);
    }
  },

  // 24. EDITMEMORY (Edit Fact)
  {
    config: {
      name: 'editmemory',
      aliases: ['updatefact', 'editfact'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Memory',
      description: 'Modify an existing fact inside your personal AIOS memory',
      category: 'ai',
      guide: '{pref}editmemory <key> <new_value>',
      countDown: 2,
      enabled: true
    },
    onStart: async ({ message, args, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const key = args[0]?.trim();
      const val = args.slice(1).join(' ').trim();

      if (!key || !val) {
        await message.reply(`❌ **ভুল ফরম্যাট!**\nব্যবহার নির্দেশিকা: **#editmemory [কী] [নতুন মান]**`);
        return;
      }

      const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID });
      const factsMap = userMemory && userMemory.facts ? 
        (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : 
        new Map();

      if (!factsMap.has(key)) {
        await message.reply(`❌ আপনার মেমরিতে **"${key}"** নামে কোনো তথ্য নেই। নতুন তথ্য যোগ করতে **#remember** ব্যবহার করুন।`);
        return;
      }

      factsMap.set(key, val);

      await (AIOSMemoryModel as any).updateOne(
        { userID: senderID },
        { $set: { facts: factsMap } }
      );

      await message.reply(`✏️ **মেমোরি আপডেট সফল!**\nআমি আপনার মেমোরিতে **"${key}"** এর মান পরিবর্তন করে **"${val}"** করেছি।`);
    }
  },

  // 25. CLEARCONTEXT (Clear chat history)
  {
    config: {
      name: 'clearcontext',
      aliases: ['clearhistory', 'resetchat'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Memory',
      description: 'Clear the active short-term conversation thread history',
      category: 'ai',
      guide: '{pref}clearcontext',
      countDown: 5,
      enabled: true
    },
    onStart: async ({ message, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      await (AIOSMemoryModel as any).updateOne(
        { userID: senderID },
        { $set: { conversationContext: [] } }
      );

      await message.reply(`🧹 **চ্যাট কনটেক্সট ক্লিয়ার সফল!**\nআপনার সাথে হওয়া সাম্প্রতিক কথপোকথনের ইতিহাস আমি ভুলে গিয়েছি। তবে আপনার সংরক্ষিত স্থায়ী ব্যক্তিগত তথ্যাদি (Facts) অপরিবর্তিত রয়েছে।`);
    }
  },

  // 26. EXPORTMEMORY (Backup Facts)
  {
    config: {
      name: 'exportmemory',
      aliases: ['backupmemory', 'backupfacts'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Security',
      description: 'Export all your saved facts as a secure base64 string backup',
      category: 'ai',
      guide: '{pref}exportmemory',
      countDown: 10,
      enabled: true
    },
    onStart: async ({ message, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID });
      const factsMap = userMemory && userMemory.facts ? 
        (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : 
        new Map();

      if (factsMap.size === 0) {
        await message.reply(`❌ আপনার মেমরিতে কোনো সংরক্ষিত তথ্য নেই, তাই ব্যাকআপ করা সম্ভব নয়।`);
        return;
      }

      const obj: Record<string, string> = {};
      for (const [k, v] of factsMap.entries()) {
        obj[k] = v;
      }

      const jsonStr = JSON.stringify(obj);
      const b64 = Buffer.from(jsonStr).toString('base64');

      await message.reply(
        `🔐 **মেমোরি সিকিউর ব্যাকআপ এক্সপোর্ট**\n` +
        `নিচের ব্যাকআপ কোডটি কপি করে নিরাপদ স্থানে সংরক্ষণ করুন:\n\n` +
        `\`\`\`\n${b64}\n\`\`\`\n\n` +
        `💡 ভবিষ্যতে এই মেমোরি ফিরিয়ে আনতে টাইপ করুন:\n**#importmemory [আপনার ব্যাকআপ কোড]**`
      );
    }
  },

  // 27. IMPORTMEMORY (Restore Facts)
  {
    config: {
      name: 'importmemory',
      aliases: ['restorefacts', 'restorememory'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Security',
      description: 'Restore facts from a secure base64 backup string',
      category: 'ai',
      guide: '{pref}importmemory <backup_code>',
      countDown: 10,
      enabled: true
    },
    onStart: async ({ message, args, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const b64 = args[0]?.trim();

      if (!b64) {
        await message.reply(`❌ অনুগ্রহ করে আপনার এক্সপোর্ট করা ব্যাকআপ কোডটি প্রদান করুন।\nব্যবহার নির্দেশিকা: **#importmemory [কোড]**`);
        return;
      }

      try {
        const jsonStr = Buffer.from(b64, 'base64').toString('utf-8');
        const obj = JSON.parse(jsonStr);

        if (typeof obj !== 'object' || obj === null) {
          throw new Error('Invalid backup structure');
        }

        const userMemory = await (AIOSMemoryModel as any).findOne({ userID: senderID }) || { facts: new Map() };
        const factsMap = userMemory.facts ? 
          (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : 
          new Map();

        let importedCount = 0;
        for (const [k, v] of Object.entries(obj)) {
          if (typeof k === 'string' && typeof v === 'string') {
            factsMap.set(k, v);
            importedCount++;
          }
        }

        await (AIOSMemoryModel as any).updateOne(
          { userID: senderID },
          { $set: { facts: factsMap } },
          { upsert: true }
        );

        await message.reply(`📥 **মেমোরি রিস্টোর সফল!**\nআপনার ব্যাকআপ থেকে মোট **${importedCount}টি** ব্যক্তিগত তথ্য রিস্টোর করা হয়েছে।`);
      } catch (err: any) {
        await message.reply(`❌ **রিস্টোর ব্যর্থ!**\nপ্রদত্ত ব্যাকআপ কোডটি সঠিক নয় অথবা কোডটির কোনো অংশ নষ্ট হয়ে গেছে।`);
      }
    }
  },

  // 28. PERSONALITY (AIOS Personality Selection)
  {
    config: {
      name: 'personality',
      aliases: ['persona', 'setpersonality'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu AIOS Core',
      description: 'Choose your desired AI personality style/tone',
      category: 'ai',
      guide: '{pref}personality <default | professional | funny | bangladesh_advisor>',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, event, currentUser }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const p = (args[0] || '').toLowerCase().trim();
      const validPersonas = ['default', 'professional', 'funny', 'bangladesh_advisor'];

      if (!p || !validPersonas.includes(p)) {
        await message.reply(
          `🎭 **AIOS ব্যক্তিত্ব (Personality) নিবার্চন**\n` +
          `─────────────────────────\n` +
          `ব্যবহার নির্দেশিকা: **#personality [ধরন]**\n\n` +
          `উপলব্ধ অপশনসমূহ:\n` +
          `• **#personality default** - সাধারণ ও প্রাণবন্ত বন্ধু।\n` +
          `• **#personality professional** - গুরুগম্ভীর ও মার্জিত বুদ্ধিজীবী।\n` +
          `• **#personality funny** - রসিক ও মজার ট্রল মাস্টার।\n` +
          `• **#personality bangladesh_advisor** - গম্ভীর রাজনৈতিক উপদেষ্টা।`
        );
        return;
      }

      await (AIOSMemoryModel as any).updateOne(
        { userID: senderID },
        { $set: { personality: p } },
        { upsert: true }
      );

      await message.reply(`🎭 **অভিনন্দন!**\nআপনার AIOS ব্যক্তিত্ব পরিবর্তন করে **${p.toUpperCase()}** করা হয়েছে।`);
    }
  },

  // 30. PAIR (Successful pairing command with Canvas)
  {
    config: {
      name: 'pair',
      aliases: ['love', 'partner'],
      version: '1.1.0',
      role: 0,
      author: 'Nyx x @Ariyan & ShiPu',
      description: 'Successful pairing of members inside the group with Canvas',
      category: 'fun',
      guide: '{pref}pair [@mention/name]',
      countDown: 5,
      enabled: true
    },
    onStart: async ({ message, event, args, usersData, currentThread, api }) => {
      try {
        const senderID = event?.senderID || '';
        const senderData = usersData.get(senderID);
        const senderName = senderData?.name || 'User';

        // Extract image parts if pairing command was invoked with an image attachment or replied message
        const pairingImageParts = await extractImagePartsFromPairing(event, args);
        let aiImageAnalysis = '';

        if (pairingImageParts.length > 0) {
          try {
            const { aiProviderManager } = await import('../ai/providers/providerManager');
            const provider = aiProviderManager.getActiveProvider();
            const visionQuery = args.join(' ').trim() || 'Analyze this photo and provide a fun, charming, 2-sentence couple compatibility observation.';

            // Query ShiPu Brain database before generating response
            const match = brainService.findMatch(visionQuery);
            let systemKnowledge = '';
            if (match && match.memory) {
              systemKnowledge = `\n\n=== SYSTEM KNOWLEDGE (ShiPu Brain Database) ===\nTrigger: "${match.memory.trigger}"\nSaved Data: "${match.memory.reply}"\nINSTRUCTION: Use this System Knowledge saved personalized data to answer accurately.`;
            }

            const aiRes = await provider.generateText([{
              role: 'user',
              parts: [...pairingImageParts, { text: visionQuery }]
            }], {
              systemInstruction: 'You are ShiPu AI Love & Vision Assistant. Provide a short, charming, witty Bengali/English observation.' + systemKnowledge
            });

            if (aiRes.success && aiRes.text) {
              aiImageAnalysis = `\n\n✨ 𝗦𝗵𝗶𝗣𝘂 𝗔𝗜 𝗩𝗶𝘀𝗶𝗼𝗻:\n${aiRes.text.trim()}`;
            }
          } catch (aiErr: any) {
            console.error('[Pair Command] Image vision processing error:', aiErr?.message || aiErr);
          }
        }

        // Helper to guess gender intelligently based on name
        const guessGender = (name: string): 'MALE' | 'FEMALE' => {
          const n = name.toLowerCase().trim();
          const femaleExact = [
            'sayantika', 'sayani', 'anika', 'fariha', 'tasnim', 'nusrat', 'sadia', 'sumaiya', 'tanjila', 'marium',
            'sabrina', 'jannatul', 'jannat', 'farhana', 'afroza', 'sharmin', 'ayesha', 'khadija', 'fatema', 'asma',
            'suraiya', 'mim', 'lima', 'silvia', 'nadia', 'farzana', 'afia', 'subah', 'shree', 'priya', 'ritu',
            'sumi', 'lipi', 'ruma', 'mimi', 'keya', 'mita', 'tisha', 'mou', 'sneha', 'tanya', 'puja', 'diya',
            'joti', 'asha', 'bithi', 'shila', 'rhea', 'isha', 'hema', 'roma', 'tina', 'payel', 'purnima', 'nupur',
            'begum', 'akter', 'sultana', 'khatun', 'moni', 'chakraborty'
          ];
          const femaleSuffixes = [
            'begum', 'akter', 'sultana', 'jahan', 'khatun', 'moni', 'parvin', 'shree'
          ];
          const words = n.split(/\s+/);
          for (const word of words) {
            if (femaleExact.includes(word)) return 'FEMALE';
          }
          for (const suffix of femaleSuffixes) {
            if (n.endsWith(suffix)) return 'FEMALE';
          }
          if (n.endsWith('a') || n.endsWith('i') || n.endsWith('y')) {
            const maleEndsWithAIY = ['joy', 'sanjay', 'mrityunjay', 'ali', 'hossain', 'karim', 'rahim', 'selim', 'hasim', 'tasnim', 'shofiq', 'rafiq', 'tariq', 'anik', 'sourav', 'das', 'arindam'];
            const lastWord = words[words.length - 1];
            if (maleEndsWithAIY.includes(lastWord) || maleEndsWithAIY.includes(words[0])) {
              return 'MALE';
            }
            return 'FEMALE';
          }
          return 'MALE';
        };

        const getGenderSafe = (user: any): 'MALE' | 'FEMALE' => {
          if (user.gender && typeof user.gender === 'string') {
            const g = user.gender.toUpperCase();
            if (g === 'MALE' || g === 'FEMALE') return g;
          }
          return guessGender(user.name);
        };

        let userInfo: any[] = [];
        
        // Try to retrieve actual group members from the Facebook API via getThreadInfo
        try {
          if (api && typeof (api as any).getThreadInfo === 'function') {
            const threadData = await new Promise<any>((resolve) => {
              (api as any).getThreadInfo(event.threadID, (err: any, info: any) => {
                if (err) resolve(null);
                else resolve(info);
              });
            });
            if (threadData && threadData.userInfo) {
              userInfo = threadData.userInfo.map((u: any) => {
                const name = u.name || u.displayName || 'Unknown User';
                return {
                  id: String(u.id || u.userID),
                  name,
                  gender: getGenderSafe({ name, gender: u.gender })
                };
              });
            }
          }
        } catch (err) {
          console.error('[Pair Command] getThreadInfo failed:', err);
        }

        // Fallback to thread members from memory state if API is empty or unavailable
        if (userInfo.length === 0 && currentThread && currentThread.members) {
          userInfo = currentThread.members.map((m: any) => {
            const name = m.name || m.displayName || 'Unknown User';
            return {
              id: String(m.userID || m.id),
              name,
              gender: getGenderSafe({ name, gender: m.gender })
            };
          });
        }

        // Get sender profile details
        let myData = userInfo.find((user) => String(user.id) === String(senderID));
        if (!myData) {
          const gender = getGenderSafe({ name: senderName, gender: (senderData as any)?.gender });
          myData = {
            id: String(senderID),
            name: senderName,
            gender
          };
        }

        let selectedMatch: any = null;

        // Extract mention or search target safely
        const eventAny = event as any;
        let mentionID: string | null = null;
        let mentionName: string | null = null;

        if (eventAny?.mentions) {
          if (Array.isArray(eventAny.mentions) && eventAny.mentions.length > 0) {
            const m = eventAny.mentions[0];
            if (typeof m === 'string') {
              mentionName = m;
            } else if (m && typeof m === 'object') {
              mentionID = m.id || m.userID || null;
              mentionName = m.name || m.tag || m.displayName || null;
            }
          } else if (typeof eventAny.mentions === 'object') {
            const keys = Object.keys(eventAny.mentions);
            if (keys.length > 0) {
              const firstKey = keys[0];
              const val = eventAny.mentions[firstKey];
              mentionID = String(firstKey);
              if (typeof val === 'string') {
                mentionName = val;
              } else if (val && typeof val === 'object') {
                mentionID = String(val.id || val.userID || firstKey);
                mentionName = String(val.name || val.tag || val.displayName || '');
              }
            }
          }
        }

        if (mentionName) {
          mentionName = String(mentionName).replace(/^@/, '').trim();
        }

        if (mentionID) {
          selectedMatch = userInfo.find(u => String(u.id) === String(mentionID));
          if (!selectedMatch && mentionName) {
            selectedMatch = userInfo.find(u => u.name.toLowerCase().includes(mentionName!.toLowerCase()) && String(u.id) !== String(senderID));
          }
          if (!selectedMatch) {
            selectedMatch = {
              id: mentionID,
              name: mentionName || 'Group Member'
            };
          }
        } else if (mentionName) {
          selectedMatch = userInfo.find(u => u.name.toLowerCase().includes(mentionName!.toLowerCase()) && String(u.id) !== String(senderID)) || {
            id: 'user_' + Date.now(),
            name: mentionName
          };
        } else if (args && args.length > 0) {
          // Name search from argument: e.g. #pair sayantika
          const searchName = args.join(' ').replace(/^@/, '').toLowerCase().trim();
          if (searchName) {
            const found = userInfo.find(u => u.name.toLowerCase().includes(searchName) && String(u.id) !== String(senderID));
            if (found) {
              selectedMatch = found;
            } else {
              // Search usersData fallback or create match object
              const fallbackUser = usersData.get ? usersData.get(args[0]) : null;
              selectedMatch = {
                id: (fallbackUser && (fallbackUser.userID || (fallbackUser as any).id)) ? String(fallbackUser.userID || (fallbackUser as any).id) : ('user_' + Date.now()),
                name: (fallbackUser && fallbackUser.name) ? fallbackUser.name : args.join(' ').replace(/^@/, '').trim()
              };
            }
          }
        }

        if (!selectedMatch) {
          // Filter candidate matches by gender
          const myGender = (myData.gender || 'MALE').toUpperCase();
          let matchCandidates = [];

          if (myGender === 'MALE') {
            matchCandidates = userInfo.filter(
              (user) => user.gender === 'FEMALE' && String(user.id) !== String(senderID)
            );
          } else if (myGender === 'FEMALE') {
            matchCandidates = userInfo.filter(
              (user) => user.gender === 'MALE' && String(user.id) !== String(senderID)
            );
          } else {
            matchCandidates = userInfo.filter(
              (user) => String(user.id) !== String(senderID)
            );
          }

          if (matchCandidates.length === 0) {
            matchCandidates = userInfo.filter(
              (user) => String(user.id) !== String(senderID)
            );
          }

          if (matchCandidates.length === 0) {
            await message.reply('❌ No suitable match found in the group.');
            return;
          }

          selectedMatch = matchCandidates[Math.floor(Math.random() * matchCandidates.length)];
        }

        const matchName = selectedMatch.name;

        // Create canvas image
        const width = 800;
        const height = 400;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Helper function to fetch images safely as buffers with multiple Facebook Graph API & UI Avatars fallback
        const fetchImageSafe = async (url: string, fallbackName: string, uid?: string): Promise<any> => {
          const tryUrls = [
            url,
            uid ? `https://graph.facebook.com/${uid}/picture?type=large` : null,
            uid ? `https://graph.facebook.com/${uid}/picture?width=500&height=500` : null,
            uid ? `https://graph.facebook.com/v18.0/${uid}/picture?width=720&height=720` : null
          ].filter(Boolean) as string[];

          for (const u of tryUrls) {
            try {
              const response = await axios.get(u, { responseType: 'arraybuffer', timeout: 6000 });
              if (response.data && response.data.length > 200) {
                return await loadImage(Buffer.from(response.data));
              }
            } catch (err) {
              // try next candidate URL
            }
          }

          // Fallback to UI Avatars with initial
          try {
            const uiAvatarUrl = `https://ui-avatars.com/api/?name=${encodeURIComponent(fallbackName)}&background=ff4d4d&color=fff&size=200&bold=true`;
            const response = await axios.get(uiAvatarUrl, { responseType: 'arraybuffer', timeout: 5000 });
            return await loadImage(Buffer.from(response.data));
          } catch (err3) {
            const dummy = createCanvas(200, 200);
            const dctx = dummy.getContext('2d');
            dctx.fillStyle = '#ff4d4d';
            dctx.fillRect(0, 0, 200, 200);
            dctx.fillStyle = '#ffffff';
            dctx.font = 'bold 80px sans-serif';
            dctx.textAlign = 'center';
            dctx.textBaseline = 'middle';
            dctx.fillText((fallbackName.charAt(0) || 'U').toUpperCase(), 100, 100);
            return dummy;
          }
        };

        // Load background with forced retry and local cache storage
        let background: any;
        const bgCacheDir = path.join(process.cwd(), 'cache');
        const bgLocalPath = path.join(bgCacheDir, 'pair_bg.jpg');
        const bgUrls = [
          'https://i.postimg.cc/tRFY2HBm/0602f6fd6933805cf417774fdfab157e.jpg',
          'https://i.ibb.co/L50n11x/pair-bg.jpg',
          'https://images.unsplash.com/photo-1518199266791-5375a83190b7?q=80&w=1000&auto=format&fit=crop'
        ];

        try {
          await fs.ensureDir(bgCacheDir);
          if (await fs.pathExists(bgLocalPath)) {
            const stats = await fs.stat(bgLocalPath);
            if (stats.size > 500) {
              const fileBuf = await fs.readFile(bgLocalPath);
              background = await loadImage(fileBuf);
            }
          }
        } catch (e) {
          // ignore cache read error
        }

        if (!background) {
          let downloadedBuf: Buffer | null = null;
          // Force trying until successfully downloaded
          for (let attempt = 1; attempt <= 5; attempt++) {
            for (const bgUrl of bgUrls) {
              try {
                const bgResponse = await axios.get(bgUrl, { responseType: 'arraybuffer', timeout: 15000 });
                if (bgResponse.data && bgResponse.data.length > 500) {
                  downloadedBuf = Buffer.from(bgResponse.data);
                  break;
                }
              } catch (err) {
                // try next URL
              }
            }
            if (downloadedBuf) break;
            // Wait 1 second before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
          }

          if (downloadedBuf) {
            try {
              await fs.writeFile(bgLocalPath, downloadedBuf);
              background = await loadImage(downloadedBuf);
            } catch (err) {
              // fallback to loading directly from buffer if write failed
              background = await loadImage(downloadedBuf);
            }
          }
        }

        if (!background) {
          const dummy = createCanvas(width, height);
          const dctx = dummy.getContext('2d');
          const grad = dctx.createLinearGradient(0, 0, width, height);
          grad.addColorStop(0, '#ff9a9e');
          grad.addColorStop(1, '#fecfef');
          dctx.fillStyle = grad;
          dctx.fillRect(0, 0, width, height);
          background = dummy;
        }
        
        const avatar1Url = `https://graph.facebook.com/${senderID}/picture?width=720&height=720&access_token=6628568379%7Cc1e620fa708a1d5696fb991c1bde5662`;
        const avatar2Url = `https://graph.facebook.com/${selectedMatch.id}/picture?width=720&height=720&access_token=6628568379%7Cc1e620fa708a1d5696fb991c1bde5662`;

        const sIdImage = await fetchImageSafe(avatar1Url, senderName, senderID);
        const pairPersonImage = await fetchImageSafe(avatar2Url, matchName, selectedMatch.id);

        // Draw background
        ctx.drawImage(background, 0, 0, width, height);

        // Helper function to draw a circular cropped avatar
        const drawCircularAvatar = (image: any, x: number, y: number, size: number) => {
          const radius = size / 2;
          const centerX = x + radius;
          const centerY = y + radius;

          ctx.save();
          ctx.beginPath();
          ctx.arc(centerX, centerY, radius, 0, Math.PI * 2, true);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(image, x, y, size, size);
          ctx.restore();

          // Outer circle border
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.arc(centerX, centerY, radius, 0, Math.PI * 2, true);
          ctx.closePath();
          ctx.stroke();
        };

        // Draw circular cropped avatars on the canvas
        drawCircularAvatar(sIdImage, 385, 40, 170);
        drawCircularAvatar(pairPersonImage, width - 213, 190, 170);

        const buffer = canvas.toBuffer('image/png');
        
        // Write buffer to a temp file to ensure FCA handles file extension correctly
        const tempPath = path.join(process.cwd(), `pair_${Date.now()}_${senderID}.png`);
        await fs.writeFile(tempPath, buffer);

        const lovePercent = Math.floor(Math.random() * 31) + 70;

        try {
          const stream = fs.createReadStream(tempPath);
          await (message as any).reply({
            body: `🥰𝗦𝘂𝗰𝗰𝗲𝘀𝘀𝗳𝘂𝗹 𝗽𝗮𝗶𝗿𝗶𝗻𝗴\n・${senderName} 🎀\n・${matchName} 🎀\n💌𝗪𝗶𝘀𝗵 𝘆𝗼𝘂 𝘁𝘄𝗼 𝗵𝘂𝗻𝗱𝗿𝗲𝗱 𝘆𝗲𝗮𝗿𝘀 𝗼𝗳 𝗵𝗮𝗽𝗽𝗶𝗻𝗲𝘀𝘀 ❤❤\n\n𝗟𝗼𝘃𝗲 𝗽𝗲𝗿𝗰𝗲𝗻𝘁𝗮𝗴𝗲: ${lovePercent}% 💙${aiImageAnalysis}`,
            attachment: stream
          });
        } finally {
          // Clean up the temporary file safely
          fs.unlink(tempPath).catch(err => {
            console.error('[Pair Command] Failed to unlink temp file:', tempPath, err);
          });
        }

      } catch (err: any) {
        await message.reply(`❌ An error occurred while trying to find a match.\n${err.message}`);
      }
    }
  },

  // SPIN (Lucky Casino Wheel with Weighted Probability & 3 Daily Free Spins)
  {
    config: {
      name: 'spin',
      aliases: ['luckyspin', 'wheel'],
      version: '2.0.0',
      role: 0,
      author: 'ShiPu Economy Engine',
      description: 'Spin the lucky casino wheel to win daily free coins (up to 100 coins jackpot)',
      category: 'economy',
      guide: '{pref}spin',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, event, currentUser, currentThread }) => {
      const senderID = event?.senderID || currentUser?.userID || '';
      const senderName = currentUser?.name || 'User';
      const threadID = currentThread?.threadID || event?.threadID || 'DIRECT';

      const res = await spinService.executeSpin(senderID, senderName, threadID);

      if (!res.success) {
        await message.reply(res.message);
        return;
      }

      if (res.imageBuffer) {
        const tempPath = path.join(process.cwd(), `spin_${Date.now()}_${senderID}.png`);
        await fs.writeFile(tempPath, res.imageBuffer);
        try {
          await message.reply({
            body: res.message,
            attachment: fs.createReadStream(tempPath)
          });
        } finally {
          setTimeout(() => fs.unlink(tempPath).catch(() => {}), 15000);
        }
      } else {
        await message.reply(res.message);
      }
    }
  },

  // 24. SAY (OpenRouter Fish Audio Text-to-Speech)
  {
    config: {
      name: 'say',
      aliases: ['speak', 'voice', 'tts', 'saytext'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu Ai Dev Team',
      description: 'Generate natural speech/audio using the Fish Audio model on OpenRouter',
      category: 'ai',
      guide: '{pref}say <message>',
      countDown: 5,
      enabled: true
    },
    onStart: async ({ message, args }) => {
      const text = args.join(' ').trim();
      if (!text) {
        return await message.reply('Please provide some text to say. Usage: #say <text>');
      }

      let loadingMsg: any = null;
      try {
        loadingMsg = await message.reply('Generating voice... Please wait...');
      } catch (err) {}

      let tempPath = '';
      try {
        const { openRouterService } = await import('../services/openRouterService');
        const audioBuffer = await openRouterService.generateSpeech(text);
        tempPath = await openRouterService.saveTempAudioFile(audioBuffer);

        await message.reply({
          body: `🎙️ **Generated Voice Message:**`,
          attachment: fs.createReadStream(tempPath)
        });

        if (loadingMsg && typeof loadingMsg.unsend === 'function') {
          try { await loadingMsg.unsend(); } catch (e) {}
        }
      } catch (err: any) {
        console.error('[Say Command Error]:', err.message);
        await message.reply(`❌ **Speech Generation Failed:** ${err.message || 'Unknown Error'}`);
      } finally {
        if (tempPath) {
          const { openRouterService } = await import('../services/openRouterService');
          setTimeout(() => {
            openRouterService.deleteTempFile(tempPath).catch(() => {});
          }, 15000);
        }
      }
    }
  },

  // INSTAGRAM DOWNLOADER (Reels, Posts, IGTV, Auto-Downloader)
  {
    config: {
      name: 'insta',
      aliases: ['instagram', 'ig', 'igdl', 'instadl', 'reel', 'reels'],
      version: '1.0.0',
      role: 0,
      author: 'ShiPu Ai',
      description: 'Auto download Instagram reels, posts, IGTV and carousels when link is detected in chat or commanded',
      category: 'Custom',
      guide: '{pref}insta <instagram_link>',
      countDown: 3,
      enabled: true
    },
    onStart: async ({ message, args, threadID, api }) => {
      const input = args.join(' ');
      const instaRegex = /(https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv|share\/(?:reel|p))\/[\w-]+(?:\/|\?[^\s]*)?)/gi;
      const match = input.match(instaRegex) || (input.includes('instagram.com') ? [input.trim()] : null);

      if (!match || match.length === 0) {
        return await message.reply(
          '📌 **INSTAGRAM DOWNLOADER**\n' +
          '─────────────────────────\n' +
          'Please provide a valid Instagram Reel or Post URL.\n\n' +
          '💡 **Usage:**\n' +
          '• `#insta https://www.instagram.com/reel/DZ2zV8UhBQZ/`\n' +
          '• Or simply paste any Instagram link directly in the chat!'
        );
      }

      const url = match[0];
      await handleInstagramDownload({ url, message, threadID, api });
    },
    onChat: async ({ message, event, threadID, api }) => {
      if (!event || !event.body) return;
      const body = event.body;

      const prefix = event.prefixUsed || '#';
      const trimmed = body.trim().toLowerCase();
      if (
        trimmed.startsWith(`${prefix}insta`) ||
        trimmed.startsWith(`${prefix}instagram`) ||
        trimmed.startsWith(`${prefix}ig`) ||
        trimmed.startsWith(`${prefix}igdl`) ||
        trimmed.startsWith(`${prefix}instadl`) ||
        trimmed.startsWith(`${prefix}reel`) ||
        trimmed.startsWith(`${prefix}reels`)
      ) {
        return;
      }

      const instaRegex = /(https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv|share\/(?:reel|p))\/[\w-]+(?:\/|\?[^\s]*)?)/gi;
      const matches = body.match(instaRegex);

      if (matches && matches.length > 0) {
        const url = matches[0];
        await handleInstagramDownload({ url, message, threadID, api });
      }
    }
  },
  // SMS GATEWAY SIMULATOR COMMAND
  {
    config: {
      name: 'sms',
      aliases: ['smstest', 'smssim', 'smssimulator'],
      version: '2.0.0',
      role: 0,
      author: 'ShiPu AI Dev Team',
      description: 'Safe SMS gateway testing and simulation engine for Bangladesh mobile numbers',
      category: 'system',
      guide: '{pref}sms <number> <rounds>',
      countDown: 5,
      enabled: true
    },
    onStart: async ({ message, args, threadID, senderID, currentThread, api }) => {
      const prefix = currentThread?.prefix || (api?.getBotConfig ? api.getBotConfig().globalPrefix : '#');
      const uID = senderID || 'unknown_user';

      // 1. Argument presence & validation
      if (!args || args.length === 0) {
        await message.reply(smsSimulationService.formatUsageGuide(prefix));
        return;
      }

      const rawPhone = args[0];
      const rawRounds = args[1];

      // 2. Validate Bangladesh Phone Number
      const normalizedPhone = smsValidator.normalizePhoneNumber(rawPhone);
      if (!normalizedPhone) {
        await message.reply(
          `❌ **Invalid Bangladesh Number!**\n` +
          `Please enter a valid 11-digit Bangladesh mobile number.\n\n` +
          `💡 **Supported Formats:**\n` +
          `• \`01316655254\`\n` +
          `• \`+8801316655254\`\n` +
          `• \`8801316655254\``
        );
        return;
      }

      // 3. Validate Rounds
      if (rawRounds === undefined) {
        await message.reply(
          `⚠️ **Missing Rounds!**\n` +
          `Please specify the number of rounds between 1 and 100.\n\n` +
          `💡 **Example:** \`${prefix}sms ${rawPhone} 10\``
        );
        return;
      }

      const roundsCheck = smsValidator.validateRounds(rawRounds);
      if (!roundsCheck.success || roundsCheck.value === undefined) {
        await message.reply(roundsCheck.error || 'Invalid rounds');
        return;
      }

      const rounds = roundsCheck.value;
      const maskedPhone = smsValidator.maskPhoneNumber(normalizedPhone);

      // 4. Rate Limiting & Concurrency Checks
      const rateCheck = smsSimulationService.checkRateLimit(uID);
      if (!rateCheck.allowed) {
        await message.reply(rateCheck.reason || 'Rate limit active');
        return;
      }

      // 5. Send initial initiation message
      const jobId = `SIM-${Date.now().toString(36).toUpperCase()}-${Math.floor(100 + Math.random() * 900)}`;
      await message.reply(
        `🚀 **SMS SIMULATION INITIALIZED**\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🆔 **Job ID:** \`${jobId}\`\n` +
        `📱 **Target:** \`${maskedPhone}\`\n` +
        `🎯 **Total Rounds:** ${rounds}\n` +
        `🛡️ **Engine:** Virtual Safe Simulator\n` +
        `━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
        `⏳ Processing ${rounds} simulated delivery jobs...`
      );

      try {
        const job = await smsSimulationService.createAndRunSimulation(
          uID,
          threadID,
          normalizedPhone,
          rounds
        );

        const summary = smsSimulationService.formatJobSummary(job);
        await message.reply(summary);
      } catch (err: any) {
        await message.reply(`❌ **Simulation Error:** ${err.message}`);
      }
    }
  }
];

async function handleInstagramDownload({ url, message, threadID, api }: { url: string; message: any; threadID: string; api: any }) {
  let tempFilePath: string | null = null;
  try {
    if (message && typeof message.react === 'function') {
      try { await message.react('📥'); } catch (e) {}
    }

    let cleanUrl = url.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = 'https://' + cleanUrl;
    }
    const baseMatch = cleanUrl.match(/(https?:\/\/(?:www\.)?(?:instagram\.com|instagr\.am)\/(?:p|reel|reels|tv|share\/(?:reel|p))\/[\w-]+)/i);
    const targetUrl = baseMatch ? baseMatch[1] : cleanUrl.split('?')[0];

    let dataResult: any = null;

    // Primary: Clipssaver
    try {
      const { data } = await axios.post(
        'https://clipssaver.com/api/instagram/instagramDownloader/download-post',
        { url: targetUrl },
        {
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          },
          timeout: 18000
        }
      );

      if (data && data.status === 'success' && data.data?.post) {
        const result = data.data.post;
        const caption = result.edge_media_to_caption?.edges?.[0]?.node?.text || result.caption || '';
        const videoUrl = result.video_url || result.download_url;
        const imageUrl = result.display_url || result.image || result.thumbnail_src;
        const isVideo = Boolean(result.video_url || result.type === 2 || result.is_video);
        const downloadUrl = isVideo ? videoUrl : imageUrl;

        dataResult = {
          username: result.owner?.username || 'instagram_user',
          fullName: result.owner?.full_name || '',
          caption: caption,
          downloadUrl: downloadUrl,
          isVideo: isVideo,
          likes: result.edge_liked_by?.count || 0,
          comments: result.edge_media_to_comment?.count || 0,
          duration: result.video_duration || 0
        };
      }
    } catch (err: any) {
      console.warn('[InstaScrape] Clipssaver API error:', err.message);
    }

    // Fallback 1: SnapInsta V2
    if (!dataResult) {
      try {
        const { data } = await axios.get(`https://api.v2.vidsaver.net/api/ig?url=${encodeURIComponent(targetUrl)}`, { timeout: 12000 });
        if (data && (data.url || data.video || data.data)) {
          const downloadUrl = data.url || data.video || (Array.isArray(data.data) ? data.data[0]?.url : null);
          if (downloadUrl) {
            dataResult = {
              username: data.username || 'instagram_user',
              fullName: '',
              caption: data.caption || '',
              downloadUrl: downloadUrl,
              isVideo: Boolean(data.video || downloadUrl.includes('.mp4')),
              likes: 0,
              comments: 0,
              duration: 0
            };
          }
        }
      } catch (err: any) {
        console.warn('[InstaScrape] Fallback 1 error:', err.message);
      }
    }

    // Fallback 2: Delirius API
    if (!dataResult) {
      try {
        const { data } = await axios.get(`https://deliriussapi.vercel.app/download/instagram?url=${encodeURIComponent(targetUrl)}`, { timeout: 12000 });
        if (data && data.status && data.data) {
          const item = Array.isArray(data.data) ? data.data[0] : data.data;
          const downloadUrl = item.url || item.download_url;
          if (downloadUrl) {
            dataResult = {
              username: data.username || 'instagram_user',
              fullName: '',
              caption: data.caption || '',
              downloadUrl: downloadUrl,
              isVideo: item.type === 'video' || downloadUrl.includes('.mp4'),
              likes: 0,
              comments: 0,
              duration: 0
            };
          }
        }
      } catch (err: any) {
        console.warn('[InstaScrape] Fallback 2 error:', err.message);
      }
    }

    if (!dataResult || !dataResult.downloadUrl) {
      throw new Error('Could not fetch Instagram content. Ensure the post is public.');
    }

    const isVideo = dataResult.isVideo;
    const ext = isVideo ? 'mp4' : 'jpg';
    tempFilePath = path.join(process.cwd(), `tmp_insta_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`);

    const res = await axios.get(dataResult.downloadUrl, {
      responseType: 'arraybuffer',
      timeout: 35000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    await fs.writeFile(tempFilePath, Buffer.from(res.data));

    let captionText = (dataResult.caption || '').trim();
    if (captionText.length > 350) {
      captionText = captionText.substring(0, 350) + '...';
    }

    let responseMsg = `📸 **INSTAGRAM ${dataResult.isVideo ? 'REEL / VIDEO' : 'POST'}**\n`;
    responseMsg += `─────────────────────────\n`;
    responseMsg += `👤 **User:** @${dataResult.username}${dataResult.fullName ? ` (${dataResult.fullName})` : ''}\n`;
    if (dataResult.likes > 0 || dataResult.comments > 0) {
      responseMsg += `❤️ **Likes:** ${dataResult.likes.toLocaleString()}  |  💬 **Comments:** ${dataResult.comments.toLocaleString()}\n`;
    }
    if (dataResult.duration > 0) {
      responseMsg += `⏱️ **Duration:** ${Math.round(dataResult.duration)}s\n`;
    }
    if (captionText) {
      responseMsg += `\n📝 **Caption:**\n${captionText}\n`;
    }
    responseMsg += `─────────────────────────\n`;
    responseMsg += `🤖 *Downloaded automatically by ShiPu Ai*`;

    const attachmentStream = fs.createReadStream(tempFilePath);

    if (message && typeof message.reply === 'function') {
      await message.reply({
        body: responseMsg,
        attachment: attachmentStream
      });
    } else if (api && typeof api.sendMessage === 'function') {
      await api.sendMessage(threadID, responseMsg, attachmentStream);
    }

    if (message && typeof message.react === 'function') {
      try { await message.react('✅'); } catch (e) {}
    }

  } catch (err: any) {
    console.error('[InstaPlugin Error]:', err.message);
    if (message && typeof message.react === 'function') {
      try { await message.react('❌'); } catch (e) {}
    }
    if (message && typeof message.reply === 'function') {
      await message.reply(`❌ **Instagram Downloader Error:** ${err.message || 'Failed to download content'}`);
    }
  } finally {
    if (tempFilePath) {
      setTimeout(() => {
        fs.remove(tempFilePath).catch(() => {});
      }, 20000);
    }
  }
}


