/**
 * SillyTavern-Summarizer — Standalone Extension
 *
 * Batch-based chat summarization with comprehensive summaries,
 * memorable quotes, prompt injection, macros, and auto-processing.
 *
 * Works fully standalone.
 */
import { eventSource, event_types, streamingProcessor } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

import { initFileStore, getSummary as getFileSummary } from './src/fileStore.js';
import {
    initSettings, getSetting, isEnabled, toggleEnabled, getBatches, getUnprocessedBatches,
    fullReset, getComprehensiveSummary, markBatchRangeDirty, markBatchesDirtyFrom,
    getBatchSize, getMessageExclusionCount,
    toggleQuotePin, getPinnedQuotes, getPinnedQuoteCount,
    getBackboneBatches, isComprehensiveSummaryCurrent, isComprehensiveContextCurrent,
} from './src/storage.js';
import { processUnprocessedBatches, generateComprehensive } from './src/generator.js';
import { switchToProfileWithConfirmation, restoreProfileWithConfirmation } from './src/utils.js';
import {
    applySummarizerPrompt, cleanupSummarizerPrompt, updateSummarizerPromptContent,
    invalidateSummarizerPromptCache, refreshSummarizerPrompt,
    applyContextArchivesPrompt, updateContextArchivesPromptContent,
    buildPromptContent,
} from './src/promptInjection.js';
import { updateBatchVisuals, scheduleBatchVisualUpdate, showProgressDialog, showIndeterminateProgress } from './src/ui.js';
import { openSummarizerModal, closeSummarizerModal, refreshSummarizerModal } from './src/modal.js';
import {
    getConfig as getCAConfig, setConfig as setCAConfig,
    getPlacementConfig as getCAPlacement, setPlacementConfig as setCAPlacement,
    getAssignedArchives, assignArchive, removeArchive, moveArchive,
    getArchivePool, isContextArchivesEnabled, setContextArchivesEnabled,
    isContextArchivesQuotesEnabled, setContextArchivesQuotesEnabled,
    buildContextArchivesContent,
} from './src/contextArchives.js';

let initialized = false;
let cachedComprehensiveSummary = null;
let isSummarizerRunning = false;
let autoProcessTimer = null;

// ============================================================
// Macro cache
// ============================================================

async function updateMacroCache() {
    if (!isEnabled()) { cachedComprehensiveSummary = null; return; }
    try { cachedComprehensiveSummary = await getComprehensiveSummary(); } catch { cachedComprehensiveSummary = null; }
}

// ============================================================
// Generate interceptor
// ============================================================

globalThis.summarizer_intercept_messages = function (chat, _contextSize, _abort, _type) {
    if (!isEnabled()) return;
    const context = getContext();
    const IGNORE_SYMBOL = context.symbols.ignore;
    if (!IGNORE_SYMBOL) return;
    const chatLength = chat.length;
    const excludeCount = getMessageExclusionCount(chatLength);
    for (let i = 0; i < excludeCount; i++) {
        chat[i] = structuredClone(chat[i]);
        if (!chat[i].extra) chat[i].extra = {};
        chat[i].extra[IGNORE_SYMBOL] = true;
    }

};

// ============================================================
// Auto-process
// ============================================================

/**
 * Auto-process new batches after a character message.
 *
 * Design principles (matching Qvink/MessageSummarize):
 *  - NO blockUserInput — don't touch the DOM or disable send.
 *  - NO profile switching — CMRS routes to the correct profile
 *    internally; slash-command profile juggling was interfering
 *    with ST's generation lifecycle.
 *  - skipProfileSwitch = false so that if CMRS is unavailable,
 *    callLLM's own fallback can still switch profiles.
 */
async function autoProcessNewBatches() {
    if (!isEnabled() || !getSetting('auto')) return;

    const context = getContext();
    const batchSize = getBatchSize();
    const autoBuffer = getSetting('autoBuffer') || 0;
    const effectiveLength = Math.max(0, context.chat.length - autoBuffer);
    const completeBatches = Math.floor(effectiveLength / batchSize);
    const processedBatches = getBatches().filter(b => !b.dirty && b.summary).length;
    if (completeBatches <= processedBatches) return;

    try {
        await processUnprocessedBatches(null, false, effectiveLength);
        updateBatchVisuals();
        updateSummarizerPromptContent();
    } catch (e) {
        console.error('[Summarizer] Auto-processing failed:', e);
    }
}

