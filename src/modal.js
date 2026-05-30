/**
 * modal.js — Main management modal for Simple Summarizer
 *
 * Pattern: Chat Design / Dynamic Events modal
 * - Persistent DOM, created once and reused across open/close
 * - Left sidebar: icon-only nav (56px)
 * - Right content: tab-specific views
 * - CSS class prefix: ss-
 */
import { getContext } from '../../../../extensions.js';
import {
    getBatches, getBatch, updateBatch, deleteBatch, clearAllBatches,
    getSetting, setSetting, getPromptSettings, setPromptSetting,
    toggleEnabled, isEnabled,
    getComprehensiveSummary, updateComprehensiveSummary, clearComprehensiveSummary,
    toggleQuotePin, getPinnedQuotes, getPinnedQuoteCount,
    MODULE_NAME,
} from './storage.js';
import { regenerateBatch, regenerateComprehensive } from './generator.js';
import {
    invalidateSummarizerPromptCache, updateSummarizerPromptContent,
    refreshSummarizerPrompt,
    updateContextArchivesPromptContent,
} from './promptInjection.js';
import { updateBatchVisuals } from './ui.js';
import { getStore } from './fileStore.js';
import {
    getConfig as getCAConfig, setConfig as setCAConfig,
    getPlacementConfig as getCAPlacement, setPlacementConfig as setCAPlacement,
    getAssignedArchives, assignArchive, removeArchive, moveArchive,
    getArchivePool, isContextArchivesEnabled, setContextArchivesEnabled,
} from './contextArchives.js';

// ============================================================
// State
// ============================================================

let isOpen = false;
let activeTab = 'batches';

const MODAL_ID = 'ss-modal';
const OVERLAY_ID = 'ss-overlay';

const TABS = [
    { id: 'batches',       icon: 'fa-layer-group', label: 'Batches' },
    { id: 'comprehensive', icon: 'fa-scroll',       label: 'Comprehensive' },
    { id: 'pinned',        icon: 'fa-thumbtack',    label: 'Pinned Quotes' },
    { id: 'archives',      icon: 'fa-box-archive',  label: 'Archives' },
    { id: 'settings',      icon: 'fa-gear',         label: 'Settings' },
];

// ============================================================
// Open / Close
// ============================================================

export function openSummarizerModal(tab = null) {
    if (tab && TABS.some(t => t.id === tab)) activeTab = tab;

    if (isOpen) {
        // Already open — just switch tab and re-render
        renderContent();
        return;
    }

    isOpen = true;
    ensureModalDOM();
    renderContent();

    requestAnimationFrame(() => {
        document.getElementById(OVERLAY_ID)?.classList.add('ss-visible');
        document.getElementById(MODAL_ID)?.classList.add('ss-visible');
    });
}

export function closeSummarizerModal() {
    if (!isOpen) return;

    document.getElementById(OVERLAY_ID)?.classList.remove('ss-visible');
    document.getElementById(MODAL_ID)?.classList.remove('ss-visible');

    isOpen = false;
}

// ============================================================
// DOM Creation
// ============================================================

