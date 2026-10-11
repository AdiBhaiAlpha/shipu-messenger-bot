import { OfficialGroupModel, SharedAccessUserModel, connectDatabase } from '../db/firebaseDb';
import { multiAccountManager } from '../adapters/messenger/MultiAccountManager';
import { messengerLogger } from '../adapters/messenger/MessengerLogger';

export interface OfficialGroupRecord {
  threadID: string;
  threadName: string;
  inviteLink: string;
  order: number;
  active: boolean;
}

export interface UserAccessStatus {
  userID: string;
  userName: string;
  joinedGroupIDs: string[];
  missingGroupIDs: string[];
  totalJoinedCount: number;
  totalRequiredCount: number;
  hasAccess: boolean;
  authorizedThreadIDs: string[];
  lastVerifiedAt: number;
}

export class SharedAccessService {
  private static instance: SharedAccessService;

  private constructor() {}

  public static getInstance(): SharedAccessService {
    if (!SharedAccessService.instance) {
      SharedAccessService.instance = new SharedAccessService();
    }
    return SharedAccessService.instance;
  }

  public async getOfficialGroups(): Promise<OfficialGroupRecord[]> {
    await connectDatabase();
    try {
      const records = await (OfficialGroupModel.find({ active: true } as any) as any).sort({ order: 1 }).lean();
      return (records || []).map((r: any) => ({
        threadID: r.threadID,
        threadName: r.threadName || `Official Group ${r.order}`,
        inviteLink: r.inviteLink || '',
        order: r.order || 1,
        active: r.active !== false
      }));
    } catch (err) {
      console.error('[SharedAccess] Failed to fetch official groups:', err);
      return [];
    }
  }

  public async saveOfficialGroups(groups: OfficialGroupRecord[]): Promise<{ success: boolean; message: string }> {
    await connectDatabase();
    if (!Array.isArray(groups) || groups.length > 5) {
      return { success: false, message: 'You can configure a maximum of 5 Official Access Groups.' };
    }

    try {
      await (OfficialGroupModel.deleteMany({} as any) as any);
      for (let i = 0; i < groups.length; i++) {
        const g = groups[i];
        if (!g.threadID || !g.threadID.trim()) continue;
        await OfficialGroupModel.create({
          threadID: g.threadID.trim(),
          threadName: g.threadName.trim() || `Official Group ${i + 1}`,
          inviteLink: g.inviteLink ? g.inviteLink.trim() : '',
          order: i + 1,
          active: true
        });
      }
      return { success: true, message: 'Official Access Groups successfully updated (up to 5 groups).' };
    } catch (err: any) {
      return { success: false, message: err?.message || 'Failed to save official groups.' };
    }
  }

  private getFcaApi(): any {
    const conn = multiAccountManager.getAccountConnection();
    return conn ? conn.getFcaApi() : null;
  }

