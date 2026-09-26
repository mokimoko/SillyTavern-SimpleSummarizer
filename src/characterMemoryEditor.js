import { getContext } from '../../../../extensions.js';
import { tags } from '../../../../tags.js';
import { getGroupInfo } from './utils.js';
import {
    CHARACTER_MEMORY_DELIVERY,
    normalizeCharacterMemory,
    normalizeCharacterMemories,
    normalizeIdentityNames,
} from './characterMemories.js';
import { normalizeRestriction, TAG_DELIVERY_MODES } from './memoryPolicy.js';

const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function getCardChoices(selectedCards = []) {
    const context = getContext();
    const groupInfo = getGroupInfo();
    const active = groupInfo
        ? groupInfo.members
        : [context.characters?.[context.characterId]].filter(Boolean);
    const selected = new Set(selectedCards.map(value => String(value).replace(/\.[^/.]+$/, '').toLocaleLowerCase()));
    const choices = [...active];
    for (const character of context.characters || []) {
        const stem = String(character?.avatar || '').replace(/\.[^/.]+$/, '').toLocaleLowerCase();
        if (selected.has(stem) && !choices.some(item => item.avatar === character.avatar)) choices.push(character);
    }
    const seen = new Set();
    return choices.filter(character => {
        const stem = String(character?.avatar || '').replace(/\.[^/.]+$/, '').toLocaleLowerCase();
        if (!stem || seen.has(stem)) return false;
        seen.add(stem);
        return true;
    });
}

function buildChoicePicker(label, optionHtml, emptyLabel, kind) {
    return `
        <div class="summarizer-picker summarizer-character-memory-picker" data-picker-kind="${kind}">
            <span class="summarizer-character-memory-picker-label">${label}</span>
            <button type="button" class="summarizer-picker-button" aria-expanded="false" aria-haspopup="listbox">
                <span class="summarizer-picker-button-content">
                    <span class="summarizer-picker-thumbnails"></span>
                    <span class="summarizer-picker-label" data-empty-label="${escapeHtml(emptyLabel)}">${escapeHtml(emptyLabel)}</span>
                </span>
                <i class="fa-solid fa-chevron-down"></i>
            </button>
            <div class="summarizer-picker-panel" role="listbox" aria-multiselectable="true">
                <div class="summarizer-picker-search">
                    <i class="fa-solid fa-magnifying-glass"></i>
                    <input type="text" class="text_pole" placeholder="Search ${label.toLocaleLowerCase()}…" aria-label="Search ${label.toLocaleLowerCase()}">
                </div>
                <div class="summarizer-picker-options">${optionHtml || `<span class="summarizer-memory-empty">${escapeHtml(emptyLabel)}</span>`}</div>
            </div>
        </div>`;
}

function closeChoicePicker(picker) {
    picker.querySelector('.summarizer-picker-panel')?.classList.remove('is-open');
    picker.querySelector('.summarizer-picker-button')?.setAttribute('aria-expanded', 'false');
}

function refreshChoicePicker(picker) {
    const selected = [...picker.querySelectorAll('.summarizer-character-memory-choice:checked')];
    const names = selected.map(input => input.dataset.label || input.value);
    const label = picker.querySelector('.summarizer-picker-label');
    label.textContent = names.length === 0
        ? label.dataset.emptyLabel
        : (names.length <= 2 ? names.join(', ') : `${names.length} selected`);
    picker.querySelector('.summarizer-picker-thumbnails').innerHTML = selected
        .filter(input => input.dataset.avatar)
        .slice(0, 4)
        .map(input => `<img src="/thumbnail?type=avatar&file=${encodeURIComponent(input.dataset.avatar)}" alt="">`)
        .join('');
}

function buildQuote(quote = {}) {
    const pinned = quote.pinned === true;
    return `
        <div class="summarizer-character-quote ${pinned ? 'is-pinned' : ''}">
            <input class="text_pole summarizer-character-quote-speaker" type="text" placeholder="Speaker" value="${escapeHtml(quote.speaker)}">
            <button type="button" class="summarizer-character-quote-pin ${pinned ? 'is-pinned' : ''}" title="${pinned ? 'Unpin private quote' : 'Pin private quote'}"><i class="fa-solid fa-thumbtack"></i></button>
            <textarea class="text_pole summarizer-character-quote-text" rows="2" placeholder="Private quote">${escapeHtml(quote.text)}</textarea>
            <input class="text_pole summarizer-character-quote-context" type="text" placeholder="Brief context" value="${escapeHtml(quote.context)}">
            <button type="button" class="menu_button summarizer-character-quote-delete" title="Delete private quote"><i class="fa-solid fa-trash"></i></button>
        </div>`;
}

