/**
 * storage.js — Batch + comprehensive storage for Summarizer (standalone)
 * 
 * Batch summaries: chat_metadata.summarizer (ST-native, no change)
 * Comprehensive summaries: archive_summarizer.json via fileStore.js
 * 
 * Primary key is always chat filename.
 */
import { chat_metadata, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, saveMetadataDebounced, getContext } from '../../../../extensions.js';
import { user_avatar } from '../../../../personas.js';
import { power_user } from '../../../../power-user.js';
import { getGroupInfo } from './utils.js';
import {
    getSummary,
    setSummary,
    updateSummary,
    deleteSummary,
} from './fileStore.js';

export const MODULE_NAME = 'summarizer';

const logError = (...args) => console.error('[Summarizer]', ...args);

/**
 * Verbose logging helper. Only prints when the `debug` setting is enabled,
 * so normal operation (retries, fallbacks, parse warnings) stays quiet.
 * Reads the setting live so it responds to toggles without a reload.
 */
export const debugWarn = (...args) => {
    if (extension_settings[MODULE_NAME]?.debug) console.warn('[Summarizer]', ...args);
};

// Default settings
export const default_settings = {
    enabled: true,
    auto: false,

    // Verbose console logging (retries, fallbacks, parse warnings).
    // When false, only genuine errors reach the console.
    debug: false,

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
    establishmentSummaryLength: '6-10 concise factual sentences',
    batchSummaryLength: '3-6 concise factual sentences',
    comprehensiveSummaryLength: '12-18 concise factual sentences',

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

    if (batchCount < 10) return '8-12 sentences';
    if (batchCount <= 20) return '12-18 sentences';
    if (batchCount <= 30) return '18-24 sentences';
    return '24-32 sentences';
}

/**
 * Get comprehensive summary length description for UI display
 */
export function getComprehensiveLengthDescription() {
    const batches = getBatches().filter(b => !b.dirty && b.summary);
    const batchCount = batches.length;

    if (batchCount < 10) return '8-12 sentences (short story)';
    if (batchCount <= 20) return '12-18 sentences (medium story)';
    return '18-32 sentences (long story)';
}

/**
 * Get current chat filename
 */
function getCurrentChatFilename() {
    const context = getContext();
    return context.chat_metadata?.file_name || `${context.chatId}.jsonl`;
}

/**
 * Get current character and persona metadata for comprehensive summaries.
 * Group-aware: stores all members when in a group chat.
 */
