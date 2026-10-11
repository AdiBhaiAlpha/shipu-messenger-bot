import { UserModel, EconomyTransactionModel, EconomyConfigModel } from '../db/firebaseDb';
import { usersData } from '../db/database';
import { botEngine } from '../core/botEngine';

export interface InventoryItem {
  itemID: string;
  name: string;
  quantity: number;
  value: number;
  category?: string;
  description?: string;
}

export interface LifetimeStats {
  dailyClaims: number;
  jobsDone: number;
  gamesPlayed: number;
  gamesWon: number;
  gamblingWins: number;
  gamblingLosses: number;
  aiPurchases: number;
}

export interface EconomyProfile {
  userID: string;
  name: string;
  money: number; // Wallet Balance
  bankMoney: number; // Bank Balance
  totalWealth: number; // Calculated (money + bankMoney)
  accountLevel: string; // 'Starter' | 'Bronze' | 'Silver' | 'Gold' | 'Diamond' | 'Master'
  accountStatus: 'Active' | 'Frozen' | 'Banned';
  createdAt: string;
  lastActive: string;
  totalEarned: number;
  totalSpent: number;
  totalDeposited: number;
  totalWithdrawn: number;
  totalTransactions: number;
  lastDailyClaim: string | null;
  lastWorkTime: string | null;
  interestEarned: number;
  netWorth: number; // money + bankMoney + total inventory value
  inventory: InventoryItem[];
  lifetimeStats: LifetimeStats;
}

export interface EconomyTransaction {
  txID: string;
  senderID: string;
  senderName: string;
  receiverID: string;
  receiverName: string;
  amount: number;
  currency: string;
  sourceCommand: string;
  type: 'EARN' | 'SPEND' | 'TRANSFER' | 'DEPOSIT' | 'WITHDRAW' | 'DAILY' | 'WORK' | 'REWARD' | 'ADMIN_ADJUST' | 'SYSTEM_DECREMENT';
  reason: string;
  timestamp: string;
  threadID: string;
  status: 'SUCCESS' | 'PENDING' | 'ROLLED_BACK' | 'FAILED';
  adminAction: boolean;
  rollbackInfo?: any;
}

export interface EconomyConfig {
  defaultWallet: number;
  defaultBank: number;
  dailyReward: number;
  workRewardMin: number;
  workRewardMax: number;
  interestRate: number; // percentage e.g. 2%
  bankLimit: number;
  transferTax: number; // percentage e.g. 1%
  shopMultiplier: number;
  gamblingMin: number;
  gamblingMax: number;
  currencySymbol: string;
  currencyName: string;
  dailyCooldownMs: number;
  workCooldownMs: number;
}

const DEFAULT_CONFIG: EconomyConfig = {
  defaultWallet: 500,
  defaultBank: 0,
  dailyReward: 200,
  workRewardMin: 50,
  workRewardMax: 150,
  interestRate: 1.5,
  bankLimit: 1000000,
  transferTax: 1,
  shopMultiplier: 1.0,
  gamblingMin: 10,
  gamblingMax: 10000,
  currencySymbol: '💰',
  currencyName: 'Coins',
  dailyCooldownMs: 86400000, // 24 hours
  workCooldownMs: 3600000    // 1 hour
};

class EconomyService {
  private config: EconomyConfig = { ...DEFAULT_CONFIG };
  private profilesCache: Map<string, EconomyProfile> = new Map();
  private pendingProfileCreations: Map<string, Promise<EconomyProfile>> = new Map();
  private transactionsCache: EconomyTransaction[] = [];
  private isInitialized = false;

  constructor() {
    this.init().catch(err => {
      console.error('[EconomyService] Initialization error:', err);
    });
  }

  public async init() {
    if (this.isInitialized) return;
    try {
      // 1. Load configuration from MongoDB or seed default
      const configDoc = await (EconomyConfigModel as any).findOne({ key: 'primary' }).lean();
      if (configDoc) {
        this.config = {
          defaultWallet: configDoc.defaultWallet ?? DEFAULT_CONFIG.defaultWallet,
          defaultBank: configDoc.defaultBank ?? DEFAULT_CONFIG.defaultBank,
          dailyReward: configDoc.dailyReward ?? DEFAULT_CONFIG.dailyReward,
          workRewardMin: configDoc.workRewardMin ?? DEFAULT_CONFIG.workRewardMin,
          workRewardMax: configDoc.workRewardMax ?? DEFAULT_CONFIG.workRewardMax,
          interestRate: configDoc.interestRate ?? DEFAULT_CONFIG.interestRate,
          bankLimit: configDoc.bankLimit ?? DEFAULT_CONFIG.bankLimit,
          transferTax: configDoc.transferTax ?? DEFAULT_CONFIG.transferTax,
          shopMultiplier: configDoc.shopMultiplier ?? DEFAULT_CONFIG.shopMultiplier,
          gamblingMin: configDoc.gamblingMin ?? DEFAULT_CONFIG.gamblingMin,
          gamblingMax: configDoc.gamblingMax ?? DEFAULT_CONFIG.gamblingMax,
          currencySymbol: configDoc.currencySymbol ?? DEFAULT_CONFIG.currencySymbol,
          currencyName: configDoc.currencyName ?? DEFAULT_CONFIG.currencyName,
          dailyCooldownMs: configDoc.dailyCooldownMs ?? DEFAULT_CONFIG.dailyCooldownMs,
          workCooldownMs: configDoc.workCooldownMs ?? DEFAULT_CONFIG.workCooldownMs,
        };
      } else {
        await (EconomyConfigModel as any).create({ key: 'primary', ...DEFAULT_CONFIG });
      }

      // 2. Load recent transactions cache
      const recentTxs = await (EconomyTransactionModel as any)
        .find({})
        .sort({ timestamp: -1 })
        .limit(200)
        .lean();
      if (Array.isArray(recentTxs)) {
        this.transactionsCache = recentTxs.map(t => this.formatTxDoc(t));
      }

      this.isInitialized = true;
      console.log('[EconomyService] Centralized economy engine initialized successfully');
    } catch (err: any) {
      console.warn('[EconomyService] Warning during DB init, running with in-memory defaults:', err.message);
      this.isInitialized = true;
    }
  }

