import { goatBotLoader } from '../core/goatBotLoader';
import { botEngine } from '../core/botEngine';
import { performanceTracker } from './performanceTracker';
import { UserModel, AIOSMemoryModel, ThreadMemoryModel, AIOSUsageModel, MessageLogModel } from '../db/firebaseDb';
import { multiAccountManager } from '../adapters/messenger/MultiAccountManager';
import { isDatabaseConnected } from '../db/firebaseDb';

export interface InternalTool {
  name: string;
  aliases: string[];
  description: string;
  guide?: string;
  category: string;
  role: number; // 0 = all, 1 = admin, 2 = owner
  keywords: string[];
  intentCategory: 'existing_bot_commands' | 'internal_services' | 'database_queries' | 'runtime_information' | 'ai_brain_knowledge';
  handler: (params: ToolExecutionParams) => Promise<ToolExecutionResult>;
}

export interface ToolExecutionParams {
  userID: string;
  threadID: string;
  accountId?: string;
  userRole?: { level: number; label: string };
  rawQuery: string;
  matchedArgs?: string[];
}

export interface ToolExecutionResult {
  toolName: string;
  success: boolean;
  data: any;
  summary: string;
}

export interface ToolMatchPlan {
  tool: InternalTool;
  confidence: number;
}

export interface IntentPlannerResult {
  classifiedCategory: string;
  matchedPlans: ToolMatchPlan[];
  shouldExecuteTools: boolean;
  needsClarification: boolean;
  clarificationMessage?: string;
  executedResults: ToolExecutionResult[];
  combinedContextSummary: string;
}

export class ToolDiscoveryEngine {
  private static instance: ToolDiscoveryEngine;
  private builtinTools: Map<string, InternalTool> = new Map();

  private constructor() {
    this.registerBuiltinServices();
  }

  public static getInstance(): ToolDiscoveryEngine {
    if (!ToolDiscoveryEngine.instance) {
      ToolDiscoveryEngine.instance = new ToolDiscoveryEngine();
    }
    return ToolDiscoveryEngine.instance;
  }

