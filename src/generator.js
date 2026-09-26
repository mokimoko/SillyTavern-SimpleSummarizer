/**
 * generator.js — LLM prompts + parsing for Summarizer (standalone)
 */
import { getContext } from '../../../../extensions.js';
import { generateQuietPrompt } from '../../../../../script.js';
import { switchToProfileWithConfirmation, restoreProfileWithConfirmation, getGroupInfo } from './utils.js';
import {
    getSetting,
    getBatchSize,
    getBatches,
    getBatch,
    addBatch,
    updateBatch,
    getComprehensiveSummary,
    setComprehensiveSummary,
    updateComprehensiveSummary,
    getDynamicComprehensiveLength,
    getCurrentChatMetadata,
    getPinnedQuotes,
    getBackboneBatches,
    getComprehensiveBackboneSignature,
    getComprehensiveArchiveSignature,
    debugWarn,
} from './storage.js';
import { parseKeywordsBlock } from './memoryPolicy.js';
import {
    normalizeCharacterMemories,
    parseCharacterMemoryBlocks,
    parseQuoteLines,
    resolveCharacterMemoryIdentities,
} from './characterMemories.js';

// Importance rubric shown to the model for the <importance> tag. Verbatim scale
// anchors (Aether-style) so scoring is consistent batch to batch. Selection uses
// this to keep pivotal batches from rotating out of context. Non-fatal: if the
// model omits or garbles the tag, the batch still succeeds at neutral 5.
const IMPORTANCE_INSTRUCTION = `Then rate how important this batch is to the overall story on a scale of 1-10, inside an <importance> tag (e.g. <importance>7</importance>). Use this scale:
- 1-2: trivia or downtime — small talk, routine action, nothing that changes the story.
- 3-4: color — atmosphere, minor character moments, small developments.
- 5-6: notable developments — meaningful decisions, plans, shifts in a scene.
- 7-8: milestones — reveals, betrayals, first times, fights, deaths, major turning points.
- 9-10: story-defining events — moments the entire story pivots on.
Output a single whole number from 1 to 10. Base it only on what actually happens in these messages.`;

const KEYWORDS_INSTRUCTION = `Then provide 5-12 concise recall triggers inside a <keywords> block, one per line.

These are retrieval triggers, not descriptive index tags. Choose exact words or short phrases that could naturally appear in a later roleplay message when someone recalls, repeats, compares, jokes about, confronts, or deals with the consequences of this scene. A trigger is useful only when seeing it later would make this batch relevant context.

- Cover the scene's central subject or action plus a few distinctive anchors: a relationship behavior, object or substance, consequence, time-reference phrase, or specific physical/location detail when it meaningfully identifies the event.
- Use vocabulary the characters or narration would actually use. Preserve relevant slang, sexual terms, violent terms, and profanity; do not sanitize them into vague euphemisms.
- Matching uses whole words and phrases, not stemming. Include a few genuinely useful grammatical, colloquial, or tense variants as separate lines when later prose might use them differently (for example: "sleep around" / "sleeping around", or "betray" / "betrayed" / "betrayal").
- Prefer 1-4 words. A frequently recurring character or place name by itself is usually too broad; combine it with the relevant action, object, body detail, or time anchor.
- Avoid abstract or generic labels such as conversation, room, feeling, intimacy, conflict, said, or event. Do not select a word merely because it occurs in the text.
- Do not try to cover every detail. Favor triggers with a clear causal or thematic connection to why this otherwise nonessential scene might matter later.`;

function keywordPromptParts() {
    if (getSetting('autoTagKeywords') !== true) return { format: '', instruction: '' };
    return {
        format: `\n<keywords>\nkeyword or phrase\nanother keyword or alias\n</keywords>\n`,
        instruction: `\n${KEYWORDS_INSTRUCTION}\n`,
    };
}

function characterMemoryPromptParts() {
    if (getSetting('autoCharacterMemories') !== true) {
        return {
            format: '',
            instruction: '',
            summaryBoundary: '',
            motiveInstruction: '- Why they do it, when the reason is clear from the messages.',
            quoteInstruction: 'Also list up to 3 memorable lines of dialogue if any stand out. If none do, write none.',
        };
    }

    const context = getContext();
    const groupInfo = getGroupInfo();
    const cardNames = groupInfo
        ? groupInfo.members.map(member => member.name)
        : [context.characters?.[context.characterId]?.name].filter(Boolean);
    const participantNames = [...new Set([context.name1, ...cardNames].filter(Boolean))];

    return {
        summaryBoundary: `
The <summary> and <character_memories> sections must complement each other, not duplicate each other. Before writing either section, separate the new information into:
- Shared chronology: events, spoken information, and outcomes available to everyone present. Put these in <summary>.
- Asymmetric knowledge: unspoken thoughts or feelings, private motives, mistaken beliefs, private communications, or observations available to only some characters. Put these only in <character_memories>.

If you place information in a character memory, omit that information from the summary. The summary may retain a directly observable action or consequence needed for continuity, but must not repeat its private content, reason, or interpretation. For example, the summary may say that a character withdrew their hand, while their private realization that prompted it belongs only in their character memory.
`,
        motiveInstruction: '- Why they do it, when the reason is shared or publicly established. Put private motives and interpretations only in <character_memories>.',
        quoteInstruction: 'Also list up to 3 shared or publicly heard memorable lines of dialogue if any stand out. Private lines belong only in the relevant character memory. If none do, write none.',
        format: `
<character_memories>
<memory>
<known_by>
["Exact character name", ${JSON.stringify(context.name1 || 'Persona')}]
</known_by>
<text>A concise private fact, belief, reaction, or limited observation.</text>
<quotes>
Speaker: "A private memorable quote" (Brief context)
</quotes>
</memory>
</character_memories>
`,
        instruction: `
Then identify any knowledge that is genuinely asymmetric between characters. The known participants are: ${participantNames.join(', ') || 'use the names in the messages'}.
- Keep the normal <summary> as the durable shared chronology of the scene, after removing the asymmetric details captured here.
- Put only private facts, mistaken beliefs, subjective reactions, or clearly witness-limited information in <character_memories>.
- Never restate a character memory's fact, interpretation, or private quote in <summary>. The two sections are one partitioned record, not two independent summaries.
- Do not create a character memory merely because someone appeared in the scene, and do not infer secrecy without evidence.
- Include every person who directly knows the fact, including ${context.name1 || 'the user persona'} when they heard, witnessed, or participated.
- Use names exactly as supplied in the messages or participant list. Never invent card filenames, IDs, or tags.
- Combine closely related facts with the same audience. Return no <memory> entries when knowledge is symmetrical.
- Private memorable quotes belong inside that memory's <quotes> block and must not be repeated in the top-level <quotes> block.
If there is no asymmetric knowledge, return exactly <character_memories>none</character_memories> for this section.
`,
    };
}