  // --- CONFIG MANAGEMENT ---
  public getConfig(): EconomyConfig {
    return { ...this.config };
  }

  public async updateConfig(newConfig: Partial<EconomyConfig>): Promise<EconomyConfig> {
    this.config = { ...this.config, ...newConfig };
    try {
      await (EconomyConfigModel as any).updateOne(
        { key: 'primary' },
        { $set: { ...this.config, updatedAt: new Date().toISOString() } },
        { upsert: true }
      );
    } catch (err) {
      console.error('[EconomyService] Failed to save economy config to DB:', err);
    }
    return { ...this.config };
  }

  // --- ACCOUNT INITIALIZATION & FETCHING ---
  public async getAccount(userID: string, nameFallback?: string): Promise<EconomyProfile> {
    const cleanUid = String(userID || '').trim();
    if (!cleanUid) {
      return this.buildDefaultProfile('UNREGISTERED', nameFallback || 'Guest User');
    }

    // Fast path: Check in-memory profile cache
    const cachedFast = this.profilesCache.get(cleanUid);
    if (cachedFast) {
      if (nameFallback && cachedFast.name !== nameFallback && !cachedFast.name.includes('User_')) {
        cachedFast.name = nameFallback;
      }
      cachedFast.lastActive = new Date().toISOString();
      return cachedFast;
    }

    // Thread-safe lock: check if profile creation/fetching is already in progress for this cleanUid
    if (this.pendingProfileCreations.has(cleanUid)) {
      return await this.pendingProfileCreations.get(cleanUid)!;
    }

    // Execute lookup or atomic initialization
    const creationPromise = (async (): Promise<EconomyProfile> => {
      let cached: EconomyProfile | null = null;

      // Try DB if not cached
      try {
        const doc = await (UserModel as any).findOne({ userID: cleanUid }).lean();
        if (doc) {
          cached = this.formatUserDoc(doc);
          this.profilesCache.set(cleanUid, cached);
        }
      } catch (err) {
        console.warn(`[EconomyService] DB lookup failed for ${cleanUid}:`, err);
      }

      // Try botEngine if still not found
      if (!cached) {
        const engineUser = botEngine.getUsers().find(u => u.userID === cleanUid);
        if (engineUser) {
          cached = this.buildDefaultProfile(cleanUid, engineUser.name || nameFallback || `User_${cleanUid.slice(-4)}`);
          cached.money = engineUser.money ?? this.config.defaultWallet;
          cached.bankMoney = engineUser.bankMoney ?? this.config.defaultBank;
        }
      }

      // If account doesn't exist anywhere, AUTOMATICALLY REGISTER with 500 Coins default
      if (!cached) {
        cached = await this.createNewProfile(cleanUid, nameFallback || `User_${cleanUid.slice(-4)}`);
      } else {
        if (nameFallback && cached.name !== nameFallback && !cached.name.includes('User_')) {
          cached.name = nameFallback;
        }
        cached.lastActive = new Date().toISOString();
        cached.totalWealth = (cached.money ?? 0) + (cached.bankMoney ?? 0);
        cached.netWorth = cached.totalWealth + this.calculateInventoryValue(cached.inventory);
      }

      return cached;
    })();

    this.pendingProfileCreations.set(cleanUid, creationPromise);

    try {
      return await creationPromise;
    } finally {
      this.pendingProfileCreations.delete(cleanUid);
    }
  }

  public async createNewProfile(userID: string, name: string): Promise<EconomyProfile> {
    const nowISO = new Date().toISOString();
    const profile: EconomyProfile = {
      userID,
      name: name || `User_${userID.slice(-4)}`,
      money: this.config.defaultWallet,
      bankMoney: this.config.defaultBank,
      totalWealth: this.config.defaultWallet + this.config.defaultBank,
      accountLevel: 'Starter',
      accountStatus: 'Active',
      createdAt: nowISO,
      lastActive: nowISO,
      totalEarned: this.config.defaultWallet,
      totalSpent: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
      totalTransactions: 0,
      lastDailyClaim: null,
      lastWorkTime: null,
      interestEarned: 0,
      netWorth: this.config.defaultWallet + this.config.defaultBank,
      inventory: [],
      lifetimeStats: {
        dailyClaims: 0,
        jobsDone: 0,
        gamesPlayed: 0,
        gamesWon: 0,
        gamblingWins: 0,
        gamblingLosses: 0,
        aiPurchases: 0
      }
    };

    this.profilesCache.set(userID, profile);

    // Sync with botEngine
    botEngine.setUserData(userID, {
      name: profile.name,
      money: profile.money,
      bankMoney: profile.bankMoney,
      level: 1
    });

    // Save to MongoDB
    try {
      await (UserModel as any).updateOne(
        { userID },
        { $setOnInsert: { ...profile, level: 1 } },
        { upsert: true }
      );
      
      // Record Welcome Sign-Up Bonus Transaction
      await this.recordTransaction({
        senderID: 'SYSTEM',
        senderName: 'ShiPu Central Bank',
        receiverID: userID,
        receiverName: profile.name,
        amount: this.config.defaultWallet,
        currency: this.config.currencyName,
        sourceCommand: 'SYSTEM_REGISTRATION',
        type: 'REWARD',
        reason: 'Automatic Messenger Account Opening Bonus (500 Coins)',
        threadID: 'SYSTEM',
        status: 'SUCCESS',
        adminAction: false
      });
    } catch (err) {
      console.error('[EconomyService] Error saving new economy profile to DB:', err);
    }

    return profile;
  }

