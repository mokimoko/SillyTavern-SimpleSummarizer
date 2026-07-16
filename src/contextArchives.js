/**
 * contextArchives.js — Context Archives for Summarizer
 *
 * Assign comprehensive summaries from prior chats to inject into the current chat.
 * Pool of summaries from archive_summarizer.json, optionally filtered by character.
 * Three token overflow strategies: priority, balanced, contextWeighted.
 */
import { chat_metadata, chat, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, getContext, saveMetadataDebounced } from '../../../../extensions.js';
import { getStore, getSummary } from './fileStore.js';
import { isEnabled, getBatches, MODULE_NAME, getSetting, getChatMetadata } from './storage.js';

// ============================================================
// Default config
// ============================================================

export const defaultContextArchivesConfig = {
    maxTokens: 2000,
    overflowStrategy: 'priority', // 'priority' | 'balanced' | 'contextWeighted'
    placement: {
        includeInPrompts: false,
        // Position/depth/order hardcoded in promptInjection.js
    },
};

// ============================================================
// Global config (extension_settings)
// ============================================================

export function getConfig() {
    if (!extension_settings[MODULE_NAME]) extension_settings[MODULE_NAME] = {};
    if (!extension_settings[MODULE_NAME].contextArchivesConfig) {
        extension_settings[MODULE_NAME].contextArchivesConfig = structuredClone(defaultContextArchivesConfig);
    }
    return extension_settings[MODULE_NAME].contextArchivesConfig;
}

export function setConfig(key, value) {
    const config = getConfig();
    config[key] = value;
    saveSettingsDebounced();
}

export function getPlacementConfig() {
    const config = getConfig();
    if (!config.placement) config.placement = structuredClone(defaultContextArchivesConfig.placement);
    return config.placement;
}

export function setPlacementConfig(key, value) {
    const config = getConfig();
    if (!config.placement) config.placement = {};
    config.placement[key] = value;
    saveSettingsDebounced();
}

// ============================================================
// Per-chat assignments (chat_metadata)
// ============================================================

function ensureChatMetadata() {
    if (!chat_metadata || !getContext()?.chatId) return null;
    // Call getChatMetadata to ensure storage.js has properly initialized chat_metadata[MODULE_NAME]
    const meta = getChatMetadata();
    if (!meta) return null;
    if (!chat_metadata[MODULE_NAME].contextArchives) {
        chat_metadata[MODULE_NAME].contextArchives = {
            assigned: [],
            enabled: true,
        };
    }
    return chat_metadata[MODULE_NAME].contextArchives;
}

export function getAssignedArchives() {
    const ca = ensureChatMetadata();
    return ca?.assigned || [];
}

export function isContextArchivesEnabled() {
    const ca = ensureChatMetadata();
    return ca?.enabled ?? true;
}

export function setContextArchivesEnabled(enabled) {
    const ca = ensureChatMetadata();
    if (!ca) return;
    ca.enabled = enabled;
    saveMetadataDebounced();
}

export function assignArchive(chatFilename, label) {
    const ca = ensureChatMetadata();
    if (!ca) return false;

    // Avoid duplicates
    if (ca.assigned.some(a => a.chatFilename === chatFilename)) {
        return false;
    }

    ca.assigned.push({ chatFilename, label });
    saveMetadataDebounced();
    return true;
}

export function removeArchive(chatFilename) {
    const ca = ensureChatMetadata();
    if (!ca) return false;

    const idx = ca.assigned.findIndex(a => a.chatFilename === chatFilename);
    if (idx === -1) return false;

    ca.assigned.splice(idx, 1);
    saveMetadataDebounced();
    return true;
}

export function moveArchive(chatFilename, direction) {
    const ca = ensureChatMetadata();
    if (!ca) return false;

    const idx = ca.assigned.findIndex(a => a.chatFilename === chatFilename);
    if (idx === -1) return false;

    const newIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (newIdx < 0 || newIdx >= ca.assigned.length) return false;

    const temp = ca.assigned[idx];
    ca.assigned[idx] = ca.assigned[newIdx];
    ca.assigned[newIdx] = temp;
    saveMetadataDebounced();
    return true;
}

// ============================================================
// Pool — available summaries
// ============================================================

