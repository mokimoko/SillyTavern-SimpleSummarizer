/**
 * ui.js — Batch visuals, dialogs, progress for Summarizer (standalone)
 * 
 * Lifted from VM's summarizer/src/ui.js with corrected import paths.
 */
import { getContext } from '../../../../extensions.js';
import {
    getBatches,
    updateBatch,
    deleteBatch,
    getSetting,
    getBatchesToInject,
    toggleQuotePin,
} from './storage.js';
import { regenerateBatch } from './generator.js';
import { invalidateSummarizerPromptCache, updateSummarizerPromptContent } from './promptInjection.js';

function getMessageDiv(index) {
    return $(`#chat .mes[mesid="${index}"]`);
}

/**
 * Update visual indicators for all batches
 */
export function updateBatchVisuals() {
    if (!getSetting('showSummariesInChat')) {
        $('.batch-summary-indicator').remove();
        return;
    }

    const batches = getBatches();
    const injectedBatches = getBatchesToInject(getContext().chat.length);
    const injectedIds = new Set(injectedBatches.map(b => b.id));
    const currentBatchIds = new Set(batches.map(b => b.id));

    // Remove indicators for batches that no longer exist
    $('.batch-summary-indicator').each(function () {
        const batchId = $(this).data('batch-id');
        if (!currentBatchIds.has(batchId)) $(this).remove();
    });

    batches.forEach((batch, index) => {
        let displayIndex = (batch.type === 'history') ? 1 : batch.endIndex;
        let $messageDiv = getMessageDiv(displayIndex);

        if (!$messageDiv.length && batch.type !== 'history') {
            for (let i = batch.endIndex - 1; i >= batch.startIndex; i--) {
                $messageDiv = getMessageDiv(i);
                if ($messageDiv.length) { displayIndex = i; break; }
            }
        }

        if (!$messageDiv.length) return;

        const isInjected = injectedIds.has(batch.id);
        const isDirty = batch.dirty;
        const isEdited = batch.edited;
        const style = getSetting('summaryDisplayStyle');

        let statusIcon = '';
        if (isDirty) statusIcon = '<span class="batch-status-dirty" title="Needs regeneration">⚠️</span>';
        else if (isEdited) statusIcon = '<span class="batch-status-edited" title="Manually edited">✏️</span>';

        const injectedIndicator = isInjected ? '<span class="batch-status-injected" title="Currently in context">📌</span>' : '';

        let typeLabel = '';
        if (batch.type === 'history') typeLabel = ' (Past History)';
        else if (batch.type === 'establishment') typeLabel = ' (Setup)';

        const summaryText = style === 'full' ? batch.summary :
            (batch.summary.length > 100 ? batch.summary.substring(0, 97) + '...' : batch.summary);

        const quoteCount = batch.quotes?.length || 0;
        const pinnedCount = batch.quotes?.filter(q => q.pinned)?.length || 0;
        const quoteIndicator = quoteCount > 0
            ? `<span class="batch-quote-count" title="${quoteCount} memorable quote${quoteCount !== 1 ? 's' : ''}${pinnedCount > 0 ? `, ${pinnedCount} pinned` : ''}">💬 ${quoteCount}${pinnedCount > 0 ? ` <i class="fa-solid fa-thumbtack batch-pin-indicator"></i>${pinnedCount}` : ''}</span>`
            : '';

        let $indicator = $messageDiv.find(`.batch-summary-indicator[data-batch-id="${batch.id}"]`);

        if ($indicator.length > 0) {
            $indicator.attr('class', `batch-summary-indicator ${isInjected ? 'batch-injected' : ''} ${isDirty ? 'batch-dirty' : ''}`);
            $indicator.find('.batch-label').html(`Batch ${index + 1}${typeLabel} ${injectedIndicator} ${statusIcon} ${quoteIndicator}`);
            $indicator.find('.batch-summary-text').text(summaryText);
        } else {
            $indicator = $(`
                <div class="batch-summary-indicator ${isInjected ? 'batch-injected' : ''} ${isDirty ? 'batch-dirty' : ''}" data-batch-id="${batch.id}">
                    <div class="batch-header">
                        <span class="batch-label">Batch ${index + 1}${typeLabel} ${injectedIndicator} ${statusIcon} ${quoteIndicator}</span>
                        <div class="batch-actions">
                            <button class="batch-btn batch-edit-btn" title="Edit summary"><i class="fa-solid fa-pen"></i></button>
                            <button class="batch-btn batch-regenerate-btn" title="Regenerate summary"><i class="fa-solid fa-refresh"></i></button>
                            <button class="batch-btn batch-delete-btn" title="Delete summary"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                    <div class="batch-summary-text">${summaryText}</div>
                </div>
            `);
            $messageDiv.find('.mes_text').after($indicator);
        }
    });

    attachBatchEventHandlers();
}