  public async updateAccount(userID: string, updates: Partial<EconomyProfile>): Promise<EconomyProfile> {
    const account = await this.getAccount(userID);
    const updated = { ...account, ...updates, lastActive: new Date().toISOString() };
    
    // Recalculate totals
    updated.totalWealth = (updated.money ?? 0) + (updated.bankMoney ?? 0);
    updated.netWorth = updated.totalWealth + this.calculateInventoryValue(updated.inventory);
    updated.accountLevel = this.calculateLevelName(updated.totalWealth);

    this.profilesCache.set(userID, updated);

    // Sync with botEngine
    botEngine.setUserData(userID, {
      name: updated.name,
      money: updated.money,
      bankMoney: updated.bankMoney
    });

    // Save to MongoDB
    try {
      await (UserModel as any).updateOne({ userID }, { $set: updated }, { upsert: true });
    } catch (err) {
      console.error('[EconomyService] DB update error for user:', userID, err);
    }

    return updated;
  }

  public async syncProfileToDb(userID: string, updates: Partial<EconomyProfile>): Promise<EconomyProfile> {
    return this.updateAccount(userID, updates);
  }

  // --- CORE BANKING OPERATIONS ---
  public async deposit(userID: string, amount: number | 'all', threadID: string = 'DIRECT'): Promise<{ success: boolean; deposited: number; message: string; account: EconomyProfile }> {
    const acc = await this.getAccount(userID);

    if (acc.accountStatus === 'Frozen' || acc.accountStatus === 'Banned') {
      return { success: false, deposited: 0, message: `❌ Your economy account is currently ${acc.accountStatus.toUpperCase()}.`, account: acc };
    }

    let depositAmt = typeof amount === 'number' ? Math.floor(amount) : acc.money;
    if (depositAmt <= 0) {
      return { success: false, deposited: 0, message: '❌ Invalid deposit amount.', account: acc };
    }

    if (acc.money < depositAmt) {
      depositAmt = acc.money;
    }

    if (depositAmt <= 0) {
      return { success: false, deposited: 0, message: '❌ You do not have enough wallet coins to deposit.', account: acc };
    }

    // Check bank limit
    if (acc.bankMoney + depositAmt > this.config.bankLimit) {
      const allowed = this.config.bankLimit - acc.bankMoney;
      if (allowed <= 0) {
        return { success: false, deposited: 0, message: `🏛️ Bank limit reached (${this.config.bankLimit.toLocaleString()} ${this.config.currencyName}).`, account: acc };
      }
      depositAmt = allowed;
    }

    acc.money -= depositAmt;
    acc.bankMoney += depositAmt;
    acc.totalDeposited += depositAmt;
    acc.totalTransactions += 1;

    const updated = await this.updateAccount(userID, acc);

    await this.recordTransaction({
      senderID: userID,
      senderName: acc.name,
      receiverID: 'BANK_ACCOUNT',
      receiverName: 'Vault Storage',
      amount: depositAmt,
      currency: this.config.currencyName,
      sourceCommand: 'DEPOSIT',
      type: 'DEPOSIT',
      reason: `Deposited ${depositAmt.toLocaleString()} coins into bank`,
      threadID,
      status: 'SUCCESS',
      adminAction: false
    });

    return {
      success: true,
      deposited: depositAmt,
      message: `🏛️ Successfully deposited **${depositAmt.toLocaleString()} ${this.config.currencyName}** into your secure bank vault.\n💰 Wallet: **$${updated.money.toLocaleString()}** | Bank: **$${updated.bankMoney.toLocaleString()}**`,
      account: updated
    };
  }

  public async withdraw(userID: string, amount: number | 'all', threadID: string = 'DIRECT'): Promise<{ success: boolean; withdrawn: number; message: string; account: EconomyProfile }> {
    const acc = await this.getAccount(userID);

    if (acc.accountStatus === 'Frozen' || acc.accountStatus === 'Banned') {
      return { success: false, withdrawn: 0, message: `❌ Your economy account is currently ${acc.accountStatus.toUpperCase()}.`, account: acc };
    }

    let withdrawAmt = typeof amount === 'number' ? Math.floor(amount) : acc.bankMoney;
    if (withdrawAmt <= 0) {
      return { success: false, withdrawn: 0, message: '❌ Invalid withdrawal amount.', account: acc };
    }

    if (acc.bankMoney < withdrawAmt) {
      withdrawAmt = acc.bankMoney;
    }

    if (withdrawAmt <= 0) {
      return { success: false, withdrawn: 0, message: '❌ You have no bank funds available to withdraw.', account: acc };
    }

    acc.bankMoney -= withdrawAmt;
    acc.money += withdrawAmt;
    acc.totalWithdrawn += withdrawAmt;
    acc.totalTransactions += 1;

    const updated = await this.updateAccount(userID, acc);

    await this.recordTransaction({
      senderID: 'BANK_ACCOUNT',
      senderName: 'Vault Storage',
      receiverID: userID,
      receiverName: acc.name,
      amount: withdrawAmt,
      currency: this.config.currencyName,
      sourceCommand: 'WITHDRAW',
      type: 'WITHDRAW',
      reason: `Withdrew ${withdrawAmt.toLocaleString()} coins from bank`,
      threadID,
      status: 'SUCCESS',
      adminAction: false
    });

    return {
      success: true,
      withdrawn: withdrawAmt,
      message: `🏧 Successfully withdrew **${withdrawAmt.toLocaleString()} ${this.config.currencyName}** from your bank vault.\n💰 Wallet: **$${updated.money.toLocaleString()}** | Bank: **$${updated.bankMoney.toLocaleString()}**`,
      account: updated
    };
  }