function ensureModalDOM() {
    if (document.getElementById(MODAL_ID)) return;

    const overlay = document.createElement('div');
    overlay.id = OVERLAY_ID;
    overlay.className = 'ss-overlay';
    overlay.addEventListener('click', closeSummarizerModal);
    document.body.appendChild(overlay);

    const modal = document.createElement('div');
    modal.id = MODAL_ID;
    modal.className = 'ss-modal';
    modal.innerHTML = `
        <div class="ss-header">
            <div class="ss-title"><i class="fa-solid fa-scroll"></i> Simple Summarizer</div>
            <div class="ss-close" id="ss-close">✕</div>
        </div>
        <div class="ss-body">
            <div class="ss-sidebar" id="ss-sidebar"></div>
            <div class="ss-content" id="ss-content"></div>
        </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector('#ss-close')?.addEventListener('click', closeSummarizerModal);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && isOpen) closeSummarizerModal();
    });
}

// ============================================================
// Sidebar
// ============================================================

function renderSidebar() {
    const sidebar = document.getElementById('ss-sidebar');
    if (!sidebar) return;

    sidebar.innerHTML = TABS.map(t => `
        <div class="ss-nav-item ${t.id === activeTab ? 'ss-nav-active' : ''}" data-tab="${t.id}" title="${t.label}">
            <i class="fa-solid ${t.icon}"></i>
        </div>
    `).join('');

    sidebar.querySelectorAll('.ss-nav-item').forEach(el => {
        el.addEventListener('click', () => {
            activeTab = el.dataset.tab;
            renderContent();
        });
    });
}

// ============================================================
// Content Rendering
// ============================================================

function renderContent() {
    renderSidebar();
    const content = document.getElementById('ss-content');
    if (!content) return;

    switch (activeTab) {
        case 'batches':       renderBatchesTab(content); break;
        case 'comprehensive': renderComprehensiveTab(content); break;
        case 'pinned':        renderPinnedTab(content); break;
        case 'archives':      renderArchivesTab(content); break;
        case 'settings':      renderSettingsTab(content); break;
    }
}

// ============================================================
// Tab: Batches
// ============================================================

function renderBatchesTab(container) {
    const context = getContext();
    if (!context?.chatId) {
        container.innerHTML = `<div class="ss-empty-state"><i class="fa-solid fa-comments"></i><p>Open a chat to manage batches</p></div>`;
        return;
    }

    const batches = getBatches();
    const enabled = isEnabled();
    const pinnedTotal = getPinnedQuoteCount();

    container.innerHTML = `
        <div class="ss-tab-header">
            <span class="ss-tab-title">Batches</span>
            <div class="ss-tab-actions">
                <button class="ss-btn ss-btn-accent" id="ss-process-all"><i class="fa-solid fa-play"></i> Process All</button>
                <button class="ss-btn ss-btn-ghost" id="ss-clear-all"><i class="fa-solid fa-trash"></i> Clear</button>
            </div>
        </div>
        ${pinnedTotal > 0 ? `<div class="ss-pinned-summary"><i class="fa-solid fa-thumbtack"></i> ${pinnedTotal} pinned quote${pinnedTotal !== 1 ? 's' : ''} — always included in context</div>` : ''}
        <div class="ss-batch-list" id="ss-batch-list">
            ${batches.length === 0
                ? '<div class="ss-empty">No batches yet. Process messages to create summaries.</div>'
                : batches.map((b, i) => renderBatchCard(b, i)).join('')}
        </div>
    `;

    wireBatchesEvents(container);
}

function renderBatchCard(batch, index) {
    const isDirty = batch.dirty;
    const isEdited = batch.edited;
    const quoteCount = batch.quotes?.length || 0;
    const pinnedCount = batch.quotes?.filter(q => q.pinned)?.length || 0;
    const typeLabel = batch.type === 'establishment' ? 'Setup' : batch.type === 'history' ? 'History' : '';
    const summaryPreview = batch.summary?.length > 120 ? batch.summary.substring(0, 117) + '...' : (batch.summary || '');

    let statusClass = '';
    let statusLabel = '';
    if (isDirty) { statusClass = 'ss-batch-dirty'; statusLabel = 'Needs regen'; }
    else if (isEdited) { statusClass = 'ss-batch-edited'; statusLabel = 'Edited'; }

    return `
        <div class="ss-batch-card ${statusClass}" data-batch-id="${batch.id}">
            <div class="ss-batch-card-header">
                <div class="ss-batch-card-info">
                    <span class="ss-batch-num">Batch ${index + 1}</span>
                    ${typeLabel ? `<span class="ss-batch-type">${typeLabel}</span>` : ''}
                    <span class="ss-batch-range">msgs ${batch.startIndex + 1}–${batch.endIndex + 1}</span>
                    ${statusLabel ? `<span class="ss-batch-status">${statusLabel}</span>` : ''}
                </div>
                <div class="ss-batch-card-meta">
                    ${quoteCount > 0 ? `<span class="ss-batch-quotes">💬 ${quoteCount}${pinnedCount > 0 ? ` <i class="fa-solid fa-thumbtack"></i>${pinnedCount}` : ''}</span>` : ''}
                    <div class="ss-batch-card-actions">
                        <button class="ss-btn-icon ss-batch-jump" title="Jump to message"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>
                        <button class="ss-btn-icon ss-batch-regen" title="Regenerate"><i class="fa-solid fa-refresh"></i></button>
                        <button class="ss-btn-icon ss-batch-del" title="Delete"><i class="fa-solid fa-trash"></i></button>
                    </div>
                </div>
            </div>
            <div class="ss-batch-card-body">
                <div class="ss-batch-preview">${summaryPreview}</div>
            </div>
        </div>
    `;
}

function wireBatchesEvents(container) {
    // Process All
    container.querySelector('#ss-process-all')?.addEventListener('click', async () => {
        await getContext().executeSlashCommandsWithOptions('/summarizer-process');
        renderContent();
    });

    // Clear All
    container.querySelector('#ss-clear-all')?.addEventListener('click', async () => {
        const ctx = getContext();
        const ok = await ctx.callGenericPopup('Clear all summaries for this chat?\n\nThis cannot be undone.', 'confirm', '', { okButton: 'Clear All', cancelButton: 'Cancel' });
        if (!ok) return;
        const { fullReset } = await import('./storage.js');
        fullReset();
        updateBatchVisuals();
        invalidateSummarizerPromptCache();
        updateSummarizerPromptContent();
        toastr.success('All summaries cleared');
        renderContent();
    });

    // Batch card actions (event delegation)
    container.querySelector('#ss-batch-list')?.addEventListener('click', async (e) => {
        const card = e.target.closest('.ss-batch-card');
        if (!card) return;
        const batchId = card.dataset.batchId;

        // Jump to message
        if (e.target.closest('.ss-batch-jump')) {
            const batch = getBatch(batchId);
            if (batch) {
                const $msg = $(`#chat .mes[mesid="${batch.endIndex}"]`);
                if ($msg.length) $msg[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
            }
            return;
        }

        // Regenerate
        if (e.target.closest('.ss-batch-regen')) {
            card.querySelector('.ss-batch-preview').textContent = 'Regenerating...';
            try {
                await regenerateBatch(batchId);
                updateBatchVisuals();
                invalidateSummarizerPromptCache();
                updateSummarizerPromptContent();
                toastr.success('Batch regenerated');
                renderContent();
            } catch (err) {
                toastr.error('Failed: ' + err.message);
                renderContent();
            }
            return;
        }

        // Delete
        if (e.target.closest('.ss-batch-del')) {
            const batch = getBatch(batchId);
            if (!batch) return;
            const batches = getBatches();
            const idx = batches.indexOf(batch);
            if (!confirm(`Delete Batch ${idx + 1}?`)) return;
            deleteBatch(batchId);
            updateBatchVisuals();
            invalidateSummarizerPromptCache();
            updateSummarizerPromptContent();
            toastr.success('Batch deleted');
            renderContent();
            return;
        }

        // Click card body → open edit dialog
        const { showEditBatchDialog } = await import('./ui.js');
        showEditBatchDialog(batchId, renderContent);
    });
}