  public async verifyUserMembership(userID: string, userName?: string, apiOverride?: any): Promise<UserAccessStatus> {
    await connectDatabase();
    const api = apiOverride || this.getFcaApi();
    const officialGroups = await this.getOfficialGroups();

    const joinedGroupIDs: string[] = [];
    const missingGroupIDs: string[] = [];

    let resolvedUserName = userName || `User_${userID}`;

    // Attempt to get user name from botEngine if available
    try {
      const botEngine = (globalThis as any).botEngine || (global as any).botEngine;
      if (botEngine && typeof botEngine.getOrCreateUser === 'function') {
        const u = botEngine.getOrCreateUser(userID);
        if (u && u.name && !u.name.startsWith('User_')) {
          resolvedUserName = u.name;
        }
      }
    } catch {}

    if (api && api.getUserInfo && (!resolvedUserName || resolvedUserName.startsWith('User_'))) {
      try {
        await new Promise<void>((resolve) => {
          api.getUserInfo(userID, (err: any, ret: any) => {
            if (!err && ret && ret[userID]) {
              resolvedUserName = ret[userID].name || resolvedUserName;
            }
            resolve();
          });
        });
      } catch {}
    }

    if (officialGroups.length === 0) {
      const record = await (SharedAccessUserModel.findOne({ userID } as any) as any).lean();
      return {
        userID,
        userName: resolvedUserName,
        joinedGroupIDs: [],
        missingGroupIDs: [],
        totalJoinedCount: 0,
        totalRequiredCount: 0,
        hasAccess: true,
        authorizedThreadIDs: record?.authorizedThreadIDs || [],
        lastVerifiedAt: Date.now()
      };
    }

    if (!api) {
      // If API is not available, we CANNOT verify. To prevent accidental revocation,
      // we retrieve the existing status from DB if it exists, or throw an error.
      const existing = await (SharedAccessUserModel.findOne({ userID } as any) as any).lean();
      if (existing) {
        return {
          userID,
          userName: existing.userName || resolvedUserName,
          joinedGroupIDs: existing.joinedGroupIDs || [],
          missingGroupIDs: existing.missingGroupIDs || [],
          totalJoinedCount: existing.totalJoinedCount || 0,
          totalRequiredCount: existing.totalRequiredCount || 0,
          hasAccess: existing.hasAccess === true,
          authorizedThreadIDs: existing.authorizedThreadIDs || [],
          lastVerifiedAt: existing.lastVerifiedAt || Date.now()
        };
      }
      throw new Error("Messenger bot API is currently disconnected or unavailable. Cannot verify membership.");
    }

    for (const group of officialGroups) {
      let isMember = false;
      if (api && api.getThreadInfo) {
        try {
          isMember = await new Promise<boolean>((resolve, reject) => {
            api.getThreadInfo(group.threadID, (err: any, info: any) => {
              if (err) {
                return reject(new Error(`Failed to fetch group info for "${group.threadName}" (${group.threadID}): ${err.message || err || 'Unknown error'}`));
              }
              if (!info) {
                return reject(new Error(`Group info for "${group.threadName}" is empty`));
              }
              const participants = info.participantIDs || info.participants || [];
              if (Array.isArray(participants)) {
                const found = participants.some((p: any) => {
                  const pid = typeof p === 'string' ? p : (p.id || p.userID || p.user_id);
                  return String(pid) === String(userID);
                });
                return resolve(found);
              }
              resolve(false);
            });
          });
        } catch (err: any) {
          // Propagate the fetch error to prevent false negative results during temporary outages or rate limits
          throw new Error(err.message || `Error verifying membership in "${group.threadName}"`);
        }
      } else {
        throw new Error("getThreadInfo is not available on the Messenger API");
      }

      if (isMember) {
        joinedGroupIDs.push(group.threadID);
      } else {
        missingGroupIDs.push(group.threadID);
      }
    }

    const totalRequiredCount = officialGroups.length;
    const totalJoinedCount = joinedGroupIDs.length;
    const hasAccess = totalRequiredCount > 0 && totalJoinedCount === totalRequiredCount;

    const existing = await (SharedAccessUserModel.findOne({ userID } as any) as any).lean();
    const authorizedThreadIDs = existing?.authorizedThreadIDs || [];
    const previousAccess = existing ? existing.hasAccess : false;

    const status: UserAccessStatus = {
      userID,
      userName: resolvedUserName,
      joinedGroupIDs,
      missingGroupIDs,
      totalJoinedCount,
      totalRequiredCount,
      hasAccess,
      authorizedThreadIDs,
      lastVerifiedAt: Date.now()
    };

    await SharedAccessUserModel.updateOne(
      { userID } as any,
      {
        $set: {
          userID,
          userName: resolvedUserName,
          joinedGroupIDs,
          missingGroupIDs,
          totalJoinedCount,
          totalRequiredCount,
          hasAccess,
          authorizedThreadIDs,
          lastVerifiedAt: Date.now()
        }
      },
      { upsert: true }
    );

    if (previousAccess && !hasAccess) {
      const leftGroup = officialGroups.find(g => missingGroupIDs.includes(g.threadID)) || officialGroups[0];
      await this.revokeAndLeaveAuthorizedGroups(userID, resolvedUserName, authorizedThreadIDs, leftGroup?.threadName || 'Official Group', api);
    }

    return status;
  }