  public async transfer(senderID: string, receiverID: string, amount: number, threadID: string = 'DIRECT', reason: string = 'Peer Transfer'): Promise<{ success: boolean; message: string; netSent?: number; taxPaid?: number }> {
    if (senderID === receiverID) {
      return { success: false, message: '❌ You cannot transfer money to yourself.' };
    }

    const sender = await this.getAccount(senderID);
    const receiver = await this.getAccount(receiverID);

    if (sender.accountStatus !== 'Active') {
      return { success: false, message: `❌ Sender account is ${sender.accountStatus.toUpperCase()}.` };
    }

    const transferAmt = Math.floor(amount);
    if (transferAmt <= 0) {
      return { success: false, message: '❌ Transfer amount must be greater than 0.' };
    }

    if (sender.money < transferAmt) {
      return { success: false, message: `❌ Insufficient wallet balance. You need $${transferAmt.toLocaleString()} but only have $${sender.money.toLocaleString()}.` };
    }

    // Calculate tax
    const taxPercent = this.config.transferTax || 0;
    const taxPaid = Math.floor((transferAmt * taxPercent) / 100);
    const netReceived = transferAmt - taxPaid;

    sender.money -= transferAmt;
    sender.totalSpent += transferAmt;
    sender.totalTransactions += 1;

    receiver.money += netReceived;
    receiver.totalEarned += netReceived;
    receiver.totalTransactions += 1;

    await this.updateAccount(senderID, sender);
    await this.updateAccount(receiverID, receiver);

    await this.recordTransaction({
      senderID,
      senderName: sender.name,
      receiverID,
      receiverName: receiver.name,
      amount: transferAmt,
      currency: this.config.currencyName,
      sourceCommand: 'TRANSFER',
      type: 'TRANSFER',
      reason: `${reason} (Tax ${taxPercent}%: -$${taxPaid})`,
      threadID,
      status: 'SUCCESS',
      adminAction: false
    });

    return {
      success: true,
      netSent: netReceived,
      taxPaid,
      message: `💸 **Transfer Successful**!\n👤 Sent to: **${receiver.name}**\n💵 Amount: **$${transferAmt.toLocaleString()} ${this.config.currencyName}**\n🏛️ Tax (${taxPercent}%): **$${taxPaid}**\n📥 Received: **$${netReceived.toLocaleString()}**\n💳 Wallet Balance: **$${sender.money.toLocaleString()}**`
    };
  }

  // --- REWARDS & DAILY / WORK ---
  public async claimDaily(userID: string, threadID: string = 'DIRECT'): Promise<{ success: boolean; reward: number; message: string; nextAvailableTime?: string }> {
    const acc = await this.getAccount(userID);
    const now = Date.now();
    const lastClaim = acc.lastDailyClaim ? new Date(acc.lastDailyClaim).getTime() : 0;
    const cooldown = this.config.dailyCooldownMs || 86400000;

    if (now - lastClaim < cooldown) {
      const remainingMs = cooldown - (now - lastClaim);
      const hours = Math.floor(remainingMs / (1000 * 60 * 60));
      const mins = Math.floor((remainingMs % (1000 * 60 * 60)) / (1000 * 60));
      return {
        success: false,
        reward: 0,
        message: `⏳ You have already claimed your daily reward today!\n⏰ Please wait **${hours}h ${mins}m** to claim again.`,
        nextAvailableTime: new Date(now + remainingMs).toISOString()
      };
    }

    const reward = this.config.dailyReward || 200;
    acc.money += reward;
    acc.totalEarned += reward;
    acc.lastDailyClaim = new Date().toISOString();
    acc.totalTransactions += 1;
    acc.lifetimeStats.dailyClaims += 1;

    const updated = await this.updateAccount(userID, acc);

    await this.recordTransaction({
      senderID: 'SYSTEM',
      senderName: 'Daily Claim Vault',
      receiverID: userID,
      receiverName: acc.name,
      amount: reward,
      currency: this.config.currencyName,
      sourceCommand: 'DAILY',
      type: 'DAILY',
      reason: 'Daily Reward Claim',
      threadID,
      status: 'SUCCESS',
      adminAction: false
    });

    return {
      success: true,
      reward,
      message: `🎁 **Daily Reward Claimed**!\n💰 Received: **+${reward.toLocaleString()} ${this.config.currencyName}**\n💵 Wallet Balance: **$${updated.money.toLocaleString()}**`
    };
  }

