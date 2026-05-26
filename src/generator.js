/**
 * generator.js — LLM prompts + parsing for Summarizer (standalone)
 * 
 * Lifted directly from VM's summarizer/src/generator.js.
 * Only changes: import paths rewired to standalone storage/utils.
 */
import { getContext } from '../../../../extensions.js';
import { generateQuietPrompt } from '../../../../../script.js';
import { switchToProfileWithConfirmation, restoreProfileWithConfirmation } from './utils.js';
import {
    getSetting,
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
} from './storage.js';

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
 * Build the quote attribution instructions, accounting for other characters
 */
function buildQuoteAttribution(otherSpeakers) {
    if (otherSpeakers.length === 0) {
        return `IMPORTANT: 
- Use exactly "CHARACTER:" for the character's quotes
- Use exactly "USER:" for the user's quotes
- Do NOT use actual character names in the quote attribution`;
    }

    return `IMPORTANT: 
- Use exactly "CHARACTER:" for the MAIN character's quotes
- Use exactly "USER:" for the user's quotes
- The following additional characters also appear: ${otherSpeakers.join(', ')}. Use their ACTUAL NAMES for quote attribution (e.g. "${otherSpeakers[0]}: \\"quote text\\" (context)")
- In the summary text, also refer to these additional characters by their actual names — do NOT fold them into the main character`;
}

/**
 * Build the establishment summary prompt (first batch)
 */
function buildEstablishmentPrompt(messages, otherSpeakers = []) {
    const length = getSetting('establishmentSummaryLength');

    let messagesText = messages.map((msg, i) => {
        const speaker = msg.is_user ? 'User' : msg.name || 'Character';
        return `Message ${i + 1} (${speaker}):\n${msg.mes}`;
    }).join('\n\n');

    const quoteAttribution = buildQuoteAttribution(otherSpeakers);

    return `You are a fact extractor for an ongoing roleplay. Your task is to record the key facts established in the opening messages of a story.

This is the FIRST batch. Think through these dimensions when extracting:
1. Setting — where are they? What does the place look like? What time is it, what's the weather, what's on the shelves? Concrete physical details that ground the scene.
2. Characters — who's here? What do they look like, what are they wearing, what can they do? What's their deal — their job, their background, their personality as shown through action?
3. Situation — what's actually happening right now? How did they get here? What's the problem or premise that kicked this off?
4. Relationships — who are these people to each other? How are they treating each other? Is someone in charge, is someone uncomfortable, is someone lying?
5. World-building — how does this world work? Is there magic, technology, hidden societies, rules about what's possible? Only include what's actually been established, not implications.

Output a single dense block of factual prose. No labels, no headers, no bullet points — just fact after fact, grouped in the natural order above. Each sentence should state a distinct fact. Do not narrate, dramatize, or editorialize. If a dimension has nothing notable, skip it entirely.

Additionally, if you notice any particularly MEMORABLE or QUOTABLE lines (emotional peaks, character-defining moments, witty dialogue, dramatic reveals), extract them. Only include quotes that would be memorable if this were a book or movie. Include 0-3 quotes maximum - don't force it.

Length requirement: ${length}
If fewer meaningful facts exist, write fewer sentences. Never pad or invent details to fill the target length.

Messages to summarize:
${messagesText}

Format your response EXACTLY as follows:

<summary>
Your summary text here
</summary>

<quotes>
CHARACTER: "Quote text" (Brief context)
USER: "Another quote" (Brief context)
</quotes>

${quoteAttribution}

If there are no memorable quotes, use:
<quotes>
none
</quotes>`;
}

/**
 * Build a regular batch summary prompt
 */
function buildBatchPrompt(messages, batchIndex, previousSummaries, otherSpeakers = []) {
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

    const quoteAttribution = buildQuoteAttribution(otherSpeakers);

    return `You are a fact extractor for an ongoing roleplay. Your task is to record the key facts and developments from batch ${batchIndex + 1}.

${contextText}Record ONLY new facts from the messages below. Do not repeat anything from previous context.

Think through these dimensions when extracting:
1. Setting — did they go somewhere new? Did the environment change? New time of day, new location, new details about the space?
2. Characters — did we learn something new about someone? New physical details, abilities, backstory, personality traits that weren't obvious before?
3. Situation — what actually happened in these messages? What did people do, what did they decide, what went wrong or right? What information came to light?
4. Relationships — did the way these people treat each other change? Did someone open up, shut down, betray someone, help someone? Are they closer or further apart than before, and why?
5. World-building — did we learn new rules about how this world works? New lore, new factions, new limitations on what's possible?

Output a single dense block of factual prose. No labels, no headers, no bullet points — just fact after fact, grouped in the natural order above. Each sentence should state a distinct fact. Do not narrate, dramatize, or pad with filler. If nothing changed in a dimension, skip it entirely.

Additionally, if you notice any particularly MEMORABLE or QUOTABLE lines (emotional peaks, character-defining moments, witty dialogue, dramatic reveals), extract them. Only include quotes that would be memorable if this were a book or movie. Include 0-3 quotes maximum - don't force it.

Length requirement: ${length}
If fewer meaningful facts exist, write fewer sentences. Never pad or invent details to fill the target length.

Messages to summarize:
${messagesText}

Format your response EXACTLY as follows:

<summary>
Your summary of these NEW messages
</summary>

<quotes>
CHARACTER: "Quote text" (Brief context)
USER: "Another quote" (Brief context)
</quotes>

${quoteAttribution}

If there are no memorable quotes, use:
<quotes>
none
</quotes>`;
}

