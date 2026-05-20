/**
 * storage.js — Batch + comprehensive storage for Summarizer (standalone)
 * 
 * Batch summaries: chat_metadata.summarizer (ST-native, no change)
 * Comprehensive summaries: archive_summarizer.json via fileStore.js
 * 
 * Primary key is always chat filename — stable regardless of VM.
 */
import { chat_metadata, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, saveMetadataDebounced, getContext } from '../../../../extensions.js';
import { user_avatar } from '../../../../personas.js';
import { power_user } from '../../../../power-user.js';
import {
    getSummary,
    setSummary,
    updateSummary,
    deleteSummary,
} from './fileStore.js';

export const MODULE_NAME = 'summarizer';

const log = (...args) => console.log('[Summarizer]', ...args);
const logError = (...args) => console.error('[Summarizer]', ...args);

// Default settings
export const default_settings = {
    enabled: true,
    auto: false,

    // Batch configuration
    batchSize: 6,
    maxSummariesInContext: 10,

    // Message exclusion
    messageExclusionMode: 'batches',
    messageExclusionBatches: 4,
    messageExclusionMessages: 24,

    alwaysKeepFirstNBatches: 3,
    alwaysKeepLastNBatches: 3,

    // Summary lengths (for prompts)
    establishmentSummaryLength: '1 paragraph, 6-8 sentences',
    batchSummaryLength: '2-4 sentences',
    comprehensiveSummaryLength: '2 paragraphs, 6-8 sentences each',

    // Connection settings
    connectionProfile: '',

    // Auto-mode active message buffer
    // Never auto-summarize the last N messages (they're "active" in RP)
    autoBuffer: 2,

    // Display
    showSummariesInChat: true,
    summaryDisplayStyle: 'minimal',

    // Context looking back for batch generation
    lookBackBatches: 2,

    // Prompt injection (placement is hardcoded in promptInjection.js)
    prompt: {
        includeInPrompts: true,
    },
};

/**
 * Calculate dynamic comprehensive summary length based on story size
 */
export function getDynamicComprehensiveLength() {
    const batches = getBatches().filter(b => !b.dirty && b.summary);
    const batchCount = batches.length;

    if (batchCount < 10) return '1 paragraph, 6-8 sentences';
    if (batchCount <= 20) return '2 paragraphs, 6-8 sentences each';
    if (batchCount <= 30) return '3 paragraphs, 6-8 sentences each';
    return '3-4 paragraphs, 6-8 sentences each';
}

/**
 * Get comprehensive summary length description for UI display
 */
export function getComprehensiveLengthDescription() {
    const batches = getBatches().filter(b => !b.dirty && b.summary);
    const batchCount = batches.length;

    if (batchCount < 10) return '1 paragraph (short story)';
    if (batchCount <= 20) return '2 paragraphs (medium story)';
    return '3 paragraphs (long story)';
}

/**
 * Get current chat filename
 */
function getCurrentChatFilename() {
    const context = getContext();
    return context.chat_metadata?.file_name || `${context.chatId}.jsonl`;
}

/**
 * Get current character and persona metadata for comprehensive summaries
 */
export function getCurrentChatMetadata() {
    const context = getContext();

    // Get current character
    let characterMeta = null;
    const character = context.characters?.[context.characterId];

    if (character) {
        const allChars = context.characters.filter(c => c.name && c.avatar);
        const nameCounts = {};
        allChars.forEach(c => {
            nameCounts[c.name] = (nameCounts[c.name] || 0) + 1;
        });

        characterMeta = {
            name: character.name,
            avatar: character.avatar,
            displayName: nameCounts[character.name] > 1
                ? `${character.name} (${character.avatar})`
                : character.name,
        };
    }

    // Get current persona
    let personaMeta = null;

    if (user_avatar) {
        const personaName = power_user.personas?.[user_avatar] || user_avatar;
        const personaTitle = power_user.persona_descriptions?.[user_avatar]?.title || '';

        personaMeta = {
            name: personaName,
            avatar: user_avatar,
            title: personaTitle,
            displayName: personaTitle ? `${personaName} (${personaTitle})` : personaName,
        };
    }

    return {
        character: characterMeta,
        persona: personaMeta,
        chatCreated: context.chat_metadata?.create_date || Date.now(),
    };
}

// ============================================================
// Extension settings (global, not per-chat)
// ============================================================

/**
 * Initialize extension settings
 */
