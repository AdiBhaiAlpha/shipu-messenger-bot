import { economyService } from './economyService';
import { createCanvas } from '@napi-rs/canvas';
import { UserSpinModel } from '../db/firebaseDb';

export { UserSpinModel };

export interface SpinResult {
  success: boolean;
  reward?: number;
  spinsRemaining?: number;
  totalSpins?: number;
  totalCoinsWon?: number;
  jackpotCount?: number;
  resetTimerStr?: string;
  message: string;
  imageBuffer?: Buffer;
}

const REWARD_TABLE = [
  { reward: 20, prob: 28, label: '20 💰' },
  { reward: 30, prob: 22, label: '30 💰' },
  { reward: 40, prob: 18, label: '40 💰' },
  { reward: 50, prob: 12, label: '50 💰' },
  { reward: 60, prob: 8, label: '60 💰' },
  { reward: 70, prob: 6, label: '70 💰' },
  { reward: 80, prob: 3, label: '80 💰' },
  { reward: 90, prob: 2, label: '90 💰' },
  { reward: 100, prob: 1, label: '100 💎 JACKPOT' }
];

const WHEEL_SEGMENTS = [
  { reward: 20, color: '#ef4444', label: '20 🪙' },
  { reward: 50, color: '#f59e0b', label: '50 🪙' },
  { reward: 30, color: '#10b981', label: '30 🪙' },
  { reward: 80, color: '#3b82f6', label: '80 🪙' },
  { reward: 40, color: '#8b5cf6', label: '40 🪙' },
  { reward: 100, color: '#ec4899', label: 'JACKPOT' },
  { reward: 20, color: '#06b6d4', label: '20 🪙' },
  { reward: 60, color: '#14b8a6', label: '60 🪙' },
  { reward: 30, color: '#6366f1', label: '30 🪙' },
  { reward: 90, color: '#eab308', label: '90 🪙' },
  { reward: 50, color: '#f43f5e', label: '50 🪙' },
  { reward: 70, color: '#a855f7', label: '70 🪙' }
];

class SpinService {
  private activeLocks: Set<string> = new Set();