/**
 * Build the comprehensive summary prompt
 */
function buildComprehensivePrompt(batches, firstMessages, trailingMessages, otherSpeakers = [], pinnedQuotes = []) {
    const length = getDynamicComprehensiveLength();

    let firstMessagesText = '';
    if (firstMessages && firstMessages.length > 0) {
        firstMessagesText = 'OPENING MESSAGES (for context):\n';
        firstMessages.forEach((msg, i) => {
            const speaker = msg.is_user ? 'User' : msg.name || 'Character';
            firstMessagesText += `Message ${i + 1} (${speaker}): ${msg.mes}\n`;
        });
        firstMessagesText += '\n';
    }

    let batchSummaries = batches.map((batch, i) => {
        const label = batch.type === 'establishment' ? '(SETUP)' : '';
        return `Batch ${i + 1} ${label}:\n${batch.summary}`;
    }).join('\n\n');

    let allQuotes = [];
    batches.forEach((batch, i) => {
        if (batch.quotes && batch.quotes.length > 0) {
            batch.quotes.forEach(quote => {
                allQuotes.push({ ...quote, sourceBatch: i + 1 });
            });
        }
    });

    let quotesSection = '';
    if (allQuotes.length > 0) {
        quotesSection = '\n\nALL MEMORABLE QUOTES FROM BATCHES:\n';
        allQuotes.forEach(q => {
            quotesSection += `Batch ${q.sourceBatch} - ${q.speaker}: "${q.text}" (${q.context})\n`;
        });
    }

    let trailingText = '';
    if (trailingMessages && trailingMessages.length > 0) {
        trailingText = '\n\nRECENT MESSAGES (after last batch):\n';
        trailingMessages.forEach((msg) => {
            const speaker = msg.is_user ? 'User' : msg.name || 'Character';
            trailingText += `Message ${msg.index + 1} (${speaker}): ${msg.mes}\n`;
        });
    }

    const quoteAttribution = buildQuoteAttribution(otherSpeakers);

    // Adjust auto-pick count based on pinned quotes
    const autoPickCount = Math.max(0, 8 - pinnedQuotes.length);

    let pinnedQuotesSection = '';
    if (pinnedQuotes.length > 0) {
        pinnedQuotesSection = '\n\nPINNED QUOTES (user-selected — ALWAYS include these exactly as written):\n';
        pinnedQuotes.forEach(q => {
            pinnedQuotesSection += `${q.speaker}: "${q.text}"${q.context ? ` (${q.context})` : ''}\n`;
        });
    }

    let quoteSelectionInstruction;
    if (pinnedQuotes.length === 0) {
        quoteSelectionInstruction = `Select exactly 8 quotes (or fewer if there aren't 8 good ones available). Do not make up quotes - only use quotes from the batch quotes provided above.`;
    } else if (autoPickCount > 0) {
        quoteSelectionInstruction = `The user has pinned ${pinnedQuotes.length} quote(s) listed above — ALWAYS include those exactly as written. Then select up to ${autoPickCount} additional quotes from the batch quotes to reach a total of 8. Do not make up quotes.`;
    } else {
        quoteSelectionInstruction = `The user has pinned ${pinnedQuotes.length} quote(s) listed above — include ALL of them exactly as written. Do not select any additional quotes. Do not make up quotes.`;
    }

    return `You are a fact extractor for a roleplay conversation. Your task is to produce a COMPREHENSIVE, CHRONOLOGICAL record of a long-form story or roleplay from batch summaries.

Think through these dimensions when synthesizing the full story:
1. Setting — where did things take place across the story? Did locations change, did the characters move around?
2. Characters — who are these people now compared to who they were at the start? What did we learn about them along the way?
3. Situation — what's the through-line of events from beginning to present? What were the major turning points, the big decisions, the things that can't be undone?
4. Relationships — how do these people feel about each other now? How did that change from the beginning? Who got closer, who drifted, who betrayed whom?
5. World-building — what do we know about how this world works, accumulated across the whole story?

OUTPUT REQUIREMENTS:
- Chronological order, earliest to latest.
- Merge repeated or similar events into a single coherent progression.
- Exclude conversational filler unless it meaningfully affected character dynamics or plot.
- Do NOT invent events, motivations, or outcomes.
- Output a single dense block of factual prose. No labels, no headers, no bullet points — just fact after fact. Every sentence should convey meaningful information. Do not narrate or dramatize — state what happened and what resulted.

This comprehensive record will be used to provide context in other scenarios or when starting new related stories.

Length requirement: ${length} (This length is based on the story's size - longer stories get more detail)
If fewer meaningful facts exist, write fewer sentences. Never pad or invent details to fill the target length.

${firstMessagesText}BATCH SUMMARIES:
${batchSummaries}${quotesSection}${pinnedQuotesSection}${trailingText}

Format your response EXACTLY as follows:

<summary>
Your cohesive comprehensive summary here
</summary>

<quotes>
CHARACTER: "Quote text" (Brief context)
USER: "Another quote" (Brief context)
</quotes>

${quoteAttribution}

${quoteSelectionInstruction}`;
}

