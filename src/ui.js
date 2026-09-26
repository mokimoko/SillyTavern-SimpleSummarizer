/**
 * ui.js — Batch visuals, dialogs, progress for Summarizer (standalone)
 */
import { getContext } from '../../../../extensions.js';
import { tags } from '../../../../tags.js';
import {
    getBatches,
    updateBatch,
    deleteBatch,
    getSetting,
    getBatchesToInject,
    toggleQuotePin,
} from './storage.js';
import {
    CARD_DELIVERY_MODES,
    KEYWORD_AUTO_MAX_IMPORTANCE,
    KNOWLEDGE_MODES,
    TAG_DELIVERY_MODES,
    getBatchMemoryPolicy,
    normalizeKeywords,
    normalizeKnowledge,
    normalizeRestriction,
} from './memoryPolicy.js';
import { regenerateBatch } from './generator.js';
import { normalizeCharacterMemories } from './characterMemories.js';
import { renderCharacterMemoryEditor, setupCharacterMemoryEditor } from './characterMemoryEditor.js';
import { getRecentSceneQuery, invalidateSummarizerPromptCache, updateSummarizerPromptContent } from './promptInjection.js';

function getMessageDiv(index) {
    return $(`#chat .mes[mesid="${index}"]`);
}

let batchVisualTimer = null;