// ============================================================
// Manual process + comprehensive
// ============================================================

async function processNewBatches(silent = false) {
    if (!isEnabled()) { if (!silent) toastr.warning('Summarizer is disabled for this chat'); return; }

    const unprocessed = getUnprocessedBatches(getContext().chat.length);
    if (unprocessed.length === 0) { if (!silent) toastr.info('All batches are already processed'); return; }

    const connectionProfile = getSetting('connectionProfile');
    let originalProfile = null;
    let progressDialog = silent ? null : showProgressDialog();

    try {
        if (connectionProfile) {
            const r = await switchToProfileWithConfirmation(connectionProfile);
            if (r.success) originalProfile = r.originalProfile;
        }

        const results = await processUnprocessedBatches((progress) => {
            if (progressDialog) {
                progressDialog.updateProgress(progress.current, progress.total, progress.type);
                if (progressDialog.isCancelled()) throw new Error('Cancelled by user');
            }
        }, !!connectionProfile);

        updateBatchVisuals();
        updateSummarizerPromptContent();
        if (progressDialog) progressDialog.close();

        const successful = results.filter(r => !r.error).length;
        const failed = results.filter(r => r.error).length;

        if (!silent) {
            if (failed > 0) toastr.warning(`Processed ${successful} batches, ${failed} failed`);
            else toastr.success(`Successfully processed ${successful} batches`);
        }
    } catch (e) {
        if (progressDialog) progressDialog.close();
        if (e.message === 'Cancelled by user') toastr.info('Processing cancelled');
        else if (!silent) toastr.error('Failed to process batches: ' + e.message);
    } finally {
        if (originalProfile) await restoreProfileWithConfirmation(originalProfile);
    }
}

async function generateComprehensiveSummary() {
    const allBatches = getBatches().filter(b => !b.dirty && b.summary);
    const batches = getBackboneBatches();
    if (allBatches.length === 0) { toastr.error('No batch summaries available. Process batches first.'); return; }
    const excluded = allBatches.length - batches.length;

    const context = getContext();
    const confirmed = await context.callGenericPopup(
        `Generate a complete archival recap from ${allBatches.length} memor${allBatches.length === 1 ? 'y' : 'ies'}?${excluded > 0 ? `\n\nA prompt-safe story backbone will use the ${batches.length} unrestricted common memor${batches.length === 1 ? 'y' : 'ies'}. The other ${excluded} will remain separate so their activation and character rules are preserved.` : '\n\nAll memories are eligible for the prompt-safe story backbone.'}`,
        'confirm', '', { okButton: 'Generate', cancelButton: 'Cancel' },
    );
    if (!confirmed) return;

    const progress = showIndeterminateProgress('Comprehensive Summary');
    progress.updateStatus('Generating comprehensive summary...');
    const connectionProfile = getSetting('connectionProfile');
    let originalProfile = null;

    try {
        if (connectionProfile) {
            progress.updateStatus('Switching connection profile...');
            const r = await switchToProfileWithConfirmation(connectionProfile);
            if (r.success) originalProfile = r.originalProfile;
        }
        progress.updateStatus('Generating comprehensive summary...');
        await generateComprehensive(!!connectionProfile);
        progress.close();
        toastr.success('Comprehensive summary generated');

        const viewNow = await context.callGenericPopup(
            'Comprehensive summary generated. View it now?',
            'confirm', '', { okButton: 'View', cancelButton: 'Later' },
        );
        if (viewNow) openSummarizerModal('comprehensive');
        await updateMacroCache();
    } catch (e) {
        progress.close();
        toastr.error('Failed: ' + e.message);
    } finally {
        if (originalProfile) await restoreProfileWithConfirmation(originalProfile);
    }
}

// ============================================================
// Event handlers
// ============================================================