function buildMemory(memory) {
    const cardChoices = getCardChoices(memory.knownBy.cards);
    const selectedCards = new Set(memory.knownBy.cards.map(value => String(value).replace(/\.[^/.]+$/, '').toLocaleLowerCase()));
    const selectedTags = new Set(memory.restriction.tags.map(String));
    const cardOptions = cardChoices.length > 0
        ? cardChoices.map(character => {
            const stem = String(character.avatar).replace(/\.[^/.]+$/, '').toLocaleLowerCase();
            const name = String(character.name || character.avatar);
            const avatarUrl = `/thumbnail?type=avatar&file=${encodeURIComponent(character.avatar)}`;
            return `
                <label class="summarizer-picker-option" data-search="${escapeHtml(name.toLocaleLowerCase())}">
                    <input class="summarizer-character-memory-choice summarizer-character-memory-card-choice" type="checkbox" value="${escapeHtml(character.avatar)}" data-label="${escapeHtml(name)}" data-avatar="${escapeHtml(character.avatar)}" ${selectedCards.has(stem) ? 'checked' : ''}>
                    <img src="${avatarUrl}" alt="">
                    <span>${escapeHtml(name)}</span>
                    <i class="fa-solid fa-check"></i>
                </label>`;
        }).join('')
        : '';
    const tagOptions = [...(tags || [])]
        .filter(tag => tag?.id)
        .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
        .map(tag => {
            const name = String(tag.name || tag.id);
            return `
                <label class="summarizer-picker-option" data-search="${escapeHtml(name.toLocaleLowerCase())}">
                    <input class="summarizer-character-memory-choice summarizer-character-memory-tag-choice" type="checkbox" value="${escapeHtml(tag.id)}" data-label="${escapeHtml(name)}" ${selectedTags.has(String(tag.id)) ? 'checked' : ''}>
                    <span>${escapeHtml(name)}</span>
                    <i class="fa-solid fa-check"></i>
                </label>`;
        })
        .join('');
    const quotes = memory.quotes.length > 0
        ? memory.quotes.map(buildQuote).join('')
        : '<div class="summarizer-character-memory-empty">No private quotes</div>';
    const review = memory.ambiguousNames.length > 0 || memory.unresolvedNames.length > 0;

    return `
        <article class="summarizer-character-memory" data-memory-id="${escapeHtml(memory.id)}" data-source="${escapeHtml(memory.source)}" data-unresolved-names="${escapeHtml(JSON.stringify(memory.unresolvedNames))}" data-ambiguous-names="${escapeHtml(JSON.stringify(memory.ambiguousNames))}">
            <header class="summarizer-character-memory-header">
                <span><i class="fa-solid fa-user-shield"></i> Character memory</span>
                <span class="summarizer-character-memory-badges">
                    ${memory.source === 'ai' ? '<span class="summarizer-character-memory-badge">AI</span>' : '<span class="summarizer-character-memory-badge">Manual</span>'}
                    ${review ? '<span class="summarizer-character-memory-badge is-warning">Review identity</span>' : ''}
                    <button type="button" class="summarizer-character-memory-delete" title="Delete character memory"><i class="fa-solid fa-trash"></i></button>
                </span>
            </header>
            <textarea class="text_pole summarizer-character-memory-text" rows="3" placeholder="Private fact, belief, reaction, or limited observation">${escapeHtml(memory.text)}</textarea>
            <div class="summarizer-character-memory-grid">
                <label>Known by
                    <input class="text_pole summarizer-character-memory-names" type="text" placeholder="Comma-separated names" value="${escapeHtml(memory.knownBy.names.join(', '))}">
                </label>
                <label>Delivery
                    <select class="text_pole summarizer-character-memory-delivery">
                        <option value="auto" ${memory.delivery === CHARACTER_MEMORY_DELIVERY.AUTO ? 'selected' : ''}>Auto</option>
                        <option value="card-only" ${memory.delivery === CHARACTER_MEMORY_DELIVERY.CARD_ONLY ? 'selected' : ''}>Bound cards / tags only</option>
                        <option value="instruction-only" ${memory.delivery === CHARACTER_MEMORY_DELIVERY.INSTRUCTION_ONLY ? 'selected' : ''}>Instruction only</option>
                    </select>
                </label>
                ${buildChoicePicker('Linked active cards', cardOptions, 'Choose characters…', 'cards')}
                <label>Tag delivery
                    <select class="text_pole summarizer-character-memory-tag-mode">
                        <option value="any" ${memory.restriction.tagMode === TAG_DELIVERY_MODES.ANY ? 'selected' : ''}>No tag filter</option>
                        <option value="only" ${memory.restriction.tagMode === TAG_DELIVERY_MODES.ONLY ? 'selected' : ''}>Only selected tags</option>
                        <option value="exclude" ${memory.restriction.tagMode === TAG_DELIVERY_MODES.EXCLUDE ? 'selected' : ''}>Except selected tags</option>
                    </select>
                </label>
            </div>
            <div class="summarizer-character-memory-tags-field">
                ${buildChoicePicker('Tags', tagOptions, 'Choose tags…', 'tags')}
            </div>
            <div class="summarizer-character-memory-status"></div>
            <details class="summarizer-character-memory-quotes">
                <summary>Private quotes <span>(${memory.quotes.length})</span></summary>
                <div class="summarizer-character-quotes-list">${quotes}</div>
                <button type="button" class="menu_button summarizer-character-quote-add"><i class="fa-solid fa-plus"></i> Add private quote</button>
            </details>
        </article>`;
}