// ============================================================
// Tab: Comprehensive
// ============================================================

async function renderComprehensiveTab(container) {
    const context = getContext();
    if (!context?.chatId) {
        container.innerHTML = `<div class="ss-empty-state"><i class="fa-solid fa-comments"></i><p>Open a chat to view comprehensive summary</p></div>`;
        return;
    }

    const comprehensive = await getComprehensiveSummary();

    if (!comprehensive) {
        const batchCount = getBatches().filter(b => !b.dirty && b.summary).length;
        container.innerHTML = `
            <div class="ss-tab-header">
                <span class="ss-tab-title">Comprehensive Summary</span>
            </div>
            <div class="ss-empty-state">
                <i class="fa-solid fa-scroll"></i>
                <p>No comprehensive summary yet</p>
                <p class="ss-empty-hint">${batchCount > 0 ? `${batchCount} batches available — generate a summary to combine them.` : 'Process batches first, then generate a comprehensive summary.'}</p>
                ${batchCount > 0 ? '<button class="ss-btn ss-btn-accent" id="ss-comp-generate"><i class="fa-solid fa-wand-magic-sparkles"></i> Generate</button>' : ''}
            </div>
        `;
        container.querySelector('#ss-comp-generate')?.addEventListener('click', () => {
            closeSummarizerModal();
            getContext().executeSlashCommandsWithOptions('/summarizer-comprehensive');
        });
        return;
    }

    const lastUpdated = new Date(comprehensive.lastGenerated).toLocaleString();
    const quoteCount = comprehensive.quotes?.length || 0;
    let metaParts = [];
    if (comprehensive.metadata?.character) metaParts.push(comprehensive.metadata.character.displayName);
    if (comprehensive.metadata?.persona) metaParts.push(comprehensive.metadata.persona.displayName);

    container.innerHTML = `
        <div class="ss-tab-header">
            <span class="ss-tab-title">Comprehensive Summary</span>
            <div class="ss-tab-actions">
                <button class="ss-btn ss-btn-accent" id="ss-comp-regen"><i class="fa-solid fa-refresh"></i> Regenerate</button>
                <button class="ss-btn ss-btn-ghost ss-btn-danger-text" id="ss-comp-delete"><i class="fa-solid fa-trash"></i></button>
            </div>
        </div>
        <div class="ss-comp-meta">
            <span>${lastUpdated}</span>
            ${metaParts.length > 0 ? `<span>${metaParts.join(' · ')}</span>` : ''}
            ${comprehensive.edited ? '<span class="ss-comp-edited">Edited</span>' : ''}
        </div>
        <div class="ss-comp-body">
            <div class="ss-comp-section">
                <label class="ss-field-label">Summary</label>
                <textarea class="ss-textarea" id="ss-comp-text" rows="10">${comprehensive.text || ''}</textarea>
            </div>
            <div class="ss-comp-section">
                <label class="ss-field-label">Quotes (${quoteCount})</label>
                <div class="ss-comp-quotes" id="ss-comp-quotes">
                    ${quoteCount > 0
                        ? comprehensive.quotes.map((q, i) => renderCompQuoteItem(q, i)).join('')
                        : '<div class="ss-empty-sm">No quotes selected</div>'}
                </div>
            </div>
        </div>
        <div class="ss-comp-footer">
            <button class="ss-btn ss-btn-accent" id="ss-comp-save"><i class="fa-solid fa-floppy-disk"></i> Save</button>
        </div>
    `;

    wireComprehensiveEvents(container, comprehensive);
}

