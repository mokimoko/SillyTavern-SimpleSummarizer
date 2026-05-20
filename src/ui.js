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
    getComprehensiveSummary,
    updateComprehensiveSummary,
    clearComprehensiveSummary,
} from './storage.js';
import { regenerateBatch, regenerateComprehensive } from './generator.js';

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
        const quoteIndicator = quoteCount > 0
            ? `<span class="batch-quote-count" title="${quoteCount} memorable quote${quoteCount !== 1 ? 's' : ''}">💬 ${quoteCount}</span>`
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

async function showEditBatchDialog(batchId) {
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

    const overlay = createModal(`Edit Batch ${batchIndex + 1} Summary`, `
        <p class="notes">Messages ${batch.startIndex + 1} - ${batch.endIndex + 1}</p>
        <label><strong>Summary</strong></label>
        <textarea id="summarizer-edit-textarea" class="text_pole" rows="6">${batch.summary || ''}</textarea>
        <label><strong>Memorable Quotes</strong></label>
        <div id="summarizer-quotes-container">${quotesHTML}</div>
        <button id="summarizer-add-quote" class="menu_button"><i class="fa-solid fa-plus"></i> Add Quote</button>
    `, [
        { label: '<i class="fa-solid fa-floppy-disk"></i> Save', class: 'summarizer-modal-save' },
        { label: 'Cancel', class: 'summarizer-modal-cancel' },
    ]);

    setupQuoteHandlers(overlay, '#summarizer-quotes-container', '#summarizer-add-quote');

    overlay.querySelector('.summarizer-modal-save').addEventListener('click', () => {
        const newSummary = overlay.querySelector('#summarizer-edit-textarea').value.trim();
        const newQuotes = collectQuotes(overlay);
        if (newSummary) {
            updateBatch(batchId, { summary: newSummary, quotes: newQuotes, edited: true, dirty: false });
            updateBatchVisuals();
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
// Comprehensive Summary Dialog
// ============================================================

export async function showComprehensiveSummaryDialog() {
    const comprehensive = await getComprehensiveSummary();
    if (!comprehensive) {
        toastr.warning('No comprehensive summary available. Generate one first.');
        return;
    }

    const lastUpdated = new Date(comprehensive.lastGenerated).toLocaleString();
    const status = comprehensive.edited ? '(Edited)' : '';

    let metaInfo = '';
    if (comprehensive.metadata) {
        const parts = [];
        if (comprehensive.metadata.character) parts.push(`Character: ${comprehensive.metadata.character.displayName}`);
        if (comprehensive.metadata.persona) parts.push(`Persona: ${comprehensive.metadata.persona.displayName}`);
        if (parts.length > 0) metaInfo = `<p class="notes">${parts.join(' | ')}</p>`;
    }

    let quotesHTML = '';
    if (comprehensive.quotes && comprehensive.quotes.length > 0) {
        quotesHTML = comprehensive.quotes.map((q, i) => buildQuoteItemHTML(q, i)).join('');
    } else {
        quotesHTML = '<p class="summarizer-empty-quotes">No memorable quotes selected</p>';
    }

    const overlay = createModal(`Comprehensive Summary ${status}`, `
        <p class="notes">Last generated: ${lastUpdated}</p>
        ${metaInfo}
        <div class="summarizer-comp-columns">
            <div class="summarizer-comp-left">
                <label><strong>Summary</strong></label>
                <textarea id="summarizer-comprehensive-textarea" class="text_pole" rows="12">${comprehensive.text || ''}</textarea>
            </div>
            <div class="summarizer-comp-right">
                <label><strong>Memorable Quotes</strong></label>
                <div id="summarizer-comprehensive-quotes-container">${quotesHTML}</div>
                <button id="summarizer-comprehensive-add-quote" class="menu_button"><i class="fa-solid fa-plus"></i> Add Quote</button>
            </div>
        </div>
    `, [
        { label: '<i class="fa-solid fa-refresh"></i> Regenerate', class: 'summarizer-comprehensive-regenerate' },
        { label: '<i class="fa-solid fa-trash"></i> Delete', class: 'summarizer-comprehensive-delete' },
        { label: '', class: 'summarizer-spacer', style: 'flex:1' },
        { label: '<i class="fa-solid fa-floppy-disk"></i> Save', class: 'summarizer-modal-save' },
        { label: 'Cancel', class: 'summarizer-modal-cancel' },
    ], 'summarizer-modal-large');

    setupQuoteHandlers(overlay, '#summarizer-comprehensive-quotes-container', '#summarizer-comprehensive-add-quote');

    // Regenerate
    overlay.querySelector('.summarizer-comprehensive-regenerate').addEventListener('click', async () => {
        const textarea = overlay.querySelector('#summarizer-comprehensive-textarea');
        textarea.value = 'Regenerating...';
        textarea.disabled = true;
        try {
            await regenerateComprehensive();
            const newComp = await getComprehensiveSummary();
            textarea.value = newComp.text;
            const container = overlay.querySelector('#summarizer-comprehensive-quotes-container');
            if (newComp.quotes && newComp.quotes.length > 0) {
                container.innerHTML = newComp.quotes.map((q, i) => buildQuoteItemHTML(q, i)).join('');
            } else {
                container.innerHTML = '<p class="summarizer-empty-quotes">No memorable quotes selected</p>';
            }
            toastr.success('Comprehensive summary regenerated');
        } catch (error) {
            toastr.error('Failed to regenerate: ' + error.message);
            textarea.value = comprehensive.text;
        } finally {
            textarea.disabled = false;
        }
    });

    // Delete
    overlay.querySelector('.summarizer-comprehensive-delete').addEventListener('click', () => {
        if (!confirm('Delete comprehensive summary?')) return;
        clearComprehensiveSummary();
        toastr.success('Comprehensive summary deleted');
        overlay.remove();
    });

    // Save
    overlay.querySelector('.summarizer-modal-save').addEventListener('click', async () => {
        const newText = overlay.querySelector('#summarizer-comprehensive-textarea').value.trim();
        const newQuotes = collectQuotes(overlay);
        if (newText) {
            await updateComprehensiveSummary({ text: newText, quotes: newQuotes, edited: true });
            toastr.success('Comprehensive summary updated');
        }
        overlay.remove();
    });

    overlay.querySelector('.summarizer-modal-cancel').addEventListener('click', () => overlay.remove());
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
    return `
        <div class="summarizer-quote-item" data-index="${idx}">
            <input type="text" class="text_pole summarizer-quote-speaker" placeholder="Speaker" value="${quote.speaker}">
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
        if (speaker && text) quotes.push({ speaker, text, context });
    });
    return quotes;
}

function setupQuoteHandlers(overlay, containerSel, addBtnSel) {
    overlay.querySelector(addBtnSel).addEventListener('click', () => {
        const container = overlay.querySelector(containerSel);
        const emptyMsg = container.querySelector('.summarizer-empty-quotes');
        if (emptyMsg) emptyMsg.remove();
        const div = document.createElement('div');
        div.className = 'summarizer-quote-item';
        div.innerHTML = `
            <input type="text" class="text_pole summarizer-quote-speaker" placeholder="Speaker" value="">
            <textarea class="text_pole summarizer-quote-text" placeholder="Quote text" rows="2"></textarea>
            <input type="text" class="text_pole summarizer-quote-context" placeholder="Brief context" value="">
            <button class="summarizer-quote-delete menu_button" title="Delete quote"><i class="fa-solid fa-trash"></i></button>`;
        container.appendChild(div);
    });

    overlay.querySelector(containerSel).addEventListener('click', (e) => {
        if (e.target.closest('.summarizer-quote-delete')) {
            e.target.closest('.summarizer-quote-item').remove();
            const container = overlay.querySelector(containerSel);
            if (container.children.length === 0) {
                container.innerHTML = '<p class="summarizer-empty-quotes">No memorable quotes</p>';
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