export function renderCharacterMemoryEditor() {
    return `
        <section class="summarizer-character-memories-section">
            <div class="summarizer-editor-section-header">
                <label><strong>Character Memories</strong></label>
                <button id="summarizer-add-character-memory" type="button" class="menu_button"><i class="fa-solid fa-plus"></i> Add</button>
            </div>
            <div class="summarizer-memory-hint">Private knowledge and limited perspectives attached to this shared batch.</div>
            <div id="summarizer-character-memories"></div>
        </section>`;
}

function checkedValues(item, selector) {
    return [...item.querySelectorAll(`${selector}:checked`)].map(input => input.value);
}

function collectQuotes(item) {
    return [...item.querySelectorAll('.summarizer-character-quote')].map(quote => ({
        speaker: quote.querySelector('.summarizer-character-quote-speaker').value.trim(),
        text: quote.querySelector('.summarizer-character-quote-text').value.trim(),
        context: quote.querySelector('.summarizer-character-quote-context').value.trim(),
        pinned: quote.querySelector('.summarizer-character-quote-pin').classList.contains('is-pinned'),
    })).filter(quote => quote.speaker && quote.text);
}

export function setupCharacterMemoryEditor(overlay, memories) {
    const container = overlay.querySelector('#summarizer-character-memories');
    let nextId = Date.now();

    const refreshItem = (item) => {
        const delivery = item.querySelector('.summarizer-character-memory-delivery').value;
        const cards = checkedValues(item, '.summarizer-character-memory-card-choice');
        const tagMode = item.querySelector('.summarizer-character-memory-tag-mode').value;
        const tagCount = checkedValues(item, '.summarizer-character-memory-tag-choice').length;
        const status = item.querySelector('.summarizer-character-memory-status');
        const tagField = item.querySelector('.summarizer-character-memory-tags-field');
        tagField.hidden = tagMode === TAG_DELIVERY_MODES.ANY;
        if (tagField.hidden) closeChoicePicker(tagField.querySelector('.summarizer-character-memory-picker'));
        item.querySelectorAll('.summarizer-character-memory-picker').forEach(refreshChoicePicker);

        status.classList.remove('is-warning');
        if (delivery === CHARACTER_MEMORY_DELIVERY.INSTRUCTION_ONLY) {
            status.textContent = 'Always supplied with a note describing who knows it.';
        } else if (tagMode === TAG_DELIVERY_MODES.ONLY && tagCount === 0) {
            status.textContent = 'Only selected tags has no tags selected, so this memory will not be delivered.';
            status.classList.add('is-warning');
        } else if (cards.length > 0) {
            status.textContent = `Hard-routed to ${cards.length} linked card${cards.length === 1 ? '' : 's'}${tagMode !== TAG_DELIVERY_MODES.ANY ? ' plus the tag rule' : ''}.`;
        } else if (tagMode !== TAG_DELIVERY_MODES.ANY && tagCount > 0) {
            status.textContent = 'Hard-routed by the selected ST tag rule.';
        } else if (delivery === CHARACTER_MEMORY_DELIVERY.CARD_ONLY) {
            status.textContent = 'No card or tag target is selected, so this memory will not be delivered.';
            status.classList.add('is-warning');
        } else {
            status.textContent = 'No card match; this currently falls back to instruction-only delivery.';
        }
    };

    const refreshQuoteCount = (item) => {
        const count = item.querySelectorAll('.summarizer-character-quote').length;
        const countNode = item.querySelector('.summarizer-character-memory-quotes summary span');
        if (countNode) countNode.textContent = `(${count})`;
    };

    const appendMemory = (memory) => {
        container.insertAdjacentHTML('beforeend', buildMemory(normalizeCharacterMemory(memory)));
        refreshItem(container.lastElementChild);
    };

    const normalized = normalizeCharacterMemories(memories);
    normalized.forEach(appendMemory);
    if (normalized.length === 0) {
        container.innerHTML = '<div class="summarizer-character-memory-empty">No character memories in this batch</div>';
    }

    overlay.querySelector('#summarizer-add-character-memory').addEventListener('click', () => {
        container.querySelector('.summarizer-character-memory-empty')?.remove();
        appendMemory({
            id: `cm_manual_${nextId++}`,
            text: '',
            knownBy: { names: [], cards: [] },
            delivery: CHARACTER_MEMORY_DELIVERY.INSTRUCTION_ONLY,
            restriction: { tagMode: TAG_DELIVERY_MODES.ANY, tags: [] },
            quotes: [],
            source: 'manual',
        });
    });

    container.addEventListener('change', event => {
        const item = event.target.closest('.summarizer-character-memory');
        if (!item) return;
        if (event.target.matches('.summarizer-character-memory-names, .summarizer-character-memory-card-choice')) {
            item.dataset.unresolvedNames = '[]';
            item.dataset.ambiguousNames = '[]';
            item.querySelector('.summarizer-character-memory-badge.is-warning')?.remove();
        }
        refreshItem(item);
    });
    container.addEventListener('click', event => {
        const item = event.target.closest('.summarizer-character-memory');
        if (!item) return;
        const pickerButton = event.target.closest('.summarizer-character-memory-picker .summarizer-picker-button');
        if (pickerButton) {
            event.preventDefault();
            const picker = pickerButton.closest('.summarizer-character-memory-picker');
            const panel = picker.querySelector('.summarizer-picker-panel');
            const willOpen = !panel.classList.contains('is-open');
            container.querySelectorAll('.summarizer-character-memory-picker').forEach(closeChoicePicker);
            if (willOpen) {
                panel.classList.add('is-open');
                pickerButton.setAttribute('aria-expanded', 'true');
                const search = picker.querySelector('.summarizer-picker-search input');
                search.value = '';
                picker.querySelectorAll('.summarizer-picker-option').forEach(option => { option.hidden = false; });
                requestAnimationFrame(() => search.focus());
            }
            return;
        }
        if (event.target.closest('.summarizer-character-memory-delete')) {
            item.remove();
            if (!container.querySelector('.summarizer-character-memory')) {
                container.innerHTML = '<div class="summarizer-character-memory-empty">No character memories in this batch</div>';
            }
            return;
        }
        if (event.target.closest('.summarizer-character-quote-add')) {
            const list = item.querySelector('.summarizer-character-quotes-list');
            list.querySelector('.summarizer-character-memory-empty')?.remove();
            list.insertAdjacentHTML('beforeend', buildQuote());
            refreshQuoteCount(item);
            return;
        }
        const quote = event.target.closest('.summarizer-character-quote');
        if (!quote) return;
        if (event.target.closest('.summarizer-character-quote-delete')) {
            const list = quote.parentElement;
            quote.remove();
            if (!list.querySelector('.summarizer-character-quote')) {
                list.innerHTML = '<div class="summarizer-character-memory-empty">No private quotes</div>';
            }
            refreshQuoteCount(item);
            return;
        }
        const pin = event.target.closest('.summarizer-character-quote-pin');
        if (pin) {
            const pinned = pin.classList.toggle('is-pinned');
            quote.classList.toggle('is-pinned', pinned);
            pin.title = pinned ? 'Unpin private quote' : 'Pin private quote';
        }
    });

    container.addEventListener('input', event => {
        if (!event.target.matches('.summarizer-character-memory-picker .summarizer-picker-search input')) return;
        const picker = event.target.closest('.summarizer-character-memory-picker');
        const query = event.target.value.trim().toLocaleLowerCase();
        picker.querySelectorAll('.summarizer-picker-option').forEach(option => {
            option.hidden = !!query && !String(option.dataset.search || '').includes(query);
        });
    });
    overlay.addEventListener('click', event => {
        if (!event.target.closest('.summarizer-character-memory-picker')) {
            container.querySelectorAll('.summarizer-character-memory-picker').forEach(closeChoicePicker);
        }
    });
    container.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        const picker = event.target.closest('.summarizer-character-memory-picker');
        if (picker) closeChoicePicker(picker);
    });

    return {
        collect: () => normalizeCharacterMemories([...container.querySelectorAll('.summarizer-character-memory')].map(item => ({
            id: item.dataset.memoryId,
            text: item.querySelector('.summarizer-character-memory-text').value.trim(),
            knownBy: {
                names: normalizeIdentityNames(item.querySelector('.summarizer-character-memory-names').value),
                cards: checkedValues(item, '.summarizer-character-memory-card-choice'),
            },
            delivery: item.querySelector('.summarizer-character-memory-delivery').value,
            restriction: normalizeRestriction({
                tagMode: item.querySelector('.summarizer-character-memory-tag-mode').value,
                tags: checkedValues(item, '.summarizer-character-memory-tag-choice'),
            }),
            quotes: collectQuotes(item),
            source: item.dataset.source,
            unresolvedNames: JSON.parse(item.dataset.unresolvedNames || '[]'),
            ambiguousNames: JSON.parse(item.dataset.ambiguousNames || '[]'),
        }))),
    };
}
