/**
 * SillyTavern-Summarizer — Standalone Extension
 * 
 * Batch-based chat summarization with comprehensive summaries,
 * memorable quotes, prompt injection, macros, and auto-processing.
 * 
 * Works fully standalone. Exposes window.Summarizer API for VM integration.
 */
import { eventSource, event_types, saveSettingsDebounced, streamingProcessor } from '../../../../script.js';
import { getContext } from '../../../extensions.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';

import { initFileStore, getSummary as getFileSummary, setVerseInfo, clearVerseInfo, getSummariesByVerse, getSummariesByStoryline } from './src/fileStore.js';
import {
    initSettings, getSetting, isEnabled, toggleEnabled, getBatches, getUnprocessedBatches,
    clearAllBatches, fullReset, getComprehensiveSummary, markBatchRangeDirty,
    getBatchesToInject, shouldExcludeMessage, MODULE_NAME,
    toggleQuotePin, getPinnedQuotes, getPinnedQuoteCount,
} from './src/storage.js';
import { processUnprocessedBatches, generateComprehensive } from './src/generator.js';
import { switchToProfileWithConfirmation, restoreProfileWithConfirmation } from './src/utils.js';
import {
    applySummarizerPrompt, cleanupSummarizerPrompt, updateSummarizerPromptContent,
    invalidateSummarizerPromptCache, refreshSummarizerPrompt,
    applyContextArchivesPrompt, updateContextArchivesPromptContent, invalidateContextArchivesCache,
} from './src/promptInjection.js';
import { updateBatchVisuals, showProgressDialog, showIndeterminateProgress } from './src/ui.js';
import { openSummarizerModal, closeSummarizerModal } from './src/modal.js';
import { runLegacyMigration } from './src/legacyMigration.js';
import {
    getConfig as getCAConfig, setConfig as setCAConfig,
    getPlacementConfig as getCAPlacement, setPlacementConfig as setCAPlacement,
    getAssignedArchives, assignArchive, removeArchive, moveArchive,
    getArchivePool, isContextArchivesEnabled, setContextArchivesEnabled,
    buildContextArchivesContent,
} from './src/contextArchives.js';

let initialized = false;
let cachedComprehensiveSummary = null;
let cachedBatchSummaries = '';
let isSummarizerRunning = false;

// ============================================================
// Macro cache
// ============================================================

async function updateMacroCache() {
    if (!isEnabled()) { cachedComprehensiveSummary = null; cachedBatchSummaries = ''; return; }
    try { cachedComprehensiveSummary = await getComprehensiveSummary(); } catch { cachedComprehensiveSummary = null; }

    const context = getContext();
    const batchesToInject = getBatchesToInject(context.chat.length);
    if (batchesToInject.length === 0) { cachedBatchSummaries = ''; return; }

    cachedBatchSummaries = batchesToInject.map(batch => {
        const allBatches = getBatches();
        const label = batch.type === 'establishment' ? 'Story Opening' : `Event Set ${allBatches.indexOf(batch) + 1}`;
        let text = `${label}:\n${batch.summary}`;
        if (batch.quotes?.length > 0) {
            text += '\n' + batch.quotes.map(q => {
                let line = `  ${q.speaker}: "${q.text}"`;
                if (q.context?.trim()) line += ` (${q.context})`;
                return line;
            }).join('\n');
        }
        return text;
    }).join('\n\n');
}

// ============================================================
// Generate interceptor
// ============================================================

