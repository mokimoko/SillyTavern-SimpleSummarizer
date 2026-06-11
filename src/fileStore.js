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

// Debounce state
let saveTimer = null;
let pendingData = null;
let unloadRegistered = false;

// ============================================================
// File API helpers
// ============================================================

async function uploadJSON(data) {
    const json = JSON.stringify(data, null, 2);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);

    const response = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: FILENAME, data: base64 }),
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

function scheduleSave(data) {
    if (saveTimer) clearTimeout(saveTimer);

    pendingData = data;

    saveTimer = setTimeout(async () => {
        try {
            await uploadJSON(data);
            pendingData = null;
            saveTimer = null;
        } catch (e) {
            logError('Debounced save failed:', e.message);
            // Keep pendingData for flush attempt
            saveTimer = null;
        }
    }, DEBOUNCE_MS);
}

async function saveImmediate(data) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    pendingData = null;
    await uploadJSON(data);
}

function flushOnUnload() {
    if (!pendingData) return;

    try {
        const json = JSON.stringify(pendingData, null, 2);
        const bytes = new TextEncoder().encode(json);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const payload = JSON.stringify({ name: FILENAME, data: base64 });

        if (payload.length < 64000) {
            navigator.sendBeacon(
                '/api/files/upload',
                new Blob([payload], { type: 'application/json' }),
            );
        }
    } catch (e) {
        logError('Unload save failed:', e);
    }

    pendingData = null;
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
        unloadRegistered = true;
    }
}

/**
 * Load the store from disk (or return cached copy).
 */
export async function getStore() {
    if (loaded && cache) return cache;

    try {
        const data = await downloadJSON();
        cache = data || createEmptyStore();
    } catch (e) {
        logError('Failed to load store:', e.message);
        cache = createEmptyStore();
    }

    loaded = true;
    return cache;
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
        await saveImmediate(cache);
    }
}

/**
 * Invalidate the in-memory cache (force reload on next access).
 */
export function invalidateCache() {
    cache = null;
    loaded = false;
}
