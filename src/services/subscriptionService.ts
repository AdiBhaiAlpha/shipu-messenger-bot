import { SubscriptionModel, SubscriptionPaymentModel } from '../db/firebaseDb';
import { economyService } from './economyService';
import { messengerLogger } from '../adapters/messenger/MessengerLogger';

export type SubscriptionStatus = 'TRIAL' | 'ACTIVE' | 'GRACE_PERIOD' | 'LIMITED' | 'SUSPENDED';

export interface SubscriptionProfile {
  userID: string;
  name: string;
  status: SubscriptionStatus;
  registrationDate: Date;
  expiryDate: Date;
  autoRenew: boolean;
  weeklyRentAmount: number;
  totalWeeksPurchased: number;
  totalCoinsPaid: number;
  lastPaymentDate: Date | null;
  lastNotificationStage: string;
  gracePeriodEndDate: Date | null;
}

export interface SubscriptionPaymentRecord {
  txID: string;
  userID: string;
  name: string;
  amount: number;
  weeks: number;
  paymentSource: string;
  previousExpiry: Date;
  newExpiry: Date;
  timestamp: Date;
  adminAction: boolean;
  adminUid: string;
  isRefunded: boolean;
  note: string;
}

export interface SubscriptionCheckResult {
  userID: string;
  name: string;
  status: SubscriptionStatus;
  registrationDate: Date;
  expiryDate: Date;
  daysLeft: number;
  hoursLeft: number;
  minutesLeft: number;
  autoRenew: boolean;
  weeklyRentAmount: number;
  totalPrepaidWeeks: number;
  totalCoinsPaid: number;
  walletBalance: number;
  bankBalance: number;
  canExecuteCommands: boolean;
  gracePeriodEndDate: Date | null;
  notificationTrigger?: string;
  notificationMessage?: string;
}

export class SubscriptionService {
  private inMemoryProfiles: Map<string, SubscriptionProfile> = new Map();
  private inMemoryPayments: SubscriptionPaymentRecord[] = [];
  private WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  private GRACE_MS = 3 * 24 * 60 * 60 * 1000;
  private DEFAULT_RENT = 1000;

  constructor() {
    this.initTimer();
  }

  private initTimer() {
    // Periodically run auto-renew and grace period updates every 10 minutes
    if (typeof setInterval !== 'undefined') {
      setInterval(() => {
        this.runAutoRenew().catch(err => {
          messengerLogger.warn('SUBSCRIPTION', `[AutoRenew] Background check error: ${err?.message}`);
        });
      }, 10 * 60 * 1000);
    }
  }

  /**
   * Registers a new user with a 7-day free trial starting from exact timestamp.
   */
  public async registerUser(userID: string, name: string = ''): Promise<SubscriptionProfile> {
    if (!userID) throw new Error('User ID is required');

    // 1. Check in-memory first
    if (this.inMemoryProfiles.has(userID)) {
      const existing = this.inMemoryProfiles.get(userID)!;
      if (name && !existing.name) existing.name = name;
      return existing;
    }

    // 2. Check MongoDB
    try {
      const dbDoc = await (SubscriptionModel as any).findOne({ userID });
      if (dbDoc) {
        const profile: SubscriptionProfile = {
          userID: dbDoc.userID,
          name: dbDoc.name || name,
          status: dbDoc.status as SubscriptionStatus,
          registrationDate: new Date(dbDoc.registrationDate),
          expiryDate: new Date(dbDoc.expiryDate),
          autoRenew: dbDoc.autoRenew ?? false,
          weeklyRentAmount: dbDoc.weeklyRentAmount ?? this.DEFAULT_RENT,
          totalWeeksPurchased: dbDoc.totalWeeksPurchased ?? 0,
          totalCoinsPaid: dbDoc.totalCoinsPaid ?? 0,
          lastPaymentDate: dbDoc.lastPaymentDate ? new Date(dbDoc.lastPaymentDate) : null,
          lastNotificationStage: dbDoc.lastNotificationStage || '',
          gracePeriodEndDate: dbDoc.gracePeriodEndDate ? new Date(dbDoc.gracePeriodEndDate) : null
        };
        this.inMemoryProfiles.set(userID, profile);
        return profile;
      }
    } catch (e) {
      // MongoDB unreachable or disabled
    }

    // 3. Create fresh profile
    const now = new Date();
    const expiryDate = new Date(now.getTime() + this.WEEK_MS);

    const freshProfile: SubscriptionProfile = {
      userID,
      name,
      status: 'TRIAL',
      registrationDate: now,
      expiryDate,
      autoRenew: false,
      weeklyRentAmount: this.DEFAULT_RENT,
      totalWeeksPurchased: 0,
      totalCoinsPaid: 0,
      lastPaymentDate: null,
      lastNotificationStage: '',
      gracePeriodEndDate: null
    };

    this.inMemoryProfiles.set(userID, freshProfile);

    // Persist async
    this.saveProfileToDb(freshProfile).catch(() => {});

    messengerLogger.info('SUBSCRIPTION', `New user registered: ${userID} (${name}). Granted 7-day Free Trial.`);

    return freshProfile;
  }