function attachBatchEventHandlers() {
    $('.batch-edit-btn').off('click').on('click', async function (e) {
        e.stopPropagation();
        await showEditBatchDialog($(this).closest('.batch-summary-indicator').data('batch-id'));
    });
    $('.batch-regenerate-btn').off('click').on('click', async function (e) {
        e.stopPropagation();
        await handleRegenerateBatch($(this).closest('.batch-summary-indicator').data('batch-id'));
    });
    $('.batch-delete-btn').off('click').on('click', async function (e) {
        e.stopPropagation();
        await handleDeleteBatch($(this).closest('.batch-summary-indicator').data('batch-id'));
    });
}

// ============================================================
// Edit Batch Dialog
// ============================================================

export async function showEditBatchDialog(batchId, onSave) {
    const batches = getBatches();
    const batch = batches.find(b => b.id === batchId);
    if (!batch) return;

    const batchIndex = batches.indexOf(batch);

    let quotesHTML = '';
    if (batch.quotes && batch.quotes.length > 0) {
        quotesHTML = batch.quotes.map((quote, idx) => buildQuoteItemHTML(quote, idx)).join('');
    } else {
        quotesHTML = '<p class="summarizer-empty-quotes">No memorable quotes in this batch</p>';
    }

    const overlay = createModal(`Edit Batch ${batchIndex + 1} Summary <span class="notes" style="font-weight: 400; margin-left: 8px;">Messages ${batch.startIndex + 1}–${batch.endIndex + 1}</span>`, `
        <label><strong>Summary</strong></label>
        <textarea id="summarizer-edit-textarea" class="text_pole" rows="6">${batch.summary || ''}</textarea>
        <div style="display: flex; justify-content: space-between; align-items: center;">
            <label style="margin: 0;"><strong>Memorable Quotes</strong></label>
            <button id="summarizer-add-quote" class="menu_button" style="padding: 2px 10px; font-size: 11px; white-space: nowrap;"><i class="fa-solid fa-plus"></i> Add Quote</button>
        </div>
        <div id="summarizer-quotes-container" style="flex: 1; min-height: 0;">${quotesHTML}</div>
    `, [
        { label: '<i class="fa-solid fa-floppy-disk"></i> Save', class: 'summarizer-modal-save' },
        { label: 'Cancel', class: 'summarizer-modal-cancel' },
    ]);

    setupQuoteHandlers(overlay, '#summarizer-quotes-container', '#summarizer-add-quote', batchId);

    overlay.querySelector('.summarizer-modal-save').addEventListener('click', () => {
        const newSummary = overlay.querySelector('#summarizer-edit-textarea').value.trim();
        const newQuotes = collectQuotes(overlay);
        if (newSummary) {
            updateBatch(batchId, { summary: newSummary, quotes: newQuotes, edited: true, dirty: false });
            updateBatchVisuals();
            onSave?.();
            toastr.success('Batch summary updated');
        }
        overlay.remove();
    });

    overlay.querySelector('.summarizer-modal-cancel').addEventListener('click', () => overlay.remove());
}

async function handleRegenerateBatch(batchId) {
    const $indicator = $(`.batch-summary-indicator[data-batch-id="${batchId}"]`);
    const $summaryText = $indicator.find('.batch-summary-text');
    const originalText = $summaryText.text();
    $summaryText.text('Regenerating...');
    try {
        await regenerateBatch(batchId);
        updateBatchVisuals();
        toastr.success('Batch summary regenerated');
    } catch (error) {
        console.error('Failed to regenerate batch:', error);
        toastr.error('Failed to regenerate summary: ' + error.message);
        $summaryText.text(originalText);
    }
}