/**
 * Parse quotes from LLM response text
 */
function parseQuotes(quotesText) {
    const quotes = [];
    if (!quotesText || quotesText.toLowerCase() === 'none') return quotes;

    const context = getContext();
    const charName = context.characters?.[context.characterId]?.name || 'Character';
    const userName = context.name1 || 'User';

    const quoteLines = quotesText.split('\n').filter(line => line.trim());

    for (const line of quoteLines) {
        const match = line.match(/^(.+?):\s*[""\u201C](.+?)[""\u201D]\s*(?:\((.+?)\))?$/);
        if (match) {
            let speaker = match[1].trim();
            if (speaker === 'CHARACTER') speaker = charName;
            if (speaker === 'USER') speaker = userName;
            quotes.push({
                speaker,
                text: match[2].trim(),
                context: match[3] ? match[3].trim() : '',
            });
        }
    }

    return quotes;
}

/**
 * Parse summary + quotes from an LLM response
 */
function parseResponse(response) {
    const summaryMatch = response.match(/<summary>(.*?)<\/summary>/s);
    let quotesMatch = response.match(/<quotes>(.*?)<\/quotes>/s);
    if (!quotesMatch) {
        quotesMatch = response.match(/<quotes>(.*)/s);
        if (quotesMatch) console.warn('Summarizer: Quotes closing tag missing, parsing anyway');
    }

    if (!summaryMatch) throw new Error('Failed to parse summary from response');

    const summary = summaryMatch[1].trim();
    const quotes = quotesMatch ? parseQuotes(quotesMatch[1].trim()) : [];

    return { summary, quotes };
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
async function callLLM(prompt, skipProfileSwitch = false) {
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
                    console.log('[Summarizer] Using CMRS for generation (profile:', resolvedProfile.name || resolvedProfile.id, ')');
                    // Retry once on transient failures
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            const cmrsResult = await CMRS.sendRequest(resolvedProfile.id, [
                                { role: 'user', content: prompt },
                            ]);
                            const response = cmrsResult?.content
                                || cmrsResult?.choices?.[0]?.message?.content
                                || cmrsResult?.text
                                || cmrsResult?.output
                                || '';
                            if (response) return String(response).trim();
                            console.warn('[Summarizer] CMRS returned empty (attempt', attempt + 1, ')');
                        } catch (err) {
                            console.warn(`[Summarizer] CMRS attempt ${attempt + 1} failed:`, err.message);
                            if (attempt === 0) await new Promise(r => setTimeout(r, 2000));
                        }
                    }
                    // Both CMRS attempts failed — fall through to quiet prompt
                    console.warn('[Summarizer] CMRS exhausted, falling back to generateQuietPrompt');
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
                console.log('[Summarizer] Profile switched for fallback generation');
            } else {
                console.warn('[Summarizer] Profile switch failed, using current profile:', result.error);
            }
        }

        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                console.log('[Summarizer] Using generateQuietPrompt (fallback path)');
                const response = await generateQuietPrompt({
                    quietPrompt: prompt,
                    quietName: 'Summarizer',
                    skipWIAN: true,
                    responseLength: 4096,
                });

                if (!response) throw new Error('Empty response from LLM');
                return String(response).trim();
            } catch (error) {
                lastError = error;
                if (attempt === 0) {
                    console.warn(`[Summarizer] Quiet prompt attempt ${attempt + 1} failed, retrying in 2s...`, error.message);
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
                console.warn('[Summarizer] Profile restoration failed:', restoreResult.error);
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
        if (chat[i] && !chat[i].is_disabled) {
            messages.push({ ...chat[i], index: i });
        }
    }
    if (messages.length === 0) throw new Error('No messages found for batch');

    // Detect other speakers
    const charName = context.characters?.[context.characterId]?.name || 'Character';
    const otherSpeakers = getOtherSpeakers(messages, charName);
    if (otherSpeakers.length > 0) console.log('Summarizer: Detected other speakers in batch:', otherSpeakers);

    let prompt;
    if (batchType === 'establishment') {
        prompt = buildEstablishmentPrompt(messages, otherSpeakers);
    } else {
        const lookBackCount = getSetting('lookBackBatches');
        const batches = getBatches();
        const previousBatches = batches
            .filter(b => b.startIndex < startIndex && b.summary && !b.dirty)
            .slice(-lookBackCount)
            .map((b) => ({ index: batches.indexOf(b), summary: b.summary }));
        prompt = buildBatchPrompt(messages, batchIndex, previousBatches, otherSpeakers);
    }

    const response = await callLLM(prompt, skipProfileSwitch);
    const parsed = parseResponse(response);

    return { summary: parsed.summary, quotes: parsed.quotes, type: batchType };
}