// Parse the <importance> tag leniently and NON-FATALLY. Returns an integer 1-10,
// or null when nothing usable is present (caller then stores null = neutral).
// Never throws: a missing/garbled score must not fail or dirty a batch.
export function parseImportance(rawText) {
    const text = String(rawText ?? '');
    const tag = text.match(/<importance>([\s\S]*?)<\/importance>/i);
    // Accept the tag body if present; otherwise scan a trailing "importance: N"
    // style line as a soft fallback for models that drop the tag but keep a label.
    const source = tag ? tag[1] : (text.match(/importance\s*[:=]\s*([0-9]{1,2})/i)?.[1] ?? '');
    const num = String(source).match(/([0-9]{1,2})/);
    if (!num) return null;
    const n = parseInt(num[1], 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.min(10, n)); // clamp; 15 -> 10, 0 -> 1
}

/** Keywords are optional metadata; malformed or missing output never fails a batch. */
export function parseKeywords(rawText) {
    return parseKeywordsBlock(rawText);
}

/**
 * Detect a message the user manually hid via the eye icon / `/hide`.
 *
 * In SillyTavern, the eye toggle (and `/hide`) only flips `message.is_system = true`
 * and changes nothing else. But `is_system` is ALSO set on born-system messages
 * like `/sys` narrator lines (extra.type === 'NARRATOR') and `/comment` lines
 * (extra.type === 'COMMENT'). Those are legitimate story/system content we do NOT
 * want to strip from summaries.
 *
 * So a genuinely user-hidden ("ghosted") message is one that is is_system BUT is
 * not one of those born-system types. This keeps narrator/comment messages in the
 * summary while excluding the char/user messages you ghosted with the eye.
 *
 * Caveat: if you ever hide a narrator/comment message with the eye, it can't be
 * distinguished from an un-hidden one and will remain in the summary.
 */
function isUserHidden(msg) {
    if (!msg || !msg.is_system) return false;
    const t = msg.extra?.type;
    if (t === 'narrator' || t === 'NARRATOR' || t === 'comment' || t === 'COMMENT') {
        return false;
    }
    return true;
}

/**
 * Scan messages for speakers other than the main character and user
 */
function getOtherSpeakers(messages, charName) {
    const others = new Set();
    for (const msg of messages) {
        if (msg.is_user || msg.is_system) continue;
        const name = msg.extra?.scene_cast?.npc_name || msg.name;
        if (name && name !== charName) {
            others.add(name);
        }
    }
    return Array.from(others);
}

/**
 * Build the quote attribution instructions, accounting for other characters and group mode
 */
function buildQuoteAttribution(otherSpeakers, isGroup = false, charName = null) {
    if (isGroup) {
        // Group mode: all character speakers are equal participants
        if (otherSpeakers.length === 0) {
            return `IMPORTANT:
- Use each character's actual name for quote attribution
- Use exactly "USER:" for the user's quotes
- Do NOT use "CHARACTER:" — always use the character's actual name`;
        }

        return `IMPORTANT:
- The following characters participate in this group conversation: ${otherSpeakers.join(', ')}
- Use each character's ACTUAL NAME for quote attribution (e.g. "${otherSpeakers[0]}: \\"quote text\\" (context)")
- Use exactly "USER:" for the user's quotes
- Do NOT use "CHARACTER:" — always use the character's actual name`;
    }

    // 1-on-1 mode: attribute quotes by the speaker's actual in-story name.
    // A single card can still portray multiple named characters (e.g. a
    // "The Tully Brothers" card that voices both Ren and Alec), so we must
    // NOT collapse everyone into one placeholder. The card name is only a
    // fallback for lines that can't be pinned to a more specific speaker.
    const cardFallback = charName
        ? `\n- If a line clearly comes from this card but no more specific speaker name fits, attribute it to "${charName}".`
        : '';

    if (otherSpeakers.length === 0) {
        return `IMPORTANT:
- Attribute each quote to the character who ACTUALLY said it, using their name exactly as it appears in the story (e.g. Ren: "quote text" (context)).
- The "${charName}" card may portray more than one named character. If different named characters speak, attribute each quote to the specific one who said it — do NOT merge them under a single name.${cardFallback}
- Use exactly "USER:" for the user's quotes.`;
    }

    return `IMPORTANT:
- Attribute each quote to the character who ACTUALLY said it, using their name exactly as it appears in the story (e.g. ${otherSpeakers[0]}: "quote text" (context)).
- The "${charName}" card may portray more than one named character, and these additional characters also appear: ${otherSpeakers.join(', ')}. Attribute each quote to the specific speaker who said it — do NOT merge different characters under one name.${cardFallback}
- In the summary text, refer to each character by their actual name — do NOT fold them together.
- Use exactly "USER:" for the user's quotes.`;
}

