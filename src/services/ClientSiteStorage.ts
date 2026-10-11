import fs from 'fs-extra';
import path from 'path';
import crypto from 'crypto';

const DATA_DIR = path.join(process.cwd(), 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const PAYMENTS_DIR = path.join(DATA_DIR, 'payments');
const SETTINGS_DIR = path.join(DATA_DIR, 'settings');

export interface ClientUser {
  userId: string;
  email: string;
  username: string;
  passwordHash: string;
  fullName: string;
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING';
  subscription: {
    plan: string;
    status: 'ACTIVE' | 'EXPIRED' | 'TRIAL';
    expiresAt: string;
    slotsCount: number;
  };
  botSlots: Array<{
    slotId: string;
    botName: string;
    status: string;
    assignedUid?: string;
  }>;
  createdAt: string;
  lastLogin?: string;
}

export interface PaymentRequest {
  paymentId: string;
  userId: string;
  username: string;
  amount: number;
  currency: string;
  plan: string;
  slots: number;
  paymentMethod: string;
  transactionReference: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  submittedAt: string;
  reviewedAt?: string;
  adminNotes?: string;
}

export class ClientSiteStorage {
  private static instance: ClientSiteStorage;

  private constructor() {
    this.ensureDirs();
  }

  public static getInstance(): ClientSiteStorage {
    if (!ClientSiteStorage.instance) {
      ClientSiteStorage.instance = new ClientSiteStorage();
    }
    return ClientSiteStorage.instance;
  }

  private async ensureDirs() {
    // Vercel serverless filesystem is read-only except /tmp — never crash boot.
    try {
      await fs.ensureDir(USERS_DIR);
      await fs.ensureDir(PAYMENTS_DIR);
      await fs.ensureDir(SETTINGS_DIR);

    const settingsPath = path.join(SETTINGS_DIR, 'settings.json');
    if (!await fs.pathExists(settingsPath)) {
      const defaultAdminPass = crypto.createHash('sha256').update('shipu_admin_2026').digest('hex');
      await fs.writeJson(settingsPath, {
        adminUsername: 'admin',
        adminPasswordHash: defaultAdminPass,
        siteTitle: 'ShiPu AI Client Portal',
        updatedAt: new Date().toISOString()
      }, { spaces: 2 });
    }

    // Seed a sample user if none exist
    const users = await this.getAllUsers();
    if (users.length === 0) {
      const sampleId = 'user_' + crypto.randomBytes(4).toString('hex');
      const samplePass = crypto.createHash('sha256').update('password123').digest('hex');
      const sampleUser: ClientUser = {
        userId: sampleId,
        email: 'customer@shipuai.com',
        username: 'democustomer',
        passwordHash: samplePass,
        fullName: 'Demo Customer',
        status: 'ACTIVE',
        subscription: {
          plan: 'Professional Bot Tier',
          status: 'ACTIVE',
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
          slotsCount: 2
        },
        botSlots: [
          { slotId: 'slot_1', botName: 'ShiPu Support Bot', status: 'ONLINE', assignedUid: '1000889922' },
          { slotId: 'slot_2', botName: 'ShiPu Sales Bot', status: 'STANDBY' }
        ],
        createdAt: new Date().toISOString()
      };
      await this.saveUser(sampleUser);
      }
    } catch (err: any) {
      console.warn(`[ClientSiteStorage] Local directory setup skipped (read-only fs?): ${err?.message || err}`);
    }
  }

  public async getAllUsers(): Promise<ClientUser[]> {
    await this.ensureDirs();
    if (!await fs.pathExists(USERS_DIR)) return [];
    const files = await fs.readdir(USERS_DIR);
    const users: ClientUser[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const user = await fs.readJson(path.join(USERS_DIR, file));
          if (user && user.userId) {
            users.push(user);
          }
        } catch (e) {
          // ignore corrupt files
        }
      }
    }
    return users;
  }

  public async getUser(userId: string): Promise<ClientUser | null> {
    await this.ensureDirs();
    const userPath = path.join(USERS_DIR, `${userId}.json`);
    if (await fs.pathExists(userPath)) {
      return await fs.readJson(userPath);
    }
    return null;
  }

  public async getUserByUsername(username: string): Promise<ClientUser | null> {
    const users = await this.getAllUsers();
    return users.find(u => u.username.toLowerCase() === username.toLowerCase() || u.email.toLowerCase() === username.toLowerCase()) || null;
  }

  public async saveUser(user: ClientUser): Promise<void> {
    await this.ensureDirs();
    const userPath = path.join(USERS_DIR, `${user.userId}.json`);
    await fs.writeJson(userPath, user, { spaces: 2 });
  }

  public async deleteUser(userId: string): Promise<boolean> {
    const userPath = path.join(USERS_DIR, `${userId}.json`);
    if (await fs.pathExists(userPath)) {
      await fs.remove(userPath);
      return true;
    }
    return false;
  }

  public async getAllPayments(): Promise<PaymentRequest[]> {
    await this.ensureDirs();
    if (!await fs.pathExists(PAYMENTS_DIR)) return [];
    const files = await fs.readdir(PAYMENTS_DIR);
    const payments: PaymentRequest[] = [];
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const payment = await fs.readJson(path.join(PAYMENTS_DIR, file));
          if (payment && payment.paymentId) {
            payments.push(payment);
          }
        } catch (e) {}
      }
    }
    return payments.sort((a, b) => new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime());
  }

  public async getPayment(paymentId: string): Promise<PaymentRequest | null> {
    await this.ensureDirs();
    const pPath = path.join(PAYMENTS_DIR, `${paymentId}.json`);
    if (await fs.pathExists(pPath)) {
      return await fs.readJson(pPath);
    }
    return null;
  }

  public async savePayment(payment: PaymentRequest): Promise<void> {
    await this.ensureDirs();
    const pPath = path.join(PAYMENTS_DIR, `${payment.paymentId}.json`);
    await fs.writeJson(pPath, payment, { spaces: 2 });
  }

  public async getSettings(): Promise<any> {
    await this.ensureDirs();
    const settingsPath = path.join(SETTINGS_DIR, 'settings.json');
    if (await fs.pathExists(settingsPath)) {
      return await fs.readJson(settingsPath);
    }
    return { adminUsername: 'admin' };
  }

  public async updateSettings(newSettings: any): Promise<void> {
    await this.ensureDirs();
    const settingsPath = path.join(SETTINGS_DIR, 'settings.json');
    const current = await this.getSettings();
    const merged = { ...current, ...newSettings, updatedAt: new Date().toISOString() };
    await fs.writeJson(settingsPath, merged, { spaces: 2 });
  }
}

export const clientSiteStorage = ClientSiteStorage.getInstance();