  private async saveProfileToDb(profile: SubscriptionProfile): Promise<void> {
    try {
      await (SubscriptionModel as any).findOneAndUpdate(
        { userID: profile.userID },
        {
          $set: {
            name: profile.name,
            status: profile.status,
            registrationDate: profile.registrationDate,
            expiryDate: profile.expiryDate,
            autoRenew: profile.autoRenew,
            weeklyRentAmount: profile.weeklyRentAmount,
            totalWeeksPurchased: profile.totalWeeksPurchased,
            totalCoinsPaid: profile.totalCoinsPaid,
            lastPaymentDate: profile.lastPaymentDate,
            lastNotificationStage: profile.lastNotificationStage,
            gracePeriodEndDate: profile.gracePeriodEndDate
          }
        },
        { upsert: true, new: true }
      );
    } catch (err: any) {
      // Fail quietly to memory
    }
  }

  /**
   * Checks subscription status and handles state transitions, grace periods, and auto-renew.
   */
  public async checkSubscription(userID: string, name: string = ''): Promise<SubscriptionCheckResult> {
    const profile = await this.registerUser(userID, name);
    const now = Date.now();
    const expiryMs = new Date(profile.expiryDate).getTime();
    const ecoAccount = await economyService.getAccount(userID, name);

    let notificationTrigger: string | undefined;
    let notificationMessage: string | undefined;

    // Check if currently active / trial and time is valid
    if (now <= expiryMs) {
      if (profile.status === 'GRACE_PERIOD' || profile.status === 'LIMITED') {
        profile.status = 'ACTIVE';
      }

      const diffMs = expiryMs - now;
      const daysLeft = Math.floor(diffMs / (24 * 60 * 60 * 1000));
      const hoursLeft = Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
      const minutesLeft = Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000));

      // Stage Notification triggers
      if (daysLeft <= 3 && daysLeft > 1 && profile.lastNotificationStage !== '3_DAYS') {
        profile.lastNotificationStage = '3_DAYS';
        notificationTrigger = '3_DAYS';
        notificationMessage = '⏰ Notice: Your bot subscription expires in 3 days! Run #payrent 1 to stay subscribed.';
      } else if (daysLeft <= 1 && diffMs > 6 * 3600 * 1000 && profile.lastNotificationStage !== '1_DAY') {
        profile.lastNotificationStage = '1_DAY';
        notificationTrigger = '1_DAY';
        notificationMessage = '⚠️ Notice: Your bot subscription expires tomorrow (1 day left)! Run #payrent 1 to renew automatically.';
      } else if (diffMs <= 6 * 3600 * 1000 && diffMs > 0 && profile.lastNotificationStage !== '6_HOURS') {
        profile.lastNotificationStage = '6_HOURS';
        notificationTrigger = '6_HOURS';
        notificationMessage = '🚨 Urgent: Only 6 hours left on your bot subscription! Please run #payrent 1 to keep uninterrupted access.';
      }

      this.saveProfileToDb(profile).catch(() => {});