/**
 * Build the establishment summary prompt (first batch)
 */
function buildEstablishmentPrompt(messages, otherSpeakers = [], isGroup = false, charName = null) {
    const length = getSetting('establishmentSummaryLength');

    let messagesText = messages.map((msg, i) => {
        const speaker = msg.is_user ? 'User' : msg.name || 'Character';
        return `Message ${i + 1} (${speaker}):\n${msg.mes}`;
    }).join('\n\n');

    const quoteAttribution = buildQuoteAttribution(otherSpeakers, isGroup, charName);
    const keywordParts = keywordPromptParts();
    const characterMemoryParts = characterMemoryPromptParts();

    return `Summarize the opening messages of this roleplay. This is the first summary, so record the starting facts the rest of the story builds on.

${characterMemoryParts.summaryBoundary}

Cover, in plain language:
- Where and when the story takes place.
- Who each character is: appearance, role, and personality shown so far.
- The situation: what is happening and how it started.
- How the characters relate to and treat each other.
- Any established facts about how this world works (magic, technology, factions, abilities).

Only include what the messages actually establish. Write it as clear, factual prose in plain English. State each fact directly. Do not use figurative language, metaphors, or dramatic phrasing.

${characterMemoryParts.quoteInstruction}

Length target: ${length}. If there is less to cover, write less.

Messages to summarize:
${messagesText}

Format your response EXACTLY as follows:

<summary>
Your summary text here
</summary>

${characterMemoryParts.format}

<quotes>
[Speaker name]: "Quote text" (Brief context)
USER: "Another quote" (Brief context)
</quotes>

<importance>N</importance>
${keywordParts.format}

${quoteAttribution}

${IMPORTANCE_INSTRUCTION}
${keywordParts.instruction}
${characterMemoryParts.instruction}

If there are no memorable quotes, use:
<quotes>
none
</quotes>`;
}

/**
 * Build a regular batch summary prompt
 */
function buildBatchPrompt(messages, batchIndex, previousSummaries, otherSpeakers = [], isGroup = false, charName = null) {
    const length = getSetting('batchSummaryLength');

    let messagesText = messages.map((msg, i) => {
        const speaker = msg.is_user ? 'User' : msg.name || 'Character';
        const globalIndex = messages[0].index + i;
        return `Message ${globalIndex + 1} (${speaker}):\n${msg.mes}`;
    }).join('\n\n');

    let contextText = '';
    if (previousSummaries && previousSummaries.length > 0) {
        contextText = `PREVIOUS CONTEXT (for reference only - DO NOT repeat this):\n`;
        previousSummaries.forEach((sum) => {
            contextText += `Batch ${sum.index + 1}: ${sum.summary}\n`;
        });
        contextText += '\n';
    }

    const quoteAttribution = buildQuoteAttribution(otherSpeakers, isGroup, charName);
    const keywordParts = keywordPromptParts();
    const characterMemoryParts = characterMemoryPromptParts();

    return `Summarize what happens in this batch of messages from an ongoing roleplay.

${characterMemoryParts.summaryBoundary}

${contextText}The context above has already been summarized. Only summarize the new messages below; do not repeat the context.

Write a clear, factual account of what happens, in the order it happens. Include:
- What each character says and does, and what results from it.
${characterMemoryParts.motiveInstruction}
- Any important change: a decision, a revelation, a lie, a location change, a shift in how two characters treat each other, or a new fact about the world.

State events plainly, in your own words, as connected prose. Write in the past tense. Do not use metaphors, imagery, or dramatic phrasing. Do not editorialize about what things mean — just report what happened and why. Leave out minor physical detail (clothing, scenery, small gestures) unless it affects the plot or a relationship.

${characterMemoryParts.quoteInstruction}

Length target: ${length}. If little happens, write less.

Messages to summarize:
${messagesText}

Format your response EXACTLY as follows:

<summary>
Your summary of these NEW messages
</summary>

${characterMemoryParts.format}

<quotes>
[Speaker name]: "Quote text" (Brief context)
USER: "Another quote" (Brief context)
</quotes>

<importance>N</importance>
${keywordParts.format}

${quoteAttribution}

${IMPORTANCE_INSTRUCTION}
${keywordParts.instruction}
${characterMemoryParts.instruction}

If there are no memorable quotes, use:
<quotes>
none
</quotes>`;
}

/**
 * Build the comprehensive summary prompt
 */
