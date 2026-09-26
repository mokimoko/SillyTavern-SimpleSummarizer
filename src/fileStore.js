/**
 * fileStore.js — Simplified file storage for Summarizer
 *
 * Single file: user/files/archive_summarizer.json
 * Keyed by chat filename. Debounced saves + unload flush.
 *
 * Combines file-api.js + file-backed-data.js into one module.
 */
import { getRequestHeaders } from '../../../../../script.js';

const logError = (...args) => console.error('[Summarizer FileStore]', ...args);

const FILENAME = 'archive_summarizer.json';
const FILE_PATH = `user/files/${FILENAME}`;
const FILE_URL = `/${FILE_PATH}`;
const DEBOUNCE_MS = 2000;

// In-memory cache
let cache = null;
let loaded = false;
let loadPromise = null;

// Debounce state
let saveTimer = null;
let pendingData = null;
let saveInFlight = null;
let unloadRegistered = false;

// ============================================================
// File API helpers
// ============================================================

function encodeBase64Utf8(value) {
    const bytes = new TextEncoder().encode(value);
    const chunks = [];
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + chunkSize)));
    }
    return btoa(chunks.join(''));
}

function buildUploadPayload(data) {
    const json = JSON.stringify(data, null, 2);
    return JSON.stringify({ name: FILENAME, data: encodeBase64Utf8(json) });
}

async function uploadJSON(data) {
    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: buildUploadPayload(data),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Upload failed: ${errorText}`);
    }

    return (await response.json()).path;
}

async function downloadJSON() {
    const response = await fetch(FILE_URL, {
        method: 'GET',
        headers: getRequestHeaders(),
    });

    if (response.status === 404) return null;
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Download failed: ${errorText}`);
    }

    const text = await response.text();
    return JSON.parse(text);
}

// ============================================================
// Debounced persistence
// ============================================================

async function persistPending() {
    if (saveInFlight) {
        await saveInFlight;
        if (pendingData) await persistPending();
        return;
    }

    const drain = (async () => {
        while (pendingData) {
            const data = pendingData;
            pendingData = null;
            try {
                await uploadJSON(data);
            } catch (e) {
                if (!pendingData) pendingData = data;
                throw e;
            }
        }
    })();
    saveInFlight = drain;

    try {
        await drain;
    } finally {
        if (saveInFlight === drain) saveInFlight = null;
    }

    if (pendingData) await persistPending();
}

function scheduleSave(data) {
    if (saveTimer) clearTimeout(saveTimer);

    pendingData = data;

    saveTimer = setTimeout(() => {
        saveTimer = null;
        persistPending().catch(e => {
            logError('Debounced save failed:', e.message);
        });
    }, DEBOUNCE_MS);
}

async function saveImmediate(data) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingData = data;
    await persistPending();
}

function flushOnUnload() {
    if (!pendingData) return;

    try {
        const payload = buildUploadPayload(pendingData);

        if (payload.length < 64000) {
            const accepted = navigator.sendBeacon(
                '/api/files/upload',
                new Blob([payload], { type: 'application/json' }),
            );
            if (accepted) pendingData = null;
        }
    } catch (e) {
        logError('Unload save failed:', e);
    }
}

function flushWhenHidden() {
    if (document.visibilityState !== 'hidden' || !pendingData) return;
    flushStore().catch(e => logError('Background save failed:', e.message));
}

// ============================================================
// Public API
// ============================================================

/**
 * Create the empty store structure
 */
function createEmptyStore() {
    return {
        version: 1,
        lastModified: new Date().toISOString(),
        summaries: {},
    };
}

/**
 * Initialize the file store. Call once on extension init.
 */
export function initFileStore() {
    if (!unloadRegistered) {
        window.addEventListener('beforeunload', flushOnUnload);
        document.addEventListener('visibilitychange', flushWhenHidden);
        unloadRegistered = true;
    }
}

/**
 * Load the store from disk (or return cached copy).
 */
export async function getStore() {
    if (loaded && cache) return cache;
    if (loadPromise) return loadPromise;

    loadPromise = (async () => {
        try {
            const data = await downloadJSON();
            cache = data || createEmptyStore();
            loaded = true;
            return cache;
        } catch (e) {
            logError('Failed to load store:', e.message);
            cache = null;
            loaded = false;
            throw e;
        } finally {
            loadPromise = null;
        }
    })();
    return loadPromise;
}

/**
 * Get a comprehensive summary by chat filename.
 */
export async function getSummary(chatFilename) {
    const store = await getStore();
    return store.summaries[chatFilename] || null;
}

/**
 * Set a comprehensive summary for a chat filename. Debounced save.
 */
export async function setSummary(chatFilename, summaryObject) {
    const store = await getStore();
    store.summaries[chatFilename] = summaryObject;
    store.lastModified = new Date().toISOString();
    scheduleSave(store);
}

/**
 * Update a comprehensive summary (partial merge). Debounced save.
 */
export async function updateSummary(chatFilename, updates) {
    const store = await getStore();
    const existing = store.summaries[chatFilename];
    if (!existing) return null;

    store.summaries[chatFilename] = { ...existing, ...updates };
    store.lastModified = new Date().toISOString();
    scheduleSave(store);
    return store.summaries[chatFilename];
}

/**
 * Delete a comprehensive summary. Debounced save.
 */
export async function deleteSummary(chatFilename) {
    const store = await getStore();
    if (store.summaries[chatFilename]) {
        delete store.summaries[chatFilename];
        store.lastModified = new Date().toISOString();
        scheduleSave(store);
    }
}

/**
 * Force an immediate save (for critical writes).
 */
export async function flushStore() {
    if (cache) {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = null;
        pendingData = cache;
        await saveImmediate(cache);
    }
}

/**
 * Invalidate the in-memory cache (force reload on next access).
 */
export function invalidateCache() {
    cache = null;
    loaded = false;
    loadPromise = null;
}
