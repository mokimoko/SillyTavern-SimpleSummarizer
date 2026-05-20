/**
 * comprehensiveCache.js — Session-level cache for comprehensive summaries (standalone)
 * 
 * Used by chatroom/matchmaker when they need to load summaries for a storyline.
 * Rewired to use Summarizer's own fileStore instead of VM's archive-store.
 */
import { user_avatar } from '../../../../personas.js';
import { getSummariesByVerse, getSummariesByStoryline } from './fileStore.js';

const log = (...args) => console.log('[Summarizer Cache]', ...args);

class ComprehensiveSummaryCache {
    constructor() {
        this.cache = new Map();
        this.currentVerseKey = null;
        this.currentPersona = null;
        log('Initialized');
    }

    /**
     * Load summaries for a storyline
     * Returns array of summary texts
     */
    async loadSummariesForStoryline(verseKey, storylineId) {
        const persona = user_avatar;

        // Invalidate cache if context changed
        if (verseKey !== this.currentVerseKey || persona !== this.currentPersona) {
            log('Context changed, clearing cache');
            this.cache.clear();
            this.currentVerseKey = verseKey;
            this.currentPersona = persona;
        }

        // Get summaries via the public API
        const MAX_SUMMARIES = 5;
        let summaryObjects;

        try {
            if (storylineId) {
                summaryObjects = await getSummariesByStoryline(verseKey, storylineId);
            } else {
                summaryObjects = await getSummariesByVerse(verseKey);
            }
        } catch (error) {
            console.error('ComprehensiveSummaryCache: Failed to load summaries:', error);
            return [];
        }

        // Take most recent ones
        const recentSummaries = summaryObjects.slice(-MAX_SUMMARIES);
        const results = [];

        for (const summary of recentSummaries) {
            if (summary?.text) {
                results.push(summary.text);
            }
        }

        log(`Loaded ${results.length} summaries`);
        return results;
    }

    clear() {
        log('Manually cleared');
        this.cache.clear();
        this.currentVerseKey = null;
        this.currentPersona = null;
    }
}

// Singleton instance (lazy-initialized)
let cacheInstance = null;

export function getComprehensiveSummaryCache() {
    if (!cacheInstance) {
        cacheInstance = new ComprehensiveSummaryCache();
    }
    return cacheInstance;
}

export function clearComprehensiveSummaryCache() {
    if (cacheInstance) cacheInstance.clear();
}

export function destroyComprehensiveSummaryCache() {
    if (cacheInstance) {
        cacheInstance.clear();
        cacheInstance = null;
        log('Destroyed');
    }
}