function buildComprehensivePrompt(batches, firstMessages, trailingMessages, otherSpeakers = [], pinnedQuotes = [], isGroup = false, charName = null, purpose = 'archive') {
    const length = getDynamicComprehensiveLength(batches.length);
    const isBackbone = purpose === 'backbone';

    let firstMessagesText = '';
    if (!isBackbone && firstMessages && firstMessages.length > 0) {
        firstMessagesText = 'OPENING MESSAGES (for context):\n';
        firstMessages.forEach((msg, i) => {
            const speaker = msg.is_user ? 'User' : msg.name || 'Character';
            firstMessagesText += `Message ${i + 1} (${speaker}): ${msg.mes}\n`;
        });
        firstMessagesText += '\n';
    }

    let batchSummaries = batches.map((batch, i) => {
        const label = batch.type === 'establishment' ? '(SETUP)' : '';
        let text = `Batch ${i + 1} ${label}:\n${batch.summary}`;
        if (!isBackbone) {
            const characterMemories = normalizeCharacterMemories(batch.characterMemories);
            if (characterMemories.length > 0) {
                text += '\nCharacter-specific knowledge:';
                for (const memory of characterMemories) {
                    text += `\n- Known by ${memory.knownBy.names.join(', ')}: ${memory.text}`;
                }
            }
        }
        return text;
    }).join('\n\n');

    let allQuotes = [];
    const pinnedTextSet = new Set(pinnedQuotes.map(pq => `${pq.speaker}::${pq.text}`));
    if (!isBackbone) batches.forEach((batch, i) => {
        if (batch.quotes && batch.quotes.length > 0) {
            batch.quotes.forEach(quote => {
                // Skip pinned quotes — they're shown separately in the PINNED QUOTES section
                if (pinnedTextSet.has(`${quote.speaker}::${quote.text}`)) return;
                allQuotes.push({ ...quote, sourceBatch: i + 1 });
            });
        }
        normalizeCharacterMemories(batch.characterMemories).forEach(memory => {
            memory.quotes.forEach(quote => {
                if (pinnedTextSet.has(`${quote.speaker}::${quote.text}`)) return;
                allQuotes.push({
                    ...quote,
                    sourceBatch: i + 1,
                    knowledgeLabel: memory.knownBy.names.join(', '),
                });
            });
        });
    });

    let quotesSection = '';
    if (allQuotes.length > 0) {
        quotesSection = '\n\nALL MEMORABLE QUOTES FROM BATCHES:\n';
        allQuotes.forEach(q => {
            const knowledge = q.knowledgeLabel ? ` [known by ${q.knowledgeLabel}]` : '';
            quotesSection += `Batch ${q.sourceBatch}${knowledge} - ${q.speaker}: "${q.text}" (${q.context})\n`;
        });
    }

    let trailingText = '';
    if (!isBackbone && trailingMessages && trailingMessages.length > 0) {
        trailingText = '\n\nRECENT MESSAGES (after last batch):\n';
        trailingMessages.forEach((msg) => {
            const speaker = msg.is_user ? 'User' : msg.name || 'Character';
            trailingText += `Message ${msg.index + 1} (${speaker}): ${msg.mes}\n`;
        });
    }

    const quoteAttribution = buildQuoteAttribution(otherSpeakers, isGroup, charName);

    // Adjust auto-pick count based on pinned quotes
    const autoPickCount = Math.max(0, 8 - pinnedQuotes.length);

    let pinnedQuotesSection = '';
    if (!isBackbone && pinnedQuotes.length > 0) {
        pinnedQuotesSection = '\n\nPINNED QUOTES (user-selected — ALWAYS include these exactly as written):\n';
        pinnedQuotes.forEach(q => {
            pinnedQuotesSection += `${q.speaker}: "${q.text}"${q.context ? ` (${q.context})` : ''}\n`;
        });
    }

    let quoteSelectionInstruction;
    if (isBackbone) {
        quoteSelectionInstruction = 'Do not select quotes for the story backbone. Return <quotes>none</quotes>.';
    } else if (pinnedQuotes.length === 0) {
        quoteSelectionInstruction = `Select exactly 8 quotes (or fewer if there aren't 8 good ones available). Do not make up quotes - only use quotes from the batch quotes provided above.`;
    } else if (autoPickCount > 0) {
        quoteSelectionInstruction = `The user has pinned ${pinnedQuotes.length} quote(s) listed above — ALWAYS include those exactly as written. Then select up to ${autoPickCount} additional quotes from the batch quotes to reach a total of 8. Do not make up quotes.`;
    } else {
        quoteSelectionInstruction = `The user has pinned ${pinnedQuotes.length} quote(s) listed above — include ALL of them exactly as written. Do not select any additional quotes. Do not make up quotes.`;
    }

    return `${isBackbone
        ? 'Write a compact, prompt-safe story backbone using only the common-memory batch summaries below. Do not invent or infer events outside these batches.'
        : 'Write a complete archival summary of this roleplay using every batch summary below. Preserve explicit boundaries around private knowledge, mistaken beliefs, and limited observations; do not imply that every character knew them.'}

Write in plain, factual prose organized into paragraphs, in chronological order from start to present. Cover:
- The main events, in order, and how the story got from its start to where it is now.
- Who each character is and how they have changed.
- How the characters relate to each other now, and how that changed from the beginning.
- Any established facts about how this world works that matter for the story.

State everything plainly and directly. Do not use metaphors, imagery, or dramatic phrasing. When several batches describe one ongoing development, combine them and describe it once. Only use information from the batch summaries; if they contradict each other, use the later one.

Length target: ${length}. If there is less to cover, write less.

${firstMessagesText}BATCH SUMMARIES:
${batchSummaries}${quotesSection}${pinnedQuotesSection}${trailingText}

Format your response EXACTLY as follows:

<summary>
Your ${isBackbone ? 'prompt-safe story backbone' : 'complete archival summary'} here
</summary>

<quotes>
[Speaker name]: "Quote text" (Brief context)
USER: "Another quote" (Brief context)
</quotes>

${isBackbone ? '' : quoteAttribution}

${quoteSelectionInstruction}`;
}

/**
 * Parse quotes from LLM response text
 */
function parseQuotes(quotesText) {
    const context = getContext();
    const groupInfo = getGroupInfo();
    const charName = groupInfo ? null : (context.characters?.[context.characterId]?.name || 'Character');
    const userName = context.name1 || 'User';
    return parseQuoteLines(quotesText, { userName, characterName: charName || 'Character' });
}