  public async revokeAndLeaveAuthorizedGroups(
    userID: string,
    userName: string,
    authorizedThreadIDs: string[],
    officialGroupName: string,
    apiOverride?: any
  ): Promise<void> {
    const api = apiOverride || this.getFcaApi();
    if (!api) return;

    const prefix = '#';

    for (const threadID of authorizedThreadIDs) {
      try {
        const revocationMsg = `@${userName}, আপনি ${officialGroupName} থেকে বের হয়ে যাওয়ায় আপনার Shared Bot Access বাতিল হয়েছে। তাই ShiPu Ai এই গ্রুপ থেকে বিদায় নিচ্ছে। পুনরায় বট ব্যবহার করতে ${prefix}request কমান্ড ব্যবহার করুন। ShiPu Ai আপনাকে ${officialGroupName}-এ পুনরায় যুক্ত করবে। সব Official Access Group-এ আবার সদস্য হওয়ার পর আপনার Shared Bot Access স্বয়ংক্রিয়ভাবে পুনরায় চালু হবে। তারপর আবার যেকোনো গ্রুপে ShiPu Ai যোগ করতে পারবেন। ধন্যবাদ।`;

        await new Promise<void>((resolve) => {
          api.sendMessage(revocationMsg, threadID, (err: any) => {
            if (err) {
              messengerLogger.warn('GROUP', `Failed to send revocation message to thread ${threadID}: ${err.message || err}`);
            }
            resolve();
          });
        });

        if (api.removeUserFromGroup) {
          await new Promise<void>((resolve) => {
            const botUid = api.getCurrentUserID ? api.getCurrentUserID() : '';
            api.removeUserFromGroup(botUid || userID, threadID, (err: any) => {
              if (err) {
                messengerLogger.warn('GROUP', `Failed to leave thread ${threadID}: ${err.message || err}`);
              }
              resolve();
            });
          });
        }
      } catch (err) {
        console.error(`[SharedAccess] Error revoking thread ${threadID}:`, err);
      }
    }

    await SharedAccessUserModel.updateOne({ userID } as any, { $set: { authorizedThreadIDs: [], hasAccess: false } });
  }

  public async registerAuthorizedGroup(userID: string, threadID: string): Promise<void> {
    await connectDatabase();
    if (!userID || !threadID) return;
    try {
      await SharedAccessUserModel.updateOne(
        { userID } as any,
        { $addToSet: { authorizedThreadIDs: threadID } },
        { upsert: true }
      );
    } catch (err) {
      console.error('[SharedAccess] Failed to register authorized group:', err);
    }
  }

  public async getAllUsersStatus(): Promise<UserAccessStatus[]> {
    await connectDatabase();
    try {
      const records = await (SharedAccessUserModel.find({} as any) as any).lean();
      return (records || []).map((r: any) => ({
        userID: r.userID,
        userName: r.userName || `User_${r.userID}`,
        joinedGroupIDs: r.joinedGroupIDs || [],
        missingGroupIDs: r.missingGroupIDs || [],
        totalJoinedCount: r.totalJoinedCount || 0,
        totalRequiredCount: r.totalRequiredCount || 0,
        hasAccess: r.hasAccess === true,
        authorizedThreadIDs: r.authorizedThreadIDs || [],
        lastVerifiedAt: r.lastVerifiedAt || Date.now()
      }));
    } catch {
      return [];
    }
  }
}

export const sharedAccessService = SharedAccessService.getInstance();
(globalThis as any).sharedAccessService = sharedAccessService;

