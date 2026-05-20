/**
 * legacyMigration.js — One-time migration of VM archive summaries → standalone fileStore
 *
 * Scans all VM verse archives for comprehensive summaries stored under
 * the 'versemanager' section, copies them into archive_summarizer.json
 * keyed by chat filename, with verse names preserved as tags.
 *
 * This is a COPY, not a MOVE — VM's archive data stays intact for
 * other VM features that may reference it.
 *
 * Idempotent: skips entries already present in the standalone store.
 * Gated by extension_settings.summarizer.legacyMigrationDone flag.
 */
import { extension_settings } from '../../../../extensions.js';
import { getStore, setSummary, flushStore } from './fileStore.js';
import { getSetting, setSetting, MODULE_NAME } from './storage.js';

const log = (...args) => console.log('[Summarizer Migration]', ...args);
const logError = (...args) => console.error('[Summarizer Migration]', ...args);

/**
 * Get all verse names that might have archive data.
 * Pulls from VM's extension_settings + always includes 'default'.
 */
function getVerseNames() {
    const vmSettings = extension_settings['verseManager'];
    if (!vmSettings?.verses) return ['default'];

    const names = Object.keys(vmSettings.verses);
    if (!names.includes('default')) {
        names.push('default');
    }
    return names;
}

/**
 * Run the legacy migration.
 * Call ONLY after confirming window.VerseManager.archiveStore exists.
 *
 * @returns {{ scanned: number, migrated: number, skipped: number, errors: number }}
 */
export async function runLegacyMigration() {
    const archiveStore = window.VerseManager?.archiveStore;
    if (!archiveStore?.getSection) {
        log('No archive store API found — skipping migration');
        return { scanned: 0, migrated: 0, skipped: 0, errors: 0 };
    }

    // Check gate flag
    if (extension_settings[MODULE_NAME]?.legacyMigrationDone) {
        log('Legacy migration already completed — skipping');
        return { scanned: 0, migrated: 0, skipped: 0, errors: 0 };
    }

    log('Starting legacy migration from VM archive store...');

    const verseNames = getVerseNames();
    const store = await getStore();
    const results = { scanned: 0, migrated: 0, skipped: 0, errors: 0 };

    for (const verseName of verseNames) {
        try {
            const vmData = await archiveStore.getSection(verseName, 'versemanager');
            if (!vmData?.summaries || Object.keys(vmData.summaries).length === 0) {
                continue;
            }

            const summaries = vmData.summaries;
            results.scanned += Object.keys(summaries).length;

            for (const [chatFilename, summaryData] of Object.entries(summaries)) {
                // Skip if already present in standalone store
                if (store.summaries[chatFilename]) {
                    results.skipped++;
                    continue;
                }

                // Copy with verse tag
                const migratedSummary = {
                    text: summaryData.text || '',
                    quotes: summaryData.quotes || [],
                    metadata: summaryData.metadata || null,
                    lastGenerated: summaryData.lastGenerated || Date.now(),
                    edited: summaryData.edited || false,
                    basedOnBatches: summaryData.basedOnBatches || [],
                    verse: verseName !== 'default' ? verseName : null,
                    storyline: null, // VM didn't store storyline on summaries
                };

                await setSummary(chatFilename, migratedSummary);
                results.migrated++;
            }
        } catch (error) {
            logError(`Failed to read verse archive "${verseName}":`, error);
            results.errors++;
        }
    }

    // Flush to ensure all migrated data is persisted
    if (results.migrated > 0) {
        try {
            await flushStore();
        } catch (e) {
            logError('Failed to flush after migration:', e);
        }
    }

    // Set gate flag to prevent re-running
    setSetting('legacyMigrationDone', true);

    log('Legacy migration complete:', results);

    if (results.migrated > 0) {
        toastr.success(
            `Migrated ${results.migrated} comprehensive summaries from VerseManager`,
            'Summarizer',
        );
    } else if (results.scanned > 0) {
        log(`All ${results.scanned} summaries already present — nothing to migrate`);
    } else {
        log('No summaries found in VM archives');
    }

    return results;
}