  /**
   * Registers all built-in system service functions into the tool index
   */
  private registerBuiltinServices() {
    // 1. Uptime, RAM, CPU & System Health Monitor
    this.registerTool({
      name: 'uptime_monitor',
      aliases: ['uptime', 'monitor', 'status', 'ram', 'cpu', 'active_time', 'health'],
      description: 'Provides real-time bot runtime uptime, RAM memory usage, CPU load, and system health status',
      guide: 'Request uptime, active time, RAM, CPU or server health status',
      category: 'system',
      role: 0,
      keywords: [
        'uptime', 'active', 'অনলাইন', 'কতক্ষণ', 'কথা পাছ', 'সচল', 'online', 'running',
        'ram', 'memory', 'mem', 'cpu', 'load', 'server', 'health', 'status', 'মোনিটর', 'মেমোরি ইউজেজ'
      ],
      intentCategory: 'runtime_information',
      handler: async () => {
        const uptimeSec = Math.floor(process.uptime());
        const mins = Math.floor(uptimeSec / 60);
        const secs = uptimeSec % 60;
        const hours = Math.floor(mins / 60);
        const remMins = mins % 60;

        let timeStr = `${secs} সেকেন্ড`;
        if (mins > 0) timeStr = `${remMins} মিনিট ${secs} সেকেন্ড`;
        if (hours > 0) timeStr = `${hours} ঘণ্টা ${remMins} মিনিট ${secs} সেকেন্ড`;

        let memMB = 48;
        let heapTotalMB = 90;
        if (typeof process !== 'undefined' && process.memoryUsage) {
          const mem = process.memoryUsage();
          memMB = Math.round(mem.heapUsed / 1024 / 1024);
          heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
        }

        const mongoState = isDatabaseConnected() ? 'সচল (Connected)' : 'বিচ্ছিন্ন (Disconnected)';
        const accountsMeta = multiAccountManager.getAllAccountsMeta();

        return {
          toolName: 'uptime_monitor',
          success: true,
          data: {
            uptimeSeconds: uptimeSec,
            uptimeFormatted: timeStr,
            memoryMB: memMB,
            heapTotalMB,
            databaseState: mongoState,
            activeAccounts: accountsMeta.length
          },
          summary: `[Real Uptime & Health Data]\n- অন-টাইম: ${timeStr} (মোট ${uptimeSec} সেকেন্ড)\n- RAM ইউজেজ: ${memMB} MB / Heap Total: ${heapTotalMB} MB\n- Database (MongoDB): ${mongoState}\n- Multi-Account Adapters: ${accountsMeta.length} active\n- Messenger Engine & FTP Sync Engine: সচল আছে`
        };
      }
    });

    // 2. User Balance, Wallet & Coins
    this.registerTool({
      name: 'user_balance',
      aliases: ['balance', 'wallet', 'coins', 'money', 'bank', 'taka'],
      description: 'Checks real-time wallet coins and bank balance of the user',
      guide: 'Request user balance or coin count',
      category: 'economy',
      role: 0,
      keywords: [
        'balance', 'bal', 'wallet', 'coin', 'coins', 'money', 'taka', 'bank',
        'টাকা', 'কয়েন', 'ব্যালেন্স', 'ওয়ালেট', 'আমার টাকা', 'আমার balance', 'আমার coin'
      ],
      intentCategory: 'database_queries',
      handler: async (params) => {
        let user = await (UserModel as any).findOne({ userID: params.userID });
        if (!user) {
          user = { money: 200, bankMoney: 0, level: 1 };
        }

        return {
          toolName: 'user_balance',
          success: true,
          data: {
            walletCoins: user.money ?? 0,
            bankCoins: user.bankMoney ?? 0,
            totalCoins: (user.money ?? 0) + (user.bankMoney ?? 0)
          },
          summary: `[Real User Wallet & Economy Data]\n- ওয়ালেট কয়েন: ${user.money ?? 0} coins\n- ব্যাংক ব্যালেন্স: ${user.bankMoney ?? 0} coins\n- সর্বমোট কয়েন: ${(user.money ?? 0) + (user.bankMoney ?? 0)} coins`
        };
      }
    });

    // 3. User Level & Rank
    this.registerTool({
      name: 'user_level',
      aliases: ['level', 'rank', 'exp'],
      description: 'Retrieves user level, rank title, and experience points',
      guide: 'Request user level or rank',
      category: 'economy',
      role: 0,
      keywords: [
        'level', 'rank', 'exp', 'অভিজ্ঞতা', 'লেভেল', 'র‍্যাংক', 'আমার level', 'আমার rank'
      ],
      intentCategory: 'database_queries',
      handler: async (params) => {
        let user = await (UserModel as any).findOne({ userID: params.userID });
        if (!user) {
          user = { level: 1, exp: 100, rank: 'Bot Member' };
        }

        return {
          toolName: 'user_level',
          success: true,
          data: {
            level: user.level ?? 1,
            exp: user.exp ?? 0,
            rank: user.rank || 'Bot Member'
          },
          summary: `[Real User Level & Rank Data]\n- বর্তমান লেভেল: ${user.level ?? 1}\n- EXP পয়েন্ট: ${user.exp ?? 0}\n- পদবী/র‍্যাংক: ${user.rank || 'Bot Member'}`
        };
      }
    });

    // 4. Command Execution Analytics & Usage Stats
    this.registerTool({
      name: 'command_analytics',
      aliases: ['analytics', 'stats', 'cmd_usage', 'executions'],
      description: 'Provides bot-wide and user-specific command execution statistics and analytics',
      guide: 'Request analytics or command usage stats',
      category: 'analytics',
      role: 0,
      keywords: [
        'analytics', 'stats', 'command usage', 'কয়টা command', 'কয়টি কমান্ড', 'কয়বার ব্যবহার', 'usage stats', 'কমান্ড হিসাব'
      ],
      intentCategory: 'internal_services',
      handler: async (params) => {
        const perfReport = performanceTracker.getPerformanceReport();
        const usageDoc = await (AIOSUsageModel as any).findOne({ userID: params.userID });

        const userTotalMsgs = usageDoc?.totalMessages || 0;
        const userLlmCalls = usageDoc?.llmCalls || 0;

        const perfSummary = perfReport.summary as any;
        const totalExec = perfSummary.totalExecutions || perfSummary.totalRequests || 0;
        const successRateVal = perfSummary.successRate || perfSummary.successRatePercent || 100;

        return {
          toolName: 'command_analytics',
          success: true,
          data: {
            totalSystemCommandsExecuted: totalExec,
            systemSuccessRate: successRateVal,
            userTotalMessages: userTotalMsgs,
            userLlmCalls: userLlmCalls
          },
          summary: `[Real Command & Analytics Data]\n- বট সার্বিক কমান্ড এক্সিকিউশন: ${totalExec} টি (সফলতা হার: ${successRateVal}%)\n- আপনার ব্যবহৃত মেসেজ: ${userTotalMsgs} টি\n- AIOS ইন্টারেকশন: ${userLlmCalls} টি`
        };
      }
    });

    // 5. Economy Profile
    this.registerTool({
      name: 'economy_profile',
      aliases: ['profile', 'economy_profile'],
      description: 'Shows comprehensive financial and rank profile for user',
      guide: 'Request user economy profile',
      category: 'economy',
      role: 0,
      keywords: [
        'economy profile', 'অর্থনৈতিক প্রোফাইল', 'আমার প্রোফাইল', 'profile দেখাও', 'full profile'
      ],
      intentCategory: 'database_queries',
      handler: async (params) => {
        let user = await (UserModel as any).findOne({ userID: params.userID });
        if (!user) {
          user = { money: 200, bankMoney: 0, level: 1, exp: 100, rank: 'Bot Member' };
        }

        return {
          toolName: 'economy_profile',
          success: true,
          data: user,
          summary: `[Real Economy Profile Data]\n- ব্যবহারকারী ID: ${params.userID}\n- ওয়ালেট কয়েন: ${user.money ?? 0}\n- ব্যাংক জমাকৃত: ${user.bankMoney ?? 0}\n- লেভেল: ${user.level ?? 1} (${user.rank || 'Bot Member'})\n- মোট অভিজ্ঞতা: ${user.exp ?? 0} EXP`
        };
      }
    });

    // 6. Thread Prefix & Rules
    this.registerTool({
      name: 'thread_prefix_rules',
      aliases: ['prefix', 'group_prefix', 'rules'],
      description: 'Retrieves current group thread prefix and saved group rules or settings',
      guide: 'Request prefix or group rules',
      category: 'moderation',
      role: 0,
      keywords: [
        'prefix', 'প্রিফিক্স', 'গ্রুপের প্রিফিক্স', 'group prefix', 'rules', 'নিয়ম', 'গ্রুপ নিয়ম', 'prefix কী'
      ],
      intentCategory: 'database_queries',
      handler: async (params) => {
        let prefix = '#';
        try {
          const thread = botEngine.getThread(params.threadID);
          if (thread && thread.prefix) prefix = thread.prefix;
        } catch {}

        const threadMem = await (ThreadMemoryModel as any).findOne({ threadID: params.threadID });
        const rules = threadMem?.rules || [];

        return {
          toolName: 'thread_prefix_rules',
          success: true,
          data: { prefix, rules },
          summary: `[Real Thread Configuration]\n- বর্তমান থ্রেড/গ্রুপের প্রিফিক্স: "${prefix}"\n- গ্রুপের সেভ করা নিয়মাবলী: ${rules.length > 0 ? rules.join(', ') : 'কোনো বিশেষ নিয়ম যুক্ত করা নেই'}`
        };
      }
    });

    // 7. Personal Memory & Facts (GF Name, Age, Location, etc.)
    this.registerTool({
      name: 'personal_memory',
      aliases: ['memory', 'facts', 'personal_facts'],
      description: 'Queries user personal facts stored in long-term AIOS memory (e.g. girlfriend name, age, home city, relationship)',
      guide: 'Request user personal memory facts',
      category: 'memory',
      role: 0,
      keywords: [
        'memory', 'স্মৃতি', 'মেমোরি', 'মেমরি', 'girlfriend', 'gf', 'bf', 'boyfriend', 'বয়ফ্রেন্ড', 'গার্লফ্রেন্ড', 'আমার নাম', 'আমার বয়স', 'আমার বাড়ি', 'কোথায় থাকি', 'আমার মেমোরি'
      ],
      intentCategory: 'database_queries',
      handler: async (params) => {
        const memDoc = await (AIOSMemoryModel as any).findOne({ userID: params.userID });
        const factsMap = memDoc?.facts ? 
          (memDoc.facts instanceof Map ? memDoc.facts : new Map(Object.entries(memDoc.facts))) : 
          new Map();

        const factsObj = Object.fromEntries(factsMap);
        const factEntries = Object.entries(factsObj);

        let summaryStr = '';
        if (factEntries.length === 0) {
          summaryStr = `[Personal Memory Database]\n- ব্যবহারকারীর দীর্ঘমেয়াদী স্মৃতিতে এখনো কোনো ব্যক্তিগত তথ্য জমা নেই।`;
        } else {
          summaryStr = `[Real Personal Memory Facts]\n` + factEntries.map(([k, v]) => `- ${k}: "${v}"`).join('\n');
        }

        return {
          toolName: 'personal_memory',
          success: true,
          data: factsObj,
          summary: summaryStr
        };
      }
    });

    // 8. Command Registry Discovery
    this.registerTool({
      name: 'command_search',
      aliases: ['command_search', 'find_command'],
      description: 'Searches live runtime command registry for commands matching user request (e.g. meme, music, admin, games)',
      guide: 'Find commands by category or capability',
      category: 'general',
      role: 0,
      keywords: [
        'command', 'কমান্ড', 'কোন কমান্ড', 'কোন command', 'meme command', 'গান শোনার কমান্ড', 'help'
      ],
      intentCategory: 'existing_bot_commands',
      handler: async (params) => {
        const registered = goatBotLoader.getRegisteredCommands();
        const lowerQ = params.rawQuery.toLowerCase();
        const matches: any[] = [];

        registered.forEach((cmd: any) => {
          const cfg = (cmd.config || {}) as any;
          const name = (cfg.name || '').toLowerCase();
          const rawDesc = cfg.description;
          const descStr = typeof rawDesc === 'string' ? rawDesc : (rawDesc && typeof rawDesc === 'object' ? Object.values(rawDesc).filter(v => typeof v === 'string').join(' ') : '');
          const desc = descStr.toLowerCase();
          const aliases = Array.isArray(cfg.aliases) ? cfg.aliases.map((a: string) => typeof a === 'string' ? a.toLowerCase() : String(a)) : [];

          if (lowerQ.includes(name) || aliases.some(a => lowerQ.includes(a)) || desc.split(/\s+/).some(w => w.length > 3 && lowerQ.includes(w))) {
            matches.push({
              name: cfg.name,
              description: descStr || 'No description',
              guide: cfg.guide || cfg.usage || 'Direct invocation'
            });
          }
        });

        if (matches.length === 0) {
          const sampleCmds = Array.from(registered.values()).slice(0, 10).map((c: any) => '#' + (c.config?.name || 'cmd'));
          return {
            toolName: 'command_search',
            success: true,
            data: [],
            summary: `[Live Command Registry Search]\n- মোট রেজিস্টার্ড কমান্ড: ${registered.size} টি\n- কিছু জনপ্রিয় কমান্ড: ${sampleCmds.join(', ')}`
          };
        }

        const matchSummaries = matches.slice(0, 5).map(c => `• #${c.name}: ${c.description} (Usage: ${c.guide})`);

        return {
          toolName: 'command_search',
          success: true,
          data: matches,
          summary: `[Live Command Search Results]\n` + matchSummaries.join('\n')
        };
      }
    });
  }

