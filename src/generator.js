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
 * Build the history summary prompt for past events from ScenarioCrafter
 */
function buildHistoryPrompt(pastHistoryContent) {
    const contentMatch = pastHistoryContent.match(/<past_history>([\s\S]*?)<\/past_history>/);
    const content = contentMatch ? contentMatch[1].trim() : pastHistoryContent;

    const wordCount = content.split(/\s+/).length;
    let targetLength;

    if (wordCount < 500) {
        targetLength = '1-2 paragraphs (300-400 words)';
    } else if (wordCount < 1500) {
        targetLength = '2-3 paragraphs (400-500 words)';
    } else {
        targetLength = '3-4 paragraphs (500-600 words)';
    }

    return `You are a summarization assistant. Your task is to create a CONCISE HISTORY summary of events that occurred BEFORE the current story.

This is a special summary of PAST EVENTS that will provide context for a new story/chat. Your summary should:
- Capture the essential plot progression and character development from the past
- Focus on events, decisions, and consequences that might be relevant going forward
- Maintain chronological order
- Be thorough but concise - this is background context, not the main story

Length requirement: ${targetLength}

Past events to summarize:
${content}

Format your response EXACTLY as follows:

<summary>
Your concise summary of past events here
</summary>

<quotes>
none
</quotes>

IMPORTANT: Do not include quotes for history summaries - just output "none" in the quotes section.`;
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

    return `You are a summarization assistant. Your task is to create an ESTABLISHMENT summary for the beginning of a story/roleplay.

This is the FIRST batch of messages. Your summary should establish:
- The setting and context
- Main characters introduced
- The initial situation/premise
- The overall tone

Additionally, if you notice any particularly MEMORABLE or QUOTABLE lines (emotional peaks, character-defining moments, witty dialogue, dramatic reveals), extract them. Only include quotes that would be memorable if this were a book or movie. Include 0-3 quotes maximum - don't force it.

Length requirement: ${length}

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

    return `You are a summarization assistant. Your task is to create a CONTINUATION summary for batch ${batchIndex + 1} of an ongoing story/roleplay.

${contextText}Now summarize the NEW events in the messages below. DO NOT repeat information from previous summaries - focus ONLY on what happens in these new messages.

Additionally, if you notice any particularly MEMORABLE or QUOTABLE lines (emotional peaks, character-defining moments, witty dialogue, dramatic reveals), extract them. Only include quotes that would be memorable if this were a book or movie. Include 0-3 quotes maximum - don't force it.

Length requirement: ${length}

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
function buildComprehensivePrompt(batches, firstMessages, trailingMessages, otherSpeakers = []) {
    const length = getDynamicComprehensiveLength();
    const hasHistoryBatch = batches.some(b => b.type === 'history');

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
        let label = '';
        if (batch.type === 'history') label = '(PAST HISTORY - for context only)';
        else if (batch.type === 'establishment') label = '(SETUP)';
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

    let historyInstruction = '';
    if (hasHistoryBatch) {
        historyInstruction = `\n\nIMPORTANT - PAST HISTORY HANDLING:
Batch 1 contains "PAST HISTORY" - events that occurred BEFORE the current story. This is provided for context only. In your comprehensive summary:
- DO NOT fully recap the past history
- Reference past events ONLY when they directly connect to or explain current story developments
- Focus your summary on the CURRENT story (batches marked as SETUP and regular batches)
- You may briefly mention past context when it's essential for understanding character motivations or plot continuity`;
    }

    return `You are a summarization assistant. Your task is to produce a COMPREHENSIVE, CHRONOLOGICAL summary of a long-form story or roleplay.

INPUT:
You will be given a detailed recounting or partial summaries of events that occurred in the story.

OUTPUT REQUIREMENTS:
- The summary must be chronological, ordered from earliest to latest events.
- Focus on plot-significant events, character decisions, relationship developments, and lasting consequences.
- Preserve emotional continuity: track how major characters feel, change, and relate to one another over time.
- Merge repeated or similar events into a single coherent progression when appropriate.
- Exclude conversational filler, small talk, or momentary banter unless it meaningfully affects character dynamics or future events.
- Do NOT invent new events, motivations, or outcomes.${historyInstruction}

This comprehensive summary will be used to provide context in other scenarios or when starting new related stories.

Additionally, from ALL the quotes you've been provided, select the 8 MOST SIGNIFICANT ones. Choose quotes that:
- Span the whole story arc
- Mix emotional peaks with most quotable moments  
- Roughly evenly split between the character and user
- Best represent the essence of the story

Length requirement: ${length} (This length is based on the story's size - longer stories get more detail)

${firstMessagesText}BATCH SUMMARIES:
${batchSummaries}${quotesSection}${trailingText}

Format your response EXACTLY as follows:

<summary>
Your cohesive comprehensive summary here
</summary>

<quotes>
CHARACTER: "Quote text" (Brief context)
USER: "Another quote" (Brief context)
</quotes>

${quoteAttribution}

Select exactly 8 quotes (or fewer if there aren't 8 good ones available). Do not make up quotes - only use quotes from the batch quotes provided above.`;
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

    // Special handling for history batch (ScenarioCrafter past_history)
    if (batchType === 'history') {
        const historyMessage = chat[startIndex];
        if (!historyMessage || !historyMessage.extra?.scenariocrafter_past_history) {
            throw new Error('History batch requested but no past history message found');
        }

        const prompt = buildHistoryPrompt(historyMessage.mes);
        const response = await callLLM(prompt, skipProfileSwitch);
        const summaryMatch = response.match(/<summary>([\s\S]*?)<\/summary>/);
        if (!summaryMatch) throw new Error('Failed to parse summary from response');

        return { summary: summaryMatch[1].trim(), quotes: [], type: 'history' };
    }

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

    // Check for ScenarioCrafter past history
    const hasPastHistory = chat[0]?.extra?.scenariocrafter_past_history === true;
    let batchStartOffset = 0;

    if (hasPastHistory) {
        const existingHistory = batches.find(b => b.startIndex === 0 && b.endIndex === 0 && b.type === 'history');

        if (!existingHistory || !existingHistory.summary || existingHistory.dirty) {
            if (onProgress) onProgress({ current: 1, total: 'calculating...', type: 'history' });

            try {
                const historyBatch = await processBatch(0, 0, 0, existingHistory, skipProfileSwitch, 'history');
                results.push(historyBatch);
                console.log('Summarizer: History batch processed');
            } catch (error) {
                console.error('Summarizer: Failed to process history batch:', error);
                results.push({ error: error.message, index: 0, type: 'history' });
            }
        } else {
            results.push(existingHistory);
        }

        batchStartOffset = 1;
    }

    const availableLength = chatLength - batchStartOffset;
    const completeBatches = Math.floor(availableLength / batchSize);

    console.log(`[Summarizer] processUnprocessedBatches: chatLength=${chatLength} (actual=${chat.length}), batchStartOffset=${batchStartOffset}, availableLength=${availableLength}, batchSize=${batchSize}, completeBatches=${completeBatches}`);

    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 2;

    for (let i = 0; i < completeBatches; i++) {
        const startIndex = batchStartOffset + (i * batchSize);
        const endIndex = startIndex + batchSize - 1;

        const existing = batches.find(b => b.startIndex === startIndex && b.endIndex === endIndex);
        if (existing && existing.summary && !existing.dirty) {
            results.push(existing);
            continue;
        }

        const batchType = (i === 0) ? 'establishment' : 'regular';

        if (onProgress) {
            const progressIndex = hasPastHistory ? i + 2 : i + 1;
            const progressTotal = hasPastHistory ? completeBatches + 1 : completeBatches;
            onProgress({ current: progressIndex, total: progressTotal, type: batchType });
        }

        try {
            const actualBatchIndex = hasPastHistory ? i + 1 : i;
            const batch = await processBatch(startIndex, endIndex, actualBatchIndex, existing, skipProfileSwitch, batchType);
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

    console.log('Comprehensive summary including:', {
        batches: batches.length,
        firstMessages: firstMessages.length,
        trailingMessages: trailingMessages.length,
        totalChatLength: chat.length,
        otherSpeakers,
    });

    const prompt = buildComprehensivePrompt(batches, firstMessages, trailingMessages, otherSpeakers);
    const response = await callLLM(prompt, skipProfileSwitch);
    const parsed = parseResponse(response);

    return setComprehensiveSummary({
        text: parsed.summary,
        quotes: parsed.quotes,
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