/** Coalesce MESSAGE_RENDERED bursts while a chat is being populated. */
export function scheduleBatchVisualUpdate(delay = 50) {
    if (batchVisualTimer) clearTimeout(batchVisualTimer);
    batchVisualTimer = setTimeout(() => {
        batchVisualTimer = null;
        updateBatchVisuals();
    }, delay);
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
    const injectedBatches = getBatchesToInject(getContext().chat.length, getRecentSceneQuery());
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

        let $indicator = $messageDiv.find('.batch-summary-indicator').filter(function () {
            return $(this).attr('data-batch-id') === String(batch.id);
        });

        if ($indicator.length > 0) {
            $indicator.attr('class', `batch-summary-indicator ${isInjected ? 'batch-injected' : ''} ${isDirty ? 'batch-dirty' : ''}`);
            $indicator.find('.batch-label').html(`Batch ${index + 1}${typeLabel} ${injectedIndicator} ${statusIcon} ${quoteIndicator}`);
            $indicator.find('.batch-summary-text').text(summaryText);
        } else {
            $indicator = $(`
                <div class="batch-summary-indicator ${isInjected ? 'batch-injected' : ''} ${isDirty ? 'batch-dirty' : ''}" data-batch-id="${escapeHtmlValue(batch.id)}">
                    <div class="batch-header">
                        <span class="batch-label">Batch ${index + 1}${typeLabel} ${injectedIndicator} ${statusIcon} ${quoteIndicator}</span>
                        <div class="batch-actions">
                            <button class="batch-btn batch-edit-btn" title="Edit summary"><i class="fa-solid fa-pen"></i></button>
                            <button class="batch-btn batch-regenerate-btn" title="Regenerate summary"><i class="fa-solid fa-refresh"></i></button>
                            <button class="batch-btn batch-delete-btn" title="Delete summary"><i class="fa-solid fa-trash"></i></button>
                        </div>
                    </div>
                    <div class="batch-summary-text"></div>
                </div>
            `);
            $indicator.find('.batch-summary-text').text(summaryText);
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

    const knowledge = normalizeKnowledge(batch.knowledge);
    const restriction = normalizeRestriction(batch.restriction);
    const characterMemories = normalizeCharacterMemories(batch.characterMemories);
    const importance = Number.isFinite(batch.importance) ? Math.max(1, Math.min(10, Math.round(batch.importance))) : 5;
    const memoryPolicy = getBatchMemoryPolicy(batch);
    const foundationKeywordProtection = memoryPolicy.keywordProtectionReason === 'foundation';

    let quotesHTML = '';
    if (batch.quotes && batch.quotes.length > 0) {
        quotesHTML = batch.quotes.map((quote, idx) => buildQuoteItemHTML(quote, idx)).join('');
    } else {
        quotesHTML = '<p class="summarizer-empty-quotes">No memorable quotes in this batch</p>';
    }

    const overlay = createModal(`Edit Batch ${batchIndex + 1} <span class="notes" style="font-weight: 400; margin-left: 8px;">Messages ${batch.startIndex + 1}–${batch.endIndex + 1}</span>`, `
        <div class="summarizer-batch-editor-grid">
            <section class="summarizer-batch-editor-main">
                <div class="summarizer-editor-section-header">
                    <label for="summarizer-edit-textarea"><strong>Summary</strong></label>
                </div>
                <textarea id="summarizer-edit-textarea" class="text_pole" rows="10"></textarea>

                ${renderCharacterMemoryEditor()}

                <div class="summarizer-memory-panel">
                    <div class="summarizer-memory-panel-title"><i class="fa-solid fa-brain"></i> Advanced Whole-Batch Behavior</div>
                    <div class="summarizer-memory-hint">These legacy controls scope the entire batch. Prefer character memories above for private details.</div>

                    <div class="summarizer-memory-field">
                        <div class="summarizer-memory-label-row">
                            <label for="summarizer-importance"><strong>Importance</strong></label>
                            <output id="summarizer-importance-value">${importance}</output>
                        </div>
                        <input id="summarizer-importance" class="summarizer-importance" type="range" min="1" max="10" step="1" value="${importance}">
                        <div class="summarizer-memory-hint">1 = background detail · 5 = notable · 10 = story-defining${batch.importanceManual ? ' · manually set' : ''}</div>
                    </div>

                    <div class="summarizer-memory-field">
                        <label class="summarizer-inline-toggle">
                            <input id="summarizer-keyword-activated" type="checkbox" ${memoryPolicy.keywordActivated ? 'checked' : ''} ${foundationKeywordProtection ? 'disabled' : ''}>
                            <span><strong>Only recall when a keyword is mentioned</strong></span>
                        </label>
                        <div class="summarizer-memory-hint" id="summarizer-keyword-policy-note"></div>
                        <div id="summarizer-keyword-field" class="summarizer-keyword-field">
                            <label for="summarizer-keywords">Keywords</label>
                            <input id="summarizer-keywords" class="text_pole" type="text" placeholder="Comma-separated keywords and phrases">
                            <div class="summarizer-memory-hint" id="summarizer-keyword-status"></div>
                        </div>
                    </div>

                    <div class="summarizer-memory-field">
                        <div class="summarizer-memory-two-column">
                            <div>
                                <label for="summarizer-knowledge-mode"><strong>Character knowledge</strong></label>
                                <select id="summarizer-knowledge-mode" class="text_pole summarizer-memory-select">
                                    <option value="${KNOWLEDGE_MODES.UNRESTRICTED}" ${knowledge.mode === KNOWLEDGE_MODES.UNRESTRICTED ? 'selected' : ''}>Everyone</option>
                                    <option value="${KNOWLEDGE_MODES.NARRATOR}" ${knowledge.mode === KNOWLEDGE_MODES.NARRATOR ? 'selected' : ''}>Narrator only</option>
                                    <option value="${KNOWLEDGE_MODES.SELECTED}" ${knowledge.mode === KNOWLEDGE_MODES.SELECTED ? 'selected' : ''}>Selected characters</option>
                                </select>
                            </div>
                            ${buildCharacterPicker('summarizer-knowledge-picker', 'Characters', 'summarizer-known-card', knowledge.characters, false)}
                        </div>
                        <div id="summarizer-known-names-row" class="summarizer-npc-row">
                            <label for="summarizer-known-names">Additional in-story NPC names</label>
                            <input id="summarizer-known-names" class="text_pole" type="text" placeholder="Comma-separated names without character cards">
                        </div>
                        <div class="summarizer-memory-note" aria-live="polite">
                            <i class="fa-solid fa-shield-halved"></i>
                            <span id="summarizer-knowledge-note"></span>
                        </div>
                    </div>

                    <details class="summarizer-delivery-overrides" id="summarizer-delivery-overrides">
                        <summary>
                            <span>Delivery overrides</span>
                            <span class="summarizer-delivery-summary">
                                <span id="summarizer-delivery-status">Automatic</span>
                                <i class="fa-solid fa-chevron-down"></i>
                            </span>
                        </summary>
                        <div class="summarizer-delivery-controls">
                            <div class="summarizer-delivery-row">
                                <div>
                                    <label for="summarizer-card-mode">Character-card delivery</label>
                                    <select id="summarizer-card-mode" class="text_pole summarizer-memory-select">
                                        <option value="${CARD_DELIVERY_MODES.AUTO}" ${restriction.cardMode === CARD_DELIVERY_MODES.AUTO ? 'selected' : ''}>Automatic from knowledge</option>
                                        <option value="${CARD_DELIVERY_MODES.ANY}" ${restriction.cardMode === CARD_DELIVERY_MODES.ANY ? 'selected' : ''}>Any character card</option>
                                        <option value="${CARD_DELIVERY_MODES.ONLY}" ${restriction.cardMode === CARD_DELIVERY_MODES.ONLY ? 'selected' : ''}>Only selected cards</option>
                                        <option value="${CARD_DELIVERY_MODES.EXCLUDE}" ${restriction.cardMode === CARD_DELIVERY_MODES.EXCLUDE ? 'selected' : ''}>Every card except selected</option>
                                    </select>
                                </div>
                                ${buildCharacterPicker('summarizer-delivery-card-picker', 'Cards', 'summarizer-restrict-card', restriction.characters, true)}
                            </div>
                            <div class="summarizer-delivery-row">
                                <div>
                                    <label for="summarizer-tag-mode">Tag delivery</label>
                                    <select id="summarizer-tag-mode" class="text_pole summarizer-memory-select">
                                        <option value="${TAG_DELIVERY_MODES.ANY}" ${restriction.tagMode === TAG_DELIVERY_MODES.ANY ? 'selected' : ''}>Any tag</option>
                                        <option value="${TAG_DELIVERY_MODES.ONLY}" ${restriction.tagMode === TAG_DELIVERY_MODES.ONLY ? 'selected' : ''}>Only selected tags</option>
                                        <option value="${TAG_DELIVERY_MODES.EXCLUDE}" ${restriction.tagMode === TAG_DELIVERY_MODES.EXCLUDE ? 'selected' : ''}>Every tag except selected</option>
                                    </select>
                                </div>
                                ${buildTagPicker('summarizer-delivery-tag-picker', 'Tags', restriction.tags)}
                            </div>
                            <div class="summarizer-memory-hint summarizer-delivery-rule">Card and tag rules both apply; a responding card must pass both.</div>
                            <div class="summarizer-memory-hint" id="summarizer-delivery-warning"></div>
                        </div>
                    </details>
                </div>
            </section>

            <section class="summarizer-batch-editor-quotes">
                <div class="summarizer-editor-section-header">
                    <label><strong>Memorable Quotes</strong></label>
                    <button id="summarizer-add-quote" class="menu_button"><i class="fa-solid fa-plus"></i> Add Quote</button>
                </div>
                <div id="summarizer-quotes-container">${quotesHTML}</div>
            </section>
        </div>
    `, [
        { label: '<i class="fa-solid fa-floppy-disk"></i> Save', class: 'summarizer-modal-save' },
        { label: 'Cancel', class: 'summarizer-modal-cancel' },
    ], 'summarizer-batch-editor-modal');

    overlay.querySelector('#summarizer-edit-textarea').value = batch.summary || '';
    overlay.querySelector('#summarizer-keywords').value = normalizeKeywords(batch.keywords).join(', ');
    overlay.querySelector('#summarizer-known-names').value = knowledge.names.join(', ');
    const characterMemoryEditor = setupCharacterMemoryEditor(overlay, characterMemories);

    const importanceInput = overlay.querySelector('#summarizer-importance');
    const importanceOutput = overlay.querySelector('#summarizer-importance-value');
    let keywordChoiceChanged = false;
    importanceInput.addEventListener('input', () => {
        importanceOutput.value = importanceInput.value;
        if (!foundationKeywordProtection && !keywordChoiceChanged && batch.keywordActivationManual !== true) {
            overlay.querySelector('#summarizer-keyword-activated').checked = memoryPolicy.keywordRequested
                && Number(importanceInput.value) <= KEYWORD_AUTO_MAX_IMPORTANCE;
        }
        refreshConditionalFields();
    });

    const selectedValues = (selector) => [...overlay.querySelectorAll(`${selector}:checked`)].map(input => input.value);
    let refreshConditionalFields = () => {};
    const knowledgePicker = setupMemoryPicker(
        overlay,
        'summarizer-knowledge-picker',
        '.summarizer-known-card',
        () => overlay.querySelector('#summarizer-knowledge-mode').value === KNOWLEDGE_MODES.SELECTED,
        'Choose characters…',
        () => refreshConditionalFields(),
    );
    const deliveryCardPicker = setupMemoryPicker(
        overlay,
        'summarizer-delivery-card-picker',
        '.summarizer-restrict-card',
        () => [CARD_DELIVERY_MODES.ONLY, CARD_DELIVERY_MODES.EXCLUDE].includes(overlay.querySelector('#summarizer-card-mode').value),
        'Choose characters…',
        () => refreshConditionalFields(),
    );
    const deliveryTagPicker = setupMemoryPicker(
        overlay,
        'summarizer-delivery-tag-picker',
        '.summarizer-restrict-tag',
        () => [TAG_DELIVERY_MODES.ONLY, TAG_DELIVERY_MODES.EXCLUDE].includes(overlay.querySelector('#summarizer-tag-mode').value),
        'Choose tags…',
        () => refreshConditionalFields(),
    );

    refreshConditionalFields = () => {
        const keywordActive = overlay.querySelector('#summarizer-keyword-activated').checked;
        const keywordCount = normalizeKeywords(overlay.querySelector('#summarizer-keywords').value).length;
        const keywordStatus = overlay.querySelector('#summarizer-keyword-status');
        const keywordPolicyNote = overlay.querySelector('#summarizer-keyword-policy-note');
        overlay.querySelector('#summarizer-keyword-field').hidden = !keywordActive;
        keywordStatus.textContent = keywordActive && keywordCount === 0
            ? 'No keywords added — this batch remains always active.'
            : `${keywordCount} keyword${keywordCount === 1 ? '' : 's'}`;
        keywordStatus.classList.toggle('summarizer-memory-warning', keywordActive && keywordCount === 0);
        if (foundationKeywordProtection) {
            keywordPolicyNote.textContent = 'Setup and past-history batches are always active so the story keeps its foundation and chronology.';
        } else if (!keywordChoiceChanged && batch.keywordActivationManual !== true
            && Number(importanceInput.value) > KEYWORD_AUTO_MAX_IMPORTANCE) {
            keywordPolicyNote.textContent = `Safety rule: automatic keyword-only recall is limited to importance 1–${KEYWORD_AUTO_MAX_IMPORTANCE}. This batch remains normally recalled; checking the option yourself overrides that rule.`;
        } else {
            keywordPolicyNote.textContent = `Automatic keyword-only recall is reserved for nonessential batches (importance 1–${KEYWORD_AUTO_MAX_IMPORTANCE}). A manual choice is respected.`;
        }

        const knowledgeMode = overlay.querySelector('#summarizer-knowledge-mode').value;
        const knowledgeCards = selectedValues('.summarizer-known-card');
        overlay.querySelector('#summarizer-known-names-row').hidden = knowledgeMode !== KNOWLEDGE_MODES.SELECTED;
        knowledgePicker.refresh();
        const knowledgeNames = knowledgeCards.map(getCharacterDisplayName);
        const knowledgeNote = overlay.querySelector('#summarizer-knowledge-note');
        if (knowledgeMode === KNOWLEDGE_MODES.UNRESTRICTED) {
            knowledgeNote.textContent = 'Automatic delivery: every responding character card receives this memory.';
        } else if (knowledgeMode === KNOWLEDGE_MODES.NARRATOR) {
            knowledgeNote.textContent = 'Narrator-only is instruction-based; characters are told not to act as though they know this memory.';
        } else if (knowledgeCards.length > 0) {
            knowledgeNote.textContent = `Automatic delivery: only ${knowledgeNames.join(', ')} receive this memory. Additional NPC names are instructions inside those receiving cards.`;
        } else {
            knowledgeNote.textContent = 'With no actual card selected, NPC-name knowledge is instruction-only and the memory remains available to any card.';
        }

        const cardMode = overlay.querySelector('#summarizer-card-mode').value;
        const tagMode = overlay.querySelector('#summarizer-tag-mode').value;
        deliveryCardPicker.refresh();
        deliveryTagPicker.refresh();
        overlay.querySelector('#summarizer-delivery-status').textContent = cardMode === CARD_DELIVERY_MODES.AUTO
            && tagMode === TAG_DELIVERY_MODES.ANY ? 'Automatic' : 'Customized';

        const warnings = [];
        if (cardMode === CARD_DELIVERY_MODES.ONLY && selectedValues('.summarizer-restrict-card').length === 0) {
            warnings.push('Only selected cards has no cards selected, so this memory will not be delivered.');
        }
        if (tagMode === TAG_DELIVERY_MODES.ONLY && selectedValues('.summarizer-restrict-tag').length === 0) {
            warnings.push('Only selected tags has no tags selected, so this memory will not be delivered.');
        }
        const deliveryWarning = overlay.querySelector('#summarizer-delivery-warning');
        deliveryWarning.textContent = warnings.join(' ');
        deliveryWarning.classList.toggle('summarizer-memory-warning', warnings.length > 0);
    };
    overlay.querySelector('#summarizer-keyword-activated').addEventListener('change', () => {
        keywordChoiceChanged = true;
        refreshConditionalFields();
    });
    overlay.querySelector('#summarizer-keywords').addEventListener('input', refreshConditionalFields);
    overlay.querySelector('#summarizer-knowledge-mode').addEventListener('change', refreshConditionalFields);
    overlay.querySelector('#summarizer-card-mode').addEventListener('change', refreshConditionalFields);
    overlay.querySelector('#summarizer-tag-mode').addEventListener('change', refreshConditionalFields);
    refreshConditionalFields();

    setupQuoteHandlers(overlay, '#summarizer-quotes-container', '#summarizer-add-quote', batchId);

    overlay.querySelector('.summarizer-modal-save').addEventListener('click', () => {
        const newSummary = overlay.querySelector('#summarizer-edit-textarea').value.trim();
        const newQuotes = collectQuotes(overlay);
        const newImportance = Math.max(1, Math.min(10, parseInt(importanceInput.value, 10) || 5));
        const newKeywords = normalizeKeywords(overlay.querySelector('#summarizer-keywords').value);
        const newCharacterMemories = characterMemoryEditor.collect();
        const characterMemoriesChanged = JSON.stringify(newCharacterMemories) !== JSON.stringify(characterMemories);
        const newKnowledge = normalizeKnowledge({
            mode: overlay.querySelector('#summarizer-knowledge-mode').value,
            characters: selectedValues('.summarizer-known-card'),
            names: normalizeKeywords(overlay.querySelector('#summarizer-known-names').value),
        });
        const newRestriction = normalizeRestriction({
            cardMode: overlay.querySelector('#summarizer-card-mode').value,
            characters: selectedValues('.summarizer-restrict-card'),
            tagMode: overlay.querySelector('#summarizer-tag-mode').value,
            tags: selectedValues('.summarizer-restrict-tag'),
        });
        if (newSummary) {
            updateBatch(batchId, {
                summary: newSummary,
                quotes: newQuotes,
                importance: newImportance,
                importanceManual: batch.importanceManual === true || newImportance !== importance,
                keywords: newKeywords,
                keywordsManuallyEdited: batch.keywordsManuallyEdited === true
                    || JSON.stringify(newKeywords) !== JSON.stringify(normalizeKeywords(batch.keywords)),
                characterMemories: newCharacterMemories,
                characterMemoriesManuallyEdited: batch.characterMemoriesManuallyEdited === true
                    || characterMemoriesChanged,
                keywordActivated: overlay.querySelector('#summarizer-keyword-activated').checked,
                keywordActivationManual: batch.keywordActivationManual === true || keywordChoiceChanged,
                knowledge: newKnowledge,
                restriction: newRestriction,
                edited: true,
                dirty: false,
            });
            invalidateSummarizerPromptCache();
            updateSummarizerPromptContent();
            updateBatchVisuals();
            onSave?.();
            toastr.success('Batch summary updated');
        }
        overlay.remove();
    });

    overlay.querySelector('.summarizer-modal-cancel').addEventListener('click', () => overlay.remove());
}

function escapeHtmlValue(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function getCharacterChoices() {
    const characters = getContext().characters || [];
    const seen = new Set();
    return characters.filter(character => {
        const stem = String(character?.avatar || '').replace(/\.[^/.]+$/, '');
        const key = stem.toLocaleLowerCase();
        if (!stem || seen.has(key)) return false;
        seen.add(key);
        return true;
    }).map(character => ({
        avatar: character.avatar,
        stem: String(character.avatar).replace(/\.[^/.]+$/, ''),
        name: character.name || character.avatar,
    })).sort((a, b) => a.name.localeCompare(b.name));
}

function cleanAvatar(value) {
    return String(value ?? '').replace(/\.[^/.]+$/, '').toLocaleLowerCase();
}

function getCharacterDisplayName(value) {
    const key = cleanAvatar(value);
    return getCharacterChoices().find(character => cleanAvatar(character.avatar) === key)?.name || String(value);
}

function buildPickerShell(id, label, inputClass, optionsHTML, emptyLabel) {
    return `
        <div class="summarizer-picker" id="${id}">
            <label>${label}</label>
            <button type="button" class="summarizer-picker-button" id="${id}-button" aria-expanded="false">
                <span class="summarizer-picker-button-content">
                    <span class="summarizer-picker-thumbnails" id="${id}-thumbnails"></span>
                    <span class="summarizer-picker-label" id="${id}-label">${emptyLabel}</span>
                </span>
                <i class="fa-solid fa-chevron-down"></i>
            </button>
            <div class="summarizer-picker-panel" id="${id}-panel">
                <div class="summarizer-picker-search">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="text" class="text_pole" placeholder="Search ${label.toLocaleLowerCase()}…" aria-label="Search ${label.toLocaleLowerCase()}">
                </div>
                <div class="summarizer-picker-options" data-input-class="${inputClass}">${optionsHTML}</div>
            </div>
        </div>`;
}

function buildCharacterPicker(id, label, className, selected, useStem) {
    const selectedSet = new Set((selected || []).map(cleanAvatar));
    const choices = getCharacterChoices();
    const options = choices.length === 0
        ? '<span class="summarizer-memory-empty">No character cards loaded</span>'
        : choices.map(character => {
            const value = useStem ? character.stem : character.avatar;
            const avatarUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`;
            return `
                <label class="summarizer-picker-option" data-search="${escapeHtmlValue(character.name.toLocaleLowerCase())}">
                    <input class="${className}" type="checkbox" value="${escapeHtmlValue(value)}" data-label="${escapeHtmlValue(character.name)}" data-avatar="${escapeHtmlValue(character.avatar)}" ${selectedSet.has(cleanAvatar(value)) ? 'checked' : ''}>
                    <img src="${avatarUrl}" alt="">
                    <span>${escapeHtmlValue(character.name)}</span>
                    <i class="fa-solid fa-check"></i>
                </label>`;
        }).join('');
    return buildPickerShell(id, label, className, options, 'Choose characters…');
}

function buildTagPicker(id, label, selected) {
    const selectedSet = new Set((selected || []).map(value => String(value)));
    const choices = [...(tags || [])].filter(tag => tag?.id).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
    const options = choices.length === 0
        ? '<span class="summarizer-memory-empty">No tags available</span>'
        : choices.map(tag => {
            const name = String(tag.name || tag.id);
            return `
                <label class="summarizer-picker-option" data-search="${escapeHtmlValue(name.toLocaleLowerCase())}">
                    <input class="summarizer-restrict-tag" type="checkbox" value="${escapeHtmlValue(tag.id)}" data-label="${escapeHtmlValue(name)}" ${selectedSet.has(String(tag.id)) ? 'checked' : ''}>
                    <span>${escapeHtmlValue(name)}</span>
                    <i class="fa-solid fa-check"></i>
                </label>`;
        }).join('');
    return buildPickerShell(id, label, 'summarizer-restrict-tag', options, 'Choose tags…');
}

function setupMemoryPicker(overlay, id, inputSelector, enabled, emptyLabel, onChange) {
    const wrapper = overlay.querySelector(`#${id}`);
    const button = overlay.querySelector(`#${id}-button`);
    const panel = overlay.querySelector(`#${id}-panel`);
    const label = overlay.querySelector(`#${id}-label`);
    const thumbnails = overlay.querySelector(`#${id}-thumbnails`);
    const search = panel.querySelector('.summarizer-picker-search input');

    const close = () => {
        panel.classList.remove('is-open');
        button.setAttribute('aria-expanded', 'false');
    };
    const refresh = () => {
        const isEnabled = enabled();
        button.disabled = !isEnabled;
        wrapper.classList.toggle('is-disabled', !isEnabled);
        if (!isEnabled) close();

        const selected = [...overlay.querySelectorAll(`${inputSelector}:checked`)];
        const names = selected.map(input => input.dataset.label || input.value);
        label.textContent = names.length === 0
            ? emptyLabel
            : (names.length <= 2 ? names.join(', ') : `${names.length} selected`);
        thumbnails.innerHTML = selected
            .filter(input => input.dataset.avatar)
            .slice(0, 4)
            .map(input => `<img src="/thumbnail?type=avatar&file=${encodeURIComponent(input.dataset.avatar)}" alt="">`)
            .join('');
    };

    button.addEventListener('click', (event) => {
        event.stopPropagation();
        if (button.disabled) return;
        const willOpen = !panel.classList.contains('is-open');
        overlay.querySelectorAll('.summarizer-picker-panel.is-open').forEach(openPanel => openPanel.classList.remove('is-open'));
        overlay.querySelectorAll('.summarizer-picker-button[aria-expanded="true"]').forEach(openButton => openButton.setAttribute('aria-expanded', 'false'));
        if (willOpen) {
            panel.classList.add('is-open');
            button.setAttribute('aria-expanded', 'true');
            search.value = '';
            panel.querySelectorAll('.summarizer-picker-option').forEach(option => { option.hidden = false; });
            requestAnimationFrame(() => search.focus());
        }
    });
    panel.addEventListener('click', event => event.stopPropagation());
    overlay.addEventListener('click', close);
    search.addEventListener('input', () => {
        const query = search.value.trim().toLocaleLowerCase();
        panel.querySelectorAll('.summarizer-picker-option').forEach(option => {
            option.hidden = !!query && !String(option.dataset.search || '').includes(query);
        });
    });
    overlay.querySelectorAll(inputSelector).forEach(input => input.addEventListener('change', () => {
        refresh();
        onChange?.();
    }));
    refresh();
    return { refresh, close };
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
            <input type="text" class="text_pole summarizer-quote-speaker" placeholder="Speaker" value="${escapeHtmlValue(quote.speaker)}">
            <button class="summarizer-quote-pin${isPinned ? ' pinned' : ''}" title="${isPinned ? 'Unpin quote' : 'Pin quote — always include in context'}">
                <i class="fa-solid fa-thumbtack"></i>
            </button>
            <textarea class="text_pole summarizer-quote-text" placeholder="Quote text" rows="2">${escapeHtmlValue(quote.text)}</textarea>
            <input type="text" class="text_pole summarizer-quote-context" placeholder="Brief context" value="${escapeHtmlValue(quote.context)}">
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