  public async executeSpin(userID: string, userName: string, threadID: string): Promise<SpinResult> {
    const cleanID = String(userID || '').trim();
    if (!cleanID) {
      return { success: false, message: '❌ Invalid user ID.' };
    }

    if (this.activeLocks.has(cleanID)) {
      return { success: false, message: '⏳ Your previous spin is currently processing. Please wait a moment!' };
    }
    this.activeLocks.add(cleanID);

    try {
      const todayDate = new Date().toISOString().slice(0, 10);
      
      let doc = await (UserSpinModel as any).findOne({ userID: cleanID });
      if (!doc) {
        doc = await (UserSpinModel as any).create({
          userID: cleanID,
          name: userName || 'User',
          dateString: todayDate,
          spinsUsedToday: 0,
          totalSpins: 0,
          totalCoinsWon: 0,
          jackpotCount: 0,
          history: []
        });
      }

      if (doc.dateString !== todayDate) {
        doc.dateString = todayDate;
        doc.spinsUsedToday = 0;
        await doc.save();
      }

      const freeLimit = 3;
      if (doc.spinsUsedToday >= freeLimit) {
        const resetTimer = this.calculateResetTimer();
        return {
          success: false,
          spinsRemaining: 0,
          totalSpins: doc.totalSpins,
          totalCoinsWon: doc.totalCoinsWon,
          jackpotCount: doc.jackpotCount,
          resetTimerStr: resetTimer,
          message: `🚫 **DAILY SPINS EXHAUSTED**\n\n` +
            `👤 User: **${userName || doc.name}**\n` +
            `🎟️ You have used all **3 / 3** free daily spins today.\n` +
            `⏱️ Next free spin reset in: **${resetTimer}**\n` +
            `💡 Come back tomorrow for 3 brand new free spins!`
        };
      }

      const wonReward = this.rollWeightedReward();
      const isJackpot = wonReward === 100;

      doc.spinsUsedToday += 1;
      doc.totalSpins += 1;
      doc.totalCoinsWon += wonReward;
      if (isJackpot) {
        doc.jackpotCount += 1;
      }
      doc.lastSpinAt = new Date();
      doc.history.unshift({
        reward: wonReward,
        timestamp: new Date().toISOString()
      });
      if (doc.history.length > 20) doc.history.pop();
      if (userName && userName !== 'User') doc.name = userName;
      await doc.save();

      await economyService.addCoins(
        cleanID,
        wonReward,
        'SPIN_WHEEL',
        isJackpot ? 'Lucky Wheel JACKPOT 100 Coins Win!' : `Lucky Wheel Reward: ${wonReward} Coins`,
        threadID
      );

      const segmentIndex = WHEEL_SEGMENTS.findIndex(s => s.reward === wonReward);
      const landedSegment = segmentIndex >= 0 ? segmentIndex : 0;

      const imageBuffer = await this.renderWheelImage(landedSegment, wonReward, isJackpot, userName || doc.name, freeLimit - doc.spinsUsedToday);

      const resetTimer = this.calculateResetTimer();
      const spinsRemaining = freeLimit - doc.spinsUsedToday;

      let msg = `🎡 **SHIPU AI CASINO LUCKY SPIN**\n` +
        `─────────────────────────\n` +
        `👤 Player: **${userName || doc.name}**\n` +
        `🎁 Reward Won: **+${wonReward} Coins 💰**\n` +
        (isJackpot ? `💎 **JACKPOT HIT!! CONGRATULATIONS!** 🎉\n` : '') +
        `─────────────────────────\n` +
        `🎟️ Free Spins Left Today: **${spinsRemaining} / 3**\n` +
        `🏆 Lifetime Coins Won: **${doc.totalCoinsWon.toLocaleString()} Coins**\n` +
        `🎰 Total Lifetime Spins: **${doc.totalSpins}**\n` +
        `💎 Jackpot Hits: **${doc.jackpotCount}**\n` +
        `⏱️ Reset Cooldown: **${resetTimer}**`;

      return {
        success: true,
        reward: wonReward,
        spinsRemaining,
        totalSpins: doc.totalSpins,
        totalCoinsWon: doc.totalCoinsWon,
        jackpotCount: doc.jackpotCount,
        resetTimerStr: resetTimer,
        message: msg,
        imageBuffer
      };

    } catch (err: any) {
      console.error('[SpinService] Error executing spin:', err);
      return { success: false, message: '❌ Failed to process spin due to a server error. Please try again.' };
    } finally {
      this.activeLocks.delete(cleanID);
    }
  }

  public async getUserSpinStats(userID: string): Promise<any> {
    const cleanID = String(userID || '').trim();
    const todayDate = new Date().toISOString().slice(0, 10);
    let doc = await (UserSpinModel as any).findOne({ userID: cleanID });
    if (!doc) {
      return {
        spinsUsedToday: 0,
        spinsRemaining: 3,
        totalSpins: 0,
        totalCoinsWon: 0,
        jackpotCount: 0,
        resetTimerStr: this.calculateResetTimer()
      };
    }
    if (doc.dateString !== todayDate) {
      doc.dateString = todayDate;
      doc.spinsUsedToday = 0;
      await doc.save();
    }
    return {
      spinsUsedToday: doc.spinsUsedToday,
      spinsRemaining: Math.max(0, 3 - doc.spinsUsedToday),
      totalSpins: doc.totalSpins,
      totalCoinsWon: doc.totalCoinsWon,
      jackpotCount: doc.jackpotCount,
      resetTimerStr: this.calculateResetTimer()
    };
  }

  private rollWeightedReward(): number {
    const rand = Math.random() * 100;
    let cumulative = 0;
    for (const item of REWARD_TABLE) {
      cumulative += item.prob;
      if (rand <= cumulative) {
        return item.reward;
      }
    }
    return 20;
  }

  private calculateResetTimer(): string {
    const now = new Date();
    const utcNow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds());
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
    const diffMs = utcMidnight - utcNow;

    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const mins = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const secs = Math.floor((diffMs % (1000 * 60)) / 1000);