globalThis.summarizer_intercept_messages = function (chat, _contextSize, _abort, type) {
    if (!isEnabled()) return;
    const context = getContext();
    const IGNORE_SYMBOL = context.symbols.ignore;
    if (!IGNORE_SYMBOL) return;
    const chatLength = chat.length;
    let excludedCount = 0;
    for (let i = 0; i < chatLength; i++) {
        if (shouldExcludeMessage(i, chatLength)) {
            chat[i] = structuredClone(chat[i]);
            if (!chat[i].extra) chat[i].extra = {};
            chat[i].extra[IGNORE_SYMBOL] = true;
            excludedCount++;
        }
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
    const batchSize = getSetting('batchSize');
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
    const batches = getBatches().filter(b => !b.dirty && b.summary);
    if (batches.length === 0) { toastr.error('No batch summaries available. Process batches first.'); return; }

    const context = getContext();
    const confirmed = await context.callGenericPopup(
        `Generate comprehensive summary from ${batches.length} batch summaries?`,
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

        // Bail if agents are running
        if (window.VerseManager?.agents?.isAgentRunActive?.()) {
            return;
        }

        // Quick check: are there even batches to process?
        const batchSize = getSetting('batchSize');
        const autoBuffer = getSetting('autoBuffer') || 0;
        const effectiveLength = Math.max(0, context.chat.length - autoBuffer);
        const completeBatches = Math.floor(effectiveLength / batchSize);
        const processedBatches = getBatches().filter(b => !b.dirty && b.summary).length;
        if (completeBatches <= processedBatches) return;

        // Defer to next tick to let ST fully settle its internal state.
        // This is intentionally NOT a long poll — just a brief yield.
        setTimeout(async () => {
            // Re-check guards after the yield
            if (isSummarizerRunning) return;
            if (streamingProcessor && !streamingProcessor.isFinished) return;
            if (window.VerseManager?.agents?.isAgentRunActive?.()) return;

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
        invalidateSummarizerPromptCache();
        invalidateContextArchivesCache();
        updateBatchVisuals();
        updateSummarizerPromptContent();
        updateContextArchivesPromptContent();
        updateMacroCache();
    });

    if (event_types.MESSAGE_RENDERED) {
        eventSource.on(event_types.MESSAGE_RENDERED, () => updateBatchVisuals());
    }

    eventSource.on(event_types.MESSAGE_DELETED, (messageIndex) => {
        const batchSize = getSetting('batchSize');
        const batchIdx = Math.floor(messageIndex / batchSize);
        const startIndex = batchIdx * batchSize;
        const endIndex = startIndex + batchSize - 1;

        const marked = markBatchRangeDirty(startIndex, endIndex);
        if (marked > 0) {
            invalidateSummarizerPromptCache();
            updateBatchVisuals();
        }
        updateSummarizerPromptContent();
    });
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
            const bs = getSetting('batchSize');
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
            description: 'Returns the comprehensive summary text for the current chat.',
            returns: 'The comprehensive summary text, or empty string',
            returnType: MacroValueType.STRING,
            exampleUsage: ['{{comprehensive_summary}}'],
            handler: () => (!isEnabled() || !cachedComprehensiveSummary) ? '' : (cachedComprehensiveSummary.text || ''),
        });

        MacroRegistry.registerMacro('comprehensive_summary_with_quotes', {
            category: MacroCategory.MISC,
            description: 'Returns the comprehensive summary with memorable quotes.',
            returns: 'Summary text followed by formatted quotes',
            returnType: MacroValueType.STRING,
            exampleUsage: ['{{comprehensive_summary_with_quotes}}'],
            handler: () => {
                if (!isEnabled() || !cachedComprehensiveSummary) return '';
                let o = cachedComprehensiveSummary.text || '';
                if (cachedComprehensiveSummary.quotes?.length > 0) {
                    o += '\n\nMemorable Quotes:\n';
                    cachedComprehensiveSummary.quotes.forEach(q => {
                        o += `- ${q.speaker}: "${q.text}"`;
                        if (q.context) o += ` (${q.context})`;
                        o += '\n';
                    });
                }
                return o;
            },
        });

        MacroRegistry.registerMacro('batch_summaries', {
            category: MacroCategory.MISC,
            description: 'Returns all batch summaries that would be injected into context.',
            returns: 'Formatted batch summaries with labels and quotes',
            returnType: MacroValueType.STRING,
            exampleUsage: ['{{batch_summaries}}'],
            handler: () => isEnabled() ? cachedBatchSummaries : '',
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
// VM Detection (APP_READY)
// ============================================================

function detectVM() {
    // Always apply standalone prompts (hardcoded placement)
    applySummarizerPrompt();
    updateSummarizerPromptContent();
    applyContextArchivesPrompt();
    updateContextArchivesPromptContent();

    // Legacy migration: copy VM archive summaries → standalone fileStore
    if (window.VerseManager?.archiveStore) {
        runLegacyMigration().catch(e => {
            console.error('[Summarizer] Legacy migration failed:', e);
        });
    }
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

        // Generation (for VM's continueChat etc.)
        processUnprocessedBatches,
        generateComprehensive,

        // VM integration (tagging)
        setVerseInfo,
        clearVerseInfo,
        getSummariesByVerse,
        getSummariesByStoryline,

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

    // Expose API immediately (VM may need it on APP_READY)
    exposePublicAPI();

    // Initialize macro cache
    updateMacroCache();

    // Detect VM — event-driven with fallback for when VM isn't installed.
    // VM emits 'VM_SETTINGS_READY' after its settings modal + core sections are registered.
    let vmDetected = false;
    const runDetect = () => {
        if (vmDetected) return;
        vmDetected = true;
        detectVM();
    };

    if (event_types.APP_READY) {
        eventSource.on('VM_SETTINGS_READY', runDetect);
        eventSource.on(event_types.APP_READY, () => {
            // Fallback: if VM isn't installed, no VM_SETTINGS_READY will fire.
            // Give a short grace period then run standalone detection.
            setTimeout(runDetect, 2000);
        });
    } else {
        setTimeout(runDetect, 2000);
    }

    initialized = true;
});
