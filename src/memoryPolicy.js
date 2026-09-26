/**
 * Pure memory-policy helpers. Kept free of SillyTavern imports so matching and
 * filtering can be tested without booting the application.
 */

export const KNOWLEDGE_MODES = Object.freeze({
    UNRESTRICTED: 'unrestricted',
    NARRATOR: 'narrator',
    SELECTED: 'selected',
});

export const RESTRICTION_MODES = Object.freeze({
    NONE: 'none',
    ONLY: 'only',
    EXCLUDE: 'exclude',
});

export const CARD_DELIVERY_MODES = Object.freeze({
    AUTO: 'auto',
    ANY: 'any',
    ONLY: 'only',
    EXCLUDE: 'exclude',
});

export const TAG_DELIVERY_MODES = Object.freeze({
    ANY: 'any',
    ONLY: 'only',
    EXCLUDE: 'exclude',
});

// Default/automatic keyword recall is intentionally conservative. Importance
// 5 is the neutral value for legacy or unscored batches, so those memories stay
// in the narrative backbone instead of disappearing behind an accidental flag.
export const KEYWORD_AUTO_MAX_IMPORTANCE = 4;

const FOUNDATION_BATCH_TYPES = new Set(['establishment', 'history']);

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

export function normalizeKeywords(value) {
    const parts = Array.isArray(value)
        ? value
        : String(value ?? '').split(/[\n,;]+/);
    return uniqueStrings(parts.map(part => String(part ?? '').replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()))
        .filter(keyword => keyword.length <= 80)
        .slice(0, 20);
}

export function parseKeywordsBlock(rawText) {
    const match = String(rawText ?? '').match(/<keywords?>([\s\S]*?)<\/keywords?>/i);
    return match ? normalizeKeywords(match[1]) : [];
}

export function normalizeKnowledge(value) {
    const source = value && typeof value === 'object' ? value : {};
    const validModes = new Set(Object.values(KNOWLEDGE_MODES));
    const mode = validModes.has(source.mode) ? source.mode : KNOWLEDGE_MODES.UNRESTRICTED;
    return {
        mode,
        characters: uniqueStrings(source.characters),
        names: uniqueStrings(source.names),
    };
}

export function normalizeRestriction(value) {
    const source = value && typeof value === 'object' ? value : {};
    const characters = uniqueStrings(source.characters);
    const tags = uniqueStrings(source.tags);
    const validCardModes = new Set(Object.values(CARD_DELIVERY_MODES));
    const validTagModes = new Set(Object.values(TAG_DELIVERY_MODES));

    let cardMode = validCardModes.has(source.cardMode) ? source.cardMode : null;
    let tagMode = validTagModes.has(source.tagMode) ? source.tagMode : null;

    // Migrate the first-pass shared mode without changing its combined behavior.
    // Empty halves stay passive; populated halves inherit the legacy Only/Except.
    if (!cardMode || !tagMode) {
        const legacyMode = Object.values(RESTRICTION_MODES).includes(source.mode)
            ? source.mode
            : RESTRICTION_MODES.NONE;
        if (!cardMode) {
            cardMode = legacyMode === RESTRICTION_MODES.ONLY && characters.length > 0
                ? CARD_DELIVERY_MODES.ONLY
                : (legacyMode === RESTRICTION_MODES.EXCLUDE && characters.length > 0
                    ? CARD_DELIVERY_MODES.EXCLUDE
                    : CARD_DELIVERY_MODES.AUTO);
        }
        if (!tagMode) {
            tagMode = legacyMode === RESTRICTION_MODES.ONLY && tags.length > 0
                ? TAG_DELIVERY_MODES.ONLY
                : (legacyMode === RESTRICTION_MODES.EXCLUDE && tags.length > 0
                    ? TAG_DELIVERY_MODES.EXCLUDE
                    : TAG_DELIVERY_MODES.ANY);
        }
    }

    return {
        cardMode,
        characters,
        tagMode,
        tags,
    };
}

export function getBatchMemoryPolicy(batch) {
    const keywords = normalizeKeywords(batch?.keywords);
    const keywordRequested = batch?.keywordActivated === true && keywords.length > 0;
    const importance = Number.isFinite(batch?.importance)
        ? Math.max(1, Math.min(10, Math.round(batch.importance)))
        : 5;
    const foundationProtected = FOUNDATION_BATCH_TYPES.has(batch?.type);
    const manuallyChosen = batch?.keywordActivationManual === true;
    const importanceProtected = !manuallyChosen && importance > KEYWORD_AUTO_MAX_IMPORTANCE;
    const keywordActivated = keywordRequested && !foundationProtected && !importanceProtected;

    return {
        keywords,
        // An empty keyword list cannot provide a recall trigger. Treat it as
        // always-active so older/mis-migrated batches remain usable.
        keywordRequested,
        keywordActivated,
        keywordActivationManual: manuallyChosen,
        keywordProtectionReason: foundationProtected
            ? 'foundation'
            : (keywordRequested && importanceProtected ? 'importance' : ''),
        knowledge: normalizeKnowledge(batch?.knowledge),
        restriction: normalizeRestriction(batch?.restriction),
    };
}