/**
 * Typed parse failure. Mirrors MemoryBooks' makeAIError so callers can branch on
 * a stable `code` instead of matching message text, and so a future "review the
 * raw failed response" UI has the original text to work with.
 *
 *   code:        TRUNCATED | NO_TAGS | ONLY_REASONING | EMPTY | REFUSAL
 *   recoverable: true when a clean retry (usually at a higher token limit) is
 *                likely to succeed — currently only truncation.
 *   raw:         the full raw model response, for later review.
 *   partial:     best-effort salvaged summary text (truncation case), for review.
 */
export class SummaryParseError extends Error {
    constructor(code, message, { raw = '', partial = '' } = {}) {
        super(message);
        this.name = 'SummaryParseError';
        this.code = code;
        this.recoverable = code === 'TRUNCATED';
        this.raw = raw;
        this.partial = partial;
    }
}

// Reasoning-model wrappers we strip before tag detection (R1, o1, QwQ, Gemini
// thinking, etc.). Only well-formed pairs are removed; an unclosed opener is
// treated as "only reasoning" downstream (usually itself a truncation).
const THINK_PAIR_RE = /<think>[\s\S]*?<\/think>|<thinking>[\s\S]*?<\/thinking>/gi;
const THINK_OPEN_RE = /<think\b|<thinking\b/i;

/**
 * Pure preprocessor: raw model text in → { summary, quotesText, warning } out,
 * or throws SummaryParseError. Deliberately free of any ST-context dependency
 * (no getContext), so it can be unit-tested against fixture strings. Quote
 * *parsing* (which needs getContext for name resolution) stays in parseResponse.
 *
 * Parse cascade (first match wins):
 *   1. <summary>…</summary> present            → success (+ optional warnings)
 *   2. <summary> opened, never closed          → throw TRUNCATED (salvage partial)
 *   3. nothing left after stripping reasoning  → throw ONLY_REASONING
 *   4. unclosed <think> and no <summary>       → throw ONLY_REASONING
 *   5. refusal phrasing, no tags               → throw REFUSAL
 *   6. prose present but no <summary> tag      → throw NO_TAGS
 *   7. empty input                             → throw EMPTY
 */