export function initSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = structuredClone(default_settings);
    } else {
        // Merge with defaults to add any new properties
        const merged = Object.assign(structuredClone(default_settings), extension_settings[MODULE_NAME]);
        // Deep-merge the prompt sub-object
        merged.prompt = Object.assign(
            structuredClone(default_settings.prompt),
            extension_settings[MODULE_NAME].prompt || {},
        );
        extension_settings[MODULE_NAME] = merged;
    }

    // One-time fallback: read from VM settings if they exist and ours don't
    const vmSettings = extension_settings['verseManager']?.summarizer;
    if (vmSettings && !extension_settings[MODULE_NAME]._migratedFromVM) {
        const promptKeys = ['includeInPrompts', 'promptRole', 'injectionPosition', 'injectionDepth', 'injectionOrder', 'placementAnchor', 'placementPosition'];
        for (const key of promptKeys) {
            if (vmSettings[key] !== undefined && extension_settings[MODULE_NAME].prompt[key] === default_settings.prompt[key]) {
                extension_settings[MODULE_NAME].prompt[key] = vmSettings[key];
            }
        }
        extension_settings[MODULE_NAME]._migratedFromVM = true;
        log('Migrated prompt placement settings from VerseManager');
    }

    saveSettingsDebounced();
}

/**
 * Get a setting value
 */
export function getSetting(key) {
    return extension_settings[MODULE_NAME]?.[key] ?? default_settings[key];
}

/**
 * Set a setting value
 */
export function setSetting(key, value) {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }
    extension_settings[MODULE_NAME][key] = value;
    saveSettingsDebounced();
}

/**
 * Get prompt placement settings
 */
export function getPromptSettings() {
    return extension_settings[MODULE_NAME]?.prompt ?? default_settings.prompt;
}

/**
 * Set a prompt placement setting
 */
export function setPromptSetting(key, value) {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    if (!extension_settings[MODULE_NAME].prompt) extension_settings[MODULE_NAME].prompt = {};
    extension_settings[MODULE_NAME].prompt[key] = value;
    saveSettingsDebounced();
}

// ============================================================
// Chat metadata (per-chat, batch data)
// ============================================================

function initChatMetadata() {
    // Guard: don't write metadata if no chat is loaded yet
    if (!chat_metadata || !getContext()?.chatId) return;

    if (!chat_metadata[MODULE_NAME]) {
        chat_metadata[MODULE_NAME] = {
            enabled: true,
            batches: [],
            comprehensive: null,
            rotationOffset: 0,
            contextArchives: {
                assigned: [],
                enabled: true,
            },
        };
        saveMetadataDebounced();
    }
    if (chat_metadata[MODULE_NAME].rotationOffset === undefined) {
        chat_metadata[MODULE_NAME].rotationOffset = 0;
    }
    // Backfill contextArchives for chats created before this feature
    if (!chat_metadata[MODULE_NAME].contextArchives) {
        chat_metadata[MODULE_NAME].contextArchives = {
            assigned: [],
            enabled: true,
        };
    }
}

export function getChatMetadata() {
    if (!chat_metadata || !getContext()?.chatId) return { enabled: false, batches: [], comprehensive: null, rotationOffset: 0 };
    initChatMetadata();
    return chat_metadata[MODULE_NAME];
}

export function isEnabled() {
    if (!chat_metadata || !getContext()?.chatId) return false;
    initChatMetadata();
    return chat_metadata[MODULE_NAME].enabled;
}

export function toggleEnabled(state = null) {
    if (!chat_metadata || !getContext()?.chatId) return false;
    initChatMetadata();
    if (state === null) {
        chat_metadata[MODULE_NAME].enabled = !chat_metadata[MODULE_NAME].enabled;
    } else {
        chat_metadata[MODULE_NAME].enabled = state;
    }
    saveMetadataDebounced();
    return chat_metadata[MODULE_NAME].enabled;
}

// ============================================================
// Batch CRUD (unchanged — lives in chat_metadata)
// ============================================================

export function getBatches() {
    if (!chat_metadata || !getContext()?.chatId) return [];
    initChatMetadata();
    return chat_metadata[MODULE_NAME].batches || [];
}

export function getBatch(batchId) {
    return getBatches().find(b => b.id === batchId);
}

export function addBatch(batch) {
    initChatMetadata();
    const batches = chat_metadata[MODULE_NAME].batches;

    if (!batch.id) batch.id = `batch_${batches.length}`;

    const newBatch = {
        id: batch.id,
        startIndex: batch.startIndex,
        endIndex: batch.endIndex,
        summary: batch.summary || '',
        quotes: batch.quotes || [],
        type: batch.type || 'regular',
        edited: batch.edited || false,
        dirty: batch.dirty || false,
        generatedAt: batch.generatedAt || Date.now(),
        lookBackBatches: batch.lookBackBatches || [],
    };

    batches.push(newBatch);
    saveMetadataDebounced();
    return newBatch;
}