function registerEventHandlers() {
    globalThis.addEventListener?.('summarizer:comprehensive-changed', updateMacroCache);

    eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId, type) => {
        if (type !== 'normal' || !isEnabled() || !getSetting('auto')) return;

        // Only trigger on character messages
        const context = getContext();
        const message = context.chat[messageId];
        if (!message || message.is_user || message.is_system) return;

        // Prevent re-entrant auto-processing
        if (isSummarizerRunning) return;

        // Bail if streaming is still in progress (matches Qvink's approach —
        // don't poll-wait, just exit; we'll catch it on the next message)
        if (streamingProcessor && !streamingProcessor.isFinished) {
            return;
        }

        // Quick check: are there even batches to process?
        const batchSize = getBatchSize();
        const autoBuffer = getSetting('autoBuffer') || 0;
        const effectiveLength = Math.max(0, context.chat.length - autoBuffer);
        const completeBatches = Math.floor(effectiveLength / batchSize);
        const processedBatches = getBatches().filter(b => !b.dirty && b.summary).length;
        if (completeBatches <= processedBatches) return;

        // Defer to next tick to let ST fully settle its internal state.
        // This is intentionally NOT a long poll — just a brief yield.
        const scheduledChatId = context.chatId;
        if (autoProcessTimer) clearTimeout(autoProcessTimer);
        autoProcessTimer = setTimeout(async () => {
            autoProcessTimer = null;
            // Re-check guards after the yield
            if (getContext().chatId !== scheduledChatId) return;
            if (isSummarizerRunning) return;
            if (streamingProcessor && !streamingProcessor.isFinished) return;

            isSummarizerRunning = true;
            try {
                await autoProcessNewBatches();
                invalidateSummarizerPromptCache();
            } finally {
                isSummarizerRunning = false;
            }
            updateSummarizerPromptContent();
        }, 1000);
    });

    eventSource.on(event_types.CHAT_CHANGED, () => {
        if (autoProcessTimer) clearTimeout(autoProcessTimer);
        autoProcessTimer = null;
        invalidateSummarizerPromptCache();
        scheduleBatchVisualUpdate();
        refreshSummarizerModal();
        updateSummarizerPromptContent();
        updateContextArchivesPromptContent();
        updateMacroCache();
    });

    // In group chats ST changes the active responder for each generation. Rebuild
    // here so hard card/tag restrictions are evaluated for that specific card.
    if (event_types.GENERATION_STARTED) {
        eventSource.on(event_types.GENERATION_STARTED, () => {
            invalidateSummarizerPromptCache();
            updateSummarizerPromptContent();
        });
    }

    if (event_types.MESSAGE_RENDERED) {
        eventSource.on(event_types.MESSAGE_RENDERED, () => scheduleBatchVisualUpdate());
    }

    const refreshChangedBatch = (messageIndex, indexesShifted = false) => {
        const index = Number.parseInt(messageIndex, 10);
        if (!Number.isInteger(index) || index < 0) return;
        const marked = indexesShifted
            ? markBatchesDirtyFrom(index)
            : markBatchRangeDirty(index, index);
        if (marked > 0) {
            invalidateSummarizerPromptCache();
            scheduleBatchVisualUpdate();
        }
        updateSummarizerPromptContent();
    };

    const contentChangeEvents = new Set([
        event_types.MESSAGE_EDITED,
        event_types.MESSAGE_UPDATED,
        event_types.MESSAGE_SWIPED,
    ].filter(Boolean));
    for (const eventName of contentChangeEvents) {
        eventSource.on(eventName, messageIndex => refreshChangedBatch(messageIndex, false));
    }
    if (event_types.MESSAGE_DELETED) {
        eventSource.on(event_types.MESSAGE_DELETED, messageIndex => refreshChangedBatch(messageIndex, true));
    }
}

// ============================================================
// Slash commands
// ============================================================

function registerSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarizer-toggle',
        callback: () => {
            const s = toggleEnabled();
            toastr.info(`Summarizer ${s ? 'enabled' : 'disabled'} for this chat`);
            return String(s);
        },
        helpString: 'Toggle summarizer on/off for the current chat',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarizer-process',
        callback: async () => { await processNewBatches(false); return ''; },
        helpString: 'Process all unprocessed batches in the current chat',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarizer-comprehensive',
        callback: async () => { await generateComprehensiveSummary(); return ''; },
        helpString: 'Generate comprehensive summary from all batch summaries',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarizer-view-comprehensive',
        callback: async () => { openSummarizerModal('comprehensive'); return ''; },
        helpString: 'Open the Summarizer modal on the Comprehensive tab',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarizer-modal',
        callback: async () => { openSummarizerModal(); return ''; },
        helpString: 'Open the Simple Summarizer management modal',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarizer-clear',
        callback: async () => {
            const c = getContext();
            const ok = await c.callGenericPopup(
                'Clear all summaries for this chat?\n\nThis cannot be undone.',
                'confirm', '', { okButton: 'Clear All', cancelButton: 'Cancel' },
            );
            if (ok) { fullReset(); updateBatchVisuals(); toastr.success('All summaries cleared'); }
            return '';
        },
        helpString: 'Clear all summaries for the current chat',
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'summarizer-status',
        callback: async () => {
            const c = getContext();
            const bs = getBatchSize();
            const batches = getBatches();
            const comp = await getComprehensiveSummary();
            const status = {
                enabled: isEnabled(), auto: getSetting('auto'),
                chatLength: c.chat.length, batchSize: bs,
                completeBatches: Math.floor(c.chat.length / bs),
                processedBatches: batches.filter(b => !b.dirty && b.summary).length,
                dirtyBatches: batches.filter(b => b.dirty).length,
                hasComprehensive: !!comp,
            };
            return JSON.stringify(status, null, 2);
        },
        helpString: 'Show summarizer status for the current chat',
    }));
}

// ============================================================
// Macros
// ============================================================

async function registerMacros() {
    try {
        const { MacroRegistry, MacroCategory, MacroValueType } = await import('../../../macros/engine/MacroRegistry.js');

        MacroRegistry.registerMacro('comprehensive_summary', {
            category: MacroCategory.MISC,
            description: 'Returns the prompt-safe common-memory story backbone for the current chat.',
            returns: 'The current story backbone, or empty string',
            returnType: MacroValueType.STRING,
            exampleUsage: ['{{comprehensive_summary}}'],
            handler: () => (!isEnabled() || !isComprehensiveContextCurrent(cachedComprehensiveSummary)) ? '' : (cachedComprehensiveSummary.contextText || ''),
        });

        MacroRegistry.registerMacro('comprehensive_summary_with_quotes', {
            category: MacroCategory.MISC,
            description: 'Returns the prompt-safe story backbone with pinned quotes from common memories.',
            returns: 'Story backbone followed by safe pinned quotes',
            returnType: MacroValueType.STRING,
            exampleUsage: ['{{comprehensive_summary_with_quotes}}'],
            handler: () => {
                if (!isEnabled() || !isComprehensiveContextCurrent(cachedComprehensiveSummary)) return '';
                let o = cachedComprehensiveSummary.contextText || '';
                const backboneIds = new Set(getBackboneBatches().map(batch => batch.id));
                const safeQuotes = getPinnedQuotes().filter(quote => backboneIds.has(quote.batchId) && !quote.characterMemoryId);
                if (safeQuotes.length > 0) {
                    o += '\n\nMemorable Quotes:\n';
                    safeQuotes.forEach(q => {
                        o += `- ${q.speaker}: "${q.text}"`;
                        if (q.context) o += ` (${q.context})`;
                        o += '\n';
                    });
                }
                return o;
            },
        });

        MacroRegistry.registerMacro('comprehensive_archive_summary', {
            category: MacroCategory.MISC,
            description: 'Returns the complete archival recap, including scoped memories. This is not prompt-safe.',
            returns: 'The complete archival recap, or empty string',
            returnType: MacroValueType.STRING,
            exampleUsage: ['{{comprehensive_archive_summary}}'],
            handler: () => (!isEnabled() || !isComprehensiveSummaryCurrent(cachedComprehensiveSummary)) ? '' : (cachedComprehensiveSummary.text || ''),
        });

        MacroRegistry.registerMacro('batch_summaries', {
            category: MacroCategory.MISC,
            description: 'Returns all batch summaries that would be injected into context.',
            returns: 'Formatted batch summaries with labels and quotes',
            returnType: MacroValueType.STRING,
            exampleUsage: ['{{batch_summaries}}'],
            handler: () => isEnabled() ? buildPromptContent() : '',
        });

        MacroRegistry.registerMacro('batch_count', {
            category: MacroCategory.MISC,
            description: 'Returns the number of processed batches in the current chat.',
            returns: 'Number of batches as a string',
            returnType: MacroValueType.INTEGER,
            exampleUsage: ['{{batch_count}}'],
            handler: () => isEnabled() ? String(getBatches().length) : '0',
        });
    } catch {
        // MacroRegistry not available
    }
}

