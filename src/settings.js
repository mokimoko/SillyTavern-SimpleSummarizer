/**
 * settings.js — Settings HTML + handlers for Summarizer (standalone)
 * 
 * Rewired from VM's summarizer settings tab.
 * Settings stored in extension_settings.summarizer (not verseManager).
 */
import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings, getContext } from '../../../../extensions.js';
import {
    getSetting,
    setSetting,
    getPromptSettings,
    setPromptSetting,
    toggleEnabled,
    isEnabled,
    MODULE_NAME,
    default_settings,
    getComprehensiveLengthDescription,
} from './storage.js';
import { refreshSummarizerPrompt, updateContextArchivesPromptContent } from './promptInjection.js';
import {
    getConfig as getCAConfig,
    setConfig as setCAConfig,
    getPlacementConfig as getCAPlacement,
    setPlacementConfig as setCAPlacement,
    getAssignedArchives,
    assignArchive,
    removeArchive,
    moveArchive,
    getArchivePool,
    isContextArchivesEnabled,
    setContextArchivesEnabled,
} from './contextArchives.js';

function escapeAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtmlAttr(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function hasActiveChat() {
    const context = getContext();
    return context && context.chatId && context.chat && context.chat.length > 0;
}

/**
 * Create the settings HTML for the extension drawer
 */
export function createSettingsHTML() {
    const hasChat = hasActiveChat();
    const enabled = isEnabled();
    const auto = getSetting('auto');
    const autoBuffer = getSetting('autoBuffer');
    const batchSize = getSetting('batchSize');
    const maxSummaries = getSetting('maxSummariesInContext');
    const exclusionMode = getSetting('messageExclusionMode');
    const exclusionBatches = getSetting('messageExclusionBatches');
    const exclusionMessages = getSetting('messageExclusionMessages');
    const alwaysFirst = getSetting('alwaysKeepFirstNBatches');
    const alwaysLast = getSetting('alwaysKeepLastNBatches');
    const lookBack = getSetting('lookBackBatches');
    const showInChat = getSetting('showSummariesInChat');
    const displayStyle = getSetting('summaryDisplayStyle');
    const connectionProfile = getSetting('connectionProfile');

    const placement = getPromptSettings();

    // Context Archives config
    const caConfig = getCAConfig();
    const caPlacement = getCAPlacement();
    const caAssigned = getAssignedArchives();

    return `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Simple Summarizer</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">

                <div class="summarizer-chat-specific" style="display: ${hasChat ? 'block' : 'none'};">
                    <label class="checkbox_label">
                        <input type="checkbox" id="summarizer-enabled" ${enabled ? 'checked' : ''}>
                        <span>Enable summarizer for this chat</span>
                    </label>
                    <small>Toggle batch summarization for the current chat</small>
                </div>

                <div class="summarizer-no-chat" style="display: ${hasChat ? 'none' : 'block'}; padding: 0.5em; text-align: center; opacity: 0.7;">
                    <p><i class="fa-solid fa-info-circle"></i> Start or open a chat to enable chat-specific settings</p>
                </div>

                <label class="checkbox_label">
                    <input type="checkbox" id="summarizer-auto" ${auto ? 'checked' : ''}>
                    <span>Auto-process mode</span>
                </label>
                <small>Automatically process summaries as chat grows</small>

                <label>Active Message Buffer
                    <input type="number" id="summarizer-auto-buffer" class="text_pole" min="0" max="10" value="${autoBuffer}" style="width: 60px;">
                </label>
                <small>Skip last N messages in auto-mode (they're still active in RP)</small>

                <label>Batch Size
                    <input type="number" id="summarizer-batch-size" class="text_pole" min="1" max="20" value="${batchSize}" style="width: 60px;">
                </label>
                <small>Messages per batch (1-20)</small>

                <label>Context Look-back
                    <input type="number" id="summarizer-lookback" class="text_pole" min="0" max="5" value="${lookBack}" style="width: 60px;">
                </label>
                <small>Previous batches to include for context (0-5)</small>

                <hr>
                <h4><i class="fa-solid fa-scissors"></i> Message Trimming</h4>
                <label>Start trimming summarized messages after:</label>
                <div style="display: flex; gap: 1em; align-items: center; flex-wrap: wrap; margin: 0.25em 0;">
                    <label class="checkbox_label" style="margin: 0;">
                        <input type="radio" name="summarizer-exclusion-mode" value="batches" ${exclusionMode === 'batches' ? 'checked' : ''}>
                        <input type="number" id="summarizer-exclusion-batches" class="text_pole" min="1" max="100" value="${exclusionBatches}" style="width: 60px; margin: 0 0.25em;">
                        <span>batches</span>
                    </label>
                    <label class="checkbox_label" style="margin: 0;">
                        <input type="radio" name="summarizer-exclusion-mode" value="messages" ${exclusionMode === 'messages' ? 'checked' : ''}>
                        <input type="number" id="summarizer-exclusion-messages" class="text_pole" min="1" max="1000" value="${exclusionMessages}" style="width: 60px; margin: 0 0.25em;">
                        <span>messages</span>
                    </label>
                </div>

                <hr>
                <h4><i class="fa-solid fa-layer-group"></i> Summary Injection</h4>

                <label class="checkbox_label">
                    <input type="checkbox" id="summarizer-include-in-prompts" ${placement.includeInPrompts !== false ? 'checked' : ''}>
                    <span>Include batch summaries in prompts</span>
                </label>
                <small>Injected before chat history as a system message</small>

                <div id="summarizer-placement-settings" ${placement.includeInPrompts !== false ? '' : 'style="display: none;"'}>
                    <label>Max summaries in context
                        <input type="number" id="summarizer-max-summaries" class="text_pole" min="3" max="50" value="${maxSummaries}" style="width: 60px;">
                    </label>
                    <label>Always include first N batches
                        <input type="number" id="summarizer-always-first" class="text_pole" min="1" max="10" value="${alwaysFirst}" style="width: 60px;">
                    </label>
                    <label>Always include last N batches
                        <input type="number" id="summarizer-always-last" class="text_pole" min="1" max="10" value="${alwaysLast}" style="width: 60px;">
                    </label>
                </div>

                <hr>
                <h4><i class="fa-solid fa-eye"></i> Display</h4>

                <label class="checkbox_label">
                    <input type="checkbox" id="summarizer-show-in-chat" ${showInChat ? 'checked' : ''}>
                    <span>Show summaries in chat</span>
                </label>
                <label>Display style
                    <select id="summarizer-display-style" class="text_pole">
                        <option value="minimal" ${displayStyle === 'minimal' ? 'selected' : ''}>Minimal (truncated)</option>
                        <option value="full" ${displayStyle === 'full' ? 'selected' : ''}>Full text</option>
                    </select>
                </label>

                <hr>
                <h4><i class="fa-solid fa-microchip"></i> Generation</h4>
                <label>Connection Profile
                    <select id="summarizer-connection-profile" class="text_pole">
                        <option value="">Use current connection</option>
                    </select>
                </label>

                <p style="margin: 0.5em 0; font-size: 0.85em; opacity: 0.8;">
                    Comprehensive length: <span id="comprehensive-length-display">Dynamic based on story length</span>
                </p>

                <div class="summarizer-chat-specific" style="display: ${hasChat ? 'block' : 'none'}; margin-top: 1em;">
                    <div style="display: flex; gap: 0.5em; flex-wrap: wrap;">
                        <button id="summarizer-process-btn" class="menu_button"><i class="fa-solid fa-play"></i> Process</button>
                        <button id="summarizer-comprehensive-btn" class="menu_button"><i class="fa-solid fa-file-text"></i> Comprehensive</button>
                        <button id="summarizer-view-comprehensive-btn" class="menu_button"><i class="fa-solid fa-eye"></i> View</button>
                        <button id="summarizer-clear-btn" class="menu_button"><i class="fa-solid fa-trash"></i> Clear All</button>
                    </div>
                </div>

                <hr>
                <h4><i class="fa-solid fa-box-archive"></i> Context Archives</h4>

                <label class="checkbox_label">
                    <input type="checkbox" id="ca-include-in-prompts" ${caPlacement.includeInPrompts ? 'checked' : ''}>
                    <span>Inject context archives into prompts</span>
                </label>
                <small>Inject assigned prior chat summaries into LLM context</small>

                <div id="ca-settings-panel" ${caPlacement.includeInPrompts ? '' : 'style="display: none;"'}>
                    <small>Injected before chat history and before batch summaries</small>
                    <label>Assign Summary</label>
                    <div style="display: flex; gap: 0.5em; align-items: center;">
                        <select id="ca-pool-dropdown" class="text_pole" style="flex: 1;"><option value="">Loading...</option></select>
                        <button id="ca-assign-btn" class="menu_button" style="white-space: nowrap;"><i class="fa-solid fa-plus"></i> Assign</button>
                    </div>

                    <div id="ca-assigned-list" style="margin-top: 0.5em;">
                        ${caAssigned.length === 0 ? '<small style="opacity: 0.5;">No archives assigned</small>' : ''}
                        ${caAssigned.map((a, i) => `
                            <div class="ca-assigned-item" data-filename="${escapeAttr(a.chatFilename)}" style="display: flex; align-items: center; gap: 4px; padding: 4px 6px; border: 1px solid var(--SmartThemeBorderColor); border-radius: 4px; margin-bottom: 3px; font-size: 0.85em;">
                                <div style="display: flex; flex-direction: column; gap: 1px;">
                                    <button class="ca-move-btn" data-dir="up" ${i === 0 ? 'disabled' : ''} style="background:none;border:none;cursor:pointer;padding:0;font-size:0.7em;"><i class="fa-solid fa-chevron-up"></i></button>
                                    <button class="ca-move-btn" data-dir="down" ${i === caAssigned.length - 1 ? 'disabled' : ''} style="background:none;border:none;cursor:pointer;padding:0;font-size:0.7em;"><i class="fa-solid fa-chevron-down"></i></button>
                                </div>
                                <span style="flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtmlAttr(a.label)}</span>
                                <button class="ca-remove-btn" style="background:none;border:none;cursor:pointer;padding:2px;color:red;font-size:0.8em;"><i class="fa-solid fa-xmark"></i></button>
                            </div>
                        `).join('')}
                    </div>
                    <span id="ca-assigned-count" style="font-size: 0.8em; opacity: 0.6;">(${caAssigned.length} assigned)</span>

                    <label>Max Tokens
                        <input type="number" id="ca-max-tokens" class="text_pole" min="500" max="10000" value="${caConfig.maxTokens || 2000}" style="width: 80px;">
                    </label>
                    <label>Overflow Strategy
                        <select id="ca-overflow-strategy" class="text_pole">
                            <option value="priority" ${caConfig.overflowStrategy === 'priority' ? 'selected' : ''}>Priority Order</option>
                            <option value="balanced" ${caConfig.overflowStrategy === 'balanced' ? 'selected' : ''}>Balanced Truncation</option>
                            <option value="contextWeighted" ${caConfig.overflowStrategy === 'contextWeighted' ? 'selected' : ''}>Context-Weighted</option>
                        </select>
                    </label>
                </div>
            </div>
        </div>
    `;
}

/**
 * Initialize settings UI event handlers
 */
export function initSettingsHandlers() {
    $('#summarizer-enabled').on('change', function () { toggleEnabled($(this).is(':checked')); });
    $('#summarizer-auto').on('change', function () { setSetting('auto', $(this).is(':checked')); });
    $('#summarizer-auto-buffer').on('change', function () { const v = Math.max(0, Math.min(10, parseInt($(this).val()))); setSetting('autoBuffer', v); $(this).val(v); });

    $('#summarizer-include-in-prompts').on('change', async function () {
        setPromptSetting('includeInPrompts', $(this).is(':checked'));
        $('#summarizer-placement-settings').toggle(this.checked);
        await refreshSummarizerPrompt();
    });

    $('#summarizer-batch-size').on('change', function () { const v = Math.max(1, Math.min(20, parseInt($(this).val()))); setSetting('batchSize', v); $(this).val(v); });
    $('#summarizer-lookback').on('change', function () { const v = Math.max(0, Math.min(5, parseInt($(this).val()))); setSetting('lookBackBatches', v); $(this).val(v); });
    $('input[name="summarizer-exclusion-mode"]').on('change', function () { setSetting('messageExclusionMode', $(this).val()); });
    $('#summarizer-exclusion-batches').on('change', function () { const v = Math.max(1, Math.min(100, parseInt($(this).val()))); setSetting('messageExclusionBatches', v); $(this).val(v); });
    $('#summarizer-exclusion-messages').on('change', function () { const v = Math.max(1, Math.min(1000, parseInt($(this).val()))); setSetting('messageExclusionMessages', v); $(this).val(v); });
    $('#summarizer-max-summaries').on('change', function () { const v = Math.max(3, Math.min(50, parseInt($(this).val()))); setSetting('maxSummariesInContext', v); $(this).val(v); });
    $('#summarizer-always-first').on('change', function () { const v = Math.max(1, Math.min(10, parseInt($(this).val()))); setSetting('alwaysKeepFirstNBatches', v); $(this).val(v); });
    $('#summarizer-always-last').on('change', function () { const v = Math.max(1, Math.min(10, parseInt($(this).val()))); setSetting('alwaysKeepLastNBatches', v); $(this).val(v); });

    $('#summarizer-show-in-chat').on('change', function () {
        setSetting('showSummariesInChat', $(this).is(':checked'));
        import('./ui.js').then(({ updateBatchVisuals }) => updateBatchVisuals());
    });
    $('#summarizer-display-style').on('change', function () {
        setSetting('summaryDisplayStyle', $(this).val());
        import('./ui.js').then(({ updateBatchVisuals }) => updateBatchVisuals());
    });

    $('#summarizer-connection-profile').on('change', function () { setSetting('connectionProfile', $(this).val()); });

    // === Context Archives (drawer version) ===
    $('#ca-include-in-prompts').on('change', function () {
        setCAPlacement('includeInPrompts', $(this).is(':checked'));
        $('#ca-settings-panel').toggle(this.checked);
        updateContextArchivesPromptContent();
    });
    $('#ca-assign-btn').on('click', async function () {
        const dropdown = document.getElementById('ca-pool-dropdown');
        const chatFilename = dropdown?.value;
        if (!chatFilename) return;
        const label = dropdown.options[dropdown.selectedIndex]?.textContent || chatFilename;
        if (assignArchive(chatFilename, label)) {
            toastr.success('Archive assigned', 'Context Archives');
            await refreshContextArchivesUI();
            updateContextArchivesPromptContent();
        }
    });
    $('#ca-max-tokens').on('change', function () {
        const v = Math.max(500, Math.min(10000, parseInt($(this).val()) || 2000));
        setCAConfig('maxTokens', v); $(this).val(v);
        updateContextArchivesPromptContent();
    });
    $('#ca-overflow-strategy').on('change', function () {
        setCAConfig('overflowStrategy', $(this).val());
        updateContextArchivesPromptContent();
    });
    populateArchivePool();
    bindAssignedListActions();
}

/**
 * Populate connection profile selector
 */
async function createConnectionProfileSelector() {
    const context = window.SillyTavern?.getContext?.();
    if (!context) return;

    const select = document.getElementById('summarizer-connection-profile');
    if (!select) return;

    select.innerHTML = '<option value="">Use current connection</option>';

    try {
        const result = await context.executeSlashCommandsWithOptions('/profile-list');
        const profiles = JSON.parse(result.pipe);
        const currentProfile = getSetting('connectionProfile');

        profiles.forEach(profileName => {
            const option = document.createElement('option');
            option.value = profileName;
            option.textContent = profileName;
            if (profileName === currentProfile) option.selected = true;
            select.appendChild(option);
        });
    } catch (error) {
        console.error('Summarizer: Failed to load connection profiles:', error);
    }
}

function updateChatSpecificVisibility() {
    const hasChat = hasActiveChat();
    $('.summarizer-chat-specific').css('display', hasChat ? 'block' : 'none');
    $('.summarizer-no-chat').css('display', hasChat ? 'none' : 'block');
}

/**
 * Refresh settings UI with current values
 */
export async function refreshSettingsUI() {
    updateChatSpecificVisibility();
    $('#summarizer-enabled').prop('checked', isEnabled());
    $('#summarizer-auto').prop('checked', getSetting('auto'));
    $('#summarizer-auto-buffer').val(getSetting('autoBuffer'));
    $('#summarizer-batch-size').val(getSetting('batchSize'));
    $('#summarizer-lookback').val(getSetting('lookBackBatches'));

    const placement = getPromptSettings();
    $('#summarizer-include-in-prompts').prop('checked', placement.includeInPrompts !== false);
    $('#summarizer-placement-settings').toggle(placement.includeInPrompts !== false);

    $('#summarizer-exclusion-batches').val(getSetting('messageExclusionBatches'));
    $('#summarizer-exclusion-messages').val(getSetting('messageExclusionMessages'));
    $(`input[name="summarizer-exclusion-mode"][value="${getSetting('messageExclusionMode')}"]`).prop('checked', true);
    $('#summarizer-max-summaries').val(getSetting('maxSummariesInContext'));
    $('#summarizer-always-first').val(getSetting('alwaysKeepFirstNBatches'));
    $('#summarizer-always-last').val(getSetting('alwaysKeepLastNBatches'));
    $('#summarizer-show-in-chat').prop('checked', getSetting('showSummariesInChat'));
    $('#summarizer-display-style').val(getSetting('summaryDisplayStyle'));
    $('#comprehensive-length-display').text(getComprehensiveLengthDescription());

    await createConnectionProfileSelector();
}

// ============================================================
// VM Settings Modal — render() + init()
// ============================================================

/**
 * VM-styled settings HTML for registration into VerseManager's settings modal.
 * Uses vm-setting-item, vm-toggle, vm-section-divider, etc.
 */
export function render() {
    const hasChat = hasActiveChat();
    const enabled = isEnabled();
    const auto = getSetting('auto');
    const autoBuffer = getSetting('autoBuffer');
    const batchSize = getSetting('batchSize');
    const maxSummaries = getSetting('maxSummariesInContext');
    const exclusionMode = getSetting('messageExclusionMode');
    const exclusionBatches = getSetting('messageExclusionBatches');
    const exclusionMessages = getSetting('messageExclusionMessages');
    const alwaysFirst = getSetting('alwaysKeepFirstNBatches');
    const alwaysLast = getSetting('alwaysKeepLastNBatches');
    const lookBack = getSetting('lookBackBatches');
    const showInChat = getSetting('showSummariesInChat');
    const displayStyle = getSetting('summaryDisplayStyle');
    const connectionProfile = getSetting('connectionProfile');

    const placement = getPromptSettings();

    // Context Archives config
    const caConfig = getCAConfig();
    const caPlacement = getCAPlacement();
    const caAssigned = getAssignedArchives();
    const hasVM = !!window.VerseManager;

    return `
        <!-- Chat-specific toggle -->
        <div class="vm-chat-specific-settings" style="display: ${hasChat ? 'block' : 'none'};">
            <div class="vm-setting-item">
                <div class="vm-setting-info">
                    <div class="vm-setting-title">Enable Summarizer</div>
                    <div class="vm-setting-desc">Toggle batch summarization for the current chat</div>
                </div>
                <div class="vm-toggle">
                    <input type="checkbox" id="summarizer-enabled" ${enabled ? 'checked' : ''}>
                    <label class="vm-toggle-label" for="summarizer-enabled"><span class="vm-toggle-handle"></span></label>
                </div>
            </div>
            <div class="vm-divider"></div>
        </div>

        <div class="vm-no-chat-message" style="display: ${hasChat ? 'none' : 'block'}; padding: 1em; text-align: center; opacity: 0.6;">
            <i class="fa-solid fa-info-circle"></i> Open a chat to enable chat-specific settings
        </div>

        <!-- ===== PROCESSING ===== -->
        <div class="vm-section-divider">
            <div class="vm-section-divider-text"><i class="fa-solid fa-gears"></i>Processing</div>
            <div class="vm-section-divider-line"></div>
        </div>

        <div class="vm-setting-item">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Auto-Process Mode</div>
                <div class="vm-setting-desc">Automatically process summaries as chat grows</div>
            </div>
            <div class="vm-toggle">
                <input type="checkbox" id="summarizer-auto" ${auto ? 'checked' : ''}>
                <label class="vm-toggle-label" for="summarizer-auto"><span class="vm-toggle-handle"></span></label>
            </div>
        </div>

        <div class="vm-divider"></div>

        <div class="vm-setting-item">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Active Message Buffer</div>
                <div class="vm-setting-desc">Skip last N messages in auto-mode (active RP messages)</div>
            </div>
            <div class="vm-inline-number">
                <input type="number" id="summarizer-auto-buffer" min="0" max="10" value="${autoBuffer}">
            </div>
        </div>

        <div class="vm-divider"></div>

        <div class="vm-setting-item">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Batch Size</div>
                <div class="vm-setting-desc">Messages per batch (1–20)</div>
            </div>
            <div class="vm-inline-number">
                <input type="number" id="summarizer-batch-size" min="1" max="20" value="${batchSize}">
            </div>
        </div>

        <div class="vm-divider"></div>

        <div class="vm-setting-item">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Context Look-back</div>
                <div class="vm-setting-desc">Previous batches included when generating (0–5)</div>
            </div>
            <div class="vm-inline-number">
                <input type="number" id="summarizer-lookback" min="0" max="5" value="${lookBack}">
            </div>
        </div>

        <div class="vm-divider" style="margin: 16px 0;"></div>

        <!-- ===== MESSAGE EXCLUSION ===== -->
        <div class="vm-section-divider">
            <div class="vm-section-divider-text"><i class="fa-solid fa-scissors"></i>Message Trimming</div>
            <div class="vm-section-divider-line"></div>
        </div>

        <div class="vm-setting-item-col">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Start Trimming After</div>
                <div class="vm-setting-desc">Once chat reaches this length, summarized messages are excluded from context (always keeps last 10)</div>
            </div>
            <div style="display: flex; gap: 1em; align-items: center; flex-wrap: wrap; margin-top: 4px;">
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.9em; color: rgba(255,255,255,0.85);">
                    <input type="radio" name="summarizer-exclusion-mode" value="batches" ${exclusionMode === 'batches' ? 'checked' : ''}>
                    <div class="vm-inline-number" style="gap: 4px;">
                        <input type="number" id="summarizer-exclusion-batches" min="1" max="100" value="${exclusionBatches}" style="width: 50px;">
                        <span>batches</span>
                    </div>
                </label>
                <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 0.9em; color: rgba(255,255,255,0.85);">
                    <input type="radio" name="summarizer-exclusion-mode" value="messages" ${exclusionMode === 'messages' ? 'checked' : ''}>
                    <div class="vm-inline-number" style="gap: 4px;">
                        <input type="number" id="summarizer-exclusion-messages" min="1" max="1000" value="${exclusionMessages}" style="width: 60px;">
                        <span>messages</span>
                    </div>
                </label>
            </div>
        </div>

        <div class="vm-divider" style="margin: 16px 0;"></div>

        <!-- ===== DISPLAY ===== -->
        <div class="vm-section-divider">
            <div class="vm-section-divider-text"><i class="fa-solid fa-eye"></i>Display</div>
            <div class="vm-section-divider-line"></div>
        </div>

        <div class="vm-setting-item">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Show Summaries in Chat</div>
                <div class="vm-setting-desc">Display summary indicators under messages</div>
            </div>
            <div class="vm-toggle">
                <input type="checkbox" id="summarizer-show-in-chat" ${showInChat ? 'checked' : ''}>
                <label class="vm-toggle-label" for="summarizer-show-in-chat"><span class="vm-toggle-handle"></span></label>
            </div>
        </div>

        <div class="vm-divider"></div>

        <div class="vm-setting-item-col">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Display Style</div>
                <div class="vm-setting-desc">How summaries appear in chat</div>
            </div>
            <select id="summarizer-display-style" class="vm-setting-select" style="max-width: 250px;">
                <option value="minimal" ${displayStyle === 'minimal' ? 'selected' : ''}>Minimal (truncated)</option>
                <option value="full" ${displayStyle === 'full' ? 'selected' : ''}>Full text</option>
            </select>
        </div>

        <div class="vm-divider" style="margin: 16px 0;"></div>

        <!-- ===== PROMPT INJECTION ===== -->
        <div class="vm-section-divider">
            <div class="vm-section-divider-text"><i class="fa-solid fa-syringe"></i>Prompt Injection</div>
            <div class="vm-section-divider-line"></div>
        </div>

        <div class="vm-setting-item">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Include Batch Summaries in Prompts</div>
                <div class="vm-setting-desc">Injected before chat history as a system message</div>
            </div>
            <div class="vm-toggle">
                <input type="checkbox" id="summarizer-include-in-prompts" ${placement.includeInPrompts !== false ? 'checked' : ''}>
                <label class="vm-toggle-label" for="summarizer-include-in-prompts"><span class="vm-toggle-handle"></span></label>
            </div>
        </div>

        <div id="summarizer-placement-settings" ${placement.includeInPrompts !== false ? '' : 'style="display: none;"'}>
            <div class="vm-divider"></div>

            <div class="vm-setting-item">
                <div class="vm-setting-info">
                    <div class="vm-setting-title">Max Summaries in Context</div>
                    <div class="vm-setting-desc">Cap on how many batches are injected</div>
                </div>
                <div class="vm-inline-number">
                    <input type="number" id="summarizer-max-summaries" min="3" max="50" value="${maxSummaries}">
                </div>
            </div>

            <div class="vm-divider"></div>

            <div class="vm-setting-item">
                <div class="vm-setting-info">
                    <div class="vm-setting-title">Always Include First N Batches</div>
                </div>
                <div class="vm-inline-number">
                    <input type="number" id="summarizer-always-first" min="1" max="10" value="${alwaysFirst}">
                </div>
            </div>

            <div class="vm-divider"></div>

            <div class="vm-setting-item">
                <div class="vm-setting-info">
                    <div class="vm-setting-title">Always Include Last N Batches</div>
                </div>
                <div class="vm-inline-number">
                    <input type="number" id="summarizer-always-last" min="1" max="10" value="${alwaysLast}">
                </div>
            </div>
        </div>

        <div class="vm-divider" style="margin: 16px 0;"></div>

        <!-- ===== CONTEXT ARCHIVES ===== -->
        <div class="vm-section-divider">
            <div class="vm-section-divider-text"><i class="fa-solid fa-box-archive"></i>Context Archives</div>
            <div class="vm-section-divider-line"></div>
        </div>

        <div class="vm-setting-item">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Inject Context Archives</div>
                <div class="vm-setting-desc">Inject assigned prior chat summaries before chat history (and before batch summaries)</div>
            </div>
            <div class="vm-toggle">
                <input type="checkbox" id="ca-include-in-prompts" ${caPlacement.includeInPrompts ? 'checked' : ''}>
                <label class="vm-toggle-label" for="ca-include-in-prompts"><span class="vm-toggle-handle"></span></label>
            </div>
        </div>

        <div id="ca-settings-panel" ${caPlacement.includeInPrompts ? '' : 'style="display: none;"'}>

            <!-- Assign from pool -->
            <div class="vm-divider"></div>
            <div class="vm-setting-item-col">
                <div class="vm-setting-info">
                    <div class="vm-setting-title">Assign Summary</div>
                    <div class="vm-setting-desc">Add a comprehensive summary from a prior chat</div>
                </div>
                <div style="display: flex; gap: 6px; align-items: center; margin-top: 4px;">
                    <select id="ca-pool-dropdown" class="vm-setting-select" style="flex: 1; min-width: 200px;">
                        <option value="">Loading...</option>
                    </select>
                    <button class="vm-btn" id="ca-assign-btn" style="white-space: nowrap;"><i class="fa-solid fa-plus"></i> Assign</button>
                </div>
                ${hasVM ? `
                <div style="display: flex; gap: 8px; margin-top: 6px;">
                    <label class="checkbox_label" style="margin: 0; font-size: 0.85em; opacity: 0.8;">
                        <input type="checkbox" id="ca-filter-verse">
                        <span>Same verse</span>
                    </label>
                    <label class="checkbox_label" style="margin: 0; font-size: 0.85em; opacity: 0.8;">
                        <input type="checkbox" id="ca-filter-character">
                        <span>Same character</span>
                    </label>
                </div>
                ` : ''}
            </div>

            <!-- Assigned list -->
            <div class="vm-divider"></div>
            <div class="vm-setting-item-col">
                <div class="vm-setting-info">
                    <div class="vm-setting-title">Assigned Archives <span id="ca-assigned-count" style="opacity: 0.6;">(${caAssigned.length})</span></div>
                </div>
                <div id="ca-assigned-list" style="margin-top: 4px;">
                    ${caAssigned.length === 0 ? '<div style="opacity: 0.5; font-size: 0.85em; padding: 8px;">No archives assigned</div>' : ''}
                    ${caAssigned.map((a, i) => `
                        <div class="ca-assigned-item" data-filename="${escapeAttr(a.chatFilename)}" style="display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 5px; margin-bottom: 4px; background: rgba(0,0,0,0.1);">
                            <div style="display: flex; flex-direction: column; gap: 2px;">
                                <button class="ca-move-btn interactable" data-dir="up" ${i === 0 ? 'disabled style="opacity:0.3;pointer-events:none;"' : ''} title="Move up" style="background:none;border:none;cursor:pointer;padding:0;font-size:0.7em;color:rgba(255,255,255,0.6);"><i class="fa-solid fa-chevron-up"></i></button>
                                <button class="ca-move-btn interactable" data-dir="down" ${i === caAssigned.length - 1 ? 'disabled style="opacity:0.3;pointer-events:none;"' : ''} title="Move down" style="background:none;border:none;cursor:pointer;padding:0;font-size:0.7em;color:rgba(255,255,255,0.6);"><i class="fa-solid fa-chevron-down"></i></button>
                            </div>
                            <span style="flex: 1; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtmlAttr(a.label)}</span>
                            <button class="ca-remove-btn interactable" title="Remove" style="background:none;border:none;cursor:pointer;padding:2px 4px;color:rgba(255,100,100,0.8);font-size:0.8em;"><i class="fa-solid fa-xmark"></i></button>
                        </div>
                    `).join('')}
                </div>
            </div>

            <!-- Token strategy -->
            <div class="vm-divider"></div>
            <div class="vm-setting-item">
                <div class="vm-setting-info">
                    <div class="vm-setting-title">Max Tokens</div>
                    <div class="vm-setting-desc">Token budget for all assigned archives combined</div>
                </div>
                <div class="vm-inline-number">
                    <input type="number" id="ca-max-tokens" min="500" max="10000" value="${caConfig.maxTokens || 2000}">
                </div>
            </div>

            <div class="vm-divider"></div>

            <div class="vm-setting-item-col">
                <div class="vm-setting-info">
                    <div class="vm-setting-title">Overflow Strategy</div>
                    <div class="vm-setting-desc">How to fit archives within the token budget</div>
                </div>
                <select id="ca-overflow-strategy" class="vm-setting-select" style="max-width: 250px;">
                    <option value="priority" ${caConfig.overflowStrategy === 'priority' ? 'selected' : ''}>Priority Order</option>
                    <option value="balanced" ${caConfig.overflowStrategy === 'balanced' ? 'selected' : ''}>Balanced Truncation</option>
                    <option value="contextWeighted" ${caConfig.overflowStrategy === 'contextWeighted' ? 'selected' : ''}>Context-Weighted Extraction</option>
                </select>
            </div>

        </div>

        <div class="vm-divider" style="margin: 16px 0;"></div>

        <!-- ===== GENERATION ===== -->
        <div class="vm-section-divider">
            <div class="vm-section-divider-text"><i class="fa-solid fa-microchip"></i>Generation</div>
            <div class="vm-section-divider-line"></div>
        </div>

        <div class="vm-setting-item-col">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Connection Profile</div>
                <div class="vm-setting-desc">Use a dedicated profile for summarization LLM calls</div>
            </div>
            <select id="summarizer-connection-profile" class="vm-setting-select" style="max-width: 250px;">
                <option value="">Use current connection</option>
            </select>
        </div>

        <div class="vm-divider"></div>

        <div class="vm-setting-item-col">
            <div class="vm-setting-info">
                <div class="vm-setting-title">Summary Lengths</div>
            </div>
            <div style="font-size: 0.85em; color: rgba(255,255,255,0.6); line-height: 1.6; padding: 8px 12px; background: rgba(0,0,0,0.15); border-radius: 5px; border: 1px solid rgba(255,255,255,0.06);">
                <div><strong style="color: rgba(255,255,255,0.8);">Establishment:</strong> ${getSetting('establishmentSummaryLength')}</div>
                <div><strong style="color: rgba(255,255,255,0.8);">Batch:</strong> ${getSetting('batchSummaryLength')}</div>
                <div><strong style="color: rgba(255,255,255,0.8);">Comprehensive:</strong> <span id="comprehensive-length-display">Dynamic based on story length</span></div>
            </div>
        </div>

        <!-- ===== ACTIONS ===== -->
        <div class="vm-chat-specific-settings" style="display: ${hasChat ? 'block' : 'none'}; margin-top: 20px;">
            <div class="vm-section-divider">
                <div class="vm-section-divider-text"><i class="fa-solid fa-bolt"></i>Actions</div>
                <div class="vm-section-divider-line"></div>
            </div>
            <div class="vm-btn-row">
                <button class="vm-btn" id="summarizer-process-btn"><i class="fa-solid fa-play"></i> Process</button>
                <button class="vm-btn" id="summarizer-comprehensive-btn"><i class="fa-solid fa-file-text"></i> Comprehensive</button>
                <button class="vm-btn" id="summarizer-view-comprehensive-btn"><i class="fa-solid fa-eye"></i> View</button>
                <button class="vm-btn vm-btn-danger" id="summarizer-clear-btn"><i class="fa-solid fa-trash"></i> Clear All</button>
            </div>
        </div>
    `;
}

/**
 * VM modal init — called after render() HTML is injected into the modal container.
 * Uses slash command delegation for action buttons (same pattern as VM's own summarizer tab).
 */
export function init() {
    // === Chat-specific ===
    $('#summarizer-enabled').on('change', function () { toggleEnabled($(this).is(':checked')); });

    // === Processing ===
    $('#summarizer-auto').on('change', function () { setSetting('auto', $(this).is(':checked')); });
    $('#summarizer-auto-buffer').on('change', function () {
        const v = Math.max(0, Math.min(10, parseInt(this.value) || 0));
        setSetting('autoBuffer', v); this.value = v;
    });
    $('#summarizer-batch-size').on('change', function () {
        const v = Math.max(1, Math.min(20, parseInt(this.value) || 6));
        setSetting('batchSize', v); this.value = v;
    });
    $('#summarizer-lookback').on('change', function () {
        const v = Math.max(0, Math.min(5, parseInt(this.value) || 2));
        setSetting('lookBackBatches', v); this.value = v;
    });

    // === Exclusion ===
    $('input[name="summarizer-exclusion-mode"]').on('change', function () { setSetting('messageExclusionMode', this.value); });
    $('#summarizer-exclusion-batches').on('change', function () {
        const v = Math.max(1, Math.min(100, parseInt(this.value) || 4));
        setSetting('messageExclusionBatches', v); this.value = v;
    });
    $('#summarizer-exclusion-messages').on('change', function () {
        const v = Math.max(1, Math.min(1000, parseInt(this.value) || 24));
        setSetting('messageExclusionMessages', v); this.value = v;
    });

    // === Display ===
    $('#summarizer-show-in-chat').on('change', function () {
        setSetting('showSummariesInChat', $(this).is(':checked'));
        import('./ui.js').then(({ updateBatchVisuals }) => updateBatchVisuals());
    });
    $('#summarizer-display-style').on('change', function () {
        setSetting('summaryDisplayStyle', this.value);
        import('./ui.js').then(({ updateBatchVisuals }) => updateBatchVisuals());
    });

    // === Prompt Injection ===
    $('#summarizer-include-in-prompts').on('change', async function () {
        setPromptSetting('includeInPrompts', $(this).is(':checked'));
        $('#summarizer-placement-settings').toggle(this.checked);
        await refreshSummarizerPrompt();
    });
    $('#summarizer-max-summaries').on('change', function () {
        const v = Math.max(3, Math.min(50, parseInt(this.value) || 10));
        setSetting('maxSummariesInContext', v); this.value = v;
    });
    $('#summarizer-always-first').on('change', function () {
        const v = Math.max(1, Math.min(10, parseInt(this.value) || 1));
        setSetting('alwaysKeepFirstNBatches', v); this.value = v;
    });
    $('#summarizer-always-last').on('change', function () {
        const v = Math.max(1, Math.min(10, parseInt(this.value) || 2));
        setSetting('alwaysKeepLastNBatches', v); this.value = v;
    });

    // === Generation ===
    $('#summarizer-connection-profile').on('change', function () { setSetting('connectionProfile', this.value); });
    $('#comprehensive-length-display').text(getComprehensiveLengthDescription());
    populateConnectionProfilesVM();

    // === Context Archives ===
    $('#ca-include-in-prompts').on('change', function () {
        setCAPlacement('includeInPrompts', $(this).is(':checked'));
        $('#ca-settings-panel').toggle(this.checked);
        updateContextArchivesPromptContent();
    });

    $('#ca-assign-btn').on('click', async function () {
        const dropdown = document.getElementById('ca-pool-dropdown');
        const chatFilename = dropdown?.value;
        if (!chatFilename) return;

        const label = dropdown.options[dropdown.selectedIndex]?.textContent || chatFilename;
        const success = assignArchive(chatFilename, label);
        if (success) {
            toastr.success('Archive assigned', 'Context Archives');
            await refreshContextArchivesUI();
            updateContextArchivesPromptContent();
        }
    });

    // Filter toggles (VM only)
    $('#ca-filter-verse, #ca-filter-character').on('change', () => populateArchivePool());

    // Config controls
    $('#ca-max-tokens').on('change', function () {
        const v = Math.max(500, Math.min(10000, parseInt(this.value) || 2000));
        setCAConfig('maxTokens', v); this.value = v;
        updateContextArchivesPromptContent();
    });
    $('#ca-overflow-strategy').on('change', function () {
        setCAConfig('overflowStrategy', this.value);
        updateContextArchivesPromptContent();
    });

    // Placement controls removed — hardcoded before chat history

    // Populate pool and bind assigned list actions
    populateArchivePool();
    bindAssignedListActions();

    // === Action buttons — delegate via slash commands ===
    const ctx = () => getContext();
    $('#summarizer-process-btn').off('click').on('click', () => ctx().executeSlashCommandsWithOptions('/summarizer-process'));
    $('#summarizer-comprehensive-btn').off('click').on('click', () => ctx().executeSlashCommandsWithOptions('/summarizer-comprehensive'));
    $('#summarizer-view-comprehensive-btn').off('click').on('click', () => ctx().executeSlashCommandsWithOptions('/summarizer-view-comprehensive'));
    $('#summarizer-clear-btn').off('click').on('click', () => ctx().executeSlashCommandsWithOptions('/summarizer-clear'));
}

async function populateConnectionProfilesVM() {
    const context = getContext();
    const select = document.getElementById('summarizer-connection-profile');
    if (!select) return;

    try {
        const result = await context.executeSlashCommandsWithOptions('/profile-list');
        const profiles = JSON.parse(result.pipe);
        const current = getSetting('connectionProfile');
        profiles.forEach(name => {
            const option = document.createElement('option');
            option.value = name;
            option.textContent = name;
            if (name === current) option.selected = true;
            select.appendChild(option);
        });
    } catch (e) {
        console.error('[Summarizer] Failed to load connection profiles for VM modal:', e);
    }
}

// ============================================================
// Context Archives UI helpers
// ============================================================

/** Populate the archive pool dropdown from fileStore */
async function populateArchivePool() {
    const dropdown = document.getElementById('ca-pool-dropdown');
    if (!dropdown) return;

    dropdown.innerHTML = '<option value="">Loading...</option>';

    try {
        // Determine filters
        const options = {};
        const hasVM = !!window.VerseManager;

        if (hasVM) {
            const verseFilter = document.getElementById('ca-filter-verse');
            const charFilter = document.getElementById('ca-filter-character');

            if (verseFilter?.checked) {
                const currentVerse = window.VerseManager?.getCurrentVerse?.() || extension_settings?.verseManager?.currentVerse;
                if (currentVerse) options.verseFilter = currentVerse;
            }

            if (charFilter?.checked) {
                const ctx = getContext();
                const character = ctx?.characters?.[ctx.characterId];
                if (character?.name) options.characterFilter = character.name;
            }
        }

        const pool = await getArchivePool(options);
        const assigned = getAssignedArchives();
        const assignedFilenames = new Set(assigned.map(a => a.chatFilename));

        dropdown.innerHTML = '<option value="">— Select a summary to assign —</option>';

        if (pool.length === 0) {
            dropdown.innerHTML = '<option value="">No comprehensive summaries available</option>';
            return;
        }

        for (const item of pool) {
            // Skip already assigned
            if (assignedFilenames.has(item.chatFilename)) continue;

            const option = document.createElement('option');
            option.value = item.chatFilename;
            option.textContent = item.label;
            dropdown.appendChild(option);
        }
    } catch (e) {
        console.error('[Summarizer] Failed to populate archive pool:', e);
        dropdown.innerHTML = '<option value="">Error loading summaries</option>';
    }
}

/** Bind click handlers on assigned list items (move + remove) */
function bindAssignedListActions() {
    const list = document.getElementById('ca-assigned-list');
    if (!list) return;

    // Use event delegation
    list.removeEventListener('click', handleAssignedListClick);
    list.addEventListener('click', handleAssignedListClick);
}

async function handleAssignedListClick(e) {
    const moveBtn = e.target.closest('.ca-move-btn');
    const removeBtn = e.target.closest('.ca-remove-btn');

    if (moveBtn) {
        const item = moveBtn.closest('.ca-assigned-item');
        const filename = item?.dataset?.filename;
        const dir = moveBtn.dataset.dir;
        if (filename && dir) {
            moveArchive(filename, dir);
            await refreshContextArchivesUI();
            updateContextArchivesPromptContent();
        }
        return;
    }

    if (removeBtn) {
        const item = removeBtn.closest('.ca-assigned-item');
        const filename = item?.dataset?.filename;
        if (filename) {
            removeArchive(filename);
            await refreshContextArchivesUI();
            updateContextArchivesPromptContent();
        }
    }
}

/** Refresh the assigned list UI and pool dropdown */
async function refreshContextArchivesUI() {
    const assigned = getAssignedArchives();

    // Update count
    const countEl = document.getElementById('ca-assigned-count');
    if (countEl) countEl.textContent = `(${assigned.length})`;

    // Rebuild assigned list
    const list = document.getElementById('ca-assigned-list');
    if (list) {
        if (assigned.length === 0) {
            list.innerHTML = '<div style="opacity: 0.5; font-size: 0.85em; padding: 8px;">No archives assigned</div>';
        } else {
            list.innerHTML = assigned.map((a, i) => `
                <div class="ca-assigned-item" data-filename="${escapeAttr(a.chatFilename)}" style="display: flex; align-items: center; gap: 6px; padding: 6px 8px; border: 1px solid rgba(255,255,255,0.08); border-radius: 5px; margin-bottom: 4px; background: rgba(0,0,0,0.1);">
                    <div style="display: flex; flex-direction: column; gap: 2px;">
                        <button class="ca-move-btn interactable" data-dir="up" ${i === 0 ? 'disabled style="opacity:0.3;pointer-events:none;"' : ''} title="Move up" style="background:none;border:none;cursor:pointer;padding:0;font-size:0.7em;color:rgba(255,255,255,0.6);"><i class="fa-solid fa-chevron-up"></i></button>
                        <button class="ca-move-btn interactable" data-dir="down" ${i === assigned.length - 1 ? 'disabled style="opacity:0.3;pointer-events:none;"' : ''} title="Move down" style="background:none;border:none;cursor:pointer;padding:0;font-size:0.7em;color:rgba(255,255,255,0.6);"><i class="fa-solid fa-chevron-down"></i></button>
                    </div>
                    <span style="flex: 1; font-size: 0.85em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${escapeHtmlAttr(a.label)}</span>
                    <button class="ca-remove-btn interactable" title="Remove" style="background:none;border:none;cursor:pointer;padding:2px 4px;color:rgba(255,100,100,0.8);font-size:0.8em;"><i class="fa-solid fa-xmark"></i></button>
                </div>
            `).join('');
        }
    }

    // Refresh pool dropdown (to remove newly assigned from options)
    await populateArchivePool();
}

/** Export for use from index.js on CHAT_CHANGED */
export { refreshContextArchivesUI, populateArchivePool };