      return {
        userID: profile.userID,
        name: profile.name,
        status: profile.status,
        registrationDate: profile.registrationDate,
        expiryDate: profile.expiryDate,
        daysLeft,
        hoursLeft,
        minutesLeft,
        autoRenew: profile.autoRenew,
        weeklyRentAmount: profile.weeklyRentAmount,
        totalPrepaidWeeks: Math.ceil(diffMs / this.WEEK_MS),
        totalCoinsPaid: profile.totalCoinsPaid,
        walletBalance: ecoAccount.money,
        bankBalance: ecoAccount.bankMoney,
        canExecuteCommands: profile.status !== 'SUSPENDED',
        gracePeriodEndDate: profile.gracePeriodEndDate,
        notificationTrigger,
        notificationMessage
      };
    }

    // EXPIRATION DETECTED (now > expiryMs)
    if (profile.status !== 'SUSPENDED') {
      // 1. Try Auto-Renew if enabled
      if (profile.autoRenew) {
        const totalCoins = ecoAccount.money + ecoAccount.bankMoney;
        if (totalCoins >= profile.weeklyRentAmount) {
          const autoRes = await this.renewSubscription(userID, 1, 'AUTO_RENEW');
          if (autoRes.success) {
            messengerLogger.info('SUBSCRIPTION', `Auto-Renew succeeded for ${userID}. Paid 1000 coins.`);
            const newExpiryMs = new Date(autoRes.newExpiry).getTime();
            const diffMs = newExpiryMs - now;
            return {
              userID: profile.userID,
              name: profile.name,
              status: profile.status,
              registrationDate: profile.registrationDate,
              expiryDate: new Date(autoRes.newExpiry),
              daysLeft: Math.floor(diffMs / (24 * 60 * 60 * 1000)),
              hoursLeft: Math.floor((diffMs % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000)),
              minutesLeft: Math.floor((diffMs % (60 * 60 * 1000)) / (60 * 1000)),
              autoRenew: profile.autoRenew,
              weeklyRentAmount: profile.weeklyRentAmount,
              totalPrepaidWeeks: 1,
              totalCoinsPaid: profile.totalCoinsPaid,
              walletBalance: ecoAccount.money,
              bankBalance: ecoAccount.bankMoney,
              canExecuteCommands: true,
              gracePeriodEndDate: null,
              notificationTrigger: 'AUTO_RENEWED',
              notificationMessage: '✅ Auto-Renew Successful: 1,000 Coins deducted. Your subscription has been extended by 1 week!'
            };
          }
        }
      }

      // 2. Transition to Grace Period if coming from TRIAL/ACTIVE
      if (profile.status === 'TRIAL' || profile.status === 'ACTIVE') {
        profile.status = 'GRACE_PERIOD';
        profile.gracePeriodEndDate = new Date(now + this.GRACE_MS);
        profile.lastNotificationStage = 'EXPIRED';
        notificationTrigger = 'EXPIRED';
        notificationMessage = '⌛ Subscription Expired: Your subscription has expired. You are now in a 3-Day Grace Period. Run #payrent 1 to renew.';
      } else if (profile.status === 'GRACE_PERIOD') {
        const graceEnd = profile.gracePeriodEndDate ? new Date(profile.gracePeriodEndDate).getTime() : 0;
        if (now > graceEnd) {
          profile.status = 'LIMITED';
          profile.lastNotificationStage = 'LIMITED';
          notificationTrigger = 'LIMITED';
          notificationMessage = '🔒 Grace Period Expired: Your account is now in Limited Mode. Only basic/payment commands are unlocked.';
        } else {
          // Grace period remaining
          const remainingGraceMs = graceEnd - now;
          if (remainingGraceMs <= 6 * 3600 * 1000 && profile.lastNotificationStage !== 'GRACE_ENDING') {
            profile.lastNotificationStage = 'GRACE_ENDING';
            notificationTrigger = 'GRACE_ENDING';
            notificationMessage = '⚠️ Grace Period Ending Soon! Your bot access will enter Limited Mode in a few hours.';
          }
        }
      }
    }

    this.saveProfileToDb(profile).catch(() => {});

    const statusStr = String(profile.status);
    const canExecute = statusStr === 'ACTIVE' || statusStr === 'GRACE_PERIOD' || statusStr === 'TRIAL';

    return {
      userID: profile.userID,
      name: profile.name,
      status: profile.status,
      registrationDate: profile.registrationDate,
      expiryDate: profile.expiryDate,
      daysLeft: 0,
      hoursLeft: 0,
      minutesLeft: 0,
      autoRenew: profile.autoRenew,
      weeklyRentAmount: profile.weeklyRentAmount,
      totalPrepaidWeeks: 0,
      totalCoinsPaid: profile.totalCoinsPaid,
      walletBalance: ecoAccount.money,
      bankBalance: ecoAccount.bankMoney,
      canExecuteCommands: canExecute,
      gracePeriodEndDate: profile.gracePeriodEndDate,
      notificationTrigger,
      notificationMessage
    };
  }

  /**
   * Extends or renews a user subscription for N weeks with payment.
   */
  public async renewSubscription(userID: string, weeks: number, paymentSource: string = 'USER_MANUAL'): Promise<{
    success: boolean;
    reason?: string;
    weeks?: number;
    totalCost?: number;
    walletDeducted?: number;
    bankDeducted?: number;
    previousExpiry?: Date;
    newExpiry?: Date;
    txID?: string;
    required?: number;
    available?: number;
    wallet?: number;
    bank?: number;
  }> {
    if (weeks < 1) return { success: false, reason: 'INVALID_WEEKS' };

    const profile = await this.registerUser(userID);
    const cost = weeks * profile.weeklyRentAmount;

    const ecoAccount = await economyService.getAccount(userID, profile.name);
    const walletBalance = ecoAccount.money;
    const bankBalance = ecoAccount.bankMoney;
    const totalAvailable = walletBalance + bankBalance;

    if (totalAvailable < cost) {
      return {
        success: false,
        reason: 'INSUFFICIENT_FUNDS',
        required: cost,
        available: totalAvailable,
        wallet: walletBalance,
        bank: bankBalance
      };
    }

    // Deduct coins: Wallet first, then Bank
    let walletDeduction = 0;
    let bankDeduction = 0;

    if (walletBalance >= cost) {
      walletDeduction = cost;
    } else {
      walletDeduction = walletBalance;
      bankDeduction = cost - walletBalance;
    }

    const newWallet = walletBalance - walletDeduction;
    const newBank = bankBalance - bankDeduction;

    // Save economy balances
    await economyService.setBalance(userID, newWallet, newBank);

    // Record Economy transaction
    await economyService.recordTransaction({
      senderID: userID,
      senderName: profile.name || 'User',
      receiverID: 'SYSTEM_SUBSCRIPTION',
      receiverName: 'ShiPu Subscription Service',
      amount: cost,
      currency: 'Coins',
      sourceCommand: 'PAYRENT',
      type: 'SPEND',
      adminAction: false,
      reason: `Bot Subscription Rent (${weeks} week${weeks > 1 ? 's' : ''}) [Source: Wallet: ${walletDeduction}, Bank: ${bankDeduction}]`,
      threadID: 'DIRECT',
      status: 'SUCCESS'
    });

    // Calculate expiry
    const now = Date.now();
    const currentExpiryMs = new Date(profile.expiryDate).getTime();
    const previousExpiry = new Date(profile.expiryDate);

    let baseMs = currentExpiryMs > now ? currentExpiryMs : now;
    const newExpiryMs = baseMs + weeks * this.WEEK_MS;
    const newExpiry = new Date(newExpiryMs);

    profile.status = 'ACTIVE';
    profile.expiryDate = newExpiry;
    profile.totalWeeksPurchased += weeks;
    profile.totalCoinsPaid += cost;
    profile.lastPaymentDate = new Date();
    profile.lastNotificationStage = '';
    profile.gracePeriodEndDate = null;

    await this.saveProfileToDb(profile);

    // Create payment transaction record
    const txID = `sub_tx_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const sourceLabel = walletDeduction > 0 && bankDeduction > 0 ? 'WALLET+BANK' : walletDeduction > 0 ? 'WALLET' : 'BANK';

    const paymentRecord: SubscriptionPaymentRecord = {
      txID,
      userID,
      name: profile.name,
      amount: cost,
      weeks,
      paymentSource: `${paymentSource} (${sourceLabel})`,
      previousExpiry,
      newExpiry,
      timestamp: new Date(),
      adminAction: false,
      adminUid: '',
      isRefunded: false,
      note: `Paid ${cost} coins for ${weeks} week(s)`
    };

    this.inMemoryPayments.unshift(paymentRecord);
    this.savePaymentToDb(paymentRecord).catch(() => {});

    messengerLogger.info('SUBSCRIPTION', `User ${userID} renewed subscription for ${weeks} weeks (${cost} coins). New Expiry: ${newExpiry.toISOString()}`);

    return {
      success: true,
      weeks,
      totalCost: cost,
      walletDeducted: walletDeduction,
      bankDeducted: bankDeduction,
      previousExpiry,
      newExpiry,
      txID
    };
  }

  private async savePaymentToDb(payment: SubscriptionPaymentRecord): Promise<void> {
    try {
      await (SubscriptionPaymentModel as any).create(payment);
    } catch (e) {
      // Memory fallback
    }
  }

  public async paySubscription(userID: string, weeks: number): Promise<any> {
    return this.renewSubscription(userID, weeks, 'USER_PAYRENT');
  }

  public async toggleAutoRenew(userID: string, enabled?: boolean): Promise<{ userID: string; autoRenew: boolean }> {
    const profile = await this.registerUser(userID);
    profile.autoRenew = enabled !== undefined ? enabled : !profile.autoRenew;
    await this.saveProfileToDb(profile);
    return { userID, autoRenew: profile.autoRenew };
  }

  public async extendSubscription(userID: string, weeks: number, adminUid: string = 'ADMIN'): Promise<SubscriptionProfile> {
    const profile = await this.registerUser(userID);
    const now = Date.now();
    const currentExpiryMs = new Date(profile.expiryDate).getTime();
    const previousExpiry = new Date(profile.expiryDate);

    const baseMs = currentExpiryMs > now ? currentExpiryMs : now;
    const newExpiry = new Date(baseMs + weeks * this.WEEK_MS);

    profile.status = 'ACTIVE';
    profile.expiryDate = newExpiry;
    profile.totalWeeksPurchased += weeks;
    profile.lastNotificationStage = '';
    profile.gracePeriodEndDate = null;

    await this.saveProfileToDb(profile);

    const txID = `sub_admin_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const paymentRecord: SubscriptionPaymentRecord = {
      txID,
      userID,
      name: profile.name,
      amount: 0,
      weeks,
      paymentSource: 'ADMIN_GRANT',
      previousExpiry,
      newExpiry,
      timestamp: new Date(),
      adminAction: true,
      adminUid,
      isRefunded: false,
      note: `Admin granted ${weeks} week(s)`
    };

    this.inMemoryPayments.unshift(paymentRecord);
    this.savePaymentToDb(paymentRecord).catch(() => {});

    return profile;
  }

  public async grantFreeWeeks(userID: string, weeks: number, adminUid: string = 'ADMIN'): Promise<SubscriptionProfile> {
    return this.extendSubscription(userID, weeks, adminUid);
  }

  public async setUserStatus(userID: string, status: SubscriptionStatus, adminUid: string = 'ADMIN'): Promise<SubscriptionProfile> {
    const profile = await this.registerUser(userID);
    profile.status = status;
    if (status === 'SUSPENDED') {
      profile.autoRenew = false;
    }
    await this.saveProfileToDb(profile);
    messengerLogger.info('SUBSCRIPTION', `Admin ${adminUid} set user ${userID} status to ${status}`);
    return profile;
  }

  public async refundPayment(userID: string, txID: string, adminUid: string = 'ADMIN'): Promise<{ success: boolean; message: string }> {
    let payment: SubscriptionPaymentRecord | undefined = this.inMemoryPayments.find(p => p.txID === txID);

    if (!payment) {
      try {
        const dbTx = await (SubscriptionPaymentModel as any).findOne({ txID });
        if (dbTx) {
          payment = dbTx.toObject();
        }
      } catch (e) {}
    }

    if (!payment) {
      return { success: false, message: 'Payment transaction not found' };
    }

    if (payment.isRefunded) {
      return { success: false, message: 'Transaction already refunded' };
    }

    // Refund coins to user's Wallet
    if (payment.amount > 0) {
      await economyService.addCoins(userID, payment.amount, `Refund for Subscription Tx ${txID}`);
    }

    // Reduce subscription expiry
    const profile = await this.registerUser(userID);
    const currentExpiryMs = new Date(profile.expiryDate).getTime();
    const reducedExpiryMs = Math.max(Date.now(), currentExpiryMs - payment.weeks * this.WEEK_MS);
    profile.expiryDate = new Date(reducedExpiryMs);
    profile.totalCoinsPaid = Math.max(0, profile.totalCoinsPaid - payment.amount);
    profile.totalWeeksPurchased = Math.max(0, profile.totalWeeksPurchased - payment.weeks);

    await this.saveProfileToDb(profile);

    payment.isRefunded = true;
    try {
      await (SubscriptionPaymentModel as any).updateOne({ txID }, { $set: { isRefunded: true } });
    } catch (e) {}

    messengerLogger.info('SUBSCRIPTION', `Admin ${adminUid} refunded Tx ${txID} (${payment.amount} coins) for user ${userID}`);

    return { success: true, message: `Successfully refunded ${payment.amount} coins and adjusted expiry date.` };
  }

  public async calculateExpiry(userID: string): Promise<any> {
    const check = await this.checkSubscription(userID);
    return {
      expiryDate: check.expiryDate,
      daysLeft: check.daysLeft,
      hoursLeft: check.hoursLeft,
      minutesLeft: check.minutesLeft,
      totalPrepaidWeeks: check.totalPrepaidWeeks
    };
  }

  public async runAutoRenew(): Promise<{ totalProcessed: number; totalRenewed: number }> {
    let totalProcessed = 0;
    let totalRenewed = 0;

    let profilesToProcess: SubscriptionProfile[] = Array.from(this.inMemoryProfiles.values());

    try {
      const dbDocs = await (SubscriptionModel as any).find({});
      if (dbDocs && dbDocs.length > 0) {
        profilesToProcess = dbDocs.map((d: any) => ({
          userID: d.userID,
          name: d.name,
          status: d.status,
          registrationDate: new Date(d.registrationDate),
          expiryDate: new Date(d.expiryDate),
          autoRenew: d.autoRenew ?? false,
          weeklyRentAmount: d.weeklyRentAmount ?? this.DEFAULT_RENT,
          totalWeeksPurchased: d.totalWeeksPurchased ?? 0,
          totalCoinsPaid: d.totalCoinsPaid ?? 0,
          lastPaymentDate: d.lastPaymentDate ? new Date(d.lastPaymentDate) : null,
          lastNotificationStage: d.lastNotificationStage || '',
          gracePeriodEndDate: d.gracePeriodEndDate ? new Date(d.gracePeriodEndDate) : null
        }));
      }
    } catch (e) {}

    const now = Date.now();

    for (const p of profilesToProcess) {
      if (p.status === 'SUSPENDED') continue;
      const expMs = new Date(p.expiryDate).getTime();
      if (now > expMs) {
        totalProcessed++;
        const checkResult = await this.checkSubscription(p.userID, p.name);
        if (checkResult.notificationTrigger === 'AUTO_RENEWED') {
          totalRenewed++;
        }
      }
    }

    return { totalProcessed, totalRenewed };
  }

  public async checkGracePeriod(): Promise<void> {
    await this.runAutoRenew();
  }

  public async generateSubscriptionReport(): Promise<any> {
    await this.syncAllDataFromDb();

    const profiles = Array.from(this.inMemoryProfiles.values());
    const payments = [...this.inMemoryPayments];

    const totalSubscribers = profiles.length;
    let activeUsers = 0;
    let trialUsers = 0;
    let graceUsers = 0;
    let limitedUsers = 0;
    let suspendedUsers = 0;
    let autoRenewEnabledCount = 0;
    let totalRevenue = 0;

    const now = Date.now();

    profiles.forEach(p => {
      const expMs = new Date(p.expiryDate).getTime();
      if (p.status === 'SUSPENDED') {
        suspendedUsers++;
      } else if (p.status === 'LIMITED') {
        limitedUsers++;
      } else if (p.status === 'GRACE_PERIOD') {
        graceUsers++;
      } else if (now <= expMs) {
        if (p.status === 'TRIAL') trialUsers++;
        else activeUsers++;
      } else {
        limitedUsers++;
      }

      if (p.autoRenew) autoRenewEnabledCount++;
      totalRevenue += p.totalCoinsPaid || 0;
    });

    const expectedUpcomingRevenue = (activeUsers + trialUsers) * this.DEFAULT_RENT;

    // Upcoming expirations (next 7 days)
    const upcomingExpirations = profiles
      .filter(p => p.status !== 'SUSPENDED' && new Date(p.expiryDate).getTime() > now && new Date(p.expiryDate).getTime() <= now + 7 * 86400 * 1000)
      .sort((a, b) => new Date(a.expiryDate).getTime() - new Date(b.expiryDate).getTime())
      .slice(0, 50);

    // Top subscribers by total coins paid / weeks
    const topSubscribers = [...profiles]
      .sort((a, b) => (b.totalCoinsPaid || 0) - (a.totalCoinsPaid || 0))
      .slice(0, 10);

    return {
      summary: {
        totalSubscribers,
        activeUsers,
        trialUsers,
        graceUsers,
        limitedUsers,
        suspendedUsers,
        autoRenewEnabledCount,
        totalRevenue,
        expectedUpcomingRevenue
      },
      recentPayments: payments.slice(0, 20),
      upcomingExpirations,
      topSubscribers
    };
  }

  public async getAllSubscriptions(filters?: { status?: string; search?: string; limit?: number }): Promise<any[]> {
    await this.syncAllDataFromDb();

    let list = Array.from(this.inMemoryProfiles.values());

    if (filters?.status && filters.status !== 'ALL') {
      list = list.filter(p => p.status === filters.status);
    }

    if (filters?.search) {
      const query = filters.search.toLowerCase();
      list = list.filter(p => p.userID.toLowerCase().includes(query) || (p.name || '').toLowerCase().includes(query));
    }

    const limit = filters?.limit || 100;

    // Enrich with economy balances
    const enriched = await Promise.all(
      list.slice(0, limit).map(async p => {
        const check = await this.checkSubscription(p.userID, p.name);
        return {
          ...p,
          daysLeft: check.daysLeft,
          hoursLeft: check.hoursLeft,
          wallet: check.walletBalance,
          bank: check.bankBalance,
          canExecuteCommands: check.canExecuteCommands
        };
      })
    );

    return enriched;
  }

  private async syncAllDataFromDb(): Promise<void> {
    try {
      const dbDocs = await (SubscriptionModel as any).find({});
      if (dbDocs && dbDocs.length > 0) {
        dbDocs.forEach((d: any) => {
          this.inMemoryProfiles.set(d.userID, {
            userID: d.userID,
            name: d.name,
            status: d.status,
            registrationDate: new Date(d.registrationDate),
            expiryDate: new Date(d.expiryDate),
            autoRenew: d.autoRenew ?? false,
            weeklyRentAmount: d.weeklyRentAmount ?? 1000,
            totalWeeksPurchased: d.totalWeeksPurchased ?? 0,
            totalCoinsPaid: d.totalCoinsPaid ?? 0,
            lastPaymentDate: d.lastPaymentDate ? new Date(d.lastPaymentDate) : null,
            lastNotificationStage: d.lastNotificationStage || '',
            gracePeriodEndDate: d.gracePeriodEndDate ? new Date(d.gracePeriodEndDate) : null
          });
        });
      }

      const txDocs = await (SubscriptionPaymentModel as any).find({}).sort({ timestamp: -1 }).limit(100);
      if (txDocs && txDocs.length > 0) {
        this.inMemoryPayments = txDocs.map((t: any) => ({
          txID: t.txID,
          userID: t.userID,
          name: t.name,
          amount: t.amount,
          weeks: t.weeks,
          paymentSource: t.paymentSource,
          previousExpiry: new Date(t.previousExpiry),
          newExpiry: new Date(t.newExpiry),
          timestamp: new Date(t.timestamp),
          adminAction: t.adminAction,
          adminUid: t.adminUid,
          isRefunded: t.isRefunded,
          note: t.note
        }));
      }
    } catch (e) {}
  }
}

export const subscriptionService = new SubscriptionService();