export function preprocessAndSplit(rawText) {
    const raw = String(rawText ?? '');

    // (7) Nothing at all.
    if (raw.trim() === '') {
        throw new SummaryParseError('EMPTY',
            'The model returned an empty response. Regenerate this batch.',
            { raw });
    }

    // (Step 1) Strip well-formed reasoning blocks before any tag matching.
    const text = raw.replace(THINK_PAIR_RE, '').trim();

    // (3) Stripping reasoning consumed everything → the model only "thought".
    if (text === '') {
        throw new SummaryParseError('ONLY_REASONING',
            'The model returned only reasoning and no summary. This usually means it ran out of tokens — increase Max Response Tokens and regenerate.',
            { raw });
    }

    // (1) Happy path: a closed <summary> block.
    const summaryClosed = text.match(/<summary>([\s\S]*?)<\/summary>/i);
    if (summaryClosed) {
        const summary = summaryClosed[1].trim();

        // A closed-but-empty <summary></summary> is not usable content.
        if (summary === '') {
            throw new SummaryParseError('EMPTY',
                'The model produced an empty <summary> block. Regenerate this batch.',
                { raw });
        }

        // Quotes: prefer a closed block; fall back to open-to-EOF with a soft
        // warning. Stop at either optional metadata tag so a missing </quotes>
        // doesn't swallow importance or keywords into quote text.
        let quotesText = null;
        let warning = null;
        // Scoped memories may contain their own <quotes>; remove that section
        // before locating the batch's public quote block.
        const publicText = text.replace(/<character_memories>[\s\S]*?<\/character_memories>/gi, '');
        const quotesClosed = publicText.match(/<quotes>([\s\S]*?)<\/quotes>/i);
        if (quotesClosed) {
            quotesText = quotesClosed[1].trim();
        } else {
            const quotesOpen = publicText.match(/<quotes>([\s\S]*?)(?:<importance>|<keywords?>|$)/i);
            if (quotesOpen) {
                quotesText = quotesOpen[1].trim();
                warning = 'quotes-unterminated';
            }
        }

        // Weak secondary truncation hint: a long summary that doesn't end on
        // terminal punctuation. Warning-only — prose can legitimately end
        // without a period, so this must never block a successful parse.
        if (!warning && summary.length >= 80 && !/[.!?"'”’)\]]\s*$/.test(summary)) {
            warning = 'summary-unterminated-punctuation';
        }

        return { summary, quotesText, warning };
    }

    // (2) A summary was opened but never closed → truncation. Salvage the partial
    // text (up to <quotes> or EOF) so a future review UI can show it.
    const summaryOpen = text.match(/<summary>([\s\S]*)/i);
    if (summaryOpen) {
        const partial = summaryOpen[1].split(/<character_memories>|<quotes>/i)[0].trim();
        throw new SummaryParseError('TRUNCATED',
            'Summary was cut off (likely hit the token limit). Increase Max Response Tokens and regenerate.',
            { raw, partial });
    }

    // No <summary> tag at all from here down.

    // (4) An unclosed <think> with no summary = reasoning that never produced a
    // result (commonly a truncation inside the reasoning block itself).
    if (THINK_OPEN_RE.test(text)) {
        throw new SummaryParseError('ONLY_REASONING',
            'The model returned only reasoning and no summary. This usually means it ran out of tokens — increase Max Response Tokens and regenerate.',
            { raw });
    }

    // (5) A refusal rather than a summary: short text, refusal phrasing, no tags.
    // Kept narrow — a real summary always has a <summary> tag and never reaches
    // here, so this can't misclassify legitimate content that merely quotes "sorry".
    if (text.length < 600 && /\b(I can['’]?t|I cannot|I['’]?m sorry|I am sorry|I['’]?m not able to|I am unable to|as an AI)\b/i.test(text)) {
        throw new SummaryParseError('REFUSAL',
            'The model declined to summarize instead of producing a summary. Check your connection profile or the content, then regenerate.',
            { raw });
    }

    // (6) There is prose, but no <summary> tag. Do NOT salvage it as the summary —
    // a stray question or comment would get stored as if it were real content.
    throw new SummaryParseError('NO_TAGS',
        'The model response did not contain a <summary> block. It may have ignored the format — regenerate this batch.',
        { raw });
}

/**
 * Parse summary + quotes from an LLM response.
 *
 * Thin wrapper over the pure preprocessAndSplit: split/validate (pure), then run
 * the ST-context-dependent quote parsing on the extracted quotes chunk. Throws a
 * typed SummaryParseError on any unparseable response.
 */
function parseResponse(response) {
    const { summary, quotesText, warning } = preprocessAndSplit(response);
    if (warning) debugWarn('Parse warning:', warning);
    const quotes = quotesText ? parseQuotes(quotesText) : [];
    return { summary, quotes, warning };
}

/**
 * Call the LLM to generate a summary.
 *
 * Generation strategy (matches Qvink/MessageSummarize):
 *  1. ALWAYS try CMRS first when a connection profile is configured.
 *     CMRS bypasses Generate() entirely — no is_send_press, no
 *     GENERATION_STARTED, no message creation/deletion side-effects.
 *  2. Only fall back to generateQuietPrompt when CMRS is unavailable
 *     (no profile configured or CMRS not on this ST build).
 *  3. skipProfileSwitch only controls the legacy manual-profile-switch
 *     fallback — it must NEVER gate the CMRS path.
 */
async function callLLM(prompt, skipProfileSwitch = false, maxTokens = 4096) {
    const connectionProfile = getSetting('connectionProfile');
    let originalProfile = null;

    try {
        // ── CMRS path (preferred — always attempted when a profile exists) ──
        if (connectionProfile) {
            const context = getContext();
            const CMRS = context?.ConnectionManagerRequestService;

            if (CMRS && typeof CMRS.sendRequest === 'function') {
                const profiles = context?.extensionSettings?.connectionManager?.profiles;
                const resolvedProfile = Array.isArray(profiles)
                    ? profiles.find(p => p.id === connectionProfile || p.name?.toLowerCase() === connectionProfile.toLowerCase())
                    : null;

                if (resolvedProfile) {
                    // Retry once on transient failures
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            const cmrsResult = await CMRS.sendRequest(resolvedProfile.id, [
                                { role: 'user', content: prompt },
                            ], maxTokens);
                            const response = cmrsResult?.content
                                || cmrsResult?.choices?.[0]?.message?.content
                                || cmrsResult?.text
                                || cmrsResult?.output
                                || '';
                            if (response) return String(response).trim();
                            debugWarn('CMRS returned empty (attempt', attempt + 1, ')');
                        } catch (err) {
                            debugWarn(`CMRS attempt ${attempt + 1} failed:`, err.message);
                            if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
                        }
                    }
                    // Both CMRS attempts failed — fall through to quiet prompt
                    debugWarn('CMRS exhausted, falling back to generateQuietPrompt');
                }
            }
        }

        // ── Fallback: profile switch + generateQuietPrompt ──
        // This path goes through Generate('quiet') which touches is_send_press
        // and fires GENERATION_STARTED. Only used when CMRS is not available.
        if (connectionProfile && !skipProfileSwitch) {
            const result = await switchToProfileWithConfirmation(connectionProfile);
            if (result.success) {
                originalProfile = result.originalProfile;
            } else {
                debugWarn('Profile switch failed:', result.error);
            }
        }

        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                const response = await generateQuietPrompt({
                    quietPrompt: prompt,
                    quietName: 'Summarizer',
                    skipWIAN: true,
                    responseLength: maxTokens,
                });

                if (!response) throw new Error('Empty response from LLM');
                return String(response).trim();
            } catch (error) {
                lastError = error;
                if (attempt === 0) {
                    debugWarn(`Quiet prompt attempt ${attempt + 1} failed, retrying in 2s...`, error.message);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }
        }

        throw lastError;
    } catch (error) {
        console.error('[Summarizer] LLM generation failed:', error);
        throw error;
    } finally {
        if (originalProfile && !skipProfileSwitch) {
            const restoreResult = await restoreProfileWithConfirmation(originalProfile);
            if (!restoreResult.success) {
                debugWarn('Profile restoration failed:', restoreResult.error);
            }
        }
    }
}

/**
 * Generate summary for a batch
 */