/**
 * Get the pool of available comprehensive summaries for assignment.
 * @param {Object} options
 * @param {string} [options.characterFilter] - Filter to this character name
 * @returns {Promise<Array<{chatFilename, label, entry}>>}
 */
export async function getArchivePool(options = {}) {
    const store = await getStore();
    if (!store?.summaries) return [];

    const context = getContext();
    const currentChatFilename = context.chat_metadata?.file_name || `${context.chatId}.jsonl`;

    const pool = [];

    for (const [chatFilename, entry] of Object.entries(store.summaries)) {
        if (!entry?.text) continue;

        // Apply filters
        if (options.characterFilter) {
            const charMeta = entry.metadata?.character;
            if (charMeta?.isGroup) {
                // Group: match if the filter name appears in any member
                const memberNames = charMeta.members?.map(m => m.name) || [];
                if (!memberNames.includes(options.characterFilter)) continue;
            } else {
                // 1-on-1: original check
                if (charMeta?.name !== options.characterFilter) continue;
            }
        }

        const isCurrent = chatFilename === currentChatFilename;
        const label = formatArchiveLabel(chatFilename, entry, isCurrent);

        pool.push({ chatFilename, label, entry, isCurrent });
    }

    // Sort: current chat first, then by lastGenerated descending
    pool.sort((a, b) => {
        if (a.isCurrent && !b.isCurrent) return -1;
        if (!a.isCurrent && b.isCurrent) return 1;
        return (b.entry.lastGenerated || 0) - (a.entry.lastGenerated || 0);
    });

    return pool;
}

// ============================================================
// Label formatting
// ============================================================

/**
 * Format a display label for a comprehensive summary entry.
 * Format: "CharName — ChatFilename — ShortDate" (1-on-1)
 * Format: "GroupName (Alice, Bob) — ChatFilename — ShortDate" (group)
 */
export function formatArchiveLabel(chatFilename, entry, isCurrent = false) {
    const charMeta = entry.metadata?.character;

    // Character/group name
    let charName;
    if (charMeta?.isGroup) {
        const memberList = charMeta.members?.map(m => m.name).join(', ') || '';
        charName = charMeta.groupName
            ? `${charMeta.groupName} (${memberList})`
            : memberList || 'Group';
    } else {
        charName = charMeta?.displayName
            || charMeta?.name
            || parseCharNameFromFilename(chatFilename)
            || 'Unknown';
    }

    // Chat name: clean filename (strip .jsonl, shorten if needed)
    const chatName = chatFilename.replace(/\.jsonl$/i, '');

    // Short date from lastGenerated
    const shortDate = entry.lastGenerated
        ? formatShortDate(entry.lastGenerated)
        : 'Unknown date';

    const suffix = isCurrent ? ' (this chat)' : '';
    return `${charName} — ${chatName} — ${shortDate}${suffix}`;
}

function parseCharNameFromFilename(filename) {
    // ST filenames: "CharName - Date.jsonl"
    const match = filename.match(/^(.+?)\s*-\s*\d/);
    return match ? match[1].trim() : null;
}

function formatShortDate(timestamp) {
    try {
        const d = new Date(timestamp);
        const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
        return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
    } catch {
        return 'Unknown date';
    }
}

// ============================================================
// Token estimation
// ============================================================

function estimateTokens(text) {
    return Math.ceil((text || '').length / 4);
}

// ============================================================
// Smart truncation (from chatroom pattern)
// ============================================================

function smartTruncate(text, maxChars) {
    if (!text || text.length <= maxChars) return text;

    const paragraphs = text.split(/\n\n+/).filter(p => p.trim());

    if (paragraphs.length <= 2) {
        return text.substring(0, maxChars - 3) + '...';
    }

    const first = paragraphs[0];
    const last = paragraphs[paragraphs.length - 1];

    if (first.length + last.length + 10 > maxChars) {
        const halfMax = Math.floor(maxChars / 2) - 10;
        return first.substring(0, halfMax) + '\n\n[...]\n\n' + last.substring(last.length - halfMax);
    }

    return first + '\n\n[...]\n\n' + last;
}

// ============================================================
// Token strategies
// ============================================================

