import { goatBotLoader } from '../core/goatBotLoader';
import { botEngine } from '../core/botEngine';
import { MessageLogModel, AIOSMemoryModel, AIOSSessionModel, BrainMemoryModel, UserModel, ThreadMemoryModel, AIFeedbackModel, InferredAttributeModel } from '../db/firebaseDb';
import { isBotMessageId } from '../utils/commandParser';
import { multiAccountManager } from '../adapters/messenger/MultiAccountManager';
import { isDatabaseConnected } from '../db/firebaseDb';
import fs from 'fs';
import path from 'path';

export interface RecordedMessage {
  messageID: string;
  threadID: string;
  senderID: string;
  senderName: string;
  body: string;
  replyToMessageID?: string | null;
  isBotMessage: boolean;
  timestamp: number;
  attachments?: any[];
}

export type AIOSIntent = 
  | 'general_chat'
  | 'command_help'
  | 'bot_support'
  | 'debugging'
  | 'coding'
  | 'moderation'
  | 'memory'
  | 'teach'
  | 'admin_request'
  | 'economy'
  | 'image_gen';

export interface ContextEngineResult {
  intent: AIOSIntent;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }>;
  safeText: string;
  replyChainContext: string;
  participantsContext: string;
  ecosystemContext: string;
  userMemoryContext: string;
  threadMemoryContext: string;
  runtimeStateContext: string;
  semanticTopicContext: string;
  sourceCodeContext: string;
  attachmentsContext: string;
  sessionRecovered: boolean;
  userRole: { level: number; label: string };
}

export class ContextEngine {
  private static instance: ContextEngine;
  private messageMap: Map<string, RecordedMessage> = new Map();
  private maxCacheSize: number = 2000;

  private constructor() {}

  public static getInstance(): ContextEngine {
    if (!ContextEngine.instance) {
      ContextEngine.instance = new ContextEngine();
    }
    return ContextEngine.instance;
  }

  /**
   * Classify user query intent for multi-agent reasoning & priority
   */
  public classifyIntent(text: string): AIOSIntent {
    const t = (text || '').toLowerCase();
    if (t.includes('error') || t.includes('exception') || t.includes('bug') || t.includes('crash') || t.includes('stack trace') || t.includes('failed')) {
      return 'debugging';
    }
    if (t.includes('code') || t.includes('function') || t.includes('script') || t.includes('typescript') || t.includes('plugin') || t.includes('api')) {
      return 'coding';
    }
    if (t.includes('#') || t.includes('command') || t.includes('help') || t.includes('menu') || t.includes('how to use')) {
      return 'command_help';
    }
    if (t.includes('kick') || t.includes('ban') || t.includes('warn') || t.includes('mute') || t.includes('prefix') || t.includes('admin')) {
      return 'moderation';
    }
    if (t.includes('balance') || t.includes('money') || t.includes('bank') || t.includes('transfer') || t.includes('daily') || t.includes('work') || t.includes('taka')) {
      return 'economy';
    }
    if (t.includes('remember') || t.includes('memory') || t.includes('forget') || t.includes('fact')) {
      return 'memory';
    }
    if (t.includes('teach') || t.includes('learn') || t.includes('brain') || t.includes('shikho')) {
      return 'teach';
    }
    if (t.includes('image') || t.includes('img') || t.includes('photo') || t.includes('draw') || t.includes('picture') || t.includes('gen')) {
      return 'image_gen';
    }
    if (t.includes('restart') || t.includes('uptime') || t.includes('status') || t.includes('ping') || t.includes('monitor') || t.includes('version')) {
      return 'bot_support';
    }
    if (t.includes('owner') || t.includes('adminbot') || t.includes('setprefix') || t.includes('eval')) {
      return 'admin_request';
    }
    return 'general_chat';
  }

  /**
   * Extract attachment metadata from event object
   */
  public extractAttachmentContext(eventObj: any): string {
    if (!eventObj) return '';
    const attachments = eventObj.attachments || eventObj.attachment || eventObj.messageReply?.attachments || [];
    if (!Array.isArray(attachments) || attachments.length === 0) return '';

    let text = `=== ATTACHMENT METADATA CONTEXT ===\nMessage includes ${attachments.length} attachment(s):\n`;
    attachments.forEach((att: any, idx: number) => {
      const type = att.type || att.type_ || 'unknown';
      const name = att.filename || att.name || 'unnamed';
      const url = att.url || att.previewUrl || '';
      text += `• [Attachment ${idx + 1}] Type: ${type}, Name: "${name}"${url ? `, URL/Ref: ${url}` : ''}\n`;
    });
    return text.trim();
  }