function renderCompQuoteItem(quote, idx) {
    return `
        <div class="ss-comp-quote-item" data-index="${idx}">
            <span class="ss-comp-quote-speaker">${quote.speaker}</span>
            <span class="ss-comp-quote-text">"${quote.text}"</span>
            ${quote.context ? `<span class="ss-comp-quote-ctx">${quote.context}</span>` : ''}
        </div>`;
}

function wireComprehensiveEvents(container, comp) {
    container.querySelector('#ss-comp-regen')?.addEventListener('click', () => {
        getContext().executeSlashCommandsWithOptions('/summarizer-comprehensive');
    });

    container.querySelector('#ss-comp-delete')?.addEventListener('click', async () => {
        if (!confirm('Delete comprehensive summary?')) return;
        await clearComprehensiveSummary();
        toastr.success('Comprehensive summary deleted');
        renderContent();
    });

    container.querySelector('#ss-comp-save')?.addEventListener('click', async () => {
        const newText = container.querySelector('#ss-comp-text')?.value?.trim();
        if (newText) {
            await updateComprehensiveSummary({ text: newText, edited: true });
            toastr.success('Summary saved');
        }
    });
}

// ============================================================
// Tab: Archives
// ============================================================

async function renderArchivesTab(container) {
    const store = await getStore();
    const allSummaries = store?.summaries || {};
    const entries = Object.entries(allSummaries);

    const context = getContext();
    const hasChat = !!(context?.chatId);
    const caAssigned = hasChat ? getAssignedArchives() : [];
    const assignedSet = new Set(caAssigned.map(a => a.chatFilename));

    container.innerHTML = `
        <div class="ss-tab-header">
            <span class="ss-tab-title">Archives</span>
            <span class="ss-tab-subtitle">${entries.length} comprehensive summar${entries.length !== 1 ? 'ies' : 'y'} stored</span>
        </div>
        ${hasChat ? `
            <div class="ss-archives-section">
                <div class="ss-section-label">Context Archives for this Chat</div>
                <div class="ss-archives-assigned" id="ss-archives-assigned">
                    ${caAssigned.length === 0 ? '<div class="ss-empty-sm">No archives assigned to this chat</div>' : caAssigned.map((a, i) => {
                        const data = allSummaries[a.chatFilename] || {};
                        const date = data.lastGenerated ? new Date(data.lastGenerated).toLocaleDateString() : '';
                        const preview = data.text?.length > 50 ? data.text.substring(0, 47) + '...' : (data.text || '');
                        return `
                        <div class="ss-archive-assigned-row" data-filename="${escapeAttr(a.chatFilename)}">
                            <div class="ss-archive-reorder">
                                <button class="ss-btn-icon ss-archive-move" data-dir="up" ${i === 0 ? 'disabled' : ''}><i class="fa-solid fa-chevron-up"></i></button>
                                <button class="ss-btn-icon ss-archive-move" data-dir="down" ${i === caAssigned.length - 1 ? 'disabled' : ''}><i class="fa-solid fa-chevron-down"></i></button>
                            </div>
                            <span class="ss-archive-assigned-label">${escapeHtml(a.label)}</span>
                            <span class="ss-archive-assigned-meta">${date}${date && preview ? ' · ' : ''}${escapeHtml(preview)}</span>
                            <button class="ss-btn-icon ss-archive-remove" title="Remove"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    `;}).join('')}
                </div>
            </div>
            <div class="ss-divider"></div>
        ` : ''}
        <div class="ss-archives-section">
            <div class="ss-section-label">All Stored Summaries</div>
            <div class="ss-archives-list" id="ss-archives-list">
                ${entries.length === 0
                    ? '<div class="ss-empty">No comprehensive summaries stored yet</div>'
                    : entries.map(([filename, data]) => renderArchiveRow(filename, data, assignedSet, hasChat)).join('')}
            </div>
        </div>
    `;

    wireArchivesEvents(container);
}