/**
 * Strategy 1: Priority Order
 * Include summaries in order until budget exhausted.
 */
function applyPriorityStrategy(summaries, maxTokens) {
    const result = [];
    let tokensUsed = 0;

    for (const item of summaries) {
        const tokens = estimateTokens(item.text);
        if (tokensUsed + tokens > maxTokens && result.length > 0) break;

        // If first item and exceeds budget, truncate it
        if (tokensUsed + tokens > maxTokens && result.length === 0) {
            const maxChars = maxTokens * 4;
            result.push({ ...item, text: smartTruncate(item.text, maxChars) });
            break;
        }

        result.push(item);
        tokensUsed += tokens;
    }

    return result;
}

/**
 * Strategy 2: Balanced Truncation
 * Distribute budget evenly, truncate each to fit.
 */
function applyBalancedStrategy(summaries, maxTokens) {
    if (summaries.length === 0) return [];

    const perBudget = Math.floor(maxTokens / summaries.length);
    const perBudgetChars = perBudget * 4;

    return summaries.map(item => {
        const tokens = estimateTokens(item.text);
        if (tokens <= perBudget) return item;
        return { ...item, text: smartTruncate(item.text, perBudgetChars) };
    });
}

/**
 * Strategy 3: Context-Weighted Extraction
 * Score paragraphs by keyword overlap with current context.
 */
function applyContextWeightedStrategy(summaries, maxTokens) {
    if (summaries.length === 0) return [];

    // Extract keywords from current chat context
    const keywords = extractContextKeywords();
    if (keywords.length === 0) {
        // Fallback to balanced if no context
        return applyBalancedStrategy(summaries, maxTokens);
    }

    // Split each summary into scored paragraphs
    const allParagraphs = [];

    for (let si = 0; si < summaries.length; si++) {
        const item = summaries[si];
        const paragraphs = (item.text || '').split(/\n\n+/).filter(p => p.trim());

        for (let pi = 0; pi < paragraphs.length; pi++) {
            const para = paragraphs[pi];
            const score = scoreParagraph(para, keywords);
            allParagraphs.push({
                summaryIndex: si,
                paragraphIndex: pi,
                text: para,
                score,
                tokens: estimateTokens(para),
                label: item.label,
            });
        }
    }

    // Sort by score descending (secondary: original order)
    allParagraphs.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (a.summaryIndex !== b.summaryIndex) return a.summaryIndex - b.summaryIndex;
        return a.paragraphIndex - b.paragraphIndex;
    });

    // Greedily include top paragraphs until budget exhausted
    let tokensUsed = 0;
    const selected = [];

    for (const para of allParagraphs) {
        if (tokensUsed + para.tokens > maxTokens && selected.length > 0) continue;
        selected.push(para);
        tokensUsed += para.tokens;
        if (tokensUsed >= maxTokens) break;
    }

    // Regroup by source summary, maintaining within-summary paragraph order
    const grouped = {};
    for (const para of selected) {
        if (!grouped[para.summaryIndex]) {
            grouped[para.summaryIndex] = {
                label: para.label,
                paragraphs: [],
            };
        }
        grouped[para.summaryIndex].paragraphs.push(para);
    }

    // Sort paragraphs within each group by original order
    const result = [];
    for (const si of Object.keys(grouped).sort((a, b) => Number(a) - Number(b))) {
        const group = grouped[si];
        group.paragraphs.sort((a, b) => a.paragraphIndex - b.paragraphIndex);
        result.push({
            ...summaries[Number(si)],
            text: group.paragraphs.map(p => p.text).join('\n\n'),
        });
    }

    return result;
}

/**
 * Extract context keywords from current chat (last 20 messages + batch summaries).
 * Returns top 50 keywords by frequency, excluding stopwords.
 */