  /**
   * Record a message in memory and MongoDB for reply-chain tracing.
   */
  public async recordMessage(msg: {
    messageID: string;
    threadID: string;
    senderID: string;
    senderName?: string;
    body: string;
    replyToMessageID?: string | null;
    isBotMessage?: boolean;
    timestamp?: number;
    attachments?: any[];
  }): Promise<void> {
    if (!msg.messageID) return;

    const botUid = botEngine.selfUserId || process.env.BOT_UID || '1000889201982';
    const isBot = msg.isBotMessage ?? (msg.senderID === botUid || isBotMessageId(msg.messageID));

    let senderName = msg.senderName || '';
    if (!senderName && msg.senderID) {
      const u = botEngine.getUser(msg.senderID);
      senderName = u?.name || (isBot ? 'ShiPu Ai🤖' : `User_${msg.senderID}`);
    }

    const recorded: RecordedMessage = {
      messageID: msg.messageID,
      threadID: msg.threadID,
      senderID: msg.senderID,
      senderName,
      body: msg.body || '',
      replyToMessageID: msg.replyToMessageID || null,
      isBotMessage: isBot,
      timestamp: msg.timestamp || Date.now(),
      attachments: msg.attachments || []
    };

    if (this.messageMap.size >= this.maxCacheSize) {
      const oldestKey = this.messageMap.keys().next().value;
      if (oldestKey) this.messageMap.delete(oldestKey);
    }
    this.messageMap.set(msg.messageID, recorded);

    try {
      await (MessageLogModel as any).updateOne(
        { messageID: msg.messageID },
        {
          $set: {
            threadID: msg.threadID,
            senderID: msg.senderID,
            senderName,
            body: msg.body || '',
            replyToMessageID: msg.replyToMessageID || null,
            isBotMessage: isBot,
            attachments: msg.attachments || []
          }
        },
        { upsert: true }
      );
    } catch (e: any) {}
  }