async function handleDeleteBatch(batchId) {
    const batches = getBatches();
    const batch = batches.find(b => b.id === batchId);
    if (!batch) return;
    const batchIndex = batches.indexOf(batch);
    if (!confirm(`Delete summary for Batch ${batchIndex + 1}?\n\nMessages ${batch.startIndex + 1} - ${batch.endIndex + 1} will not be summarized.`)) return;
    deleteBatch(batchId);
    updateBatchVisuals();
    toastr.success('Batch summary deleted');
}

// ============================================================
// Progress Dialog
// ============================================================

export function showProgressDialog() {
    const overlay = document.createElement('div');
    overlay.className = 'summarizer-modal-overlay';
    overlay.innerHTML = `
        <div class="summarizer-modal summarizer-progress-modal">
            <div class="summarizer-modal-header">
                <div class="summarizer-progress-title"><i class="fa-solid fa-layer-group"></i> <span>Processing Summaries</span></div>
            </div>
            <div class="summarizer-modal-body summarizer-progress-body">
                <div class="summarizer-progress-status">
                    <div class="summarizer-progress-text">Initializing...</div>
                    <div class="summarizer-progress-count"></div>
                </div>
                <div class="summarizer-progress-track"><div class="summarizer-progress-fill"></div></div>
            </div>
            <div class="summarizer-modal-footer">
                <span style="flex:1"></span>
                <button class="summarizer-progress-cancel"><i class="fa-solid fa-xmark"></i> Cancel</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    let cancelled = false;
    overlay.querySelector('.summarizer-progress-cancel').addEventListener('click', () => { cancelled = true; overlay.remove(); });

    return {
        updateProgress: (current, total, type) => {
            const percent = Math.round((current / total) * 100);
            overlay.querySelector('.summarizer-progress-fill').style.width = percent + '%';
            overlay.querySelector('.summarizer-progress-text').textContent = `Processing ${type} ${current} of ${total}...`;
            overlay.querySelector('.summarizer-progress-count').textContent = `${percent}%`;
        },
        isCancelled: () => cancelled,
        close: () => overlay.remove(),
    };
}

/**
 * Show indeterminate progress (for comprehensive gen — single LLM call, no percentage)
 */
export function showIndeterminateProgress(title = 'Generating...') {
    const overlay = document.createElement('div');
    overlay.className = 'summarizer-modal-overlay';
    overlay.innerHTML = `
        <div class="summarizer-modal summarizer-progress-modal">
            <div class="summarizer-modal-header">
                <div class="summarizer-progress-title"><i class="fa-solid fa-wand-magic-sparkles"></i> <span>${title}</span></div>
            </div>
            <div class="summarizer-modal-body summarizer-progress-body">
                <div class="summarizer-progress-status">
                    <div class="summarizer-progress-text" id="summarizer-indeterminate-status">Preparing...</div>
                </div>
                <div class="summarizer-progress-track"><div class="summarizer-progress-fill summarizer-indeterminate"></div></div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    return {
        updateStatus: (text) => {
            const el = overlay.querySelector('#summarizer-indeterminate-status');
            if (el) el.textContent = text;
        },
        close: () => overlay.remove(),
    };
}

// ============================================================
// Shared helpers
// ============================================================

function buildQuoteItemHTML(quote, idx) {
    const isPinned = quote.pinned || false;
    return `
        <div class="summarizer-quote-item ${isPinned ? 'summarizer-quote-pinned' : ''}" data-index="${idx}">
            <input type="text" class="text_pole summarizer-quote-speaker" placeholder="Speaker" value="${quote.speaker}">
            <button class="summarizer-quote-pin${isPinned ? ' pinned' : ''}" title="${isPinned ? 'Unpin quote' : 'Pin quote — always include in context'}">
                <i class="fa-solid fa-thumbtack"></i>
            </button>
            <textarea class="text_pole summarizer-quote-text" placeholder="Quote text" rows="2">${quote.text}</textarea>
            <input type="text" class="text_pole summarizer-quote-context" placeholder="Brief context" value="${quote.context}">
            <button class="summarizer-quote-delete menu_button" title="Delete quote"><i class="fa-solid fa-trash"></i></button>
        </div>`;
}