function extractContextKeywords() {
    const textParts = [];

    // Recent messages
    if (chat && chat.length > 0) {
        const recent = chat.slice(-20);
        for (const msg of recent) {
            if (msg.mes) textParts.push(msg.mes);
        }
    }

    // Current batch summaries
    const batches = getBatches().filter(b => !b.dirty && b.summary);
    for (const batch of batches) {
        textParts.push(batch.summary);
    }

    if (textParts.length === 0) return [];

    const combined = textParts.join(' ').toLowerCase();
    const words = combined.match(/\b[a-z]{3,}\b/g) || [];

    const stopwords = new Set([
        'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
        'her', 'was', 'one', 'our', 'out', 'has', 'his', 'how', 'its', 'let',
        'may', 'new', 'now', 'old', 'see', 'way', 'who', 'did', 'get', 'got',
        'him', 'hit', 'too', 'use', 'she', 'that', 'with', 'have', 'this',
        'will', 'your', 'from', 'they', 'been', 'said', 'each', 'make', 'like',
        'long', 'look', 'many', 'some', 'them', 'then', 'what', 'when', 'were',
        'into', 'just', 'over', 'such', 'take', 'than', 'very', 'about', 'after',
        'being', 'could', 'would', 'their', 'there', 'these', 'which', 'other',
        'still', 'those', 'where', 'while', 'should', 'back', 'before', 'also',
        'down', 'even', 'first', 'much', 'only', 'most', 'more', 'through',
        'well', 'know', 'just', 'need', 'tell', 'think', 'want', 'does', 'going',
        'really', 'something', 'anything', 'nothing', 'everything', 'everyone',
        'another', 'around', 'always', 'never', 'because', 'between', 'without',
        'though', 'again', 'until', 'already', 'enough', 'away',
    ]);

    const freq = {};
    for (const word of words) {
        if (stopwords.has(word)) continue;
        freq[word] = (freq[word] || 0) + 1;
    }

    return Object.entries(freq)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 50)
        .map(([word]) => word);
}

/**
 * Score a paragraph by keyword overlap.
 */
function scoreParagraph(paragraph, keywords) {
    const lower = paragraph.toLowerCase();
    let score = 0;
    for (const keyword of keywords) {
        if (lower.includes(keyword)) score++;
    }
    return score;
}

// ============================================================
// Content builder (for prompt injection)
// ============================================================

/**
 * Build the injection content from assigned context archives.
 * Applies the selected token overflow strategy.
 */
export async function buildContextArchivesContent() {
    const ca = ensureChatMetadata();
    if (!ca?.enabled) return '';
    if (!ca.assigned || ca.assigned.length === 0) return '';

    const config = getConfig();
    if (config.placement?.includeInPrompts === false) return '';

    // Load summaries for each assigned archive
    const summaries = [];
    for (const assignment of ca.assigned) {
        const entry = await getSummary(assignment.chatFilename);
        if (!entry?.text) continue;

        summaries.push({
            chatFilename: assignment.chatFilename,
            label: assignment.label,
            text: entry.text,
        });
    }

    if (summaries.length === 0) return '';

    // Apply token strategy
    const maxTokens = config.maxTokens || 2000;
    const strategy = config.overflowStrategy || 'priority';

    let processed;
    switch (strategy) {
        case 'balanced':
            processed = applyBalancedStrategy(summaries, maxTokens);
            break;
        case 'contextWeighted':
            processed = applyContextWeightedStrategy(summaries, maxTokens);
            break;
        case 'priority':
        default:
            processed = applyPriorityStrategy(summaries, maxTokens);
            break;
    }

    if (processed.length === 0) return '';

    // Format output
    const preamble = 'These summaries describe events from prior story sessions. Use as historical reference for understanding character history and relationships, not as templates for writing style.';

    const sections = processed.map(item => {
        // Extract short label for injection header
        const shortLabel = extractShortLabel(item.label);
        return `[Context: ${shortLabel}]\n${item.text}`;
    });

    return `<prior_story_context>\n${preamble}\n\n${sections.join('\n\n')}\n</prior_story_context>`;
}

/**
 * Extract a shorter label for injection headers (strip chat filename portion).
 * Works for both 1-on-1 ("CharName — ShortDate") and group ("GroupName (members) — ShortDate").
 */
function extractShortLabel(label) {
    // Label format: "CharName — ChatFilename — ShortDate"
    // For injection, just use "CharName — ShortDate"
    const parts = label.split(' — ');
    if (parts.length >= 3) {
        return `${parts[0]} — ${parts[parts.length - 1].replace(' (this chat)', '')}`;
    }
    return label.replace(' (this chat)', '');
}