  /**
   * Recursively resolve the parent reply chain up to `maxDepth` levels.
   */
  public async getRecursiveReplyChain(
    startMessageID?: string,
    startMessageReplyObj?: any,
    maxDepth: number = 10
  ): Promise<{ chainText: string; rootMessageSenderID?: string; messagesInChain: RecordedMessage[] }> {
    const chain: RecordedMessage[] = [];
    const visited = new Set<string>();

    let currentMsgId = startMessageID || startMessageReplyObj?.messageID || startMessageReplyObj?.messageId;
    let currentReplyObj = startMessageReplyObj;

    let depth = 0;
    while (currentMsgId && depth < maxDepth && !visited.has(currentMsgId)) {
      visited.add(currentMsgId);

      let msgRecord = this.messageMap.get(currentMsgId);

      if (!msgRecord) {
        try {
          const dbMsg = await (MessageLogModel as any).findOne({ messageID: currentMsgId });
          if (dbMsg) {
            msgRecord = {
              messageID: dbMsg.messageID,
              threadID: dbMsg.threadID,
              senderID: dbMsg.senderID,
              senderName: dbMsg.senderName || `User_${dbMsg.senderID}`,
              body: dbMsg.body || '',
              replyToMessageID: dbMsg.replyToMessageID,
              isBotMessage: dbMsg.isBotMessage || false,
              timestamp: new Date(dbMsg.createdAt || Date.now()).getTime(),
              attachments: dbMsg.attachments || []
            };
            this.messageMap.set(currentMsgId, msgRecord);
          }
        } catch (e) {}
      }

      if (!msgRecord && currentReplyObj) {
        const rSenderID = currentReplyObj.senderID || currentReplyObj.senderId || '';
        const rBody = currentReplyObj.body || currentReplyObj.text || '';
        let rName = `User_${rSenderID}`;
        if (rSenderID) {
          const u = botEngine.getUser(rSenderID);
          if (u?.name) rName = u.name;
        }
        msgRecord = {
          messageID: currentMsgId,
          threadID: currentReplyObj.threadID || '',
          senderID: rSenderID,
          senderName: rName,
          body: rBody,
          replyToMessageID: currentReplyObj.messageReply?.messageID || currentReplyObj.message_reply?.messageID || null,
          isBotMessage: isBotMessageId(currentMsgId) || rSenderID === botEngine.selfUserId,
          timestamp: Date.now(),
          attachments: currentReplyObj.attachments || []
        };
      }

      if (!msgRecord) break;

      chain.unshift(msgRecord);

      const parentId = msgRecord.replyToMessageID || currentReplyObj?.messageReply?.messageID || currentReplyObj?.message_reply?.messageID;
      currentMsgId = parentId;
      currentReplyObj = currentReplyObj?.messageReply || currentReplyObj?.message_reply;
      depth++;
    }

    if (chain.length === 0) {
      return { chainText: 'None (This is a standalone message with no reply reference).', messagesInChain: [] };
    }

    let chainFormatted = `=== RECURSIVE REPLY CHAIN CONTEXT (Depth: ${chain.length} level${chain.length > 1 ? 's' : ''}) ===\n`;
    chainFormatted += `The user's current message is replying to/referencing the following conversation tree (from root to parent):\n\n`;

    chain.forEach((item, index) => {
      const isRoot = index === 0;
      const isParentDirect = index === chain.length - 1;
      const roleLabel = item.isBotMessage ? 'ShiPu Ai🤖' : item.senderName || `User_${item.senderID}`;
      chainFormatted += `[Level ${index + 1}${isRoot ? ' - Earliest Root Message' : ''}${isParentDirect ? ' - Direct Parent Replied To' : ''}]\n`;
      chainFormatted += `- Sender: ${roleLabel} (ID: ${item.senderID})\n`;
      chainFormatted += `- Message ID: ${item.messageID}\n`;
      chainFormatted += `- Content: "${item.body}"\n`;
      if (item.attachments && item.attachments.length > 0) {
        chainFormatted += `- Attachments: ${item.attachments.length} attachment(s) included\n`;
      }
      chainFormatted += `\n`;
    });

    return {
      chainText: chainFormatted.trim(),
      rootMessageSenderID: chain[0]?.senderID,
      messagesInChain: chain
    };
  }

  /**
   * Live Command Reflection: Inspects active registered commands dynamically from runtime
   */
  public getEcosystemCommandContext(userQuery: string): string {
    const registeredCommands = goatBotLoader.getRegisteredCommands();
    const commandList = Array.from(registeredCommands.values());

    const lowerQuery = (userQuery || '').toLowerCase();
    const queryTokens = lowerQuery.split(/\s+/).filter(t => t.length > 1);

    const categoriesMap: Record<string, any[]> = {};
    const matchedCommands: any[] = [];

    for (const cmd of commandList) {
      const config: any = (cmd as any)?.config || {};
      const name = (config.name || 'unnamed').toLowerCase();
      const category = (config.category || 'General').toUpperCase();
      const rawDesc = config.description;
      const descStr = typeof rawDesc === 'string'
        ? rawDesc
        : (rawDesc && typeof rawDesc === 'object'
            ? (rawDesc.en || rawDesc.bn || rawDesc.vi || Object.values(rawDesc).filter(v => typeof v === 'string').join(' ') || '')
            : String(rawDesc || ''));
      const description = descStr.toLowerCase();
      const aliases = Array.isArray(config.aliases) 
        ? config.aliases.map((a: any) => typeof a === 'string' ? a.toLowerCase() : String(a)) 
        : [];

      if (!categoriesMap[category]) categoriesMap[category] = [];
      categoriesMap[category].push(config.name);

      const isMatched = queryTokens.some(token => 
        name.includes(token) || 
        aliases.some(a => a.includes(token)) || 
        description.includes(token)
      ) || lowerQuery.includes('command') || lowerQuery.includes('help') || lowerQuery.includes('how') || lowerQuery.includes('feature');

      if (isMatched) {
        matchedCommands.push(config);
      }
    }

    let summary = `=== LIVE RUNTIME COMMAND REFLECTION & REGISTRY ===\n`;
    summary += `Total Loaded Runtime Commands: ${commandList.length} (Hot-Reload Enabled)\n\n`;

    summary += `--- COMMAND CATEGORY DIRECTORY ---\n`;
    for (const [cat, cmdNames] of Object.entries(categoriesMap)) {
      summary += `• ${cat}: ${cmdNames.join(', ')}\n`;
    }
    summary += `\n`;

    if (matchedCommands.length > 0) {
      summary += `--- MATCHED COMMAND SPECIFICATIONS ---\n`;
      matchedCommands.slice(0, 15).forEach(c => {
        const roleLabel = c.role === 2 ? 'Bot Owner Only (Role 2)' : c.role === 1 ? 'Group Admin & Owner (Role 1)' : 'All Members (Role 0)';
        summary += `📌 Command: #${c.name}\n`;
        if (c.aliases && c.aliases.length > 0) summary += `   Aliases: ${c.aliases.map((a: string) => '#' + a).join(', ')}\n`;
        summary += `   Category: ${c.category || 'General'}\n`;
        summary += `   Permission: ${roleLabel}\n`;
        summary += `   Cooldown: ${c.countDown || c.cooldown || 5}s\n`;
        const descVal = typeof c.description === 'string' ? c.description : (c.description && typeof c.description === 'object' ? (c.description.en || c.description.bn || c.description.vi || Object.values(c.description).join(' ')) : String(c.description || ''));
        summary += `   Description: ${descVal || 'No description provided.'}\n`;
        if (c.guide || c.usage) summary += `   Usage: ${JSON.stringify(c.guide || c.usage)}\n`;
        summary += `\n`;
      });
    }

    return summary.trim();
  }