    return `${String(hours).padStart(2, '0')}h ${String(mins).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
  }

  private async renderWheelImage(landedIndex: number, reward: number, isJackpot: boolean, userName: string, spinsLeft: number): Promise<Buffer> {
    const width = 700;
    const height = 750;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext('2d');

    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#0f0c29');
    bgGrad.addColorStop(0.5, '#302b63');
    bgGrad.addColorStop(1, '#24243e');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(width / 2, 340);
    const glowGrad = ctx.createRadialGradient(0, 0, 50, 0, 0, 280);
    glowGrad.addColorStop(0, isJackpot ? 'rgba(236, 72, 153, 0.4)' : 'rgba(245, 158, 11, 0.3)');
    glowGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glowGrad;
    ctx.beginPath();
    ctx.arc(0, 0, 280, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 28px sans-serif';
    ctx.textAlign = 'center';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 10;
    ctx.fillText('🌟 SHIPU AI LUCKY SPIN WHEEL 🌟', width / 2, 50);

    ctx.fillStyle = '#cbd5e1';
    ctx.font = '16px sans-serif';
    ctx.fillText(`Player: ${userName}  •  Spins Left: ${spinsLeft}/3`, width / 2, 80);

    const centerX = width / 2;
    const centerY = 360;
    const radius = 220;
    const totalSegments = WHEEL_SEGMENTS.length;
    const arcSize = (Math.PI * 2) / totalSegments;

    const targetAngle = -Math.PI / 2 - (landedIndex * arcSize + arcSize / 2);

    ctx.save();
    ctx.translate(centerX, centerY);
    ctx.rotate(targetAngle);

    for (let i = 0; i < totalSegments; i++) {
      const seg = WHEEL_SEGMENTS[i];
      const startAngle = i * arcSize;
      const endAngle = (i + 1) * arcSize;

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, radius, startAngle, endAngle);
      ctx.closePath();

      const segGrad = ctx.createRadialGradient(0, 0, 20, 0, 0, radius);
      segGrad.addColorStop(0, '#ffffff');
      segGrad.addColorStop(0.3, seg.color);
      segGrad.addColorStop(1, '#111827');
      ctx.fillStyle = segGrad;
      ctx.fill();

      ctx.lineWidth = 3;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();

      ctx.save();
      ctx.rotate(startAngle + arcSize / 2);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 16px sans-serif';
      ctx.shadowColor = 'rgba(0,0,0,0.9)';
      ctx.shadowBlur = 6;
      ctx.fillText(seg.label, radius - 25, 6);
      ctx.restore();
    }

    ctx.restore();

    ctx.beginPath();
    ctx.arc(centerX, centerY, radius + 8, 0, Math.PI * 2);
    ctx.lineWidth = 12;
    ctx.strokeStyle = isJackpot ? '#ec4899' : '#f59e0b';
    ctx.shadowColor = isJackpot ? '#ec4899' : '#f59e0b';
    ctx.shadowBlur = 20;
    ctx.stroke();
    ctx.shadowBlur = 0;

    ctx.beginPath();
    ctx.arc(centerX, centerY, 38, 0, Math.PI * 2);
    const hubGrad = ctx.createRadialGradient(centerX, centerY, 5, centerX, centerY, 38);
    hubGrad.addColorStop(0, '#fbbf24');
    hubGrad.addColorStop(1, '#b45309');
    ctx.fillStyle = hubGrad;
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();

    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 14px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('SPIN', centerX, centerY);

    ctx.save();
    ctx.translate(centerX, centerY - radius - 15);
    ctx.beginPath();
    ctx.moveTo(0, 20);
    ctx.lineTo(-14, -10);
    ctx.lineTo(14, -10);
    ctx.closePath();
    ctx.fillStyle = '#ef4444';
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 8;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.restore();

    const bannerY = 620;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.85)';
    ctx.fillRect(50, bannerY, width - 100, 95);
    ctx.lineWidth = 2;
    ctx.strokeStyle = isJackpot ? '#ec4899' : '#f59e0b';
    ctx.stroke();

    ctx.fillStyle = isJackpot ? '#ec4899' : '#fbbf24';
    ctx.font = 'bold 22px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(isJackpot ? '💎 JACKPOT WIN! +100 COINS! 💎' : `🎉 YOU WON +${reward} COINS! 🎉`, width / 2, bannerY + 40);

    ctx.fillStyle = '#e2e8f0';
    ctx.font = '15px sans-serif';
    ctx.fillText(`ShiPu AI Official Economy Reward • Free Spins Remaining: ${spinsLeft}/3`, width / 2, bannerY + 72);

    return canvas.toBuffer('image/png');
  }
}

export const spinService = new SpinService();