function collectQuotes(overlay) {
    const quotes = [];
    overlay.querySelectorAll('.summarizer-quote-item').forEach(item => {
        const speaker = item.querySelector('.summarizer-quote-speaker').value.trim();
        const text = item.querySelector('.summarizer-quote-text').value.trim();
        const context = item.querySelector('.summarizer-quote-context').value.trim();
        const pinned = item.querySelector('.summarizer-quote-pin')?.classList.contains('pinned') || false;
        if (speaker && text) quotes.push({ speaker, text, context, pinned });
    });
    return quotes;
}

function setupQuoteHandlers(overlay, containerSel, addBtnSel, batchId = null) {
    overlay.querySelector(addBtnSel).addEventListener('click', () => {
        const container = overlay.querySelector(containerSel);
        const emptyMsg = container.querySelector('.summarizer-empty-quotes');
        if (emptyMsg) emptyMsg.remove();
        const div = document.createElement('div');
        div.className = 'summarizer-quote-item';
        div.innerHTML = `
            <input type="text" class="text_pole summarizer-quote-speaker" placeholder="Speaker" value="">
            <button class="summarizer-quote-pin" title="Pin quote — always include in context">
                <i class="fa-solid fa-thumbtack"></i>
            </button>
            <textarea class="text_pole summarizer-quote-text" placeholder="Quote text" rows="2"></textarea>
            <input type="text" class="text_pole summarizer-quote-context" placeholder="Brief context" value="">
            <button class="summarizer-quote-delete menu_button" title="Delete quote"><i class="fa-solid fa-trash"></i></button>`;
        container.appendChild(div);
    });

    overlay.querySelector(containerSel).addEventListener('click', (e) => {
        // Delete handler
        if (e.target.closest('.summarizer-quote-delete')) {
            e.target.closest('.summarizer-quote-item').remove();
            const container = overlay.querySelector(containerSel);
            if (container.children.length === 0) {
                container.innerHTML = '<p class="summarizer-empty-quotes">No memorable quotes</p>';
            }
        }

        // Pin toggle handler
        const pinBtn = e.target.closest('.summarizer-quote-pin');
        if (pinBtn) {
            const quoteItem = pinBtn.closest('.summarizer-quote-item');
            const isPinned = pinBtn.classList.toggle('pinned');
            quoteItem.classList.toggle('summarizer-quote-pinned', isPinned);
            pinBtn.title = isPinned ? 'Unpin quote' : 'Pin quote — always include in context';

            // If we have a batchId, persist the pin state immediately
            if (batchId) {
                const quoteIndex = parseInt(quoteItem.dataset.index, 10);
                if (!isNaN(quoteIndex)) {
                    toggleQuotePin(batchId, quoteIndex);
                    invalidateSummarizerPromptCache();
                    updateSummarizerPromptContent();
                    updateBatchVisuals();
                }
            }
        }
    });
}

function createModal(title, bodyHTML, buttons, extraClass = '') {
    const overlay = document.createElement('div');
    overlay.className = 'summarizer-modal-overlay';
    const buttonsHTML = buttons.map(b => {
        if (b.style) return `<div style="${b.style}"></div>`;
        return `<button class="menu_button ${b.class}">${b.label}</button>`;
    }).join('');

    overlay.innerHTML = `
        <div class="summarizer-modal ${extraClass}">
            <div class="summarizer-modal-header">
                <h3>${title}</h3>
                <button class="summarizer-modal-close">×</button>
            </div>
            <div class="summarizer-modal-body">${bodyHTML}</div>
            <div class="summarizer-modal-footer">${buttonsHTML}</div>
        </div>`;

    document.body.appendChild(overlay);

    overlay.querySelector('.summarizer-modal-close').addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    return overlay;
}