// ============================================================
// Prompt setup (APP_READY)
// ============================================================

function applyStandalonePrompts() {
    // Apply standalone prompts (hardcoded placement)
    applySummarizerPrompt();
    updateSummarizerPromptContent();
    applyContextArchivesPrompt();
    updateContextArchivesPromptContent();
}

// ============================================================
// Input Area Button
// ============================================================

function setupInputButton() {
    const extensionsMenu = document.getElementById('extensionsMenu');
    if (!extensionsMenu) {
        // Fallback: try common ST extension menu selectors
        const altMenu = document.querySelector('#data_bank_wand_container') || document.querySelector('.extensions_block');
        if (altMenu) {
            const btn = createInputButton();
            altMenu.appendChild(btn);
        }
        return;
    }

    const btn = createInputButton();
    extensionsMenu.appendChild(btn);
}

function createInputButton() {
    const btn = document.createElement('div');
    btn.id = 'summarizer-input-btn';
    btn.className = 'list-group-item flex-container flexGap5 interactable';
    btn.title = 'Simple Summarizer';
    btn.tabIndex = 0;
    btn.innerHTML = '<i class="fa-solid fa-scroll"></i> Summarizer';
    btn.addEventListener('click', () => openSummarizerModal());
    return btn;
}

// ============================================================
// Public API
// ============================================================

function exposePublicAPI() {
    window.Summarizer = {
        // Core access
        getComprehensiveSummary,
        getSummary: getFileSummary,
        getBatches,
        isEnabled,

        // Modal
        openModal: openSummarizerModal,
        closeModal: closeSummarizerModal,

        // Pinned quotes
        toggleQuotePin,
        getPinnedQuotes,
        getPinnedQuoteCount,

        // Generation
        processUnprocessedBatches,
        generateComprehensive,

        // Prompt management
        applySummarizerPrompt,
        cleanupSummarizerPrompt,
        updateSummarizerPromptContent,
        refreshSummarizerPrompt,

        // Context Archives
        contextArchives: {
            getConfig: getCAConfig,
            setConfig: setCAConfig,
            getPlacement: getCAPlacement,
            setPlacement: setCAPlacement,
            getAssigned: getAssignedArchives,
            assign: assignArchive,
            remove: removeArchive,
            move: moveArchive,
            getPool: getArchivePool,
            isEnabled: isContextArchivesEnabled,
            setEnabled: setContextArchivesEnabled,
            isQuotesEnabled: isContextArchivesQuotesEnabled,
            setQuotesEnabled: setContextArchivesQuotesEnabled,
            buildContent: buildContextArchivesContent,
            updatePrompt: updateContextArchivesPromptContent,
        },

        // Presence flag
        isInstalled: true,
    };
}

// ============================================================
// Init
// ============================================================

jQuery(async () => {
    if (initialized) return;

    // Initialize storage systems
    initFileStore();
    initSettings();

    // Register features
    registerEventHandlers();
    registerSlashCommands();
    await registerMacros();

    // Load modal CSS
    const modalCSS = document.createElement('link');
    modalCSS.rel = 'stylesheet';
    modalCSS.href = '/scripts/extensions/third-party/SillyTavern-SimpleSummarizer/modal.css';
    document.head.appendChild(modalCSS);

    // Add extension button to input area
    setupInputButton();

    // Expose API immediately
    exposePublicAPI();

    // Initialize macro cache
    updateMacroCache();

    // Apply standalone prompts once the app is ready.
    let promptsApplied = false;
    const runApply = () => {
        if (promptsApplied) return;
        promptsApplied = true;
        applyStandalonePrompts();
    };

    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, runApply);
    } else {
        setTimeout(runApply, 2000);
    }

    initialized = true;
});