export function getCurrentChatMetadata() {
    const context = getContext();
    const groupInfo = getGroupInfo();

    // Get character(s) metadata
    let characterMeta = null;

    if (groupInfo) {
        // Group mode: store all members as equal participants
        characterMeta = {
            isGroup: true,
            groupName: groupInfo.groupName,
            groupId: groupInfo.groupId,
            members: groupInfo.members.map(m => ({
                name: m.name,
                avatar: m.avatar,
            })),
        };
    } else {
        // 1-on-1 mode: existing single-character logic
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
        // Importance 1-10 (LLM-scored during summarization). Batches created
        // before this feature — or where the model omitted/garbled the tag —
        // have no score; selection treats a missing value as neutral 5. Stored
        // as null (not 5) so we can tell "unscored" from "genuinely scored 5",
        // e.g. to surface a regen hint in the UI later.
        importance: (typeof batch.importance === 'number') ? batch.importance : null,
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
// Pinned Quotes
// ============================================================

/**
 * Toggle the pinned state of a quote within a batch.
 * @param {string} batchId - The batch containing the quote
 * @param {number} quoteIndex - Index of the quote in the batch's quotes array
 * @returns {boolean|null} New pinned state, or null if not found
 */
export function toggleQuotePin(batchId, quoteIndex) {
    const batch = getBatch(batchId);
    if (!batch || !batch.quotes || quoteIndex < 0 || quoteIndex >= batch.quotes.length) return null;

    const quote = batch.quotes[quoteIndex];
    quote.pinned = !quote.pinned;
    updateBatch(batchId, { quotes: batch.quotes });
    return quote.pinned;
}

/**
 * Get all pinned quotes across all batches in the current chat.
 * Returns them with batch context for display and injection.
 * @returns {Array<{speaker: string, text: string, context: string, batchId: string, batchIndex: number, quoteIndex: number}>}
 */
export function getPinnedQuotes() {
    const batches = getBatches();
    const pinned = [];

    batches.forEach((batch, batchIdx) => {
        if (!batch.quotes) return;
        batch.quotes.forEach((quote, quoteIdx) => {
            if (quote.pinned) {
                pinned.push({
                    speaker: quote.speaker,
                    text: quote.text,
                    context: quote.context || '',
                    batchId: batch.id,
                    batchIndex: batchIdx,
                    quoteIndex: quoteIdx,
                    startIndex: batch.startIndex ?? 0,
                });
            }
        });
    });

    // Keep pinned quotes in chronological order even if the batches array
    // isn't strictly ordered (e.g. after regeneration). Sort by the batch's
    // message start index, then by quote position within the batch.
    pinned.sort((a, b) => a.startIndex - b.startIndex || a.quoteIndex - b.quoteIndex);

    return pinned;
}

/**
 * Count of pinned quotes in current chat.
 * @returns {number}
 */
export function getPinnedQuoteCount() {
    return getPinnedQuotes().length;
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
    };

    try {
        await setSummary(chatFilename, summaryObject);
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
    clearComprehensiveSummary().catch(() => {});
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

// Neutral importance for batches with no LLM score (pre-feature or garbled tag).
const NEUTRAL_IMPORTANCE = 5;

// Stopwords for the relevance signal — mirrors the RP-flavored stoplist Aether
// uses, plus pronouns/fillers that add noise to token overlap. Kept local so
// storage.js stays dependency-free.
const _REL_STOP = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'is', 'are',
    'was', 'were', 'be', 'been', 'it', 'its', 'with', 'for', 'as', 'that', 'this',
    'she', 'he', 'they', 'her', 'his', 'their', 'you', 'your', 'i', 'my', 'we', 'him',
    'them', 'had', 'has', 'have', 'not', 'no', 'so', 'if', 'then', 'than', 'from',
    'by', 'about', 'into', 'out', 'up', 'down', 'over', 'after', 'before', 'when',
    'while', 'who', 'what', 'which', 'there', 'here', 'him', 'said', 'says',
]);

function _relTokens(text) {
    const out = new Set();
    for (const m of String(text || '').toLowerCase().matchAll(/[a-z0-9']+/g)) {
        const t = m[0];
        if (t.length > 1 && !_REL_STOP.has(t)) out.add(t);
    }
    return out;
}

/**
 * IDF-weighted token overlap between a query and each candidate summary
 * (Aether's "_bm25ish", trimmed). Rare shared words count more than common
 * ones; returns a raw score per candidate (higher = more related to the query).
 * Pure and deterministic — no scale normalization needed, callers only rank.
 */
function _relevanceScores(queryText, candidates) {
    const q = _relTokens(queryText);
    if (q.size === 0 || candidates.length === 0) return candidates.map(() => 0);
    const docs = candidates.map(b => _relTokens(b.summary));
    const df = new Map();
    for (const d of docs) {
        for (const t of q) if (d.has(t)) df.set(t, (df.get(t) || 0) + 1);
    }
    const n = docs.length;
    return docs.map(d => {
        let s = 0;
        for (const t of q) if (d.has(t)) s += Math.log(1 + n / (1 + df.get(t)));
        return s;
    });
}

/**
 * Select which batch summaries to inject.
 *
 * First N (opening) and last N (immediate context) batches are always kept, as
 * before. The remaining "middle" pool — previously chosen by a blind rotating
 * stride — is now RANKED so the batches most worth showing win the limited slots:
 *   1. importance  (LLM-scored 1-10; unscored batches treated as neutral 5)
 *   2. relevance   (IDF token overlap with the current scene = last few messages)
 *   3. rotation    (the original offset stride, as a final tiebreaker so that
 *                   equally-unremarkable batches still cycle over time)
 *
 * Net effect: a pivotal batch (a reveal, a death) stops rotating out of context,
 * ties break toward whatever relates to what's happening right now, and when
 * every signal is flat the behavior degrades gracefully to the old rotation.
 *
 * @param {number} chatLength
 * @param {string} [queryText] recent-scene text for the relevance signal; when
 *        omitted, relevance contributes 0 and selection is importance-then-rotation.
 */
export function getBatchesToInject(chatLength, queryText = '') {
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
    if (middleBatches.length <= remaining) {
        // Everything in the middle fits — no need to rank, keep chronological.
        return [...firstN, ...middleBatches, ...lastN];
    }

    // Score the middle pool. Rotation is folded in as a tiny per-candidate
    // tiebreaker: the original stride pattern decides order only when importance
    // and relevance are identical, preserving the "cycle over time" behavior for
    // flat/unremarkable stretches without ever overriding a real signal.
    const offset = getRotationOffset();
    const rel = _relevanceScores(queryText, middleBatches);
    const scored = middleBatches.map((batch, i) => {
        const imp = (typeof batch.importance === 'number') ? batch.importance : NEUTRAL_IMPORTANCE;
        // Deterministic rotation phase in [0,1): batches whose position aligns
        // with the current offset sort slightly earlier this pass, next pass a
        // different set does. Scaled tiny so it never outweighs imp/rel.
        const rotationTie = ((i + offset) % middleBatches.length) / middleBatches.length;
        return { batch, imp, rel: rel[i], rotationTie, idx: i };
    });

    scored.sort((a, b) =>
        (b.imp - a.imp) ||               // 1. importance, high first
        (b.rel - a.rel) ||               // 2. relevance to current scene
        (a.rotationTie - b.rotationTie)  // 3. rotation stride, cycles the flat ones
    );

    // Advance rotation so the next injection cycles the flat-signal batches,
    // exactly as the old stride did.
    incrementRotationOffset();

    const selected = scored.slice(0, remaining).map(s => s.batch);
    selected.sort((a, b) => a.startIndex - b.startIndex);  // re-chronologize for display
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
