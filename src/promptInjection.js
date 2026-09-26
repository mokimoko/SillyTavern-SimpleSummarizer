/**
 * promptInjection.js — Prompt injection for Summarizer
 *
 * Simple, hardcoded placement using setExtensionPrompt (NOT Prompt Manager):
 *   - Batch summaries → IN_CHAT position, depth 9999, role SYSTEM
 *   - Context Archives → IN_CHAT position, depth 10000, role SYSTEM
 *   - Comprehensive summary of current chat → user places via {{comprehensive_summary}} macro
 */
import { getContext } from '../../../../extensions.js';
import {
    isEnabled,
    getSetting,
    getPromptSettings,
    getBatches,
    getBatchesToInject,
    getPinnedQuotes,
    getBatch,
    isBatchEligible,
    getCurrentMemoryAudience,
    getMemoryAudienceSignature,
} from './storage.js';
import { getBatchMemoryPolicy, KNOWLEDGE_MODES } from './memoryPolicy.js';
import {
    getCharacterMemoryKnowledge,
    isCharacterMemoryEligible,
    normalizeCharacterMemories,
} from './characterMemories.js';
import {
    buildContextArchivesContent,
    getPlacementConfig as getCAPlacement,
} from './contextArchives.js';

const PROMPT_IDENTIFIER = 'summarizer_batches';
const CA_PROMPT_IDENTIFIER = 'summarizer_context_archives';

// Hardcoded injection settings
// Position 1 = IN_CHAT (injected into message list at depth)
// High depth = before all chat messages (effectively "before chat history")
// Higher depth appears earlier in chat, so CA (10000) comes before batches (9999)
// Role 0 = SYSTEM (extension_prompt_roles.SYSTEM)
const INJECTION_POSITION = 1;
const BATCH_DEPTH = 9999;
const CA_DEPTH = 10000;
const INJECTION_ROLE = 0;

// Signature-based cache to avoid rebuilding when nothing changed
let lastContentSignature = null;
let lastContentResult = null;

/**
 * Build content signature to detect changes
 */
function getContentSignature() {
    const context = getContext();
    const chat = context.chat;
    const batches = getBatches();
    const batchSig = batches.map(b => {
        const characterMemories = normalizeCharacterMemories(b.characterMemories);
        const pinnedCount = (b.quotes?.filter(q => q.pinned)?.length || 0)
            + characterMemories.reduce((count, memory) => count + memory.quotes.filter(q => q.pinned).length, 0);
        const policy = getBatchMemoryPolicy(b);
        const raw = `${b.id}:${b.dirty}:${b.summary || ''}:p${pinnedCount}:i${b.importance ?? 'x'}:${JSON.stringify(policy)}:${JSON.stringify(characterMemories)}`;
        let hash = 5381;
        for (let i = 0; i < raw.length; i++) hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
        return (hash >>> 0).toString(36);
    }).join('|');
    // The relevance query is the recent scene; fold a cheap fingerprint of it in
    // so selection refreshes as the scene moves, not only when batches change.
    // Length alone collides across different same-length scenes, so use a fast
    // rolling char hash (djb2-ish) — enough to detect the scene actually changed.
    const q = getRecentSceneQuery();
    let querySig = 0;
    for (let i = 0; i < q.length; i++) querySig = ((querySig << 5) - querySig + q.charCodeAt(i)) | 0;
    return `${chat?.length || 0}:${batchSig}:${getSetting('maxSummariesInContext')}:${getSetting('alwaysKeepFirstNBatches')}:${getSetting('alwaysKeepLastNBatches')}:${getSetting('enableCharacterRestrictions')}:a${getMemoryAudienceSignature()}:q${querySig}`;
}

/**
 * Build the relevance query from the current scene: the most recent few
 * non-hidden messages, which is what the injected summaries should be
 * relevant *to*. Kept small (last 4, capped length) so token overlap reflects
 * the immediate moment rather than the whole tail. Mirrors generator.js's
 * hidden-message handling loosely — is_system messages are skipped so ghosted
 * lines and narrator scaffolding don't skew the query.
 */
export function getRecentSceneQuery() {
    const context = getContext();
    const chat = context.chat;
    if (!chat?.length) return '';
    const parts = [];
    for (let i = chat.length - 1; i >= 0 && parts.length < 4; i--) {
        const m = chat[i];
        if (!m || m.is_system || m.is_disabled) continue;
        if (typeof m.mes === 'string' && m.mes.trim()) parts.push(m.mes);
    }
    return parts.join(' ').slice(0, 2000);
}

/**
 * Build the prompt content from batch summaries
 */
