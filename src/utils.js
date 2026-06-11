/**
 * utils.js — Shared utilities for Summarizer (standalone)
 * Profile switching with polling confirmation + group chat detection.
 */
import { getContext } from '../../../../extensions.js';

let profileSwitchInProgress = false;

// ============================================================
// Group chat detection
// ============================================================

/**
 * Check if the current chat is a group chat.
 * @returns {boolean}
 */
export function isGroupChat() {
    return !!getContext().groupId;
}

/**
 * Get group info for the current chat. Returns null if not a group chat.
 * @returns {{groupId: string, groupName: string, members: Array<{name: string, avatar: string}>, disabledMembers: string[]}|null}
 */
export function getGroupInfo() {
    const context = getContext();
    if (!context.groupId) return null;

    const group = context.groups?.find(g => g.id === context.groupId);
    if (!group || !Array.isArray(group.members)) return null;

    const members = group.members
        .filter(avatar => !group.disabled_members?.includes(avatar))
        .map(avatar => {
            const char = context.characters?.find(c => c.avatar === avatar);
            return char ? { name: char.name, avatar: char.avatar } : null;
        })
        .filter(Boolean);

    return {
        groupId: group.id,
        groupName: group.name,
        members,
        disabledMembers: group.disabled_members || [],
    };
}

/**
 * Switch to a profile with polling confirmation
 */
export async function switchToProfileWithConfirmation(profileId, maxWaitMs = 10000) {
    let waitAttempts = 0;
    while (profileSwitchInProgress && waitAttempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 500));
        waitAttempts++;
    }

    if (profileSwitchInProgress) {
        return { success: false, originalProfile: null, error: 'Another profile switch is in progress' };
    }

    profileSwitchInProgress = true;

    const { getContext } = await import('../../../../extensions.js');
    const context = getContext();

    try {
        const profilesResult = await context.executeSlashCommandsWithOptions('/profile');
        const originalProfile = profilesResult?.pipe?.trim();

        if (originalProfile === profileId) {
            return { success: true, originalProfile };
        }

        await context.executeSlashCommandsWithOptions(`/profile ${profileId}`);

        const maxAttempts = Math.floor(maxWaitMs / 500);
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const checkResult = await context.executeSlashCommandsWithOptions('/profile');
            const currentProfile = checkResult?.pipe?.trim();
            if (currentProfile === profileId) {
                return { success: true, originalProfile };
            }
        }

        throw new Error(`Profile switch to "${profileId}" timed out after ${maxWaitMs}ms`);
    } catch (error) {
        return { success: false, originalProfile: null, error: error.message };
    } finally {
        profileSwitchInProgress = false;
    }
}

/**
 * Restore to a previous profile with polling confirmation
 */
export async function restoreProfileWithConfirmation(profileId, maxWaitMs = 5000) {
    if (!profileId) {
        return { success: false, error: 'No profile ID provided' };
    }

    let waitAttempts = 0;
    while (profileSwitchInProgress && waitAttempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 500));
        waitAttempts++;
    }

    if (profileSwitchInProgress) {
        return { success: false, error: 'Another profile switch is in progress' };
    }

    profileSwitchInProgress = true;

    const { getContext } = await import('../../../../extensions.js');
    const context = getContext();

    try {
        await context.executeSlashCommandsWithOptions(`/profile ${profileId}`);

        const maxAttempts = Math.floor(maxWaitMs / 500);
        for (let i = 0; i < maxAttempts; i++) {
            await new Promise(resolve => setTimeout(resolve, 500));
            const checkResult = await context.executeSlashCommandsWithOptions('/profile');
            const currentProfile = checkResult?.pipe?.trim();
            if (currentProfile === profileId) {
                return { success: true };
            }
        }

        throw new Error(`Profile restore to "${profileId}" timed out after ${maxWaitMs}ms`);
    } catch (error) {
        return { success: false, error: error.message };
    } finally {
        profileSwitchInProgress = false;
    }
}