function renderArchiveRow(filename, data, assignedSet, hasChat) {
    const isAssigned = assignedSet.has(filename);
    const charName = data.metadata?.character?.displayName || '';
    const date = data.lastGenerated ? new Date(data.lastGenerated).toLocaleDateString() : '';
    const preview = data.text?.length > 50 ? data.text.substring(0, 47) + '...' : (data.text || 'No text');
    const label = filename.replace(/\.jsonl$/, '').replace(/_/g, ' ');

    return `
        <div class="ss-archive-row ${isAssigned ? 'ss-archive-assigned' : ''}" data-filename="${escapeAttr(filename)}">
            <div class="ss-archive-row-info">
                <div class="ss-archive-row-title">${escapeHtml(label)}</div>
                <div class="ss-archive-row-meta">
                    ${charName ? `<span>${escapeHtml(charName)}</span>` : ''}
                    ${date ? `<span>${date}</span>` : ''}
                    ${isAssigned ? '<span class="ss-archive-tag">assigned</span>' : ''}
                </div>
                <div class="ss-archive-row-preview">${escapeHtml(preview)}</div>
            </div>
            ${hasChat && !isAssigned ? `<button class="ss-btn-icon ss-archive-assign" title="Assign to current chat"><i class="fa-solid fa-plus"></i></button>` : ''}
        </div>
    `;
}

function wireArchivesEvents(container) {
    // Context Archives assigned list: move/remove
    container.querySelector('#ss-archives-assigned')?.addEventListener('click', (e) => {
        const row = e.target.closest('.ss-archive-assigned-row');
        if (!row) return;
        const filename = row.dataset.filename;

        if (e.target.closest('.ss-archive-move')) {
            const dir = e.target.closest('.ss-archive-move').dataset.dir;
            moveArchive(filename, dir);
            updateContextArchivesPromptContent();
            renderContent();
            return;
        }

        if (e.target.closest('.ss-archive-remove')) {
            removeArchive(filename);
            updateContextArchivesPromptContent();
            renderContent();
        }
    });

    // All summaries list: assign
    container.querySelector('#ss-archives-list')?.addEventListener('click', (e) => {
        const assignBtn = e.target.closest('.ss-archive-assign');
        if (!assignBtn) return;
        const row = assignBtn.closest('.ss-archive-row');
        const filename = row?.dataset?.filename;
        if (!filename) return;
        const label = row.querySelector('.ss-archive-row-title')?.textContent || filename;
        if (assignArchive(filename, label)) {
            toastr.success('Archive assigned');
            updateContextArchivesPromptContent();
            renderContent();
        }
    });
}

// ============================================================
// Tab: Pinned Quotes
// ============================================================