function escapeXmlAttribute(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function resolveKnowledgeNames(source) {
    const context = getContext();
    const knowledge = source?.mode ? source : getBatchMemoryPolicy(source).knowledge;
    const names = [...knowledge.names];
    for (const avatar of knowledge.characters) {
        const stem = String(avatar).replace(/\.[^/.]+$/, '');
        const character = context.characters?.find(item =>
            item.avatar === avatar || String(item.avatar || '').replace(/\.[^/.]+$/, '') === stem,
        );
        names.push(character?.name || stem || avatar);
    }
    return [...new Set(names.map(name => String(name).trim()).filter(Boolean))];
}

function formatCharacterMemory(memory, label, quotes = memory.quotes || []) {
    let text = `${label} — limited knowledge:\n${memory.text}`;
    if (quotes.length > 0) {
        text += '\n' + quotes.map(quote => {
            let line = `  ${quote.speaker}: "${quote.text}"`;
            if (quote.context?.trim()) line += ` (${quote.context})`;
            return line;
        }).join('\n');
    }
    return text;
}

function formatMemory(batch, label, quotes = batch.quotes || []) {
    let text = `${label}:\n${batch.summary}`;
    if (quotes.length > 0) {
        text += '\n' + quotes.map(quote => {
            let line = `  ${quote.speaker}: "${quote.text}"`;
            if (quote.context?.trim()) line += ` (${quote.context})`;
            return line;
        }).join('\n');
    }
    return text;
}

function renderKnowledgeGroups(items) {
    const common = [];
    const narrator = [];
    const selected = new Map();

    for (const item of items) {
        const knowledge = item.knowledge || getBatchMemoryPolicy(item.batch).knowledge;
        if (knowledge.mode === KNOWLEDGE_MODES.NARRATOR) {
            narrator.push(item.text);
            continue;
        }
        if (knowledge.mode === KNOWLEDGE_MODES.SELECTED) {
            const names = resolveKnowledgeNames(knowledge).sort((a, b) => a.localeCompare(b));
            if (names.length === 0) {
                narrator.push(item.text);
                continue;
            }
            const key = names.join('\u241f');
            if (!selected.has(key)) selected.set(key, { names, memories: [] });
            selected.get(key).memories.push(item.text);
            continue;
        }
        common.push(item.text);
    }

    const sections = [];
    if (common.length > 0) {
        sections.push(`<common_memories>\n${common.join('\n\n')}\n</common_memories>`);
    }
    if (narrator.length > 0) {
        sections.push(`<narrator_only_memories>\nThese facts are known to the narrator, but characters must not act as though they know them unless the story establishes that knowledge.\n\n${narrator.join('\n\n')}\n</narrator_only_memories>`);
    }
    for (const { names, memories } of selected.values()) {
        const list = names.join(', ');
        sections.push(`<character_memories known_by="${escapeXmlAttribute(list)}">\nOnly ${list} may act as though they know these facts. The narrator may use them without revealing them improperly.\n\n${memories.join('\n\n')}\n</character_memories>`);
    }
    return sections.join('\n\n');
}

export function buildPromptContent() {
    if (!isEnabled()) return '';

    const context = getContext();
    const chat = context.chat;
    if (!chat?.length) return '';

    // Check cache
    const sig = getContentSignature();
    if (sig === lastContentSignature && lastContentResult !== null) {
        return lastContentResult;
    }

    // Relevance query = the current scene. getBatchesToInject ranks the middle
    // pool by importance, then relevance to this, then a stable chat-length
    // rotation so repeated renders do not mutate chat metadata.
    const queryText = getRecentSceneQuery();
    const batchesToInject = getBatchesToInject(chat.length, queryText);
    const selectedIds = new Set(batchesToInject.map(batch => batch.id));
    const audience = getCurrentMemoryAudience();
    const restrictionsEnabled = getSetting('enableCharacterRestrictions') !== false;

    // Pinning is an explicit always-recall override for keyword activation, but
    // hard card/tag restrictions and knowledge instructions still apply.
    const extraPinned = getPinnedQuotes().filter(quote => {
        if (selectedIds.has(quote.batchId)) return false;
        const source = getBatch(quote.batchId);
        if (!source || !isBatchEligible(source, queryText, {
            ignoreKeywordActivation: true,
            audience,
            restrictionsEnabled,
        })) return false;
        return !quote.characterMemory
            || isCharacterMemoryEligible(quote.characterMemory, audience, restrictionsEnabled);
    });

    if (batchesToInject.length === 0 && extraPinned.length === 0) {
        lastContentSignature = sig;
        lastContentResult = '';
        return '';
    }

    const preamble = `These summaries describe events that occurred earlier in the story, presented in chronological order. They provide context for understanding the current situation but should not dictate the phrasing, tone, or style of future narration. Use them as factual reference, not as templates.`;

    // Relative-time labels give the model a sense of chronology that a bare
    // "Event Set 7" does not. The phrase is derived from the batch's position in
    // the full chronological list (so internal numbering stays intact and
    // load-bearing) versus how many batches exist — earliest reads "long ago",
    // most recent reads "just now".
    const allBatchesChrono = getBatches()
        .filter(b => !b.dirty && b.summary)
        .sort((a, b) => a.startIndex - b.startIndex);
    const totalChrono = allBatchesChrono.length;
    const whenPhrase = (batch) => {
        const pos = allBatchesChrono.findIndex(b => b.id === batch.id); // 0 = earliest
        if (pos < 0 || totalChrono <= 1) return 'Earlier';
        const fromEnd = (totalChrono - 1) - pos; // 0 = most recent
        if (fromEnd === 0) return 'Just now';
        if (fromEnd <= 2) return 'Recently';
        if (fromEnd <= 5) return 'Earlier';
        if (fromEnd <= 10) return 'A while back';
        return 'Long ago';
    };

    const memoryItems = [];
    for (const batch of batchesToInject) {
        let label;
        if (batch.type === 'establishment') {
            label = 'Story Opening';
        } else {
            label = whenPhrase(batch);
        }

        memoryItems.push({ batch, text: formatMemory(batch, label) });
        for (const memory of normalizeCharacterMemories(batch.characterMemories)) {
            if (!isCharacterMemoryEligible(memory, audience, restrictionsEnabled)) continue;
            memoryItems.push({
                batch,
                knowledge: getCharacterMemoryKnowledge(memory),
                text: formatCharacterMemory(memory, label),
            });
        }
    }

    for (const quote of extraPinned) {
        const batch = getBatch(quote.batchId);
        if (!batch) continue;
        let quoteLine = `Key Moment (user-pinned):\n  ${quote.speaker}: "${quote.text}"`;
        if (quote.context?.trim()) quoteLine += ` (${quote.context})`;
        memoryItems.push({
            batch,
            knowledge: quote.characterMemory
                ? getCharacterMemoryKnowledge(quote.characterMemory)
                : undefined,
            text: quoteLine,
        });
    }

    const groupedMemories = renderKnowledgeGroups(memoryItems);
    const content = `<prior_events>\n${preamble}\n\n${groupedMemories}\n</prior_events>`;

    lastContentSignature = sig;
    lastContentResult = content;
    return content;
}

// ============================================================
// Batch summaries injection
// ============================================================

/**
 * Apply the summarizer prompt using ST's extension prompt system.
 * Always injects directly before chat history (IN_CHAT position, depth 9999).
 */
export function applySummarizerPrompt() {
    const settings = getPromptSettings();
    if (settings.includeInPrompts === false) return;

    const content = buildPromptContent();
    const context = getContext();

    context.setExtensionPrompt(
        PROMPT_IDENTIFIER,
        content,
        INJECTION_POSITION, // 1 = IN_CHAT
        BATCH_DEPTH,        // 9999 = before all chat messages
        false,              // not scannable
        INJECTION_ROLE,     // 0 = SYSTEM
    );
}

/**
 * Remove the summarizer prompt
 */
export function cleanupSummarizerPrompt() {
    try {
        const context = getContext();
        context.setExtensionPrompt(PROMPT_IDENTIFIER, '', 0, 0, false, 0);
        context.setExtensionPrompt(CA_PROMPT_IDENTIFIER, '', 0, 0, false, 0);
    } catch { /* ignore if context not ready */ }

    lastContentSignature = null;
    lastContentResult = null;
    caUpdateRevision++;
}

/**
 * Update the content of the existing prompt
 */
export function updateSummarizerPromptContent() {
    const settings = getPromptSettings();
    if (settings.includeInPrompts === false) return;

    // Re-apply with fresh content
    applySummarizerPrompt();
}

/**
 * Invalidate the content cache so next update rebuilds
 */
export function invalidateSummarizerPromptCache() {
    lastContentSignature = null;
    lastContentResult = null;
}

/**
 * Refresh: cleanup then re-apply
 */
export function refreshSummarizerPrompt() {
    cleanupSummarizerPrompt();
    applySummarizerPrompt();
    applyContextArchivesPrompt();
}

// ============================================================
// Context Archives injection
// ============================================================

let caUpdateRevision = 0;

/**
 * Apply the context archives prompt.
 * Always injects directly before chat history AND before batch summaries
 * (IN_CHAT position, depth 9999, order 99 vs batch summaries at order 100).
 */
export function applyContextArchivesPrompt() {
    const placement = getCAPlacement();
    if (placement.includeInPrompts === false) return;

    updateContextArchivesPromptContent();
}

/**
 * Update context archives prompt content (async)
 */
export async function updateContextArchivesPromptContent() {
    const revision = ++caUpdateRevision;
    const placement = getCAPlacement();
    if (placement.includeInPrompts === false) {
        // Clear it
        try {
            const context = getContext();
            context.setExtensionPrompt(CA_PROMPT_IDENTIFIER, '', 0, 0, false, 0);
        } catch { /* ignore */ }
        return;
    }

    try {
        const content = await buildContextArchivesContent();
        if (revision !== caUpdateRevision) return;
        const context = getContext();

        context.setExtensionPrompt(
            CA_PROMPT_IDENTIFIER,
            content,
            INJECTION_POSITION, // 1 = IN_CHAT
            CA_DEPTH,           // 10000 = before batch summaries (higher depth = earlier)
            false,              // not scannable
            INJECTION_ROLE,     // 0 = SYSTEM
        );
    } catch (e) {
        console.error('[Summarizer] Failed to update context archives prompt:', e);
    }
}

/**
 * Clean up context archives prompt
 */
export function cleanupContextArchivesPrompt() {
    caUpdateRevision++;
    try {
        const context = getContext();
        context.setExtensionPrompt(CA_PROMPT_IDENTIFIER, '', 0, 0, false, 0);
    } catch { /* ignore */ }
}