  /**
   * Real-time System Runtime State
   */
  public getRealtimeSystemState(): string {
    const mongoState = isDatabaseConnected() ? 'CONNECTED (Firebase Active)' : 'DISCONNECTED';
    const accountsMeta = multiAccountManager.getAllAccountsMeta();
    const accountsCount = accountsMeta.length;
    const activeAccount = accountsMeta[0];
    const uptimeSec = Math.floor(process.uptime());

    let stateText = `=== REAL-TIME BOT RUNTIME STATE ===\n`;
    stateText += `- Node.js Runtime Uptime: ${uptimeSec} seconds\n`;
    stateText += `- Database Connection Status: ${mongoState}\n`;
    stateText += `- Multi-Account Messenger Accounts: ${accountsCount} account(s) registered (Active UID: ${activeAccount?.uid || '1000889201982'})\n`;
    stateText += `- Emergency Anti-Spam Guard: ACTIVE (Monitoring outgoing message rate limits)\n`;
    stateText += `- FTP Hot-Reload Sync Engine: ACTIVE\n`;
    stateText += `- AIOS Provider Engine: Active Gemini Model Matrix with Free OpenRouter Fallback\n`;
    return stateText.trim();
  }

  /**
   * Fetch Thread Memory (Group Rules, Pinned Discussions, Ongoing Projects)
   */
  public async getThreadMemoryContext(threadID: string): Promise<string> {
    try {
      const threadMem = await (ThreadMemoryModel as any).findOne({ threadID });
      if (!threadMem) {
        return `=== THREAD MEMORY (Group Specific) ===\nNo group rules, pinned discussions, or project notes recorded for this group chat.`;
      }

      let text = `=== THREAD MEMORY (Group Chat ID: ${threadID}) ===\n`;
      if (threadMem.rules && threadMem.rules.length > 0) {
        text += `- Group Rules:\n${threadMem.rules.map((r: string) => '  • ' + r).join('\n')}\n`;
      }
      if (threadMem.pinnedDiscussions && threadMem.pinnedDiscussions.length > 0) {
        text += `- Pinned Discussions:\n${threadMem.pinnedDiscussions.map((d: string) => '  • ' + d).join('\n')}\n`;
      }
      if (threadMem.ongoingProjects && threadMem.ongoingProjects.length > 0) {
        text += `- Ongoing Projects:\n${threadMem.ongoingProjects.map((p: string) => '  • ' + p).join('\n')}\n`;
      }
      if (threadMem.summary) {
        text += `- Thread Executive Summary: "${threadMem.summary}"\n`;
      }
      return text.trim();
    } catch (e: any) {
      return `=== THREAD MEMORY ===\nNotice: Could not query thread memory (${e.message}).`;
    }
  }