function renderPinnedTab(container) {
    const context = getContext();
    if (!context?.chatId) {
        container.innerHTML = `<div class="ss-empty-state"><i class="fa-solid fa-comments"></i><p>Open a chat to view pinned quotes</p></div>`;
        return;
    }

    const pinned = getPinnedQuotes();
    const batches = getBatches();

    if (pinned.length === 0) {
        container.innerHTML = `
            <div class="ss-tab-header">
                <span class="ss-tab-title">Pinned Quotes</span>
            </div>
            <div class="ss-empty-state">
                <i class="fa-solid fa-thumbtack"></i>
                <p>No pinned quotes</p>
                <p class="ss-empty-hint">Pin quotes from the batch editor to keep them always included in context.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = `
        <div class="ss-tab-header">
            <span class="ss-tab-title">Pinned Quotes</span>
            <span class="ss-tab-subtitle">${pinned.length} quote${pinned.length !== 1 ? 's' : ''} — always in context</span>
        </div>
        <div class="ss-pinned-list" id="ss-pinned-list">
            ${pinned.map(pq => {
                const batch = batches[pq.batchIndex];
                const rangeLabel = batch ? `msgs ${batch.startIndex + 1}–${batch.endIndex + 1}` : '';
                return `
                <div class="ss-pinned-item" data-batch-id="${pq.batchId}" data-quote-index="${pq.quoteIndex}">
                    <div class="ss-pinned-item-header">
                        <span class="ss-pinned-speaker">${escapeHtml(pq.speaker)}</span>
                        <span class="ss-pinned-batch" title="${rangeLabel}">Batch ${pq.batchIndex + 1}</span>
                    </div>
                    <div class="ss-pinned-text">"${escapeHtml(pq.text)}"</div>
                    ${pq.context ? `<div class="ss-pinned-context">${escapeHtml(pq.context)}</div>` : ''}
                    <div class="ss-pinned-item-actions">
                        <button class="ss-btn-icon ss-pinned-unpin" title="Unpin"><i class="fa-solid fa-thumbtack"></i></button>
                    </div>
                </div>`;
            }).join('')}
        </div>
    `;

    wirePinnedEvents(container);
}

function wirePinnedEvents(container) {
    container.querySelector('#ss-pinned-list')?.addEventListener('click', async (e) => {
        const item = e.target.closest('.ss-pinned-item');
        if (!item) return;
        const batchId = item.dataset.batchId;
        const quoteIndex = parseInt(item.dataset.quoteIndex, 10);

        // Unpin
        if (e.target.closest('.ss-pinned-unpin')) {
            toggleQuotePin(batchId, quoteIndex);
            invalidateSummarizerPromptCache();
            updateSummarizerPromptContent();
            updateBatchVisuals();
            renderContent();
            return;
        }

        // Click anywhere else on the item → open batch editor
        const { showEditBatchDialog } = await import('./ui.js');
        showEditBatchDialog(batchId, renderContent);
    });
}

// ============================================================
// Tab: Settings
// ============================================================

function renderSettingsTab(container) {
    const context = getContext();
    const hasChat = !!(context?.chatId);
    const enabled = isEnabled();
    const auto = getSetting('auto');
    const autoBuffer = getSetting('autoBuffer');
    const batchSize = getSetting('batchSize');
    const lookBack = getSetting('lookBackBatches');
    const maxSummaries = getSetting('maxSummariesInContext');
    const alwaysFirst = getSetting('alwaysKeepFirstNBatches');
    const alwaysLast = getSetting('alwaysKeepLastNBatches');
    const exclusionMode = getSetting('messageExclusionMode');
    const exclusionBatches = getSetting('messageExclusionBatches');
    const exclusionMessages = getSetting('messageExclusionMessages');
    const showInChat = getSetting('showSummariesInChat');
    const displayStyle = getSetting('summaryDisplayStyle');
    const placement = getPromptSettings();
    const caPlacement = getCAPlacement();
    const caConfig = getCAConfig();

    const dropdownWidth = '170px';

    container.innerHTML = `
        <div class="ss-tab-header">
            <span class="ss-tab-title">Settings</span>
        </div>
        <div class="ss-settings">
            <!-- ===== GENERAL ===== -->
            <div class="ss-section-label"><i class="fa-solid fa-gears"></i> General</div>

            ${hasChat ? `
                <div class="ss-setting-item">
                    <div class="ss-setting-info"><div class="ss-setting-title">Enable Summarizer</div></div>
                    <label class="ss-toggle"><input type="checkbox" id="ss-enabled" ${enabled ? 'checked' : ''}><span class="ss-toggle-slider"></span></label>
                </div>
                <div class="ss-divider"></div>
            ` : `<div class="ss-no-chat-msg"><i class="fa-solid fa-info-circle"></i> Open a chat to enable chat-specific settings</div>`}

            <div class="ss-setting-item">
                <div class="ss-setting-info"><div class="ss-setting-title">Auto-Process Mode</div></div>
                <label class="ss-toggle"><input type="checkbox" id="ss-auto" ${auto ? 'checked' : ''}><span class="ss-toggle-slider"></span></label>
            </div>
            <div class="ss-divider"></div>

            <div class="ss-setting-item">
                <div class="ss-setting-info"><div class="ss-setting-title">Show Summaries in Chat</div></div>
                <label class="ss-toggle"><input type="checkbox" id="ss-show-chat" ${showInChat ? 'checked' : ''}><span class="ss-toggle-slider"></span></label>
            </div>
            <div class="ss-divider"></div>

            <div class="ss-setting-item">
                <div class="ss-setting-info"><div class="ss-setting-title">Display Style</div></div>
                <select class="ss-select" id="ss-display-style" style="width: ${dropdownWidth};">
                    <option value="minimal" ${displayStyle === 'minimal' ? 'selected' : ''}>Minimal (truncated)</option>
                    <option value="full" ${displayStyle === 'full' ? 'selected' : ''}>Full text</option>
                </select>
            </div>
            <div class="ss-divider"></div>

            <div class="ss-setting-item">
                <div class="ss-setting-info"><div class="ss-setting-title">Connection Profile</div></div>
                <select class="ss-select" id="ss-conn-profile" style="width: ${dropdownWidth};">
                    <option value="">Use current connection</option>
                </select>
            </div>

            <div class="ss-divider-section"></div>

            <!-- ===== BATCHES ===== -->
            <div class="ss-section-label"><i class="fa-solid fa-layer-group"></i> Batches</div>

            <div class="ss-grid-2col">
                <div class="ss-setting-item ss-grid-cell">
                    <div class="ss-setting-info"><div class="ss-setting-title">Batch Size</div></div>
                    <input type="number" class="ss-input-num" id="ss-batch-size" min="1" max="20" value="${batchSize}">
                </div>
                <div class="ss-setting-item ss-grid-cell ss-grid-cell-right">
                    <div class="ss-setting-info"><div class="ss-setting-title">Message Buffer</div></div>
                    <input type="number" class="ss-input-num" id="ss-buffer" min="0" max="10" value="${autoBuffer}">
                </div>
                <div class="ss-setting-item ss-grid-cell ss-grid-cell-bottom">
                    <div class="ss-setting-info"><div class="ss-setting-title">Context Look-back</div></div>
                    <input type="number" class="ss-input-num" id="ss-lookback" min="0" max="5" value="${lookBack}">
                </div>
                <div class="ss-setting-item ss-grid-cell ss-grid-cell-right ss-grid-cell-bottom">
                    <div class="ss-setting-info"><div class="ss-setting-title">Max in Context</div></div>
                    <input type="number" class="ss-input-num" id="ss-max-sum" min="3" max="50" value="${maxSummaries}">
                </div>
            </div>

            <div class="ss-divider-section"></div>

            <!-- ===== MESSAGE TRIMMING ===== -->
            <div class="ss-section-label"><i class="fa-solid fa-scissors"></i> Message Trimming</div>

            <div class="ss-setting-item-col">
                <div class="ss-setting-info"><div class="ss-setting-title">Start Trimming After</div></div>
                <div class="ss-exclusion-row">
                    <label class="ss-radio-label">
                        <input type="radio" name="ss-excl-mode" value="batches" ${exclusionMode === 'batches' ? 'checked' : ''}>
                        <input type="number" class="ss-input-sm" id="ss-excl-batches" min="1" max="100" value="${exclusionBatches}"> batches
                    </label>
                    <label class="ss-radio-label">
                        <input type="radio" name="ss-excl-mode" value="messages" ${exclusionMode === 'messages' ? 'checked' : ''}>
                        <input type="number" class="ss-input-sm" id="ss-excl-messages" min="1" max="1000" value="${exclusionMessages}"> messages
                    </label>
                </div>
            </div>

            <div class="ss-divider-section"></div>

            <!-- ===== PROMPT INJECTION ===== -->
            <div class="ss-section-label"><i class="fa-solid fa-syringe"></i> Prompt Injection</div>

            <div class="ss-setting-item">
                <div class="ss-setting-info"><div class="ss-setting-title">Include Batch Summaries</div></div>
                <label class="ss-toggle"><input type="checkbox" id="ss-include-prompts" ${placement.includeInPrompts !== false ? 'checked' : ''}><span class="ss-toggle-slider"></span></label>
            </div>

            <div id="ss-injection-details" ${placement.includeInPrompts !== false ? '' : 'style="display:none"'}>
                <div class="ss-grid-2col" style="margin-top: 6px;">
                    <div class="ss-setting-item ss-grid-cell">
                        <div class="ss-setting-info"><div class="ss-setting-title">Always Keep First</div></div>
                        <input type="number" class="ss-input-num" id="ss-first-n" min="1" max="10" value="${alwaysFirst}">
                    </div>
                    <div class="ss-setting-item ss-grid-cell ss-grid-cell-right">
                        <div class="ss-setting-info"><div class="ss-setting-title">Always Keep Last</div></div>
                        <input type="number" class="ss-input-num" id="ss-last-n" min="1" max="10" value="${alwaysLast}">
                    </div>
                </div>
            </div>

            <div class="ss-divider-section"></div>

            <!-- ===== CONTEXT ARCHIVES ===== -->
            <div class="ss-section-label"><i class="fa-solid fa-box-archive"></i> Context Archives</div>

            <div class="ss-setting-item">
                <div class="ss-setting-info"><div class="ss-setting-title">Inject Context Archives</div></div>
                <label class="ss-toggle"><input type="checkbox" id="ss-ca-enabled" ${caPlacement.includeInPrompts ? 'checked' : ''}><span class="ss-toggle-slider"></span></label>
            </div>

            <div id="ss-ca-details" ${caPlacement.includeInPrompts ? '' : 'style="display:none"'}>
                <div class="ss-divider"></div>
                <div class="ss-grid-2col" style="margin-top: 6px;">
                    <div class="ss-setting-item ss-grid-cell">
                        <div class="ss-setting-info"><div class="ss-setting-title">Max Tokens</div></div>
                        <input type="number" class="ss-input-num" id="ss-ca-tokens" min="500" max="10000" value="${caConfig.maxTokens}">
                    </div>
                    <div class="ss-setting-item ss-grid-cell ss-grid-cell-right">
                        <div class="ss-setting-info"><div class="ss-setting-title">Overflow Strategy</div></div>
                        <select class="ss-select" id="ss-ca-overflow" style="width: ${dropdownWidth};">
                            <option value="priority" ${caConfig.overflowStrategy === 'priority' ? 'selected' : ''}>Priority (top first)</option>
                            <option value="balanced" ${caConfig.overflowStrategy === 'balanced' ? 'selected' : ''}>Balanced (equal trim)</option>
                            <option value="contextWeighted" ${caConfig.overflowStrategy === 'contextWeighted' ? 'selected' : ''}>Context-weighted</option>
                        </select>
                    </div>
                </div>
            </div>
        </div>
    `;

    wireSettingsEvents(container);
    populateConnectionProfiles();
}

function renderNumberSetting(title, desc, id, value, min, max) {
    return `
        <div class="ss-setting-item">
            <div class="ss-setting-info">
                <div class="ss-setting-title">${title}</div>
                ${desc ? `<div class="ss-setting-desc">${desc}</div>` : ''}
            </div>
            <input type="number" class="ss-input-num" id="${id}" min="${min}" max="${max}" value="${value}">
        </div>`;
}

function wireSettingsEvents(container) {
    const $ = (sel) => container.querySelector(sel);

    // Toggles
    $('#ss-enabled')?.addEventListener('change', (e) => toggleEnabled(e.target.checked));
    $('#ss-auto')?.addEventListener('change', (e) => setSetting('auto', e.target.checked));

    // Numbers
    const numHandler = (id, key, min, max) => {
        $(id)?.addEventListener('change', (e) => {
            const v = Math.max(min, Math.min(max, parseInt(e.target.value) || min));
            setSetting(key, v); e.target.value = v;
        });
    };
    numHandler('#ss-buffer', 'autoBuffer', 0, 10);
    numHandler('#ss-batch-size', 'batchSize', 1, 20);
    numHandler('#ss-lookback', 'lookBackBatches', 0, 5);
    numHandler('#ss-max-sum', 'maxSummariesInContext', 3, 50);
    numHandler('#ss-first-n', 'alwaysKeepFirstNBatches', 1, 10);
    numHandler('#ss-last-n', 'alwaysKeepLastNBatches', 1, 10);

    // Exclusion mode
    container.querySelectorAll('input[name="ss-excl-mode"]').forEach(r => {
        r.addEventListener('change', () => setSetting('messageExclusionMode', r.value));
    });
    $('#ss-excl-batches')?.addEventListener('change', (e) => {
        const v = Math.max(1, Math.min(100, parseInt(e.target.value) || 4));
        setSetting('messageExclusionBatches', v); e.target.value = v;
    });
    $('#ss-excl-messages')?.addEventListener('change', (e) => {
        const v = Math.max(1, Math.min(1000, parseInt(e.target.value) || 24));
        setSetting('messageExclusionMessages', v); e.target.value = v;
    });

    // Prompt injection toggle
    $('#ss-include-prompts')?.addEventListener('change', async (e) => {
        setPromptSetting('includeInPrompts', e.target.checked);
        const details = container.querySelector('#ss-injection-details');
        if (details) details.style.display = e.target.checked ? '' : 'none';
        await refreshSummarizerPrompt();
    });

    // Display
    $('#ss-show-chat')?.addEventListener('change', (e) => {
        setSetting('showSummariesInChat', e.target.checked);
        updateBatchVisuals();
    });
    $('#ss-display-style')?.addEventListener('change', (e) => {
        setSetting('summaryDisplayStyle', e.target.value);
        updateBatchVisuals();
    });

    // Context Archives
    $('#ss-ca-enabled')?.addEventListener('change', (e) => {
        setCAPlacement('includeInPrompts', e.target.checked);
        const details = container.querySelector('#ss-ca-details');
        if (details) details.style.display = e.target.checked ? '' : 'none';
        updateContextArchivesPromptContent();
    });
    $('#ss-ca-tokens')?.addEventListener('change', (e) => {
        const v = Math.max(500, Math.min(10000, parseInt(e.target.value) || 2000));
        setCAConfig('maxTokens', v); e.target.value = v;
        updateContextArchivesPromptContent();
    });
    $('#ss-ca-overflow')?.addEventListener('change', (e) => {
        setCAConfig('overflowStrategy', e.target.value);
        updateContextArchivesPromptContent();
    });

    // Connection profile
    $('#ss-conn-profile')?.addEventListener('change', (e) => setSetting('connectionProfile', e.target.value));
}

async function populateConnectionProfiles() {
    const select = document.getElementById('ss-conn-profile');
    if (!select) return;
    try {
        const ctx = getContext();
        const result = await ctx.executeSlashCommandsWithOptions('/profile-list');
        const profiles = JSON.parse(result.pipe);
        const current = getSetting('connectionProfile');
        profiles.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name; opt.textContent = name;
            if (name === current) opt.selected = true;
            select.appendChild(opt);
        });
    } catch { /* profiles not available */ }
}

// ============================================================
// Utilities
// ============================================================

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