export async function generateBatchSummary(startIndex, endIndex, batchIndex, skipProfileSwitch = false, explicitType = null) {
    const context = getContext();
    const chat = context.chat;

    let batchType = explicitType || (batchIndex === 0 ? 'establishment' : 'regular');

    // Get messages for this batch
    const messages = [];
    for (let i = startIndex; i <= endIndex; i++) {
        if (chat[i] && !chat[i].is_disabled && !isUserHidden(chat[i])) {
            messages.push({ ...chat[i], index: i });
        }
    }
    if (messages.length === 0) throw new Error('No messages found for batch');

    // Detect group mode and speakers
    const groupInfo = getGroupInfo();
    const isGroup = !!groupInfo;
    // charName is null in group mode (all speakers are equal participants); in
    // 1-on-1 it's the card name, used both to filter out "other" speakers and
    // as the attribution fallback for lines with no more specific speaker.
    const charName = isGroup ? null : (context.characters?.[context.characterId]?.name || 'Character');
    const otherSpeakers = getOtherSpeakers(messages, charName);

    let prompt;
    if (batchType === 'establishment') {
        prompt = buildEstablishmentPrompt(messages, otherSpeakers, isGroup, charName);
    } else {
        const lookBackCount = getSetting('lookBackBatches');
        const batches = getBatches();
        const previousBatches = batches
            .filter(b => b.startIndex < startIndex && b.summary && !b.dirty)
            .slice(-lookBackCount)
            .map((b) => ({ index: batches.indexOf(b), summary: b.summary }));
        prompt = buildBatchPrompt(messages, batchIndex, previousBatches, otherSpeakers, isGroup, charName);
    }

    const response = await callLLM(prompt, skipProfileSwitch);
    const parsed = parseResponse(response);
    // Importance is parsed off the SAME raw response, separately and non-fatally:
    // parseResponse throws on a missing <summary>, but a missing <importance> must
    // never fail the batch — null here means "unscored", stored as neutral downstream.
    const importance = parseImportance(response);
    const keywords = getSetting('autoTagKeywords') === true ? parseKeywords(response) : [];
    const memoryBlocks = getSetting('autoCharacterMemories') === true
        ? parseCharacterMemoryBlocks(response)
        : [];
    const candidateCards = groupInfo
        ? groupInfo.members
        : [context.characters?.[context.characterId]].filter(Boolean).map(character => ({
            name: character.name,
            avatar: character.avatar,
        }));
    const characterMemories = resolveCharacterMemoryIdentities(
        memoryBlocks.map(block => ({
            ...block,
            quotes: parseQuoteLines(block.quotesText, {
                userName: context.name1 || 'User',
                characterName: charName || 'Character',
            }),
        })),
        candidateCards,
        context.name1 || '',
    );
    const privateQuoteKeys = new Set(characterMemories.flatMap(memory => memory.quotes)
        .map(quote => `${quote.speaker.toLocaleLowerCase()}\u241f${quote.text.toLocaleLowerCase()}`));
    const publicQuotes = parsed.quotes.filter(quote => !privateQuoteKeys.has(
        `${quote.speaker.toLocaleLowerCase()}\u241f${quote.text.toLocaleLowerCase()}`,
    ));

    return {
        summary: parsed.summary,
        quotes: publicQuotes,
        characterMemories,
        type: batchType,
        importance,
        keywords,
    };
}

/**
 * Process a single batch (generate or regenerate)
 */
export async function processBatch(startIndex, endIndex, batchIndex, existingBatch = null, skipProfileSwitch = false, explicitType = null) {
    try {
        const result = await generateBatchSummary(startIndex, endIndex, batchIndex, skipProfileSwitch, explicitType);

        if (existingBatch) {
            const preserveManualImportance = existingBatch.importanceManual === true;
            const preserveManualKeywords = existingBatch.keywordsManuallyEdited === true;
            const preserveManualCharacterMemories = existingBatch.characterMemoriesManuallyEdited === true;
            return updateBatch(existingBatch.id, {
                summary: result.summary,
                quotes: result.quotes || [],
                type: result.type,
                // null when unscored; regenerating an old batch backfills a real
                // score here, which is the intended "regen over time" path.
                importance: preserveManualImportance
                    ? existingBatch.importance
                    : ((typeof result.importance === 'number') ? result.importance : null),
                importanceManual: preserveManualImportance,
                keywords: preserveManualKeywords
                    ? existingBatch.keywords
                    : (getSetting('autoTagKeywords') === true ? result.keywords : (existingBatch.keywords || [])),
                keywordsManuallyEdited: preserveManualKeywords,
                characterMemories: preserveManualCharacterMemories
                    ? existingBatch.characterMemories
                    : (getSetting('autoCharacterMemories') === true
                        ? result.characterMemories
                        : (existingBatch.characterMemories || [])),
                characterMemoriesManuallyEdited: preserveManualCharacterMemories,
                dirty: false,
                edited: false,
                generatedAt: Date.now(),
            });
        } else {
            return addBatch({
                startIndex, endIndex,
                summary: result.summary,
                quotes: result.quotes || [],
                type: result.type,
                importance: (typeof result.importance === 'number') ? result.importance : null,
                importanceManual: false,
                keywords: result.keywords || [],
                keywordsManuallyEdited: false,
                characterMemories: result.characterMemories || [],
                characterMemoriesManuallyEdited: false,
                dirty: false,
                edited: false,
                generatedAt: Date.now(),
            });
        }
    } catch (error) {
        console.error('Summarizer: Failed to process batch:', error);
        if (existingBatch) {
            return updateBatch(existingBatch.id, {
                dirty: true,
                error: error.message,
                // Breadcrumbs for a future "review failed response" view. Typed
                // parse failures (SummaryParseError) carry a stable code plus the
                // raw text; other errors (network, etc.) just leave these null.
                errorCode: error.code || null,
                errorRaw: error.raw || null,
            });
        }
        throw error;
    }
}

/**
 * Process all unprocessed batches
 */