/**
 * Process a single batch (generate or regenerate)
 */
export async function processBatch(startIndex, endIndex, batchIndex, existingBatch = null, skipProfileSwitch = false, explicitType = null) {
    try {
        const result = await generateBatchSummary(startIndex, endIndex, batchIndex, skipProfileSwitch, explicitType);

        if (existingBatch) {
            return updateBatch(existingBatch.id, {
                summary: result.summary,
                quotes: result.quotes || [],
                type: result.type,
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
                dirty: false,
                edited: false,
                generatedAt: Date.now(),
            });
        }
    } catch (error) {
        console.error('Summarizer: Failed to process batch:', error);
        if (existingBatch) {
            return updateBatch(existingBatch.id, { dirty: true, error: error.message });
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
    const batchSize = getSetting('batchSize');
    const batches = getBatches();
    const results = [];

    // Allow callers (auto-mode) to cap the effective length so trailing
    // "active" messages are never included in a complete batch.
    const chatLength = effectiveChatLength ?? chat.length;
    const completeBatches = Math.floor(chatLength / batchSize);

    console.log(`[Summarizer] processUnprocessedBatches: chatLength=${chatLength} (actual=${chat.length}), batchSize=${batchSize}, completeBatches=${completeBatches}`);

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
                console.warn(`[Summarizer] ${MAX_CONSECUTIVE_FAILURES} consecutive failures — aborting remaining ${remaining} batch(es). Backend may be down.`);
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
    const batches = getBatches().filter(b => !b.dirty && b.summary);

    if (batches.length === 0) {
        throw new Error('No batch summaries available to create comprehensive summary');
    }

    const firstMessages = chat
        .slice(0, Math.min(2, chat.length))
        .filter(msg => !msg.is_disabled)
        .map((msg, i) => ({ ...msg, index: i }));

    const lastBatchEndIndex = batches[batches.length - 1].endIndex;
    const trailingMessages = [];
    if (lastBatchEndIndex < chat.length - 1) {
        for (let i = lastBatchEndIndex + 1; i < chat.length; i++) {
            if (!chat[i].is_disabled) {
                trailingMessages.push({ ...chat[i], index: i });
            }
        }
    }

    const charName = context.characters?.[context.characterId]?.name || 'Character';
    const otherSpeakers = getOtherSpeakers(chat.filter(m => !m.is_disabled), charName);
    const pinnedQuotes = getPinnedQuotes();

    console.log('Comprehensive summary including:', {
        batches: batches.length,
        firstMessages: firstMessages.length,
        trailingMessages: trailingMessages.length,
        totalChatLength: chat.length,
        otherSpeakers,
        pinnedQuotes: pinnedQuotes.length,
    });

    const prompt = buildComprehensivePrompt(batches, firstMessages, trailingMessages, otherSpeakers, pinnedQuotes);
    const response = await callLLM(prompt, skipProfileSwitch);
    const parsed = parseResponse(response);

    // Merge pinned quotes into the result: ensure all pinned quotes are present
    // even if the LLM missed them, and preserve their pinned flag
    const finalQuotes = [...parsed.quotes];
    for (const pq of pinnedQuotes) {
        const alreadyIncluded = finalQuotes.some(q =>
            q.text === pq.text && q.speaker === pq.speaker,
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
    const pinnedTexts = new Set(pinnedQuotes.map(pq => `${pq.speaker}::${pq.text}`));
    finalQuotes.forEach(q => {
        if (pinnedTexts.has(`${q.speaker}::${q.text}`)) {
            q.pinned = true;
        }
    });

    return setComprehensiveSummary({
        text: parsed.summary,
        quotes: finalQuotes,
        metadata: getCurrentChatMetadata(),
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