export function normalizeMatchText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLocaleLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Match complete normalized words or phrases; "ring" never matches "spring". */
export function getKeywordMatches(keywords, queryText) {
    const haystack = normalizeMatchText(queryText);
    if (!haystack) return [];
    const padded = ` ${haystack} `;
    return normalizeKeywords(keywords).filter(keyword => {
        const needle = normalizeMatchText(keyword);
        return needle && padded.includes(` ${needle} `);
    });
}

export function passesKeywordActivation(batch, queryText) {
    const policy = getBatchMemoryPolicy(batch);
    if (!policy.keywordActivated) return true;
    return getKeywordMatches(policy.keywords, queryText).length > 0;
}

const avatarStem = (avatar) => String(avatar ?? '').trim().replace(/\.[^/.]+$/, '').toLocaleLowerCase();

function entityPassesRestriction(entity, restriction, knowledge) {
    const entityAvatar = avatarStem(entity?.avatar);
    const entityTags = new Set((entity?.tags || []).map(value => String(value)));
    const selectedKnowledgeCards = knowledge.mode === KNOWLEDGE_MODES.SELECTED
        ? knowledge.characters
        : [];
    const automaticCards = selectedKnowledgeCards.length > 0 ? selectedKnowledgeCards : [];
    const effectiveCardMode = restriction.cardMode === CARD_DELIVERY_MODES.AUTO
        ? (automaticCards.length > 0 ? CARD_DELIVERY_MODES.ONLY : CARD_DELIVERY_MODES.ANY)
        : restriction.cardMode;
    const cardChoices = restriction.cardMode === CARD_DELIVERY_MODES.AUTO
        ? automaticCards
        : restriction.characters;
    const nameMatch = cardChoices.some(avatar => avatarStem(avatar) === entityAvatar);
    const tagMatch = restriction.tags.some(tagId => entityTags.has(String(tagId)));

    const cardPass = effectiveCardMode === CARD_DELIVERY_MODES.ONLY
        ? cardChoices.length > 0 && nameMatch
        : (effectiveCardMode === CARD_DELIVERY_MODES.EXCLUDE ? !nameMatch : true);
    const tagPass = restriction.tagMode === TAG_DELIVERY_MODES.ONLY
        ? restriction.tags.length > 0 && tagMatch
        : (restriction.tagMode === TAG_DELIVERY_MODES.EXCLUDE ? !tagMatch : true);

    // Card and tag delivery are independent gates and therefore combine with AND.
    return cardPass && tagPass;
}

/**
 * A group audience normally contains the current responder. If ST has not yet
 * exposed that responder, it contains every enabled member and fails closed: all
 * possible recipients must qualify so a restricted memory cannot leak.
 */
export function passesCharacterRestriction(batch, audience = [], restrictionsEnabled = true) {
    const policy = getBatchMemoryPolicy(batch);
    const { restriction, knowledge } = policy;
    if (!restrictionsEnabled) return true;
    if (!Array.isArray(audience) || audience.length === 0) {
        const automaticOnly = restriction.cardMode === CARD_DELIVERY_MODES.AUTO
            && knowledge.mode === KNOWLEDGE_MODES.SELECTED
            && knowledge.characters.length > 0;
        return !automaticOnly
            && restriction.cardMode !== CARD_DELIVERY_MODES.ONLY
            && restriction.tagMode !== TAG_DELIVERY_MODES.ONLY;
    }
    return audience.every(entity => entityPassesRestriction(entity, restriction, knowledge));
}

export function isBackboneBatch(batch) {
    const policy = getBatchMemoryPolicy(batch);
    const cardDeliveryIsPassive = policy.restriction.cardMode === CARD_DELIVERY_MODES.AUTO
        || policy.restriction.cardMode === CARD_DELIVERY_MODES.ANY;
    return !policy.keywordActivated
        && policy.knowledge.mode === KNOWLEDGE_MODES.UNRESTRICTED
        && cardDeliveryIsPassive
        && policy.restriction.tagMode === TAG_DELIVERY_MODES.ANY;
}

export function hasSpecialMemoryPolicy(batch) {
    return !isBackboneBatch(batch);
}

/** Policy-aware archives must never fall back to their complete, scoped recap. */
export function getPromptSafeArchiveText(entry) {
    if (!entry || typeof entry !== 'object') return '';
    return Number(entry.memoryPolicyVersion) >= 1
        ? String(entry.contextText || '')
        : String(entry.text || '');
}