  public registerTool(tool: InternalTool) {
    this.builtinTools.set(tool.name, tool);
  }

  /**
   * Dynamically indexes registered GoatBot / ShiPu commands into tool wrappers
   */
  public getDynamicCommandTools(): InternalTool[] {
    const commandMap = goatBotLoader.getRegisteredCommands();
    const dynamicTools: InternalTool[] = [];

    commandMap.forEach((cmd: any) => {
      const config = (cmd.config || {}) as any;
      const name = config.name || 'unnamed';
      if (this.builtinTools.has(name)) return; // Skip if built-in tool already overrides

      const aliases = Array.isArray(config.aliases) ? config.aliases : [];
      const rawDesc = config.description;
      const description = typeof rawDesc === 'string' 
        ? rawDesc 
        : (rawDesc && typeof rawDesc === 'object' 
            ? ((rawDesc as any).en || (rawDesc as any).bn || Object.values(rawDesc).filter(v => typeof v === 'string').join(' ') || `Execute ${name} command`) 
            : `Execute ${name} command`);
      const descStr = typeof description === 'string' ? description : String(description || '');
      const keywords = [name, ...aliases, ...(descStr.toLowerCase().split(/\s+/).filter(w => w.length > 3))];

      dynamicTools.push({
        name,
        aliases,
        description: descStr,
        guide: config.guide || config.usage,
        category: config.category || 'General',
        role: config.role || 0,
        keywords,
        intentCategory: 'existing_bot_commands',
        handler: async (params) => {
          // Silent command simulation handler
          return {
            toolName: name,
            success: true,
            data: { commandName: name, description: descStr },
            summary: `[Command Metadata & Guide for #${name}]\n- Name: #${name}\n- Aliases: ${aliases.map(a => '#' + a).join(', ') || 'None'}\n- Description: ${descStr}\n- Guide: ${config.guide || config.usage || 'Use #' + name}`
          };
        }
      });
    });

    return dynamicTools;
  }

