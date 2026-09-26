import {
    CARD_DELIVERY_MODES,
    KNOWLEDGE_MODES,
    normalizeRestriction,
    passesCharacterRestriction,
    TAG_DELIVERY_MODES,
} from './memoryPolicy.js';

export const CHARACTER_MEMORY_DELIVERY = Object.freeze({
    AUTO: 'auto',
    CARD_ONLY: 'card-only',
    INSTRUCTION_ONLY: 'instruction-only',
});

const uniqueStrings = (values) => {
    const seen = new Set();
    const result = [];
    for (const value of values || []) {
        const clean = String(value ?? '').trim();
        const key = clean.toLocaleLowerCase();
        if (!clean || seen.has(key)) continue;
        seen.add(key);
        result.push(clean);
    }
    return result;
};

export function normalizeIdentityNames(value) {
    const parts = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[\n,;]+/);
    return uniqueStrings(parts).slice(0, 20);
}

function normalizeQuotes(value) {
    if (!Array.isArray(value)) return [];
    return value.map(quote => ({
        speaker: String(quote?.speaker ?? '').trim(),
        text: String(quote?.text ?? '').trim(),
        context: String(quote?.context ?? '').trim(),
        pinned: quote?.pinned === true,
    })).filter(quote => quote.speaker && quote.text).slice(0, 6);
}

export function normalizeCharacterMemory(value, index = 0) {
    const source = value && typeof value === 'object' ? value : {};
    const knownBy = source.knownBy && typeof source.knownBy === 'object' ? source.knownBy : {};
    const validDeliveries = new Set(Object.values(CHARACTER_MEMORY_DELIVERY));
    const restriction = normalizeRestriction(source.restriction);

    return {
        id: String(source.id || `cm_${index}`),
        text: String(source.text ?? '').trim(),
        knownBy: {
            names: normalizeIdentityNames(knownBy.names),
            cards: uniqueStrings(knownBy.cards).slice(0, 20),
        },
        delivery: validDeliveries.has(source.delivery)
            ? source.delivery
            : CHARACTER_MEMORY_DELIVERY.AUTO,
        restriction: {
            cardMode: CARD_DELIVERY_MODES.AUTO,
            characters: [],
            tagMode: restriction.tagMode,
            tags: restriction.tags,
        },
        quotes: normalizeQuotes(source.quotes),
        source: source.source === 'manual' ? 'manual' : 'ai',
        unresolvedNames: normalizeIdentityNames(source.unresolvedNames),
        ambiguousNames: normalizeIdentityNames(source.ambiguousNames),
    };
}

export function normalizeCharacterMemories(value) {
    if (!Array.isArray(value)) return [];
    return value
        .map((memory, index) => normalizeCharacterMemory(memory, index))
        .filter(memory => memory.text && memory.knownBy.names.length > 0)
        .slice(0, 12);
}

function getTagBody(text, tagName) {
    return String(text ?? '').match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'))?.[1]?.trim() || '';
}

function parseKnownBy(value) {
    const text = String(value ?? '').trim();
    if (!text) return [];
    if (text.startsWith('[')) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) return normalizeIdentityNames(parsed);
        } catch { /* fall through to the line-based parser */ }
    }
    return uniqueStrings(text.split(/\r?\n|;/).map(line => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '')));
}

/** Parse optional character-memory XML without making batch generation fail. */
export function parseCharacterMemoryBlocks(rawText) {
    const section = String(rawText ?? '').match(/<character_memories>([\s\S]*?)<\/character_memories>/i)?.[1];
    if (!section) return [];

    const results = [];
    const memoryPattern = /<memory\b([^>]*)>([\s\S]*?)<\/memory>/gi;
    let match;
    while ((match = memoryPattern.exec(section)) !== null && results.length < 12) {
        const attributes = match[1];
        const body = match[2];
        const attributeNames = attributes.match(/known_by\s*=\s*["']([^"']*)["']/i)?.[1] || '';
        const names = parseKnownBy(getTagBody(body, 'known_by') || attributeNames.replace(/\s*,\s*/g, '\n'));
        const text = getTagBody(body, 'text');
        const quotesText = getTagBody(body, 'quotes');
        if (!text || names.length === 0) continue;
        results.push({ text, names, quotesText });
    }
    return results;
}

export function parseQuoteLines(quotesText, { userName = 'User', characterName = 'Character' } = {}) {
    if (!quotesText || String(quotesText).trim().toLocaleLowerCase() === 'none') return [];
    const quotes = [];
    for (const line of String(quotesText).split('\n').filter(Boolean)) {
        const match = line.match(/^(.+?):\s*["“](.+?)["”]\s*(?:\((.+?)\))?$/);
        if (!match) continue;
        let speaker = match[1].trim();
        if (speaker.toLocaleUpperCase() === 'USER') speaker = userName;
        if (speaker.toLocaleUpperCase() === 'CHARACTER') speaker = characterName;
        quotes.push({
            speaker,
            text: match[2].trim(),
            context: match[3]?.trim() || '',
        });
    }
    return quotes;
}

const identityKey = (value) => String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Resolve only exact, unique active-card names. Ambiguous names are never guessed. */
export function resolveCharacterMemoryIdentities(memories, candidates = [], personaName = '') {
    const personaKey = identityKey(personaName);
    const byName = new Map();
    for (const candidate of candidates || []) {
        const key = identityKey(candidate?.name);
        if (!key || !candidate?.avatar) continue;
        if (!byName.has(key)) byName.set(key, []);
        byName.get(key).push(candidate);
    }

    return (memories || []).map((memory, index) => {
        const names = normalizeIdentityNames(memory.names || memory.knownBy?.names)
            .map(name => identityKey(name) === 'user' && personaName ? personaName : name);
        const cards = [];
        const unresolvedNames = [];
        const ambiguousNames = [];
        for (const name of names) {
            const key = identityKey(name);
            if (personaKey && key === personaKey) continue;
            const matches = byName.get(key) || [];
            if (matches.length === 1) cards.push(matches[0].avatar);
            else if (matches.length > 1) ambiguousNames.push(name);
            else unresolvedNames.push(name);
        }
        return normalizeCharacterMemory({
            id: `cm_${index}`,
            text: memory.text,
            knownBy: { names, cards },
            delivery: CHARACTER_MEMORY_DELIVERY.AUTO,
            quotes: memory.quotes || [],
            source: 'ai',
            unresolvedNames,
            ambiguousNames,
        }, index);
    });
}

export function getCharacterMemoryKnowledge(memory) {
    const normalized = normalizeCharacterMemory(memory);
    return {
        mode: KNOWLEDGE_MODES.SELECTED,
        characters: normalized.knownBy.cards,
        names: normalized.knownBy.names,
    };
}

export function hasHardCharacterMemoryTargets(memory) {
    const normalized = normalizeCharacterMemory(memory);
    return normalized.knownBy.cards.length > 0
        || normalized.restriction.tagMode !== TAG_DELIVERY_MODES.ANY;
}

export function isCharacterMemoryEligible(memory, audience = [], restrictionsEnabled = true) {
    const normalized = normalizeCharacterMemory(memory);
    if (normalized.delivery === CHARACTER_MEMORY_DELIVERY.INSTRUCTION_ONLY || !restrictionsEnabled) return true;

    const hasHardTargets = hasHardCharacterMemoryTargets(normalized);
    if (!hasHardTargets) {
        return normalized.delivery === CHARACTER_MEMORY_DELIVERY.AUTO;
    }

    return passesCharacterRestriction({
        knowledge: getCharacterMemoryKnowledge(normalized),
        restriction: normalized.restriction,
    }, audience, true);
}