  public async doWork(userID: string, threadID: string = 'DIRECT'): Promise<{ success: boolean; reward: number; message: string; jobTitle: string }> {
    const acc = await this.getAccount(userID);
    const now = Date.now();
    const lastWork = acc.lastWorkTime ? new Date(acc.lastWorkTime).getTime() : 0;
    const cooldown = this.config.workCooldownMs || 3600000;

    if (now - lastWork < cooldown) {
      const remainingMs = cooldown - (now - lastWork);
      const mins = Math.ceil(remainingMs / (1000 * 60));
      return {
        success: false,
        reward: 0,
        jobTitle: 'None',
        message: `☕ You are tired from your previous shift!\n⏰ Take a rest for **${mins} minutes** before working again.`
      };
    }

    const minWork = this.config.workRewardMin || 10;
    const maxWork = this.config.workRewardMax || 30;

    const jobs = [
      { title: 'Software Code Auditor' },
      { title: 'AI Assistant Trainer' },
      { title: 'Community Moderator' },
      { title: 'Graphic Designer' },
      { title: 'Database Architect' }
    ];

    const job = jobs[Math.floor(Math.random() * jobs.length)];
    const reward = Math.floor(Math.random() * (maxWork - minWork + 1)) + minWork;

    acc.money += reward;
    acc.totalEarned += reward;
    acc.lastWorkTime = new Date().toISOString();
    acc.totalTransactions += 1;
    acc.lifetimeStats.jobsDone += 1;

    const updated = await this.updateAccount(userID, acc);

    await this.recordTransaction({
      senderID: 'EMPLOYER_SYSTEM',
      senderName: job.title,
      receiverID: userID,
      receiverName: acc.name,
      amount: reward,
      currency: this.config.currencyName,
      sourceCommand: 'WORK',
      type: 'WORK',
      reason: `Salary payout for job: ${job.title}`,
      threadID,
      status: 'SUCCESS',
      adminAction: false
    });

    return {
      success: true,
      reward,
      jobTitle: job.title,
      message: `🛠️ **Shift Completed**: ${job.title}\n💵 Salary Earned: **+$${reward.toLocaleString()} ${this.config.currencyName}**\n💰 Wallet Balance: **$${updated.money.toLocaleString()}**`
    };
  }

  // --- COIN MODIFICATION & ADMIN ADJUSTMENTS ---
  public async addCoins(userID: string, amount: number, source: string = 'ADMIN', reason: string = 'Manual Adjustment', threadID: string = 'ADMIN'): Promise<EconomyProfile> {
    const acc = await this.getAccount(userID);
    const amt = Math.floor(amount);
    acc.money += amt;
    acc.totalEarned += amt;
    acc.totalTransactions += 1;
    const updated = await this.updateAccount(userID, acc);

    await this.recordTransaction({
      senderID: 'ADMIN_SYSTEM',
      senderName: source,
      receiverID: userID,
      receiverName: acc.name,
      amount: amt,
      currency: this.config.currencyName,
      sourceCommand: source,
      type: 'ADMIN_ADJUST',
      reason,
      threadID,
      status: 'SUCCESS',
      adminAction: true
    });

    return updated;
  }

  public async removeCoins(userID: string, amount: number, source: string = 'ADMIN', reason: string = 'Manual Adjustment', threadID: string = 'ADMIN'): Promise<EconomyProfile> {
    const acc = await this.getAccount(userID);
    const amt = Math.floor(amount);
    acc.money = Math.max(0, acc.money - amt);
    acc.totalSpent += amt;
    acc.totalTransactions += 1;
    const updated = await this.updateAccount(userID, acc);

    await this.recordTransaction({
      senderID: userID,
      senderName: acc.name,
      receiverID: 'ADMIN_SYSTEM',
      receiverName: source,
      amount: amt,
      currency: this.config.currencyName,
      sourceCommand: source,
      type: 'SYSTEM_DECREMENT',
      reason,
      threadID,
      status: 'SUCCESS',
      adminAction: true
    });

    return updated;
  }