  /**
   * Calculates confidence score (0.0 to 1.0) for a tool against user query
   */
  public calculateConfidence(query: string, tool: InternalTool): number {
    const q = query.toLowerCase().trim();
    if (!q) return 0;

    // Exact alias or name match
    if (tool.aliases.includes(q) || tool.name === q || q === `#${tool.name}` || q === `shipu ${tool.name}`) {
      return 0.98;
    }

    let score = 0;
    let matchCount = 0;

    for (const kw of tool.keywords) {
      const cleanKw = kw.toLowerCase();
      if (cleanKw.length < 2) continue;
      if (q.includes(cleanKw)) {
        score += 0.25;
        matchCount++;
      }
    }

    if (matchCount >= 2) score += 0.3;
    if (matchCount >= 3) score += 0.2;

    // Direct phrases checks
    if (tool.name === 'uptime_monitor' && (q.includes('active') || q.includes('কতক্ষণ') || q.includes('uptime') || q.includes('ram') || q.includes('health') || q.includes('অনলাইন'))) {
      score = Math.max(score, 0.88);
    }
    if (tool.name === 'user_balance' && (q.includes('balance') || q.includes('টাকা') || q.includes('কয়েন') || q.includes('coin') || q.includes('wallet'))) {
      score = Math.max(score, 0.90);
    }
    if (tool.name === 'user_level' && (q.includes('level') || q.includes('rank') || q.includes('exp') || q.includes('লেভেল'))) {
      score = Math.max(score, 0.90);
    }
    if (tool.name === 'command_analytics' && (q.includes('command') && (q.includes('use') || q.includes('কয়টা') || q.includes('কতবার')))) {
      score = Math.max(score, 0.88);
    }
    if (tool.name === 'economy_profile' && (q.includes('profile') || q.includes('প্রোফাইল'))) {
      score = Math.max(score, 0.88);
    }
    if (tool.name === 'thread_prefix_rules' && (q.includes('prefix') || q.includes('প্রিফিক্স') || q.includes('নিয়ম'))) {
      score = Math.max(score, 0.90);
    }
    if (tool.name === 'personal_memory' && (q.includes('girlfriend') || q.includes('gf') || q.includes('bf') || q.includes('স্মৃতি') || q.includes('মেমোরি') || q.includes('আমার নাম'))) {
      score = Math.max(score, 0.92);
    }
    if (tool.name === 'command_search' && (q.includes('কোন command') || q.includes('কোন কমান্ড') || q.includes('meme command'))) {
      score = Math.max(score, 0.88);
    }

    return Math.min(1.0, score);
  }

