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
} from './storage.js';
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
        const pinnedCount = b.quotes?.filter(q => q.pinned)?.length || 0;
        // importance participates: regenerating a batch to backfill its score
        // must invalidate the cache so selection re-ranks.
        return `${b.id}:${b.dirty}:${b.summary?.length || 0}:p${pinnedCount}:i${b.importance ?? 'x'}`;
    }).join('|');
    // The relevance query is the recent scene; fold a cheap fingerprint of it in
    // so selection refreshes as the scene moves, not only when batches change.
    // Length alone collides across different same-length scenes, so use a fast
    // rolling char hash (djb2-ish) — enough to detect the scene actually changed.
    const q = getRecentSceneQuery();
    let querySig = 0;
    for (let i = 0; i < q.length; i++) querySig = ((querySig << 5) - querySig + q.charCodeAt(i)) | 0;
    return `${chat?.length || 0}:${batchSig}:${getSetting('maxSummariesInContext')}:${getSetting('alwaysKeepFirstNBatches')}:${getSetting('alwaysKeepLastNBatches')}:q${querySig}`;
}

/**
 * Build the relevance query from the current scene: the most recent few
 * non-hidden messages, which is what the injected summaries should be
 * relevant *to*. Kept small (last 4, capped length) so token overlap reflects
 * the immediate moment rather than the whole tail. Mirrors generator.js's
 * hidden-message handling loosely — is_system messages are skipped so ghosted
 * lines and narrator scaffolding don't skew the query.
 */
function getRecentSceneQuery() {
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
function buildPromptContent() {
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
    // pool by importance, then relevance to this, then rotation — and advances
    // the rotation offset itself, so we no longer increment it here.
    const queryText = getRecentSceneQuery();
    const batchesToInject = getBatchesToInject(chat.length, queryText);
    if (batchesToInject.length === 0) {
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

    const summaryLines = batchesToInject.map((batch) => {
        let label;
        if (batch.type === 'establishment') {
            label = 'Story Opening';
        } else {
            label = whenPhrase(batch);
        }

        let text = `${label}:\n${batch.summary}`;

        if (batch.quotes?.length > 0) {
            const quotesFormatted = batch.quotes.map(quote => {
                let quoteLine = `  ${quote.speaker}: "${quote.text}"`;
                if (quote.context?.trim()) quoteLine += ` (${quote.context})`;
                return quoteLine;
            }).join('\n');
            text += '\n' + quotesFormatted;
        }

        return text;
    });

    // Collect pinned quotes across all batches
    const pinnedQuotes = getPinnedQuotes();
    let pinnedSection = '';
    if (pinnedQuotes.length > 0) {
        const pinnedLines = pinnedQuotes.map(q => {
            let line = `  ${q.speaker}: "${q.text}"`;
            if (q.context?.trim()) line += ` (${q.context})`;
            return line;
        }).join('\n');
        pinnedSection = `\n\nKey Moments (user-pinned):\n${pinnedLines}`;
    }

    const content = `<prior_events>\n${preamble}\n\n${summaryLines.join('\n\n')}${pinnedSection}\n</prior_events>`;

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
    caCacheValid = false;
    caContentCache = null;
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

let caContentCache = null;
let caCacheValid = false;

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
    try {
        const context = getContext();
        context.setExtensionPrompt(CA_PROMPT_IDENTIFIER, '', 0, 0, false, 0);
    } catch { /* ignore */ }
}

/**
 * Invalidate context archives cache
 */
export function invalidateContextArchivesCache() {
    caCacheValid = false;
    caContentCache = null;
}