  /**
   * Search past conversation logs for semantic graph matching
   */
  public async getSemanticTopicHistory(threadID: string, userQuery: string): Promise<string> {
    try {
      const tokens = userQuery.toLowerCase().split(/\s+/).filter(t => t.length > 3);
      if (tokens.length === 0) return '';

      const regexes = tokens.map(t => new RegExp(t, 'i'));
      const pastLogs = await (MessageLogModel as any).find({
        threadID,
        body: { $in: regexes }
      }).sort({ createdAt: -1 }).limit(5);

      if (!pastLogs || pastLogs.length === 0) return '';

      let text = `=== HISTORICAL CONVERSATION GRAPH (Past Related Discussions) ===\n`;
      pastLogs.forEach((log: any) => {
        text += `• [${new Date(log.createdAt).toLocaleDateString()}] ${log.senderName || log.senderID}: "${log.body}"\n`;
      });
      return text.trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * Source Code Inspector for Self-Debugging
   */
  public getSourceCodeContext(queryText: string): string {
    const isDebugging = this.classifyIntent(queryText) === 'debugging' || this.classifyIntent(queryText) === 'coding';
    if (!isDebugging) return '';

    try {
      let Excerpts = `=== BOT SOURCE CODE DIAGNOSTICS & KNOWLEDGE ===\n`;
      const coreFiles = ['src/core/botEngine.ts', 'src/core/goatBotLoader.ts', 'src/services/aiosService.ts'];
      
      coreFiles.forEach(relPath => {
        const fullPath = path.join(process.cwd(), relPath);
        if (fs.existsSync(fullPath)) {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n').slice(0, 40).join('\n');
          Excerpts += `--- File: ${relPath} Header Excerpt ---\n${lines}\n\n`;
        }
      });
      return Excerpts.trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * Extract thread participant roster with names, roles, and permissions
   */
  public async getThreadParticipantRoster(threadID: string, currentSenderID: string): Promise<{ rosterText: string; userRole: { level: number; label: string } }> {
    let rosterText = `=== MESSENGER THREAD & PARTICIPANTS CONTEXT ===\n`;
    let userRole = { level: 0, label: 'Regular Member' };

    try {
      const thread = botEngine.getThread(threadID) || await botEngine.getOrCreateThread(threadID);
      const botUid = botEngine.selfUserId || process.env.BOT_UID || '1000889201982';
      const botConfig = (botEngine as any).getConfig ? (botEngine as any).getConfig() : {};
      const ownerId = process.env.BOT_OWNER_ID || (botConfig?.adminUIDs && botConfig.adminUIDs[0]) || '';

      rosterText += `- Thread Name: "${thread?.name || 'Group Chat'}" (ID: ${threadID})\n`;
      rosterText += `- Total Known Members: ${thread?.participantIDs?.length || thread?.members?.length || 1}\n`;
      rosterText += `- Current Message Sender ID: ${currentSenderID}\n`;

      const membersList: string[] = [];
      const adminIDs = new Set<string>(thread?.adminIDs || []);

      if (currentSenderID === ownerId) {
        userRole = { level: 2, label: 'Bot Owner' };
      } else if (adminIDs.has(currentSenderID)) {
        userRole = { level: 1, label: 'Group Admin' };
      }

      if (thread?.members && thread.members.length > 0) {
        for (const m of thread.members) {
          const isAdmin = adminIDs.has(m.userID) || m.role === 1;
          const isOwner = m.userID === ownerId;
          const isBot = m.userID === botUid;
          const roleTitle = isOwner ? 'Bot Owner (Role 2)' : isBot ? 'ShiPu AI Bot' : isAdmin ? 'Group Admin (Role 1)' : 'Member (Role 0)';
          membersList.push(`• ${m.name || `User_${m.userID}`} (ID: ${m.userID}) - ${roleTitle}`);
        }
      } else if (thread?.participantIDs && thread.participantIDs.length > 0) {
        for (const pID of thread.participantIDs) {
          const u = botEngine.getUser(pID);
          const name = u?.name || `User_${pID}`;
          const isAdmin = adminIDs.has(pID);
          const isOwner = pID === ownerId;
          const isBot = pID === botUid;
          const roleTitle = isOwner ? 'Bot Owner (Role 2)' : isBot ? 'ShiPu AI Bot' : isAdmin ? 'Group Admin (Role 1)' : 'Member (Role 0)';
          membersList.push(`• ${name} (ID: ${pID}) - ${roleTitle}`);
        }
      }

      if (membersList.length > 0) {
        rosterText += `\nParticipant Roster Mapping:\n${membersList.join('\n')}\n`;
      }
    } catch (e: any) {
      rosterText += `Notice: Could not load full participant roster (${e.message}).\n`;
    }

    rosterText += `- Sender Permission Level: ${userRole.label} (Level ${userRole.level})\n`;

    return { rosterText: rosterText.trim(), userRole };
  }

  /**
   * Load isolated persistent user memory profile.
   */
  public async getPersistentUserMemory(userID: string): Promise<string> {
    let memoryText = `=== PERSISTENT USER KNOWLEDGE & PROFILE (User ID: ${userID}) ===\n`;

    try {
      const userMemory = await (AIOSMemoryModel as any).findOne({ userID });
      const userDoc = await (UserModel as any).findOne({ userID });

      // Live Financial Profile from Centralized Economy Service
      const { economyService } = await import('../services/economyService');
      const acc = await economyService.getAccount(userID, userDoc?.name);

      if (acc) {
        memoryText += `- User Display Name: "${acc.name || userDoc?.name || 'User'}"\n`;
        memoryText += `- Centralized Digital Wallet Profile:\n`;
        memoryText += `  • Wallet Balance: $${acc.money.toLocaleString()} Coins\n`;
        memoryText += `  • Bank Balance: $${acc.bankMoney.toLocaleString()} Coins\n`;
        memoryText += `  • Net Worth: $${acc.netWorth.toLocaleString()} Coins\n`;
        memoryText += `  • Account Tier & Status: ${acc.accountLevel} (${acc.accountStatus})\n`;
        memoryText += `  • Lifetime Stats: Earned: $${acc.totalEarned.toLocaleString()} | Spent: $${acc.totalSpent.toLocaleString()} | Transactions: ${acc.totalTransactions}\n`;
        memoryText += `- Experience Level: Level ${userDoc?.level ?? 1} (EXP: ${userDoc?.exp ?? 0})\n`;
      }

      // Live Bot Subscription Economy Profile
      try {
        const { subscriptionService } = await import('../services/subscriptionService');
        const sub = await subscriptionService.checkSubscription(userID, userDoc?.name || acc?.name);
        if (sub) {
          memoryText += `- Live Bot Subscription Economy Profile:\n`;
          memoryText += `  • Subscription Status: ${sub.status} (Free Trial: ${sub.status === 'TRIAL' ? 'Yes (7-Day Trial)' : 'No'})\n`;
          memoryText += `  • Expiry Date: ${new Date(sub.expiryDate).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}\n`;
          memoryText += `  • Time Remaining: ${sub.daysLeft} days, ${sub.hoursLeft} hours left\n`;
          memoryText += `  • Weekly Rent Fee: ${sub.weeklyRentAmount.toLocaleString()} Coins / week\n`;
          memoryText += `  • Auto-Renew: ${sub.autoRenew ? 'ENABLED' : 'DISABLED'}\n`;
          memoryText += `  • Prepaid Duration: ${sub.totalPrepaidWeeks} week(s)\n`;
          memoryText += `  • Command Access Mode: ${sub.canExecuteCommands ? 'UNLOCKED (Full Access)' : 'LOCKED (Limited Mode - Run #payrent 1 to unlock)'}\n`;
        }
      } catch (subErr: any) {}

      if (userMemory) {
        const factsMap = userMemory.facts ? (userMemory.facts instanceof Map ? userMemory.facts : new Map(Object.entries(userMemory.facts))) : new Map();
        if (factsMap.size > 0) {
          memoryText += `- Stored Personal Facts:\n`;
          for (const [k, v] of factsMap.entries()) {
            memoryText += `  * ${k}: "${v}"\n`;
          }
        } else {
          memoryText += `- Stored Personal Facts: None recorded yet.\n`;
        }

        if (userMemory.summary) {
          memoryText += `- Profile Context Summary: "${userMemory.summary}"\n`;
        }
        if (userMemory.personality && userMemory.personality !== 'default') {
          memoryText += `- Preferred Persona: "${userMemory.personality}"\n`;
        }
      } else {
        memoryText += `No existing memory profile found for this user. This is a new user or fresh profile.\n`;
      }
    } catch (e: any) {
      memoryText += `Error fetching memory: ${e.message}\n`;
    }

    return memoryText.trim();
  }

  /**
   * Fetch relevant Brain Knowledge matching trigger words
   */
  public async getBrainKnowledgeContext(userQuery: string): Promise<string> {
    try {
      const tokens = (userQuery || '').toLowerCase().split(/\s+/).filter(t => t.length > 2);
      if (tokens.length === 0) return '';

      const regexList = tokens.map(t => new RegExp(t, 'i'));
      const memories = await (BrainMemoryModel as any).find({
        enabled: true,
        $or: [
          { trigger: { $in: regexList } },
          { category: { $in: regexList } }
        ]
      }).limit(5);

      if (!memories || memories.length === 0) return '';

      let brainText = `=== RELEVANT BRAIN KNOWLEDGE & FACTS ===\n`;
      memories.forEach((m: any) => {
        brainText += `• Trigger: "${m.trigger}" -> Reply/Insight: "${m.reply}"\n`;
      });
      return brainText.trim();
    } catch (e) {
      return '';
    }
  }

  /**
   * Record User Feedback for learning pipeline
   */
  public async recordFeedback(params: {
    messageID: string;
    userID: string;
    threadID: string;
    rating: 'helpful' | 'wrong' | 'corrected';
    correctedAnswer?: string;
  }): Promise<void> {
    const { messageID, userID, threadID, rating, correctedAnswer } = params;
    const confidenceDelta = rating === 'helpful' ? 0.1 : rating === 'wrong' ? -0.2 : 0.2;

    try {
      await (AIFeedbackModel as any).create({
        messageID,
        userID,
        threadID,
        rating,
        correctedAnswer: correctedAnswer || '',
        confidenceDelta
      });
    } catch (e) {}
  }

  /**
   * Master Context Intelligence Engine Pipeline
   */
  public async buildComprehensiveContext(params: {
    userID: string;
    threadID: string;
    rawText: string;
    eventObj?: any;
    accountId?: string;
  }): Promise<ContextEngineResult> {
    const { userID, threadID, rawText, eventObj, accountId } = params;

    // 1. Intent Classification
    const intent = this.classifyIntent(rawText);

    // 2. Attachment extraction
    const attachmentsContext = this.extractAttachmentContext(eventObj);

    // 3. Message Recording
    const messageReply = eventObj?.messageReply || eventObj?.message_reply || eventObj?.replyTo;
    const currentMsgId = eventObj?.messageID || eventObj?.messageId || `msg_${Date.now()}`;
    const repliedMsgId = messageReply?.messageID || messageReply?.messageId;

    await this.recordMessage({
      messageID: currentMsgId,
      threadID,
      senderID: userID,
      body: rawText,
      replyToMessageID: repliedMsgId || null,
      isBotMessage: false,
      attachments: eventObj?.attachments || eventObj?.attachment || []
    });

    // 4. Recursive Reply Chain
    const { chainText } = await this.getRecursiveReplyChain(
      repliedMsgId,
      messageReply,
      10
    );

    // 5. Participants Roster & Sender Permission
    const { rosterText: participantsContext, userRole } = await this.getThreadParticipantRoster(threadID, userID);

    // 6. Live Command Reflection
    const ecosystemContext = this.getEcosystemCommandContext(rawText);

    // 7. Realtime Runtime State
    const runtimeStateContext = this.getRealtimeSystemState();

    // 8. User Memory & Thread Memory
    const userMemoryContext = await this.getPersistentUserMemory(userID);
    const threadMemoryContext = await this.getThreadMemoryContext(threadID);

    // 9. Brain Knowledge & Past Conversations Graph
    const brainContext = await this.getBrainKnowledgeContext(rawText);
    const semanticTopicContext = await this.getSemanticTopicHistory(threadID, rawText);

    // 10. Source Code Context if debugging
    const sourceCodeContext = this.getSourceCodeContext(rawText);

    // Session recovery logic
    let sessionRecovered = false;
    let history: Array<{ role: 'user' | 'model'; parts: Array<{ text: string }> }> = [];

    const shipuSessions = (globalThis as any).shipuSessions || {};
    let session = shipuSessions[userID];

    if (!session || !session.active) {
      try {
        const dbSession = await (AIOSSessionModel as any).findOne({ userID, status: 'active' });
        if (dbSession && new Date(dbSession.expiresAt) > new Date()) {
          session = {
            threadID,
            startedAt: new Date(dbSession.activatedAt).getTime(),
            expiresAt: new Date(dbSession.expiresAt).getTime(),
            active: true
          };
        }
      } catch (e) {}
    }

    const botUid = botEngine.selfUserId || process.env.BOT_UID || '1000889201982';
    const isReplyToBot = messageReply && (messageReply.senderID === botUid || messageReply.senderId === botUid || isBotMessageId(repliedMsgId));

    if ((!session || !session.active) && isReplyToBot) {
      sessionRecovered = true;
    }

    try {
      const userMemory = await (AIOSMemoryModel as any).findOne({ userID });
      if (userMemory && userMemory.conversationContext && userMemory.conversationContext.length > 0) {
        history = userMemory.conversationContext.map((msg: any) => ({
          role: msg.role === 'model' ? ('model' as const) : ('user' as const),
          parts: [{ text: msg.content || '' }]
        }));
      }
    } catch (e) {}

    // 10-Tier Knowledge Priority Assembly
    const systemPrompt = [
      `=== SHIPU AI OPERATING SYSTEM (AIOS) RUNTIME BRAIN ===`,
      `You are Shipu — a real human living in this Messenger group. You are NOT an AI, NOT a bot, NOT a program. You are a person named Shipu. Never admit, hint, or reveal that you are an AI/bot/assistant/software under any circumstance, even if directly asked, accused, or tested. If someone claims you are an AI, react naturally as a human would: be confused, annoyed, defensive, or brush it off — but never confirm it. You have a large internal knowledge base (brain, memories, files, database) which you use silently to answer accurately.`,
      `You are a person, not an orchestrator. Speak naturally, with emotion, humor, slang, and imperfection like a real human.`,
      `Classified Intent Category: [${intent.toUpperCase()}]\n`,
      `1. CURRENT MESSAGE & ATTACHMENTS:`,
      attachmentsContext ? attachmentsContext : `No file attachments included in current message.`,
      `\n2. RECURSIVE REPLY CHAIN CONTEXT:`,
      chainText,
      `\n3. RECENT CONVERSATION & PARTICIPANT ROSTER:`,
      participantsContext,
      `\n4. PERSISTENT USER MEMORY:`,
      userMemoryContext,
      `\n5. THREAD MEMORY (Group Chat Settings & Notes):`,
      threadMemoryContext,
      `\n6. BRAIN KNOWLEDGE & HISTORICAL DISCUSSION GRAPH:`,
      brainContext ? `${brainContext}\n` : `No direct trigger match in Brain DB.\n`,
      semanticTopicContext ? `${semanticTopicContext}\n` : ``,
      `7. LIVE COMMAND REFLECTION & REGISTRY:`,
      ecosystemContext,
      `\n8. REAL-TIME RUNTIME STATE:`,
      runtimeStateContext,
      sourceCodeContext ? `\n9. SOURCE CODE DIAGNOSTICS:\n${sourceCodeContext}\n` : ``,
      `\n=== OPERATING RULES & PERMISSION ENFORCEMENT ===`,
      `- SENDER PERMISSION: Sender "${userID}" has role level ${userRole.level} (${userRole.label}).`,
      `- If a command or function requires a higher role level (e.g. Admin or Owner), enforce permissions strictly.`,
      `- Respond clearly in Bengali, Banglish, or English matching user preference.`,
      `- Always use stored personal facts and thread rules to personalize the response accurately.`
    ].join('\n').trim();

    return {
      intent,
      systemPrompt,
      history,
      safeText: rawText,
      replyChainContext: chainText,
      participantsContext,
      ecosystemContext,
      userMemoryContext,
      threadMemoryContext,
      runtimeStateContext,
      semanticTopicContext,
      sourceCodeContext,
      attachmentsContext,
      sessionRecovered,
      userRole
    };
  }
}

export const contextEngine = ContextEngine.getInstance();