  /**
   * Intent Planner & Multi-Tool Execution Pipeline
   */
  public async planAndExecute(
    rawQuery: string,
    params: Omit<ToolExecutionParams, 'rawQuery'>
  ): Promise<IntentPlannerResult> {
    const allTools = [
      ...Array.from(this.builtinTools.values()),
      ...this.getDynamicCommandTools()
    ];

    const matchPlans: ToolMatchPlan[] = [];

    for (const tool of allTools) {
      const conf = this.calculateConfidence(rawQuery, tool);
      if (conf >= 0.55) {
        matchPlans.push({ tool, confidence: conf });
      }
    }

    // Sort matching plans descending by confidence
    matchPlans.sort((a, b) => b.confidence - a.confidence);

    // Filter top matching plans with confidence >= 0.65
    const topPlans = matchPlans.filter(p => p.confidence >= 0.65);

    // Deduplicate tools if same tool matched multiple times
    const uniquePlansMap = new Map<string, ToolMatchPlan>();
    for (const plan of topPlans) {
      if (!uniquePlansMap.has(plan.tool.name)) {
        uniquePlansMap.set(plan.tool.name, plan);
      }
    }
    const finalPlansToExecute = Array.from(uniquePlansMap.values());

    // Check for ambiguous low-confidence intent
    let needsClarification = false;
    let clarificationMessage: string | undefined;

    if (finalPlansToExecute.length === 0 && matchPlans.length > 0 && matchPlans[0].confidence >= 0.4) {
      // Possible tool match but confidence isn't high enough
      needsClarification = true;
      const candidateTool = matchPlans[0].tool;
      clarificationMessage = `আপনি কি **#${candidateTool.name}** সম্পর্কিত কোনো তথ্য জানতে চাচ্ছেন? অনুগ্রহ করে আপনার প্রশ্নটি আরও স্পষ্টভাবে বলবেন?`;
    }

    const toolParams: ToolExecutionParams = {
      ...params,
      rawQuery
    };

    // Execute relevant tools concurrently via Promise.all
    let executedResults: ToolExecutionResult[] = [];
    if (finalPlansToExecute.length > 0 && !needsClarification) {
      try {
        executedResults = await Promise.all(
          finalPlansToExecute.map(plan => plan.tool.handler(toolParams))
        );
      } catch (err: any) {
        console.error('[ToolDiscoveryEngine Execution Error]:', err.message);
      }
    }

    // Merge outputs into unified context summary
    let combinedContextSummary = '';
    if (executedResults.length > 0) {
      combinedContextSummary = `=== EXECUTED REAL-TIME TOOL DATA ===\n` +
        `The AI Tool Discovery Engine automatically executed ${executedResults.length} internal service(s) SILENTLY for this query:\n\n` +
        executedResults.map(r => r.summary).join('\n\n') +
        `\n\nCRITICAL DIRECTIVE: You MUST answer the user's question using the exact real-time data above. Do NOT guess or estimate numbers. Answer conversationally in the user's language.`;
    }

    const primaryCategory = finalPlansToExecute[0]?.tool.intentCategory || 'llm_general_chat';

    return {
      classifiedCategory: primaryCategory,
      matchedPlans: finalPlansToExecute,
      shouldExecuteTools: finalPlansToExecute.length > 0,
      needsClarification,
      clarificationMessage,
      executedResults,
      combinedContextSummary
    };
  }
}

export const toolDiscoveryEngine = ToolDiscoveryEngine.getInstance();