export async function processUnprocessedBatches(onProgress = null, skipProfileSwitch = false, effectiveChatLength = null) {
    const context = getContext();
    const chat = context.chat;
    const batchSize = getBatchSize();
    const batches = getBatches();
    const results = [];

    // Allow callers (auto-mode) to cap the effective length so trailing
    // "active" messages are never included in a complete batch.
    const chatLength = effectiveChatLength ?? chat.length;
    const completeBatches = Math.floor(chatLength / batchSize);

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 2;

    for (let i = 0; i < completeBatches; i++) {
        const startIndex = i * batchSize;
        const endIndex = startIndex + batchSize - 1;

        const existing = batches.find(b => b.startIndex === startIndex && b.endIndex === endIndex);
        if (existing && existing.summary && !existing.dirty) {
            results.push(existing);
            continue;
        }

        const batchType = (i === 0) ? 'establishment' : 'regular';

        if (onProgress) {
            onProgress({ current: i + 1, total: completeBatches, type: batchType });
        }

        try {
            const batch = await processBatch(startIndex, endIndex, i, existing, skipProfileSwitch, batchType);
            results.push(batch);
            consecutiveFailures = 0; // Reset on success
        } catch (error) {
            console.error(`Summarizer: Failed to process batch ${i}:`, error);
            results.push({ error: error.message, index: i });
            consecutiveFailures++;

            if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
                const remaining = completeBatches - i - 1;
                debugWarn(`${MAX_CONSECUTIVE_FAILURES} consecutive failures — aborting remaining ${remaining} batch(es). Backend may be down.`);
                toastr.error(`Summarizer stopped after ${MAX_CONSECUTIVE_FAILURES} consecutive failures. Check your connection profile / backend.`, 'Summarizer', { timeOut: 8000 });
                break;
            }
        }
    }

    return results;
}

/**
 * Generate comprehensive summary from all batches
 */
export async function generateComprehensive(skipProfileSwitch = false) {
    const context = getContext();
    const chat = context.chat;
    const allBatches = getBatches().filter(b => !b.dirty && b.summary);
    const batches = getBackboneBatches();

    if (allBatches.length === 0) {
        throw new Error('No batch summaries available to create a comprehensive summary');
    }

    const groupInfo = getGroupInfo();
    const isGroup = !!groupInfo;
    const charName = isGroup ? null : (context.characters?.[context.characterId]?.name || 'Character');
    const otherSpeakers = getOtherSpeakers(chat.filter(m => !m.is_disabled), charName);

    const pinnedQuotes = getPinnedQuotes();

    // Raw opening/trailing messages carry no memory policy. The backbone uses
    // only eligible batch summaries so scoped facts cannot leak through a raw tail.
    const prompt = buildComprehensivePrompt(allBatches, [], [], otherSpeakers, pinnedQuotes, isGroup, charName, 'archive');
    // Comprehensive summaries are the longest output (up to 24-32 sentences plus
    // 8 quotes for long stories). Give CMRS an explicit, generous token ceiling so
    // the response isn't silently truncated by the connection profile's default,
    // which would cut off the closing </summary> tag and cause a parse failure.
    const response = await callLLM(prompt, skipProfileSwitch, 8192);
    const parsed = parseResponse(response);
    let contextText = '';
    if (batches.length === allBatches.length) {
        contextText = parsed.summary;
    } else if (batches.length > 0) {
        // Generate the prompt-facing text from a separate, restricted input so
        // scoped memories cannot bleed into it through the model's attention.
        const backboneIds = new Set(batches.map(batch => batch.id));
        const backbonePinned = pinnedQuotes.filter(quote => backboneIds.has(quote.batchId) && !quote.characterMemoryId);
        const backbonePrompt = buildComprehensivePrompt(batches, [], [], otherSpeakers, backbonePinned, isGroup, charName, 'backbone');
        const backboneResponse = await callLLM(backbonePrompt, skipProfileSwitch, 8192);
        contextText = parseResponse(backboneResponse).summary;
    }

    // Normalize a quote string for fuzzy dedup — lowercase, collapse whitespace,
    // strip leading/trailing punctuation so minor LLM variations still match.
    const normalizeQuote = (s) => (s || '').toLowerCase().replace(/[\s]+/g, ' ').replace(/[""''.,!?;:…—\-]+/g, '').trim();
    const quoteKey = (speaker, text) => `${normalizeQuote(speaker)}::${normalizeQuote(text)}`;

    // Merge pinned quotes into the result: ensure all pinned quotes are present
    // even if the LLM missed them, and preserve their pinned flag
    const finalQuotes = [...parsed.quotes];
    for (const pq of pinnedQuotes) {
        const pqKey = quoteKey(pq.speaker, pq.text);
        const alreadyIncluded = finalQuotes.some(q =>
            quoteKey(q.speaker, q.text) === pqKey,
        );
        if (!alreadyIncluded) {
            finalQuotes.push({
                speaker: pq.speaker,
                text: pq.text,
                context: pq.context,
            });
        }
    }

    // Mark which quotes in the final set are pinned
    const pinnedKeys = new Set(pinnedQuotes.map(pq => quoteKey(pq.speaker, pq.text)));
    finalQuotes.forEach(q => {
        if (pinnedKeys.has(quoteKey(q.speaker, q.text))) {
            q.pinned = true;
        }
    });

    return setComprehensiveSummary({
        text: parsed.summary,
        contextText,
        quotes: finalQuotes,
        metadata: {
            ...getCurrentChatMetadata(),
            excludedScopedMemories: Math.max(0, allBatches.length - batches.length),
        },
        basedOnBatches: allBatches.map(batch => batch.id),
        basedOnBackboneBatches: batches.map(batch => batch.id),
        backboneSignature: getComprehensiveBackboneSignature(),
        archiveSignature: getComprehensiveArchiveSignature(),
    });
}

/**
 * Regenerate a specific batch
 */
export async function regenerateBatch(batchId) {
    const batch = getBatch(batchId);
    if (!batch) throw new Error(`Batch ${batchId} not found`);
    const batches = getBatches();
    const batchIndex = batches.indexOf(batch);
    return await processBatch(batch.startIndex, batch.endIndex, batchIndex, batch);
}

/**
 * Regenerate comprehensive summary
 */
export async function regenerateComprehensive() {
    return await generateComprehensive();
}