  // --- TRANSACTION LEDGER & ROLLBACK ---
  public async recordTransaction(txData: Omit<EconomyTransaction, 'txID' | 'timestamp'>): Promise<EconomyTransaction> {
    const txID = `TX_${Date.now()}_${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
    const tx: EconomyTransaction = {
      ...txData,
      txID,
      timestamp: new Date().toISOString()
    };

    this.transactionsCache.unshift(tx);
    if (this.transactionsCache.length > 500) {
      this.transactionsCache.pop();
    }

    try {
      await (EconomyTransactionModel as any).create(tx);
    } catch (err) {
      console.error('[EconomyService] Error saving transaction to DB:', err);
    }

    return tx;
  }

  public async getTransactions(filter?: { userID?: string; command?: string; type?: string; status?: string; search?: string; limit?: number }): Promise<EconomyTransaction[]> {
    const limit = filter?.limit || 100;
    try {
      const query: any = {};
      if (filter?.userID) {
        query.$or = [{ senderID: filter.userID }, { receiverID: filter.userID }];
      }
      if (filter?.command) {
        query.sourceCommand = new RegExp(filter.command, 'i');
      }
      if (filter?.type) {
        query.type = filter.type;
      }
      if (filter?.status) {
        query.status = filter.status;
      }
      if (filter?.search) {
        const reg = new RegExp(filter.search, 'i');
        query.$or = [
          { txID: reg },
          { senderID: reg },
          { senderName: reg },
          { receiverID: reg },
          { receiverName: reg },
          { reason: reg },
          { sourceCommand: reg }
        ];
      }

      const docs = await (EconomyTransactionModel as any)
        .find(query)
        .sort({ timestamp: -1 })
        .limit(limit)
        .lean();

      if (Array.isArray(docs) && docs.length > 0) {
        return docs.map(d => this.formatTxDoc(d));
      }
    } catch (err) {
      console.warn('[EconomyService] DB transaction query error, falling back to memory cache:', err);
    }

    // Memory filter fallback
    let list = [...this.transactionsCache];
    if (filter?.userID) {
      list = list.filter(t => t.senderID === filter.userID || t.receiverID === filter.userID);
    }
    if (filter?.command) {
      list = list.filter(t => t.sourceCommand.toLowerCase().includes(filter.command!.toLowerCase()));
    }
    if (filter?.search) {
      const q = filter.search.toLowerCase();
      list = list.filter(t =>
        t.txID.toLowerCase().includes(q) ||
        t.senderName.toLowerCase().includes(q) ||
        t.receiverName.toLowerCase().includes(q) ||
        t.reason.toLowerCase().includes(q)
      );
    }
    return list.slice(0, limit);
  }

  public async rollbackTransaction(txID: string, adminID: string = 'ADMIN'): Promise<{ success: boolean; message: string }> {
    try {
      const txDoc = await (EconomyTransactionModel as any).findOne({ txID }).lean();
      if (!txDoc) {
        return { success: false, message: '❌ Transaction not found.' };
      }

      if (txDoc.status === 'ROLLED_BACK') {
        return { success: false, message: '⚠️ Transaction has already been rolled back.' };
      }

      const tx = this.formatTxDoc(txDoc);

      // Perform reverse adjustment
      if (tx.type === 'TRANSFER' || tx.type === 'SPEND' || tx.type === 'ADMIN_ADJUST') {
        // Return money to sender
        if (tx.senderID && tx.senderID !== 'SYSTEM' && tx.senderID !== 'ADMIN_SYSTEM') {
          const sender = await this.getAccount(tx.senderID);
          sender.money += tx.amount;
          await this.updateAccount(tx.senderID, sender);
        }
        // Deduct money from receiver
        if (tx.receiverID && tx.receiverID !== 'SYSTEM' && tx.receiverID !== 'ADMIN_SYSTEM') {
          const receiver = await this.getAccount(tx.receiverID);
          receiver.money = Math.max(0, receiver.money - tx.amount);
          await this.updateAccount(tx.receiverID, receiver);
        }
      }

      // Mark transaction status
      await (EconomyTransactionModel as any).updateOne(
        { txID },
        {
          $set: {
            status: 'ROLLED_BACK',
            rollbackInfo: {
              rolledBackBy: adminID,
              rolledBackAt: new Date().toISOString()
            }
          }
        }
      );

      // Update cache
      const cachedIdx = this.transactionsCache.findIndex(t => t.txID === txID);
      if (cachedIdx !== -1) {
        this.transactionsCache[cachedIdx].status = 'ROLLED_BACK';
      }

      return { success: true, message: `✅ Transaction #${txID} successfully rolled back.` };
    } catch (err: any) {
      return { success: false, message: `❌ Rollback failed: ${err.message}` };
    }
  }

  // --- ANALYTICS & CRYPTO DASHBOARD DATA ---
  public async getOverviewStats(): Promise<{
    totalUsers: number;
    activeUsersToday: number;
    walletCirculation: number;
    bankCirculation: number;
    totalEcosystemCoins: number;
    coinsCreatedToday: number;
    coinsDestroyedToday: number;
    serverEconomyHealth: string;
    inflationRate: number;
    richestUsers: EconomyProfile[];
    topBankHolders: EconomyProfile[];
    topSpenders: EconomyProfile[];
    topEarners: EconomyProfile[];
    recentTransactions: EconomyTransaction[];
    config: EconomyConfig;
  }> {
    const usersList = await this.getAccounts(undefined, 1000);

    const totalUsers = usersList.length;
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const activeUsersToday = usersList.filter(u => now - new Date(u.lastActive).getTime() < oneDayMs).length;

    let walletCirculation = 0;
    let bankCirculation = 0;

    usersList.forEach(u => {
      walletCirculation += u.money || 0;
      bankCirculation += u.bankMoney || 0;
    });

    const totalEcosystemCoins = walletCirculation + bankCirculation;

    // Daily created / destroyed from transactions
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    let coinsCreatedToday = 0;
    let coinsDestroyedToday = 0;

    try {
      const todayTxs = await (EconomyTransactionModel as any).find({
        timestamp: { $gte: startOfDay }
      }).lean();

      if (Array.isArray(todayTxs)) {
        todayTxs.forEach((t: any) => {
          if (['DAILY', 'WORK', 'REWARD', 'ADMIN_ADJUST'].includes(t.type)) {
            coinsCreatedToday += t.amount || 0;
          } else if (['SYSTEM_DECREMENT', 'SPEND'].includes(t.type)) {
            coinsDestroyedToday += t.amount || 0;
          }
        });
      }
    } catch (e) {}

    const netCreation = coinsCreatedToday - coinsDestroyedToday;
    const inflationRate = totalEcosystemCoins > 0 ? Number(((netCreation / totalEcosystemCoins) * 100).toFixed(2)) : 0;
    const serverEconomyHealth = inflationRate > 10 ? 'Inflation Warning' : inflationRate < -5 ? 'Deflationary' : 'Healthy & Stable';

    const richestUsers = [...usersList].sort((a, b) => b.totalWealth - a.totalWealth).slice(0, 10);
    const topBankHolders = [...usersList].sort((a, b) => b.bankMoney - a.bankMoney).slice(0, 10);
    const topSpenders = [...usersList].sort((a, b) => b.totalSpent - a.totalSpent).slice(0, 10);
    const topEarners = [...usersList].sort((a, b) => b.totalEarned - a.totalEarned).slice(0, 10);

    const recentTransactions = await this.getTransactions({ limit: 20 });

    return {
      totalUsers,
      activeUsersToday,
      walletCirculation,
      bankCirculation,
      totalEcosystemCoins,
      coinsCreatedToday,
      coinsDestroyedToday,
      serverEconomyHealth,
      inflationRate,
      richestUsers,
      topBankHolders,
      topSpenders,
      topEarners,
      recentTransactions,
      config: this.getConfig()
    };
  }

  public async getAccounts(search?: string, limit: number = 100): Promise<EconomyProfile[]> {
    const userMap = new Map<string, EconomyProfile>();

    // 1. Load from UserModel DB
    try {
      const docs = await (UserModel as any).find({}).lean();
      if (Array.isArray(docs)) {
        docs.forEach((d: any) => {
          const profile = this.formatUserDoc(d);
          userMap.set(profile.userID, profile);
        });
      }
    } catch (err) {}

    // 2. Load from usersData.getAll()
    try {
      const allDbUsers = await usersData.getAll();
      if (Array.isArray(allDbUsers)) {
        allDbUsers.forEach(u => {
          if (!userMap.has(u.userID)) {
            const profile = this.buildDefaultProfile(u.userID, u.name);
            profile.money = u.money || 0;
            profile.bankMoney = u.bankMoney || 0;
            profile.totalWealth = profile.money + profile.bankMoney;
            profile.netWorth = profile.totalWealth + this.calculateInventoryValue(profile.inventory);
            userMap.set(u.userID, profile);
          } else {
            const existing = userMap.get(u.userID)!;
            if ((u.money || 0) > existing.money) {
              existing.money = u.money || 0;
              existing.totalWealth = existing.money + existing.bankMoney;
              existing.netWorth = existing.totalWealth + this.calculateInventoryValue(existing.inventory);
            }
            if ((u.bankMoney || 0) > existing.bankMoney) {
              existing.bankMoney = u.bankMoney || 0;
              existing.totalWealth = existing.money + existing.bankMoney;
              existing.netWorth = existing.totalWealth + this.calculateInventoryValue(existing.inventory);
            }
          }
        });
      }
    } catch (err) {}

    // 3. Load from profilesCache
    for (const [uid, profile] of this.profilesCache.entries()) {
      if (!userMap.has(uid)) {
        userMap.set(uid, profile);
      } else {
        // Merge latest balances if cached profile is newer/higher
        const existing = userMap.get(uid)!;
        if ((profile.money + profile.bankMoney) > (existing.money + existing.bankMoney)) {
          userMap.set(uid, profile);
        }
      }
    }

    // 4. Merge botEngine users
    for (const u of botEngine.getUsers()) {
      if (!userMap.has(u.userID)) {
        userMap.set(u.userID, this.buildDefaultProfile(u.userID, u.name));
      } else {
        const existing = userMap.get(u.userID)!;
        if (u.money !== undefined && u.money > existing.money) {
          existing.money = u.money;
          existing.totalWealth = existing.money + existing.bankMoney;
        }
        if (u.bankMoney !== undefined && u.bankMoney > existing.bankMoney) {
          existing.bankMoney = u.bankMoney;
          existing.totalWealth = existing.money + existing.bankMoney;
        }
      }
    }

    let usersList = Array.from(userMap.values());

    // Filter by search if provided
    if (search && search.trim() !== '' && search !== 'undefined' && search !== 'null') {
      const q = search.trim().toLowerCase();
      usersList = usersList.filter(u => 
        (u.userID && u.userID.toLowerCase().includes(q)) || 
        (u.name && u.name.toLowerCase().includes(q))
      );
    }

    // Sort by totalWealth descending (richest users first)
    usersList.sort((a, b) => b.totalWealth - a.totalWealth);

    return usersList.slice(0, limit);
  }

  public async setBalance(userID: string, money: number, bankMoney: number, note: string = 'Admin Set Balance'): Promise<EconomyProfile> {
    const acc = await this.getAccount(userID);
    const newWallet = Math.max(0, money);
    const newBank = Math.max(0, bankMoney);

    const oldTotal = acc.money + acc.bankMoney;
    const newTotal = newWallet + newBank;
    const diff = newTotal - oldTotal;

    acc.money = newWallet;
    acc.bankMoney = newBank;
    acc.totalWealth = newWallet + newBank;
    acc.netWorth = acc.totalWealth + this.calculateInventoryValue(acc.inventory);

    await this.updateAccount(userID, {
      money: newWallet,
      bankMoney: newBank
    });

    await this.recordTransaction({
      senderID: 'ADMIN_OVERRIDE',
      senderName: 'Admin Dashboard',
      receiverID: userID,
      receiverName: acc.name,
      amount: Math.abs(diff),
      currency: 'Coins',
      sourceCommand: 'ADMIN_SET_BALANCE',
      type: diff >= 0 ? 'ADMIN_ADJUST' : 'SYSTEM_DECREMENT',
      reason: `${note} | New Wallet: $${newWallet}, Bank: $${newBank}`,
      threadID: 'ADMIN',
      status: 'SUCCESS',
      adminAction: true
    });

    botEngine.setUserData(userID, { money: newWallet, bankMoney: newBank });
    await usersData.update(userID, { money: newWallet, bankMoney: newBank });

    return acc;
  }

  // --- PRIVATE UTILS ---
  private calculateLevelName(totalWealth: number): string {
    if (totalWealth >= 1000000) return 'Master 👑';
    if (totalWealth >= 250000) return 'Diamond 💎';
    if (totalWealth >= 50000) return 'Gold 🥇';
    if (totalWealth >= 10000) return 'Silver 🥈';
    if (totalWealth >= 2500) return 'Bronze 🥉';
    return 'Starter 🔰';
  }

  private calculateInventoryValue(inv: InventoryItem[] = []): number {
    if (!Array.isArray(inv)) return 0;
    return inv.reduce((sum, item) => sum + ((item.value || 0) * (item.quantity || 1)), 0);
  }

  private buildDefaultProfile(userID: string, name: string): EconomyProfile {
    const now = new Date().toISOString();
    return {
      userID,
      name: name || `User_${userID.slice(-4)}`,
      money: this.config.defaultWallet,
      bankMoney: this.config.defaultBank,
      totalWealth: this.config.defaultWallet + this.config.defaultBank,
      accountLevel: 'Starter',
      accountStatus: 'Active',
      createdAt: now,
      lastActive: now,
      totalEarned: this.config.defaultWallet,
      totalSpent: 0,
      totalDeposited: 0,
      totalWithdrawn: 0,
      totalTransactions: 0,
      lastDailyClaim: null,
      lastWorkTime: null,
      interestEarned: 0,
      netWorth: this.config.defaultWallet + this.config.defaultBank,
      inventory: [],
      lifetimeStats: {
        dailyClaims: 0,
        jobsDone: 0,
        gamesPlayed: 0,
        gamesWon: 0,
        gamblingWins: 0,
        gamblingLosses: 0,
        aiPurchases: 0
      }
    };
  }

  private formatUserDoc(doc: any): EconomyProfile {
    const money = doc.money ?? this.config.defaultWallet;
    const bankMoney = doc.bankMoney ?? this.config.defaultBank;
    const totalWealth = money + bankMoney;
    const inv = Array.isArray(doc.inventory) ? doc.inventory : [];
    const netWorth = totalWealth + this.calculateInventoryValue(inv);

    return {
      userID: doc.userID,
      name: doc.name || `User_${doc.userID.slice(-4)}`,
      money,
      bankMoney,
      totalWealth,
      accountLevel: doc.accountLevel || this.calculateLevelName(totalWealth),
      accountStatus: doc.accountStatus || (doc.isBanned ? 'Banned' : 'Active'),
      createdAt: doc.createdAt ? new Date(doc.createdAt).toISOString() : new Date().toISOString(),
      lastActive: doc.lastActive ? new Date(doc.lastActive).toISOString() : new Date().toISOString(),
      totalEarned: doc.totalEarned ?? money,
      totalSpent: doc.totalSpent ?? 0,
      totalDeposited: doc.totalDeposited ?? 0,
      totalWithdrawn: doc.totalWithdrawn ?? 0,
      totalTransactions: doc.totalTransactions ?? 0,
      lastDailyClaim: doc.lastDailyClaim ? new Date(doc.lastDailyClaim).toISOString() : null,
      lastWorkTime: doc.lastWorkTime ? new Date(doc.lastWorkTime).toISOString() : null,
      interestEarned: doc.interestEarned ?? 0,
      netWorth,
      inventory: inv,
      lifetimeStats: {
        dailyClaims: doc.lifetimeStats?.dailyClaims ?? 0,
        jobsDone: doc.lifetimeStats?.jobsDone ?? 0,
        gamesPlayed: doc.lifetimeStats?.gamesPlayed ?? 0,
        gamesWon: doc.lifetimeStats?.gamesWon ?? 0,
        gamblingWins: doc.lifetimeStats?.gamblingWins ?? 0,
        gamblingLosses: doc.lifetimeStats?.gamblingLosses ?? 0,
        aiPurchases: doc.lifetimeStats?.aiPurchases ?? 0
      }
    };
  }

  private formatTxDoc(doc: any): EconomyTransaction {
    return {
      txID: doc.txID,
      senderID: doc.senderID,
      senderName: doc.senderName || 'User',
      receiverID: doc.receiverID,
      receiverName: doc.receiverName || 'System',
      amount: doc.amount ?? 0,
      currency: doc.currency || this.config.currencyName,
      sourceCommand: doc.sourceCommand || 'SYSTEM',
      type: doc.type || 'TRANSFER',
      reason: doc.reason || '',
      timestamp: doc.timestamp ? new Date(doc.timestamp).toISOString() : new Date().toISOString(),
      threadID: doc.threadID || 'DIRECT',
      status: doc.status || 'SUCCESS',
      adminAction: Boolean(doc.adminAction),
      rollbackInfo: doc.rollbackInfo || null
    };
  }

  public async resetAllUsersBalance(): Promise<void> {
    this.profilesCache.clear();
    try {
      await (UserModel as any).updateMany({}, {
        $set: {
          money: 0,
          bankMoney: 0,
          totalWealth: 0,
          netWorth: 0,
          totalEarned: 0,
          totalSpent: 0,
          totalDeposited: 0,
          totalWithdrawn: 0
        }
      });
    } catch (err) {
      console.error('[EconomyService] Failed to reset all user balances in DB:', err);
    }

    for (const u of botEngine.getUsers()) {
      u.money = 0;
      u.bankMoney = 0;
      botEngine.setUserData(u.userID, { money: 0, bankMoney: 0 });
    }
  }
}

export const economyService = new EconomyService();
