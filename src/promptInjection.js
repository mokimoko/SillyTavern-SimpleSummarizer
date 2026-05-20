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
    incrementRotationOffset,
} from './storage.js';
import {
    buildContextArchivesContent,
    getPlacementConfig as getCAPlacement,
} from './contextArchives.js';

const log = (...args) => console.log('[Summarizer Prompt]', ...args);

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
    const batchSig = batches.map(b => `${b.id}:${b.dirty}:${b.summary?.length || 0}`).join('|');
    return `${chat?.length || 0}:${batchSig}:${getSetting('maxSummariesInContext')}:${getSetting('alwaysKeepFirstNBatches')}:${getSetting('alwaysKeepLastNBatches')}`;
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

    const batchesToInject = getBatchesToInject(chat.length);
    if (batchesToInject.length === 0) {
        lastContentSignature = sig;
        lastContentResult = '';
        return '';
    }

    // Increment rotation for next time
    incrementRotationOffset();

    const preamble = `These summaries describe events that occurred earlier in the story, presented in chronological order. They provide context for understanding the current situation but should not dictate the phrasing, tone, or style of future narration. Use them as factual reference, not as templates.`;

    const summaryLines = batchesToInject.map((batch) => {
        let label;
        if (batch.type === 'establishment') {
            label = 'Story Opening';
        } else {
            const allBatches = getBatches();
            const batchNumber = allBatches.indexOf(batch) + 1;
            label = `Event Set ${batchNumber}`;
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

    const content = `<prior_events>\n${preamble}\n\n${summaryLines.join('\n\n')}\n</prior_events>`;

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
    if (settings.includeInPrompts === false) {
        log('⛔ includeInPrompts is FALSE — skipping injection');
        return;
    }

    const content = buildPromptContent();
    const context = getContext();

    log(`📋 Injection diagnostics:`,
        `\n  content length: ${content.length}`,
        `\n  content preview: ${content.substring(0, 120)}...`,
        `\n  position: ${INJECTION_POSITION} (IN_CHAT)`,
        `\n  depth: ${BATCH_DEPTH}`,
        `\n  role: ${INJECTION_ROLE} (SYSTEM)`,
        `\n  isEnabled: ${isEnabled()}`,
        `\n  batches total: ${getBatches().length}`,
        `\n  batches with summaries: ${getBatches().filter(b => !b.dirty && b.summary).length}`,
    );

    context.setExtensionPrompt(
        PROMPT_IDENTIFIER,
        content,
        INJECTION_POSITION, // 1 = IN_CHAT
        BATCH_DEPTH,        // 9999 = before all chat messages
        false,              // not scannable
        INJECTION_ROLE,     // 0 = SYSTEM
    );

    log(content ? '✓ Applied batch summaries prompt (before chat history)' : '✓ Cleared batch summaries prompt (no batches)');
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

        log(content ? '✓ Applied context archives prompt (before chat history + before batch summaries)' : '✓ Cleared context archives prompt (none assigned)');
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