export function updateBatch(batchId, updates) {
    initChatMetadata();
    const batches = chat_metadata[MODULE_NAME].batches;
    const index = batches.findIndex(b => b.id === batchId);
    if (index === -1) {
        logError(`Batch ${batchId} not found`);
        return null;
    }
    batches[index] = { ...batches[index], ...updates };
    saveMetadataDebounced();
    return batches[index];
}

export function deleteBatch(batchId) {
    initChatMetadata();
    const batches = chat_metadata[MODULE_NAME].batches;
    const index = batches.findIndex(b => b.id === batchId);
    if (index === -1) return false;
    batches.splice(index, 1);
    saveMetadataDebounced();
    return true;
}

export function clearAllBatches() {
    initChatMetadata();
    chat_metadata[MODULE_NAME].batches = [];
    saveMetadataDebounced();
}

export function markBatchDirty(batchId) {
    return updateBatch(batchId, { dirty: true });
}

export function markBatchRangeDirty(startIndex, endIndex) {
    const batches = getBatches();
    let marked = 0;
    batches.forEach(batch => {
        if (batch.endIndex >= startIndex && batch.startIndex <= endIndex) {
            markBatchDirty(batch.id);
            marked++;
        }
    });
    return marked;
}

// ============================================================
// Comprehensive summary (now uses own fileStore)
// ============================================================

/**
 * Get the comprehensive summary for the current chat
 */
export async function getComprehensiveSummary() {
    const chatFilename = getCurrentChatFilename();

    try {
        const data = await getSummary(chatFilename);
        if (!data) return null;

        return {
            text: data.text || '',
            quotes: data.quotes || [],
            metadata: data.metadata || null,
            lastGenerated: data.lastGenerated || Date.now(),
            edited: data.edited || false,
            basedOnBatches: data.basedOnBatches || [],
        };
    } catch (error) {
        logError('Failed to load comprehensive summary:', error);
        return null;
    }
}

/**
 * Set the comprehensive summary for the current chat
 */
export async function setComprehensiveSummary(summaryData) {
    const chatFilename = getCurrentChatFilename();
    if (!chatFilename) {
        logError('No chat filename found, cannot save comprehensive summary');
        return null;
    }

    const summaryText = typeof summaryData === 'string' ? summaryData : summaryData.text;
    const quotes = typeof summaryData === 'object' && summaryData.quotes ? summaryData.quotes : [];

    const summaryObject = {
        text: summaryText,
        quotes,
        metadata: summaryData.metadata || null,
        lastGenerated: Date.now(),
        edited: false,
        basedOnBatches: getBatches().map(b => b.id),
        // Verse/storyline tags — null when standalone, set by VM via API
        verse: null,
        storyline: null,
    };

    try {
        await setSummary(chatFilename, summaryObject);
        log('Comprehensive summary saved successfully');
        return summaryObject;
    } catch (error) {
        logError('Failed to save comprehensive summary:', error);
        throw error;
    }
}

/**
 * Update the comprehensive summary (partial update)
 */
export async function updateComprehensiveSummary(updates) {
    const chatFilename = getCurrentChatFilename();

    try {
        const result = await updateSummary(chatFilename, updates);
        if (result) log('Comprehensive summary updated');
        return result;
    } catch (error) {
        logError('Failed to update comprehensive summary:', error);
        return null;
    }
}

/**
 * Clear the comprehensive summary for the current chat
 */
export async function clearComprehensiveSummary() {
    const chatFilename = getCurrentChatFilename();
    try {
        await deleteSummary(chatFilename);
        log('Comprehensive summary cleared');
    } catch (error) {
        logError('Failed to clear comprehensive summary:', error);
    }
}

/**
 * Full reset — clear everything for the current chat
 */
export function fullReset() {
    initChatMetadata();
    chat_metadata[MODULE_NAME] = {
        enabled: true,
        batches: [],
        comprehensive: null,
        rotationOffset: 0,
    };
    saveMetadataDebounced();

    // Also clear the file-based comprehensive summary
    clearComprehensiveSummary().catch(e => logError('Failed to clear comprehensive on full reset:', e));
}

// ============================================================
// Batch selection + injection helpers (unchanged logic)
// ============================================================

export function getUnprocessedBatches(chatLength) {
    const batches = getBatches();
    const batchSize = getSetting('batchSize');
    const completeBatches = Math.floor(chatLength / batchSize);
    const unprocessed = [];

    for (let i = 0; i < completeBatches; i++) {
        const startIndex = i * batchSize;
        const endIndex = startIndex + batchSize - 1;
        const existing = batches.find(b => b.startIndex === startIndex && b.endIndex === endIndex);
        if (!existing || existing.dirty) {
            unprocessed.push({
                index: i,
                startIndex,
                endIndex,
                type: i === 0 ? 'establishment' : 'regular',
                existing: existing || null,
            });
        }
    }

    return unprocessed;
}

export function incrementRotationOffset() {
    initChatMetadata();
    chat_metadata[MODULE_NAME].rotationOffset =
        (chat_metadata[MODULE_NAME].rotationOffset || 0) + 1;
    saveMetadataDebounced();
}

function getRotationOffset() {
    initChatMetadata();
    return chat_metadata[MODULE_NAME].rotationOffset || 0;
}

export function getBatchesToInject(chatLength) {
    const batches = getBatches();
    const maxSummaries = getSetting('maxSummariesInContext');
    const alwaysFirst = getSetting('alwaysKeepFirstNBatches');
    const alwaysLast = getSetting('alwaysKeepLastNBatches');

    // Sort chronologically so "first N" / "last N" are actually earliest / latest
    const validBatches = batches
        .filter(b => !b.dirty && b.summary)
        .sort((a, b) => a.startIndex - b.startIndex);

    if (validBatches.length <= maxSummaries) return validBatches;

    const firstN = validBatches.slice(0, Math.min(alwaysFirst, validBatches.length));
    const lastN = validBatches.slice(-Math.min(alwaysLast, validBatches.length));
    const remaining = maxSummaries - (firstN.length + lastN.length);

    if (remaining <= 0) return [...firstN, ...lastN];

    const middleStart = firstN.length;
    const middleEnd = validBatches.length - lastN.length;
    const middleBatches = validBatches.slice(middleStart, middleEnd);

    if (middleBatches.length === 0) return [...firstN, ...lastN];

    const offset = getRotationOffset();
    const selected = [];
    const step = Math.max(1, Math.floor(middleBatches.length / remaining));

    for (let i = 0; i < remaining && i < middleBatches.length; i++) {
        const index = ((i * step) + offset) % middleBatches.length;
        selected.push(middleBatches[index]);
    }

    selected.sort((a, b) => a.startIndex - b.startIndex);
    return [...firstN, ...selected, ...lastN];
}

export function getMessageExclusionCount(chatLength) {
    const mode = getSetting('messageExclusionMode');
    const batchSize = getSetting('batchSize');
    const threshold = mode === 'batches'
        ? getSetting('messageExclusionBatches') * batchSize
        : getSetting('messageExclusionMessages');

    // Don't exclude anything until chat reaches the threshold
    if (chatLength < threshold) return 0;

    // Only exclude messages that are actually covered by summarized batches
    const summarized = getBatches().filter(b => b.summary && !b.dirty);
    if (summarized.length === 0) return 0;

    // Sort by startIndex and find contiguous coverage from the start of chat
    summarized.sort((a, b) => a.startIndex - b.startIndex);
    let coveredUpTo = 0;
    for (const batch of summarized) {
        if (batch.startIndex <= coveredUpTo) {
            coveredUpTo = Math.max(coveredUpTo, batch.endIndex + 1);
        } else {
            break; // gap — stop here, don't skip unsummarized messages
        }
    }

    if (coveredUpTo === 0) return 0;

    // Always keep at least the last 10 messages, even if they've been batched
    const MIN_KEEP = 10;
    const maxExclude = Math.max(0, chatLength - MIN_KEEP);
    const excludeCount = Math.min(coveredUpTo, maxExclude);

    log(`Message exclusion: chat=${chatLength}, threshold=${threshold}, summarized covers 0–${coveredUpTo - 1}, excluding=${excludeCount}, keeping=${chatLength - excludeCount}`);
    return excludeCount;
}

export function shouldExcludeMessage(messageIndex, chatLength) {
    const excludeCount = getMessageExclusionCount(chatLength);
    if (excludeCount === 0) return false;
    return messageIndex < excludeCount;
}

export function getMessageBatchIndex(messageIndex) {
    const batchSize = getSetting('batchSize');
    return Math.floor(messageIndex / batchSize);
}
