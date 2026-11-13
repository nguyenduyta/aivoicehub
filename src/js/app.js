/**
 * App — main application controller
 * Wires together: settings, UI, Soniox client, and audio capture
 */

import { settingsManager } from './settings.js';
import { TranscriptUI } from './ui.js';
import { sonioxClient } from './soniox.js';
import { elevenLabsTTS } from './elevenlabs-tts.js';
import { googleTTS } from './google-tts.js';
import { edgeTTSRust } from './edge-tts.js';
import { audioPlayer } from './audio-player.js';
import { CalendarPanel } from './calendar.js';
import { MeetingNoteDialog } from './meeting-note.js';

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

/** Human labels for `audio_source`. Keys must match the values `start_capture` accepts. */
const SOURCE_LABELS = {
    system: 'System Audio',
    microphone: 'Microphone',
    both: 'System Audio + Microphone',
};

/**
 * Domain hints for Soniox — must match `value` in `#select-context-preset` (Settings → Context).
 * Open-source: contributors can add presets here and in index.html.
 */
const CONTEXT_DOMAIN_PRESETS = {
    meeting:
        'Business meeting. Use clear, professional language; preserve names, acronyms, and product names.',
    interview:
        'Job or media interview. Keep questions and answers distinct; faithful wording.',
    medical:
        'Medical context. Prioritize accuracy for symptoms, medications, dosages, and units.',
    legal: 'Legal or compliance discussion. Prefer precise terminology; do not add interpretation.',
    education: 'Lecture or classroom. Educational and subject-matter terminology.',
    tech: 'Technical / software discussion. Preserve API names, commands, version numbers, and code terms.',
    support:
        'Customer support call. Polite, solution-oriented tone; keep product and ticket identifiers.',
    general: 'General conversation. Neutral, natural phrasing.',
};

class App {
    constructor() {
        this.isRunning = false;
        this.isStarting = false; // Guard against re-entry
        this.currentSource = 'both'; // 'system' | 'microphone' | 'both'
        this.translationMode = 'soniox'; // 'soniox' | 'local'
        this.transcriptUI = null;
        this.appWindow = getCurrentWindow();
        this.localPipelineChannel = null;
        this.localPipelineReady = false;
        this.recordingStartTime = null;
        this.ttsEnabled = false;  // TTS runtime toggle
        this.isPinned = true;     // Always-on-top state
        this.isSummarizing = false;
        /** Active conversation folder id (under transcripts/sessions/). null = next save creates a new folder. */
        this.currentSessionId = null;
        /** Conversations list (history view) */
        this.historyPage = 1;
        this.historyPageSize = 10;
        this.historySearchQuery = '';
        this._historyTotalPages = 0;
        this._historySearchDebounce = null;
        /** History → Edit session meta (meta.json) */
        this._sessionMetaEditId = null;
        this._sessionMetaInitialTitle = '';
        this._sessionMetaInitialNotes = '';
        /** Calendar agenda + MTG note export */
        this.calendarPanel = null;
        this.meetingNote = null;
        /**
         * Meeting this session is attached to, set when started from the agenda:
         * `{ title, meetingUrl, uid, start, end, calendar }`. Feeds the MTG note and the
         * transcript front matter.
         */
        this.activeMeeting = null;
        /** Epoch ms when recording last stopped — the meeting's end time in the note. */
        this.recordingEndTime = null;
        /** True during an audio-source switch, so stop() knows the meeting isn't over. */
        this._switchingSource = false;
    }

    async init() {
        // Load settings
        await settingsManager.load();

        // Init transcript UI
        const transcriptContainer = document.getElementById('transcript-content');
        this.transcriptUI = new TranscriptUI(transcriptContainer);

        // Check platform — hide Local MLX on non-Apple-Silicon
        await this._checkPlatformSupport();

        // Apply saved settings to UI
        this._applySettings(settingsManager.get());

        // Bind event listeners
        this._bindEvents();

        // Bind keyboard shortcuts
        this._bindKeyboardShortcuts();

        // Subscribe to settings changes
        settingsManager.onChange((settings) => this._applySettings(settings));

        // Calendar agenda + meeting-note dialog
        this.calendarPanel = new CalendarPanel({
            onStart: (ev) => this._startMeetingFromCalendar(ev),
            onToast: (msg, kind) => this._showToast(msg, kind),
            onOpenSettings: () => this._showView('settings'),
        });
        this.meetingNote = new MeetingNoteDialog({
            onToast: (msg, kind) => this._showToast(msg, kind),
            getSettings: () => settingsManager.get(),
            onOpenSettings: () => this._showView('settings'),
        });

        // Init audio player for TTS
        audioPlayer.init();

        // Wire TTS audio callbacks for providers that use audioPlayer
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onAudioChunk = (base64Audio, isFinal) => {
                audioPlayer.enqueue(base64Audio);
            };
        }
        for (const tts of [elevenLabsTTS, edgeTTSRust, googleTTS]) {
            tts.onError = (error) => {
                console.error('[TTS]', error);
                this._showToast(error, 'error');
            };
        }

        // Window position restore disabled — causes issues on Retina displays
        // await this._restoreWindowPosition();

        console.log('🌐 AIVoiceHub v0.5.0 initialized');
    }

    async _checkPlatformSupport() {
        try {
            // Check if we're on macOS Apple Silicon
            const arch = await invoke('get_platform_info');
            const info = JSON.parse(arch);
            this.isAppleSilicon = (info.os === 'macos' && info.arch === 'aarch64');
        } catch {
            // Fallback: check via navigator
            this.isAppleSilicon = navigator.platform === 'MacIntel' &&
                navigator.userAgent.includes('Mac OS X');
        }

        if (!this.isAppleSilicon) {
            // Hide Local MLX option
            const select = document.getElementById('select-translation-mode');
            const localOption = select?.querySelector('option[value="local"]');
            if (localOption) localOption.remove();

            // Force soniox mode if user had local selected
            const settings = settingsManager.get();
            if (settings.translation_mode === 'local') {
                settings.translation_mode = 'soniox';
                settingsManager.save(settings);
            }
        }
    }

    // ─── Event Binding ──────────────────────────────────────

    _bindEvents() {
        // Calendar / meetings
        document.getElementById('btn-calendar')?.addEventListener('click', () => {
            this._showView('calendar');
        });
        document.getElementById('btn-calendar-back')?.addEventListener('click', () => {
            this._showView('overlay');
        });

        // Meeting note (MTG)
        document.getElementById('btn-meeting-note')?.addEventListener('click', () => {
            this._openMeetingNoteDialog();
        });

        // Active meeting bar
        document.getElementById('btn-clear-active-meeting')?.addEventListener('click', () => {
            this.activeMeeting = null;
            this._updateActiveMeetingBar();
            this._showToast('Meeting detached from this session', 'info');
        });
        document.getElementById('active-meeting-link')?.addEventListener('click', async (e) => {
            e.preventDefault();
            const url = this.activeMeeting?.meetingUrl;
            if (!url) return;
            try {
                await window.__TAURI__.opener.openUrl(url);
            } catch (err) {
                this._showToast('Could not open the link: ' + err, 'error');
            }
        });

        // Settings → Meeting
        document.getElementById('btn-open-mtg-dir')?.addEventListener('click', async () => {
            // Save first so the folder just typed is the one that gets opened.
            const typed = document.getElementById('input-mtg-dir')?.value?.trim() ?? '';
            try {
                if (typed !== (settingsManager.get().mtg_export_dir || '')) {
                    await settingsManager.save({ mtg_export_dir: typed });
                }
                await invoke('open_mtg_location', { path: null });
            } catch (err) {
                this._showToast('Could not open the folder: ' + err, 'error');
            }
        });
        document.getElementById('input-mtg-dir')?.addEventListener('input', () => {
            this._refreshMtgSampleHint();
        });
        document.getElementById('select-mtg-layout')?.addEventListener('change', () => {
            this._refreshMtgSampleHint();
        });
        document.getElementById('input-mtg-prefix')?.addEventListener('input', () => {
            this._refreshMtgSampleHint();
        });

        // Settings → Calendar
        document.getElementById('btn-add-feed')?.addEventListener('click', () => {
            this._addFeedRow({ label: '', url: '', enabled: true });
        });
        document.getElementById('range-calendar-days')?.addEventListener('input', (e) => {
            const el = document.getElementById('calendar-days-value');
            if (el) el.textContent = e.target.value;
        });
        document.getElementById('range-calendar-refresh')?.addEventListener('input', (e) => {
            const el = document.getElementById('calendar-refresh-value');
            const v = parseInt(e.target.value, 10);
            if (el) el.textContent = v === 0 ? 'off' : `${v}m`;
        });

        // Conversation history
        document.getElementById('btn-history')?.addEventListener('click', () => {
            this._showView('history');
        });
        document.getElementById('btn-history-back')?.addEventListener('click', () => {
            this._showView('overlay');
        });
        document.getElementById('btn-history-new')?.addEventListener('click', async () => {
            await this._startNewConversation();
        });

        const historySearch = document.getElementById('history-search');
        if (historySearch) {
            const scheduleSearch = () => {
                clearTimeout(this._historySearchDebounce);
                this._historySearchDebounce = setTimeout(() => {
                    this.historyPage = 1;
                    this._refreshHistoryList();
                }, 300);
            };
            historySearch.addEventListener('input', (e) => {
                // Skip mid-composition (IME); compositionend will refresh
                if (e.isComposing) return;
                scheduleSearch();
            });
            historySearch.addEventListener('compositionend', () => {
                this.historyPage = 1;
                this._refreshHistoryList();
            });
        }

        const presetSelect = document.getElementById('select-context-preset');
        if (presetSelect) {
            presetSelect.addEventListener('change', () => {
                const v = presetSelect.value;
                if (!v) return;
                const hint = CONTEXT_DOMAIN_PRESETS[v];
                const input = document.getElementById('input-context-domain');
                if (input && hint) input.value = hint;
            });
        }

        document.getElementById('btn-session-meta-cancel')?.addEventListener('click', () => {
            this._closeSessionMetaModal();
        });
        document.getElementById('btn-session-meta-save')?.addEventListener('click', () => {
            this._saveSessionMeta();
        });
        document.getElementById('btn-session-meta-revert-title')?.addEventListener('click', () => {
            this._revertSessionTitleFromTranscript();
        });
        document.getElementById('session-meta-modal')?.addEventListener('click', (e) => {
            if (e.target?.id === 'session-meta-modal') this._closeSessionMetaModal();
        });

        document.getElementById('history-page-prev')?.addEventListener('click', () => {
            if (this.historyPage <= 1) return;
            this.historyPage -= 1;
            this._refreshHistoryList();
        });
        document.getElementById('history-page-next')?.addEventListener('click', () => {
            if (this.historyPage >= this._historyTotalPages) return;
            this.historyPage += 1;
            this._refreshHistoryList();
        });

        document.getElementById('btn-new-conversation')?.addEventListener('click', async () => {
            await this._startNewConversation();
        });

        // Settings button
        document.getElementById('btn-settings').addEventListener('click', () => {
            this._showView('settings');
        });

        // Back from settings
        document.getElementById('btn-back').addEventListener('click', () => {
            this._showView('overlay');
        });

        // Close button (overlay)
        // The window disappears at once; saving the transcript and writing the meeting note
        // (which can take minutes for a long meeting) carry on hidden, then the app exits.
        document.getElementById('btn-close').addEventListener('click', async () => {
            await this._saveWindowPosition();
            await this.appWindow.hide();
            try {
                if (this.transcriptUI.hasSegments()) {
                    await this._saveTranscriptFile();
                }
                await this.stop();
            } finally {
                await this.appWindow.close();
            }
        });

        // Minimize button
        document.getElementById('btn-minimize').addEventListener('click', async () => {
            await this._saveWindowPosition();
            await this.appWindow.minimize();
        });

        // Pin/Unpin button
        document.getElementById('btn-pin').addEventListener('click', () => {
            this._togglePin();
        });

        // View mode toggle (dual panel)
        document.getElementById('btn-view-mode').addEventListener('click', () => {
            this._toggleViewMode();
        });

        // Font size quick controls
        document.getElementById('btn-font-up').addEventListener('click', () => this._adjustFontSize(4));
        document.getElementById('btn-font-down').addEventListener('click', () => this._adjustFontSize(-4));

        // Start/Stop button
        document.getElementById('btn-start').addEventListener('click', async () => {
            if (this.isStarting) return; // Prevent re-entry
            try {
                if (this.isRunning) {
                    await this.stop();
                } else {
                    this.isStarting = true;
                    await this.start();
                }
            } catch (err) {
                console.error('[App] Start/Stop error:', err);
                this._showToast(`Error: ${err}`, 'error');
                this.isRunning = false;
                this._updateStartButton();
                this._updateStatus('error');
                this.transcriptUI.clear();
                this.transcriptUI.showPlaceholder();
            } finally {
                this.isStarting = false;
            }
        });

        // Source buttons — each toggles its own device in/out of the mix
        document.getElementById('btn-source-system').addEventListener('click', () => {
            this._toggleSource('system');
        });

        document.getElementById('btn-source-mic').addEventListener('click', () => {
            this._toggleSource('microphone');
        });

        // Clear button — save transcript file then clear
        document.getElementById('btn-clear').addEventListener('click', async () => {
            if (this.transcriptUI.hasSegments()) {
                await this._saveTranscriptFile();
            }
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.recordingStartTime = null;
            this.currentSessionId = null;
        });

        // Copy transcript button
        document.getElementById('btn-copy').addEventListener('click', async () => {
            const text = this.transcriptUI.getPlainText();
            if (text) {
                await navigator.clipboard.writeText(text);
                this._showToast('Copied to clipboard', 'success');
            } else {
                this._showToast('Nothing to copy', 'info');
            }
        });

        // Open saved transcripts folder
        document.getElementById('btn-open-transcripts').addEventListener('click', async () => {
            try {
                await invoke('open_transcript_dir');
            } catch (err) {
                this._showToast('Failed to open folder: ' + err, 'error');
            }
        });

        // Summary button (ChatGPT)
        document.getElementById('btn-summary')?.addEventListener('click', async () => {
            await this._summarizeTranscript();
        });

        // Summary modal controls
        document.getElementById('btn-close-summary')?.addEventListener('click', () => {
            const modal = document.getElementById('summary-modal');
            if (modal) modal.style.display = 'none';
        });
        document.getElementById('btn-open-settings-from-summary')?.addEventListener('click', () => {
            const modal = document.getElementById('summary-modal');
            if (modal) modal.style.display = 'none';
            this._showView('settings');
        });
        document.getElementById('btn-copy-summary')?.addEventListener('click', async () => {
            const text = document.getElementById('summary-text')?.value || '';
            if (text.trim()) {
                await navigator.clipboard.writeText(text);
                this._showToast('Summary copied', 'success');
            } else {
                this._showToast('Nothing to copy', 'info');
            }
        });

        // Settings form elements
        this._bindSettingsForm();

        // Manual drag for settings view
        // data-tauri-drag-region doesn't work well when parent contains buttons
        // Using Tauri's recommended appWindow.startDragging() approach instead
        document.getElementById('settings-view')?.addEventListener('mousedown', (e) => {
            const interactive = e.target.closest('button, input, select, label, a, textarea, .settings-section, .settings-actions');
            if (!interactive && e.buttons === 1) {
                e.preventDefault();
                this.appWindow.startDragging();
            }
        });

        document.getElementById('history-view')?.addEventListener('mousedown', (e) => {
            // Include inputs/labels — same as settings view; otherwise search box gets preventDefault and never focuses.
            const interactive = e.target.closest(
                'button, input, select, label, textarea, a, .history-list, .history-row, .history-btn, .history-toolbar, .history-pagination',
            );
            if (!interactive && e.buttons === 1) {
                e.preventDefault();
                this.appWindow.startDragging();
            }
        });

        document.getElementById('calendar-view')?.addEventListener('mousedown', (e) => {
            const interactive = e.target.closest(
                'button, input, select, label, textarea, a, .calendar-list, .calendar-row, .history-btn, .calendar-status',
            );
            if (!interactive && e.buttons === 1) {
                e.preventDefault();
                this.appWindow.startDragging();
            }
        });

        this._setupMacMoreMenu();

        // Toggle API key visibility
        document.getElementById('btn-toggle-key').addEventListener('click', () => {
            const input = document.getElementById('input-api-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Toggle OpenAI key visibility
        document.getElementById('btn-toggle-openai-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-openai-key');
            if (!input) return;
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Translation mode toggle
        document.getElementById('select-translation-mode').addEventListener('change', (e) => {
            this._updateModeUI(e.target.value);
        });

        // Translate on/off — greys out the target language picker, which is meaningless when off
        document.getElementById('check-translation-enabled')?.addEventListener('change', (e) => {
            this._updateTranslationToggleUI(e.target.checked);
        });

        // Soniox link
        document.getElementById('link-soniox').addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://console.soniox.com/signup/');
        });

        // ElevenLabs link
        document.getElementById('link-elevenlabs')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.__TAURI__.opener.openUrl('https://elevenlabs.io/app/sign-up');
        });

        // Save settings — both top and bottom buttons
        document.getElementById('btn-save-settings').addEventListener('click', () => {
            this._saveSettingsFromForm();
        });
        document.getElementById('btn-save-settings-top')?.addEventListener('click', () => {
            this._saveSettingsFromForm();
        });

        // Slider live updates
        document.getElementById('range-opacity').addEventListener('input', (e) => {
            document.getElementById('opacity-value').textContent = `${e.target.value}%`;
        });

        document.getElementById('range-font-size').addEventListener('input', (e) => {
            document.getElementById('font-size-value').textContent = `${e.target.value}px`;
        });

        document.getElementById('range-max-lines').addEventListener('input', (e) => {
            document.getElementById('max-lines-value').textContent = e.target.value;
        });

        // Toggle ElevenLabs API key visibility
        document.getElementById('btn-toggle-elevenlabs-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-elevenlabs-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        document.getElementById('btn-toggle-google-key')?.addEventListener('click', () => {
            const input = document.getElementById('input-google-tts-key');
            input.type = input.type === 'password' ? 'text' : 'password';
        });

        // Settings tab switching
        document.querySelectorAll('.settings-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
                document.querySelectorAll('.settings-tab-content').forEach(c => c.classList.remove('active'));
                tab.classList.add('active');
                document.getElementById(tab.dataset.tab)?.classList.add('active');
            });
        });

        // TTS enable/disable toggle in settings — show/hide detail
        document.getElementById('check-tts-enabled')?.addEventListener('change', (e) => {
            const detail = document.getElementById('tts-settings-detail');
            if (detail) detail.style.display = e.target.checked ? '' : 'none';
        });

        // TTS provider toggle — show/hide relevant settings panels
        document.getElementById('select-tts-provider')?.addEventListener('change', (e) => {
            this._updateTTSProviderUI(e.target.value);
        });

        // TTS speed slider — show value
        document.getElementById('range-tts-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('tts-speed-value');
            if (label) label.textContent = e.target.value + 'x';
        });

        // Edge TTS speed slider
        document.getElementById('range-edge-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('edge-speed-value');
            const v = parseInt(e.target.value);
            if (label) label.textContent = (v >= 0 ? '+' : '') + v + '%';
        });

        document.getElementById('range-google-speed')?.addEventListener('input', (e) => {
            const label = document.getElementById('google-speed-value');
            if (label) label.textContent = parseFloat(e.target.value).toFixed(1) + 'x';
        });

        // Add translation term row
        document.getElementById('btn-add-term')?.addEventListener('click', () => {
            this._addTermRow('', '');
        });

        // TTS toggle button in overlay
        document.getElementById('btn-tts').addEventListener('click', () => {
            this._toggleTTS();
        });

        // Wire Soniox callbacks
        sonioxClient.onOriginal = (text, speaker) => {
            this.transcriptUI.addOriginal(text, speaker);
        };

        sonioxClient.onTranslation = (text) => {
            this.transcriptUI.addTranslation(text);
            this._speakIfEnabled(text);
        };

        sonioxClient.onProvisional = (text, speaker) => {
            if (text) {
                this.transcriptUI.setProvisional(text, speaker);
            } else {
                this.transcriptUI.clearProvisional();
            }
        };

        sonioxClient.onStatusChange = (status) => {
            this._updateStatus(status);
        };

        sonioxClient.onError = (error) => {
            this._showToast(error, 'error');
        };
    }

    _bindSettingsForm() {
        // These are handled in _populateSettingsForm and _saveSettingsFromForm
    }

    // ─── Keyboard Shortcuts ─────────────────────────────────

    _bindKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            const sessionModal = document.getElementById('session-meta-modal');
            if (
                e.key === 'Escape' &&
                sessionModal &&
                sessionModal.style.display !== 'none'
            ) {
                e.preventDefault();
                this._closeSessionMetaModal();
                return;
            }

            if (e.key === 'Escape' && this.meetingNote?.isOpen) {
                e.preventDefault();
                this.meetingNote.close();
                return;
            }

            // Ignore when typing in input fields
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') {
                return;
            }

            // Cmd/Ctrl + Enter: Start/Stop
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                if (this.isStarting) return;
                (async () => {
                    try {
                        if (this.isRunning) {
                            await this.stop();
                        } else {
                            this.isStarting = true;
                            await this.start();
                        }
                    } catch (err) {
                        console.error('[App] Keyboard start/stop error:', err);
                        this._showToast(`Error: ${err}`, 'error');
                        this.isRunning = false;
                        this._updateStartButton();
                        this._updateStatus('error');
                    } finally {
                        this.isStarting = false;
                    }
                })();
            }

            // Escape: Go back to overlay / close settings
            if (e.key === 'Escape') {
                e.preventDefault();
                const onSubView = ['settings-view', 'calendar-view', 'history-view'].some((id) =>
                    document.getElementById(id)?.classList.contains('active'),
                );
                if (onSubView) {
                    this._showView('overlay');
                }
            }

            // Cmd/Ctrl + ,: Open settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            // Cmd/Ctrl + 1: Toggle System Audio in/out of the mix
            if ((e.metaKey || e.ctrlKey) && e.key === '1') {
                e.preventDefault();
                this._toggleSource('system');
            }

            // Cmd/Ctrl + 2: Toggle Microphone in/out of the mix
            if ((e.metaKey || e.ctrlKey) && e.key === '2') {
                e.preventDefault();
                this._toggleSource('microphone');
            }

            // Cmd/Ctrl + T: Toggle TTS
            if ((e.metaKey || e.ctrlKey) && e.key === 't') {
                e.preventDefault();
                this._toggleTTS();
            }

            // Cmd/Ctrl + M: Minimize
            if ((e.metaKey || e.ctrlKey) && e.key === 'm') {
                e.preventDefault();
                this._saveWindowPosition();
                this.appWindow.minimize();
            }

            // Cmd/Ctrl + P: Toggle Pin
            if ((e.metaKey || e.ctrlKey) && e.key === 'p') {
                e.preventDefault();
                this._togglePin();
            }

        });
    }

    // ─── Views ──────────────────────────────────────────────

    _showView(view) {
        if (typeof this._closeMoreMenu === 'function') {
            this._closeMoreMenu();
        }
        if (view !== 'history') {
            this._closeSessionMetaModal();
        }

        document.getElementById('overlay-view').classList.toggle('active', view === 'overlay');
        document.getElementById('settings-view').classList.toggle('active', view === 'settings');
        document.getElementById('history-view')?.classList.toggle('active', view === 'history');
        document.getElementById('calendar-view')?.classList.toggle('active', view === 'calendar');

        if (view === 'settings') {
            this._populateSettingsForm();
        }
        if (view === 'history') {
            this._refreshHistoryList();
        }

        // Only poll the calendar while its view is on screen.
        if (view === 'calendar') {
            this.calendarPanel?.onShow(settingsManager.get().calendar_refresh_minutes);
        } else {
            this.calendarPanel?.onHide();
        }
    }

    /** macOS-style ⋯ menu (overflow) */
    _setupMacMoreMenu() {
        const btnMore = document.getElementById('btn-more');
        const panel = document.getElementById('more-menu-panel');
        if (!btnMore || !panel) return;

        this._closeMoreMenu = () => {
            panel.hidden = true;
            btnMore.setAttribute('aria-expanded', 'false');
        };

        btnMore.addEventListener('click', (e) => {
            e.stopPropagation();
            const open = panel.hidden;
            panel.hidden = !open;
            btnMore.setAttribute('aria-expanded', open ? 'true' : 'false');
        });

        panel.addEventListener('click', () => {
            queueMicrotask(() => this._closeMoreMenu());
        });

        document.addEventListener('click', (e) => {
            if (panel.hidden) return;
            if (e.target.closest('.mac-menu-wrap')) return;
            this._closeMoreMenu();
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !panel.hidden) {
                this._closeMoreMenu();
            }
        });
    }

    // ─── Settings Form ─────────────────────────────────────

    _populateSettingsForm() {
        const s = settingsManager.get();

        document.getElementById('input-api-key').value = s.soniox_api_key || '';
        document.getElementById('input-openai-key').value = s.openai_api_key || '';
        document.getElementById('select-source-lang').value = s.source_language || 'auto';
        document.getElementById('select-target-lang').value = s.target_language || 'vi';
        document.getElementById('check-translation-enabled').checked = s.translation_enabled !== false;
        this._updateTranslationToggleUI(s.translation_enabled !== false);
        document.getElementById('select-translation-mode').value = s.translation_mode || 'soniox';
        this._updateModeUI(s.translation_mode || 'soniox');

        // Audio source radio
        const radioValue = s.audio_source || 'system';
        const radio = document.querySelector(`input[name="audio-source"][value="${radioValue}"]`);
        if (radio) radio.checked = true;

        // Display
        const opacityPercent = Math.round((s.overlay_opacity || 0.85) * 100);
        document.getElementById('range-opacity').value = opacityPercent;
        document.getElementById('opacity-value').textContent = `${opacityPercent}%`;

        document.getElementById('range-font-size').value = s.font_size || 16;
        document.getElementById('font-size-value').textContent = `${s.font_size || 16}px`;

        document.getElementById('range-max-lines').value = s.max_lines || 5;
        document.getElementById('max-lines-value').textContent = s.max_lines || 5;

        document.getElementById('check-show-original').checked = s.show_original !== false;

        // Custom context
        const ctx = s.custom_context;
        const domain = ctx?.domain || '';
        document.getElementById('input-context-domain').value = domain;
        const presetSel = document.getElementById('select-context-preset');
        if (presetSel) {
            let matched = '';
            for (const [k, text] of Object.entries(CONTEXT_DOMAIN_PRESETS)) {
                if (text === domain) {
                    matched = k;
                    break;
                }
            }
            presetSel.value = matched;
        }
        // Load translation terms as rows
        const termsList = document.getElementById('translation-terms-list');
        if (termsList) {
            termsList.innerHTML = '';
            const terms = ctx?.translation_terms || [];
            terms.forEach(t => this._addTermRow(t.source, t.target));
        }

        // TTS settings
        document.getElementById('input-elevenlabs-key').value = s.elevenlabs_api_key || '';
        document.getElementById('select-tts-voice').value = s.tts_voice_id || '21m00Tcm4TlvDq8ikWAM';
        // Edge TTS settings
        const edgeVoiceSelect = document.getElementById('select-edge-voice');
        if (edgeVoiceSelect) edgeVoiceSelect.value = s.edge_tts_voice || 'vi-VN-HoaiMyNeural';
        const edgeSpeedSlider = document.getElementById('range-edge-speed');
        const edgeSpeedLabel = document.getElementById('edge-speed-value');
        const edgeSpeed = s.edge_tts_speed !== undefined ? s.edge_tts_speed : 20;
        if (edgeSpeedSlider) edgeSpeedSlider.value = edgeSpeed;
        if (edgeSpeedLabel) edgeSpeedLabel.textContent = (edgeSpeed >= 0 ? '+' : '') + edgeSpeed + '%';

        // Google TTS settings
        const googleKeyInput = document.getElementById('input-google-tts-key');
        if (googleKeyInput) googleKeyInput.value = s.google_tts_api_key || '';
        const googleVoiceSelect = document.getElementById('select-google-voice');
        if (googleVoiceSelect) googleVoiceSelect.value = s.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
        const googleSpeedSlider = document.getElementById('range-google-speed');
        const googleSpeedLabel = document.getElementById('google-speed-value');
        const googleSpeed = s.google_tts_speed || 1.0;
        if (googleSpeedSlider) googleSpeedSlider.value = googleSpeed;
        if (googleSpeedLabel) googleSpeedLabel.textContent = googleSpeed + 'x';

        // TTS provider
        const providerSelect = document.getElementById('select-tts-provider');
        if (providerSelect) {
            providerSelect.value = s.tts_provider || 'edge';
            this._updateTTSProviderUI(providerSelect.value);
        }

        // ─── Meeting (MTG) ──────────────────────────────────
        const setVal = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value;
        };
        const setChecked = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.checked = !!value;
        };

        setVal('input-mtg-dir', s.mtg_export_dir || '');
        setVal('select-mtg-layout', s.mtg_folder_layout || 'year_month');
        setVal('input-mtg-prefix', s.mtg_filename_prefix || 'mtg');
        setChecked('check-mtg-include-transcript', s.mtg_include_transcript !== false);
        setChecked('check-mtg-include-original', s.mtg_include_original === true);
        setChecked('check-mtg-auto-export', s.mtg_auto_export === true);
        setVal('select-mtg-language', s.mtg_summary_language || 'vi');
        setVal('input-mtg-model', s.mtg_summary_model || 'gpt-4o-mini');
        setVal('input-mtg-prompt', s.mtg_summary_prompt || '');
        this._refreshMtgSampleHint();

        // ─── Calendar ───────────────────────────────────────
        const feedsList = document.getElementById('calendar-feeds-list');
        if (feedsList) {
            feedsList.innerHTML = '';
            const feeds = Array.isArray(s.calendar_feeds) ? s.calendar_feeds : [];
            feeds.forEach((f) => this._addFeedRow(f));
        }

        const daysSlider = document.getElementById('range-calendar-days');
        const daysLabel = document.getElementById('calendar-days-value');
        const days = s.calendar_days_ahead ?? 7;
        if (daysSlider) daysSlider.value = days;
        if (daysLabel) daysLabel.textContent = days;

        const refreshSlider = document.getElementById('range-calendar-refresh');
        const refreshLabel = document.getElementById('calendar-refresh-value');
        const refreshMins = s.calendar_refresh_minutes ?? 15;
        if (refreshSlider) refreshSlider.value = refreshMins;
        if (refreshLabel) refreshLabel.textContent = refreshMins === 0 ? 'off' : `${refreshMins}m`;

        setChecked('check-calendar-only-meet', s.calendar_only_with_meet === true);
        setChecked('check-calendar-open-link', s.calendar_open_link_on_start !== false);
        setVal('input-calendar-tz', s.calendar_timezone || '');
    }

    /**
     * Show where the next MTG note would land, so the folder setting isn't guesswork.
     *
     * Built from the *typed* values rather than the saved ones — the preview is most useful
     * while editing, before Save has happened. Only the "empty = app data folder" case asks
     * Rust, since that path is not knowable here.
     */
    async _refreshMtgSampleHint() {
        const hint = document.getElementById('hint-mtg-sample');
        if (!hint) return;

        const dir = document.getElementById('input-mtg-dir')?.value.trim() || '';
        const layout = document.getElementById('select-mtg-layout')?.value || 'year_month';
        const prefix = document.getElementById('input-mtg-prefix')?.value.trim() || 'mtg';

        if (!dir) {
            try {
                const info = await invoke('get_mtg_dir_info');
                hint.textContent = info?.error
                    ? `⚠ ${info.error}`
                    : `Next note: ${info?.samplePath || info?.dir || ''} (app data folder — set a path above)`;
            } catch {
                hint.textContent = '';
            }
            return;
        }

        if (!dir.startsWith('/') && !dir.startsWith('~')) {
            hint.textContent = '⚠ Use an absolute path (starting with / or ~).';
            return;
        }
        if (dir.split('/').includes('..')) {
            hint.textContent = '⚠ The path must not contain "..".';
            return;
        }

        const now = new Date();
        const yyyy = now.getFullYear();
        const mm = String(now.getMonth() + 1).padStart(2, '0');
        const dd = String(now.getDate()).padStart(2, '0');
        const base = dir.replace(/\/+$/, '');
        const folder = layout === 'flat' ? base : `${base}/${yyyy}/${mm}`;
        hint.textContent = `Next note: ${folder}/${prefix}-${yyyy}-${mm}-${dd}-weekly-sync.md`;
    }

    /** One editable row in Settings → Calendar → Subscribed calendars. */
    _addFeedRow({ label = '', url = '', enabled = true } = {}) {
        const list = document.getElementById('calendar-feeds-list');
        if (!list) return;

        const row = document.createElement('div');
        row.className = 'feed-row';

        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'feed-enabled';
        check.checked = !!enabled;
        check.title = 'Include this calendar';

        const inputs = document.createElement('div');
        inputs.className = 'feed-row-inputs';

        const labelInput = document.createElement('input');
        labelInput.type = 'text';
        labelInput.className = 'feed-label';
        labelInput.placeholder = 'Label (optional) — e.g. Work';
        labelInput.value = label;

        const urlInput = document.createElement('input');
        urlInput.type = 'text';
        urlInput.className = 'feed-url';
        urlInput.placeholder = 'https://calendar.google.com/calendar/ical/…/basic.ics';
        urlInput.spellcheck = false;
        urlInput.value = url;

        const result = document.createElement('div');
        result.className = 'feed-test-result';

        inputs.appendChild(labelInput);
        inputs.appendChild(urlInput);
        inputs.appendChild(result);

        const actions = document.createElement('div');
        actions.className = 'feed-row-actions';

        const btnTest = document.createElement('button');
        btnTest.type = 'button';
        btnTest.className = 'btn-test-feed';
        btnTest.textContent = 'Test';
        btnTest.addEventListener('click', async () => {
            const u = urlInput.value.trim();
            if (!u) {
                result.className = 'feed-test-result err';
                result.textContent = 'Paste the iCal URL first.';
                return;
            }
            btnTest.disabled = true;
            btnTest.textContent = '…';
            result.className = 'feed-test-result';
            result.textContent = 'Checking…';
            try {
                const res = await invoke('test_calendar_feed', { url: u });
                if (res?.ok) {
                    result.className = 'feed-test-result ok';
                    result.textContent = `✓ ${res.calendarName || 'calendar'} — ${
                        res.eventCount
                    } entries, ${res.upcomingCount} in the next 7 days`;
                    if (!labelInput.value.trim() && res.calendarName) {
                        labelInput.value = res.calendarName;
                    }
                } else {
                    result.className = 'feed-test-result err';
                    result.textContent = `✕ ${res?.error || 'failed'}`;
                }
            } catch (err) {
                result.className = 'feed-test-result err';
                result.textContent = `✕ ${err}`;
            } finally {
                btnTest.disabled = false;
                btnTest.textContent = 'Test';
            }
        });

        const btnRemove = document.createElement('button');
        btnRemove.type = 'button';
        btnRemove.className = 'btn-remove-feed';
        btnRemove.textContent = '×';
        btnRemove.title = 'Remove';
        btnRemove.addEventListener('click', () => row.remove());

        actions.appendChild(btnTest);
        actions.appendChild(btnRemove);

        row.appendChild(check);
        row.appendChild(inputs);
        row.appendChild(actions);
        list.appendChild(row);
    }

    async _saveSettingsFromForm() {
        const settings = {
            soniox_api_key: document.getElementById('input-api-key').value.trim(),
            openai_api_key: document.getElementById('input-openai-key')?.value.trim() || '',
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
            translation_enabled: document.getElementById('check-translation-enabled').checked,
            translation_mode: document.getElementById('select-translation-mode').value,
            audio_source: document.querySelector('input[name="audio-source"]:checked')?.value || 'system',
            overlay_opacity: parseInt(document.getElementById('range-opacity').value) / 100,
            font_size: parseInt(document.getElementById('range-font-size').value),
            max_lines: parseInt(document.getElementById('range-max-lines').value),
            show_original: document.getElementById('check-show-original').checked,
            custom_context: null,
        };

        // Parse custom context
        const domain = document.getElementById('input-context-domain').value.trim();
        const translationTerms = [];
        document.querySelectorAll('#translation-terms-list .term-row').forEach(row => {
            const source = row.querySelector('.term-source')?.value.trim();
            const target = row.querySelector('.term-target')?.value.trim();
            if (source && target) translationTerms.push({ source, target });
        });

        if (domain || translationTerms.length > 0) {
            settings.custom_context = {
                domain: domain || null,
                translation_terms: translationTerms,
            };
        }

        // TTS settings
        settings.tts_provider = document.getElementById('select-tts-provider')?.value || 'edge';
        settings.elevenlabs_api_key = document.getElementById('input-elevenlabs-key').value.trim();
        settings.tts_voice_id = document.getElementById('select-tts-voice').value;
        settings.edge_tts_voice = document.getElementById('select-edge-voice')?.value || 'vi-VN-HoaiMyNeural';
        settings.edge_tts_speed = parseInt(document.getElementById('range-edge-speed')?.value || 20);
        settings.tts_speed = parseFloat(document.getElementById('range-tts-speed')?.value || 1.2);
        settings.google_tts_api_key = document.getElementById('input-google-tts-key')?.value.trim() || '';
        settings.google_tts_voice = document.getElementById('select-google-voice')?.value || 'vi-VN-Chirp3-HD-Aoede';
        settings.google_tts_speed = parseFloat(document.getElementById('range-google-speed')?.value || 1.0);
        settings.tts_enabled = false;

        // Meeting (MTG) note export
        settings.mtg_export_dir = document.getElementById('input-mtg-dir')?.value.trim() || '';
        settings.mtg_folder_layout =
            document.getElementById('select-mtg-layout')?.value || 'year_month';
        settings.mtg_filename_prefix =
            document.getElementById('input-mtg-prefix')?.value.trim() || 'mtg';
        settings.mtg_include_transcript =
            document.getElementById('check-mtg-include-transcript')?.checked !== false;
        settings.mtg_include_original =
            document.getElementById('check-mtg-include-original')?.checked === true;
        settings.mtg_auto_export =
            document.getElementById('check-mtg-auto-export')?.checked === true;
        settings.mtg_summary_language =
            document.getElementById('select-mtg-language')?.value || 'vi';
        settings.mtg_summary_model =
            document.getElementById('input-mtg-model')?.value.trim() || 'gpt-4o-mini';
        settings.mtg_summary_prompt = document.getElementById('input-mtg-prompt')?.value || '';

        // Calendar subscription — drop rows with no URL so an empty "+" row isn't persisted.
        const feeds = [];
        document.querySelectorAll('#calendar-feeds-list .feed-row').forEach((row) => {
            const url = row.querySelector('.feed-url')?.value.trim() || '';
            if (!url) return;
            feeds.push({
                label: row.querySelector('.feed-label')?.value.trim() || '',
                url,
                enabled: row.querySelector('.feed-enabled')?.checked !== false,
            });
        });
        settings.calendar_source = 'ics';
        settings.calendar_feeds = feeds;
        settings.calendar_days_ahead = parseInt(
            document.getElementById('range-calendar-days')?.value || 7,
            10,
        );
        settings.calendar_refresh_minutes = parseInt(
            document.getElementById('range-calendar-refresh')?.value || 15,
            10,
        );
        settings.calendar_only_with_meet =
            document.getElementById('check-calendar-only-meet')?.checked === true;
        settings.calendar_open_link_on_start =
            document.getElementById('check-calendar-open-link')?.checked !== false;
        settings.calendar_timezone =
            document.getElementById('input-calendar-tz')?.value.trim() || '';

        try {
            await settingsManager.save(settings);
            this._showToast('Settings saved', 'success');
            this._showView('overlay');
        } catch (err) {
            this._showToast(`Failed to save: ${err}`, 'error');
        }
    }

    // ─── Apply Settings ────────────────────────────────────

    _applySettings(settings) {
        // Update overlay opacity
        const overlayView = document.getElementById('overlay-view');
        overlayView.style.opacity = settings.overlay_opacity || 0.85;

        // Update transcript UI
        if (this.transcriptUI) {
            this.transcriptUI.configure({
                maxLines: settings.max_lines || 5,
                showOriginal: settings.show_original !== false,
                translationEnabled: settings.translation_enabled !== false,
                fontSize: settings.font_size || 16,
            });
        }

        // Update current source button states. Not while running: a capture may have degraded
        // to a single source (missing mic), and saving any unrelated setting would otherwise
        // reset the buttons to the configured value and re-light a mic that isn't recording.
        // Changing the source mid-session goes through `_setSource`, which restarts capture.
        if (!this.isRunning) {
            this.currentSource = settings.audio_source || 'both';
            this._updateSourceButtons();
        }

        // TTS is always OFF on app start — user must toggle on each session
        this.ttsEnabled = false;
        this._updateTTSButton();
    }

    // ─── TTS Control ──────────────────────────────────────

    _toggleTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';

        // TTS narrates translations. With translation off there is nothing to narrate,
        // so say that outright instead of leaving the user with a silent "ON" button.
        if (settings.translation_enabled === false) {
            this._showToast('TTS narrates translations — turn Translate on in Settings first.', 'info');
            return;
        }

        // Check API key for premium providers
        if (provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('Add ElevenLabs API key in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }
        if (provider === 'google' && !settings.google_tts_api_key) {
            this._showToast('Add Google TTS API key in Settings → TTS', 'error');
            this._showView('settings');
            return;
        }

        this.ttsEnabled = !this.ttsEnabled;
        this._updateTTSButton();

        const tts = this._getActiveTTS();

        if (this.ttsEnabled) {
            this._configureTTS(tts, settings);
            if (this.isRunning) {
                tts.connect();
                audioPlayer.resume();
            }
            const label = { edge: 'Edge TTS (Free)', google: 'Google Chirp 3 HD', elevenlabs: 'ElevenLabs' }[provider] || provider;
            this._showToast(`TTS narration ON 🔊 (${label})`, 'success');
        } else {
            tts.disconnect();
            audioPlayer.stop();
            this._showToast('TTS narration OFF 🔇', 'success');
        }
    }

    _getActiveTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';
        if (provider === 'elevenlabs') return elevenLabsTTS;
        if (provider === 'google') return googleTTS;
        return edgeTTSRust;
    }

    _configureTTS(tts, settings) {
        const provider = settings.tts_provider || 'edge';
        if (provider === 'elevenlabs') {
            tts.configure({
                apiKey: settings.elevenlabs_api_key,
                voiceId: settings.tts_voice_id || '21m00Tcm4TlvDq8ikWAM',
            });
        } else if (provider === 'google') {
            const voice = settings.google_tts_voice || 'vi-VN-Chirp3-HD-Aoede';
            const langCode = voice.replace(/-Chirp3.*/, '');
            tts.configure({
                apiKey: settings.google_tts_api_key,
                voice: voice,
                languageCode: langCode,
                speakingRate: settings.google_tts_speed || 1.0,
            });
        } else {
            tts.configure({
                voice: settings.edge_tts_voice || 'vi-VN-HoaiMyNeural',
                speed: settings.edge_tts_speed !== undefined ? settings.edge_tts_speed : 20,
            });
        }
    }

    _addTermRow(source = '', target = '') {
        const list = document.getElementById('translation-terms-list');
        if (!list) return;
        const row = document.createElement('div');
        row.className = 'term-row';
        row.innerHTML = `<input type="text" class="term-source" value="${source}" placeholder="Source" />` +
            `<input type="text" class="term-target" value="${target}" placeholder="Target" />` +
            `<button type="button" class="btn-remove-term" title="Remove">×</button>`;
        row.querySelector('.btn-remove-term').addEventListener('click', () => row.remove());
        list.appendChild(row);
    }

    _updateTTSProviderUI(provider) {
        const ed = document.getElementById('tts-edge-settings');
        const go = document.getElementById('tts-google-settings');
        const el = document.getElementById('tts-elevenlabs-settings');
        if (ed) ed.style.display = provider === 'edge' ? '' : 'none';
        if (go) go.style.display = provider === 'google' ? '' : 'none';
        if (el) el.style.display = provider === 'elevenlabs' ? '' : 'none';
        // Update hint text
        const hint = document.getElementById('tts-provider-hint');
        if (hint) {
            const hints = {
                edge: 'Free, natural voices — no API key needed',
                google: 'Near-human quality — requires Google Cloud API key (1M chars/month free)',
                elevenlabs: 'Premium quality — requires ElevenLabs API key',
            };
            hint.textContent = hints[provider] || '';
        }
    }

    _updateTTSButton() {
        const btn = document.getElementById('btn-tts');
        const iconOff = document.getElementById('icon-tts-off');
        const iconOn = document.getElementById('icon-tts-on');

        if (btn) btn.classList.toggle('active', this.ttsEnabled);
        if (iconOff) iconOff.style.display = this.ttsEnabled ? 'none' : 'block';
        if (iconOn) iconOn.style.display = this.ttsEnabled ? 'block' : 'none';
    }

    _speakIfEnabled(text) {
        if (this.ttsEnabled && text?.trim()) {
            this._getActiveTTS().speak(text);
        }
    }

    // ─── Source Control ────────────────────────────────────

    _setSource(source) {
        // A switch is a full stop/start cycle. Two quick ⌘1/⌘2 presses would otherwise queue
        // two of them and let the second stop() land inside the first start().
        if (this._switchingSource) return;

        const wasRunning = this.isRunning;

        // If currently running, restart with new source
        if (wasRunning) {
            // Switching source stops and restarts capture. That is not the end of the meeting, so
            // suppress the auto-export in stop() — otherwise a half-finished MTG note gets written.
            this._switchingSource = true;
            this.stop().then(() => {
                this.currentSource = source;
                this._updateSourceButtons();
                this._showToast(`Switched to ${SOURCE_LABELS[source] || source}`, 'success');
                return this.start();
            }).finally(() => {
                this._switchingSource = false;
            });
        } else {
            this.currentSource = source;
            this._updateSourceButtons();
            this._showToast(`Source: ${SOURCE_LABELS[source] || source}`, 'success');
        }
    }

    /**
     * The overlay has one button per capture device rather than a "Both" button: "both" is
     * simply the state where each is lit, and clicking one toggles it out of the mix. Dropping
     * the last active source would leave nothing to transcribe, so that click is ignored.
     */
    _toggleSource(source) {
        const active = new Set(
            this.currentSource === 'both' ? ['system', 'microphone'] : [this.currentSource]
        );
        if (active.has(source)) {
            if (active.size === 1) {
                this._showToast('At least one audio source has to stay on.', 'info');
                return;
            }
            active.delete(source);
        } else {
            active.add(source);
        }
        this._setSource(active.size === 2 ? 'both' : [...active][0]);
    }

    /**
     * `start_capture` reports what it actually opened. With source "both" a missing microphone
     * degrades to system audio instead of failing, so reflect that in the buttons and say why —
     * otherwise the mic button stays lit over a stream that carries no mic audio.
     */
    _applyCaptureStatus(status) {
        if (!status) return; // older backend, or the dummy permission-check call
        if (status.active_source && status.active_source !== this.currentSource) {
            this.currentSource = status.active_source;
            this._updateSourceButtons();
        }
        if (status.warning) {
            console.warn('[App]', status.warning);
            this._showToast(status.warning, 'error');
        }
    }

    _updateSourceButtons() {
        const both = this.currentSource === 'both';
        document.getElementById('btn-source-system').classList.toggle('active',
            both || this.currentSource === 'system');
        document.getElementById('btn-source-mic').classList.toggle('active',
            both || this.currentSource === 'microphone');
    }

    _updateModeUI(mode) {
        const hintSoniox = document.getElementById('hint-mode-soniox');
        const hintLocal = document.getElementById('hint-mode-local');

        if (hintSoniox) hintSoniox.style.display = mode === 'soniox' ? '' : 'none';
        if (hintLocal) hintLocal.style.display = mode === 'local' ? '' : 'none';
    }

    _updateTranslationToggleUI(enabled) {
        const targetField = document.getElementById('field-target-lang');
        const targetSelect = document.getElementById('select-target-lang');
        if (targetSelect) targetSelect.disabled = !enabled;
        if (targetField) targetField.style.opacity = enabled ? '' : '0.45';

        // "Show original text" only chooses whether the source line accompanies a translation.
        // With no translation the original is the subtitle, so the option has nothing to do.
        const showOriginal = document.getElementById('check-show-original');
        if (showOriginal) {
            showOriginal.disabled = !enabled;
            const label = showOriginal.closest('.checkbox-option');
            if (label) label.style.opacity = enabled ? '' : '0.45';
        }
    }

    // ─── Start/Stop ────────────────────────────────────────

    async start() {
        const settings = settingsManager.get();
        this.translationMode = settings.translation_mode || 'soniox';
        console.log('[App] start() called, translation_mode:', this.translationMode, 'settings:', JSON.stringify(settings));

        // Always check Soniox API key (required for all modes)
        if (!settings.soniox_api_key) {
            this._showToast('Soniox API key is required. Add it in Settings.', 'error');
            this._showView('settings');
            return;
        }

        // Check ElevenLabs key only if TTS is enabled AND provider is elevenlabs
        if (this.ttsEnabled && settings.tts_provider === 'elevenlabs' && !settings.elevenlabs_api_key) {
            this._showToast('TTS is ON but ElevenLabs API key is missing. Add it in Settings or disable TTS.', 'error');
            this._showView('settings');
            return;
        }

        this.isRunning = true;
        this._updateStartButton();
        if (!this.recordingStartTime) this.recordingStartTime = Date.now();

        // Clear transcript only if nothing is showing
        if (!this.transcriptUI.hasContent()) {
            this.transcriptUI.showListening();
        } else {
            this.transcriptUI.clearProvisional();
        }

        if (this.translationMode === 'local') {
            await this._startLocalMode(settings);
        } else {
            await this._startSonioxMode(settings);
        }

        // Start TTS if enabled
        if (this.ttsEnabled) {
            const tts = this._getActiveTTS();
            this._configureTTS(tts, settings);
            tts.connect();
            audioPlayer.resume();
        }
    }

    async _startSonioxMode(settings) {
        // Connect to Soniox
        console.log('[App] Connecting to Soniox...');
        this._updateStatus('connecting');
        sonioxClient.connect({
            apiKey: settings.soniox_api_key,
            sourceLanguage: settings.source_language,
            // null → the client omits the `translation` block, so Soniox returns
            // transcription tokens only (no translation billing, no extra latency).
            targetLanguage: settings.translation_enabled === false ? null : settings.target_language,
            customContext: settings.custom_context,
        });

        // Start audio capture — Rust batches audio every 200ms, JS just forwards
        try {
            let audioChunkCount = 0;

            const channel = new window.__TAURI__.core.Channel();
            channel.onmessage = (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Audio] Batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                // Forward batched audio to Soniox
                const bytes = new Uint8Array(pcmData);
                sonioxClient.sendAudio(bytes.buffer);
            };

            console.log('[App] Starting audio capture, source:', this.currentSource);
            const status = await invoke('start_capture', {
                source: this.currentSource,
                channel: channel,
            });
            this._applyCaptureStatus(status);
            console.log('[App] Audio capture started successfully');
        } catch (err) {
            console.error('Failed to start audio capture:', err);
            this._showToast(`Audio error: ${err}`, 'error');
            await this.stop();
        }
    }

    async _startLocalMode(settings) {
        console.log('[App] Starting Local mode (MLX models)...');
        this._updateStatus('connecting');

        // Step 0: Check audio permission FIRST (before loading models)
        try {
            const status = await invoke('start_capture', {
                source: this.currentSource,
                channel: new window.__TAURI__.core.Channel(), // dummy channel for permission check
            });
            // Resolve a missing microphone here, before the multi-minute model load — and so the
            // real capture below asks for the source that actually works instead of retrying the
            // failing device a second time.
            this._applyCaptureStatus(status);
            await invoke('stop_capture');
        } catch (err) {
            console.error('[App] Audio permission check failed:', err);
            this._showToast(`Audio permission required: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            return;
        }

        // Step 1: Check if MLX setup is complete
        try {
            const checkResult = await invoke('check_mlx_setup');
            const status = JSON.parse(checkResult);
            if (!status.ready) {
                this._showToast('Setting up MLX models (one-time, ~5GB)...', 'success');
                this.transcriptUI.showStatusMessage('Downloading MLX models (one-time setup)...');
                await this._runMlxSetup();
            }
        } catch (err) {
            console.warn('[App] MLX check failed (proceeding anyway):', err);
        }

        console.log('[App] MLX check passed, starting pipeline...');

        // Step 1: Start pipeline FIRST (independent of audio)
        try {
            this._showToast('Starting local pipeline...', 'success');

            this.localPipelineChannel = new window.__TAURI__.core.Channel();
            this.localPipelineReady = false;

            this.localPipelineChannel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    console.warn('[Local] JSON parse failed:', typeof msg, msg);
                    return;
                }
                try {
                    this._handleLocalPipelineResult(data);
                } catch (e) {
                    console.error('[Local] Handler error for type:', data?.type, e);
                }
            };

            const sourceLangMap = {
                'auto': 'auto', 'ja': 'Japanese', 'en': 'English',
                'zh': 'Chinese', 'ko': 'Korean', 'vi': 'Vietnamese',
            };
            const sourceLang = sourceLangMap[settings.source_language] || 'Japanese';

            await invoke('start_local_pipeline', {
                sourceLang: sourceLang,
                // "none" tells local_pipeline.py to skip loading and running the translator LLM.
                targetLang: settings.translation_enabled === false
                    ? 'none'
                    : (settings.target_language || 'vi'),
                channel: this.localPipelineChannel,
            });
            console.log('[App] Local pipeline spawned');
        } catch (err) {
            console.error('Failed to start pipeline:', err);
            this._showToast(`Pipeline error: ${err}`, 'error');
            await this.stop();
            return;
        }

        // Step 2: Start audio capture
        try {
            const audioChannel = new window.__TAURI__.core.Channel();
            let audioChunkCount = 0;

            audioChannel.onmessage = async (pcmData) => {
                audioChunkCount++;
                if (audioChunkCount <= 3 || audioChunkCount % 50 === 0) {
                    console.log(`[Local] Audio batch #${audioChunkCount}, size:`, pcmData?.length || 0);
                }
                try {
                    await invoke('send_audio_to_pipeline', { data: Array.from(new Uint8Array(pcmData)) });
                } catch (e) {
                    // Pipeline may not be ready yet
                }
            };

            const status = await invoke('start_capture', {
                source: this.currentSource,
                channel: audioChannel,
            });
            this._applyCaptureStatus(status);
            console.log('[App] Audio capture started');
        } catch (err) {
            console.error('Audio capture failed (pipeline still running):', err);
            this._showToast(`Audio: ${err}. Pipeline still loading...`, 'error');
        }
    }

    _handleLocalPipelineResult(data) {
        switch (data.type) {
            case 'ready':
                this.localPipelineReady = true;
                this._updateStatus('connected');
                this.transcriptUI.removeStatusMessage();
                this.transcriptUI.showListening();
                this._showToast('Local models ready!', 'success');
                break;
            case 'result':
                // Chase effect: show original first (gray), then translation (white)
                if (data.original) {
                    this.transcriptUI.addOriginal(data.original);
                }
                // Small delay for visual "chase" effect
                setTimeout(() => {
                if (data.translated) {
                    this.transcriptUI.addTranslation(data.translated);
                    this._speakIfEnabled(data.translated);
                }
                }, 80);
                break;
            case 'status':
                const msg = data.message || 'Loading...';
                // Status bar: show compact message (strip [pipeline] prefix)
                const statusText = document.getElementById('status-text');
                if (statusText) {
                    const compact = msg.replace(/^\[pipeline\]\s*/, '');
                    statusText.textContent = compact;
                }
                // Transcript area: only show loading/starting messages, not debug logs
                if (!msg.startsWith('[pipeline]')) {
                    this.transcriptUI.showStatusMessage(msg);
                }
                break;
            case 'done':
                this._updateStatus('disconnected');
                break;
        }
    }

    async _runMlxSetup() {
        const modal = document.getElementById('setup-modal');
        const progressFill = document.getElementById('setup-progress-fill');
        const progressPct = document.getElementById('setup-progress-pct');
        const statusText = document.getElementById('setup-status-text');
        const cancelBtn = document.getElementById('btn-cancel-setup');

        // Step mapping: step name → total progress weight
        const stepWeights = { check: 5, venv: 10, packages: 35, models: 50 };
        let totalProgress = 0;

        const updateStep = (stepName, icon, isActive) => {
            const stepEl = document.getElementById(`step-${stepName}`);
            if (!stepEl) return;
            stepEl.querySelector('.step-icon').textContent = icon;
            stepEl.classList.toggle('active', isActive);
            stepEl.classList.toggle('done', icon === '✅');
        };

        const updateProgress = (pct) => {
            totalProgress = Math.min(100, pct);
            progressFill.style.width = totalProgress + '%';
            progressPct.textContent = Math.round(totalProgress) + '%';
        };

        // Show modal
        modal.style.display = 'flex';

        return new Promise((resolve, reject) => {
            const channel = new window.__TAURI__.core.Channel();

            // Cancel handler
            const onCancel = () => {
                modal.style.display = 'none';
                reject(new Error('Setup cancelled'));
            };
            cancelBtn.addEventListener('click', onCancel, { once: true });

            channel.onmessage = (msg) => {
                let data;
                try {
                    data = (typeof msg === 'string') ? JSON.parse(msg) : msg;
                } catch (e) {
                    return;
                }

                switch (data.type) {
                    case 'progress':
                        statusText.textContent = data.message || 'Working...';

                        // Update step indicators
                        if (data.step) {
                            // Mark previous steps as done
                            const steps = ['check', 'venv', 'packages', 'models'];
                            const currentIdx = steps.indexOf(data.step);
                            steps.forEach((s, i) => {
                                if (i < currentIdx) updateStep(s, '✅', false);
                                else if (i === currentIdx) updateStep(s, '🔄', true);
                            });

                            if (data.done) {
                                updateStep(data.step, '✅', false);
                            }

                            // Calculate overall progress
                            let pct = 0;
                            steps.forEach((s, i) => {
                                if (i < currentIdx) pct += stepWeights[s];
                                else if (i === currentIdx) {
                                    pct += (data.progress || 0) / 100 * stepWeights[s];
                                }
                            });
                            updateProgress(pct);
                        }
                        break;

                    case 'complete':
                        updateProgress(100);
                        statusText.textContent = '✅ ' + (data.message || 'Setup complete!');
                        ['check', 'venv', 'packages', 'models'].forEach(s => updateStep(s, '✅', false));

                        // Close modal after brief delay
                        setTimeout(() => {
                            modal.style.display = 'none';
                            resolve();
                        }, 1000);
                        break;

                    case 'error':
                        statusText.textContent = '❌ ' + (data.message || 'Setup failed');
                        cancelBtn.textContent = 'Close';
                        cancelBtn.removeEventListener('click', onCancel);
                        cancelBtn.addEventListener('click', () => {
                            modal.style.display = 'none';
                            reject(new Error(data.message));
                        }, { once: true });
                        break;

                    case 'log':
                        console.log('[MLX Setup]', data.message);
                        break;
                }
            };

            invoke('run_mlx_setup', { channel })
                .catch(err => {
                    statusText.textContent = '❌ ' + err;
                    modal.style.display = 'none';
                    reject(err);
                });
        });
    }

    async stop() {
        const wasRunning = this.isRunning;
        this.isRunning = false;
        if (wasRunning) this.recordingEndTime = Date.now();
        this._updateStartButton();

        // Stop audio capture
        try {
            await invoke('stop_capture');
        } catch (err) {
            console.error('Failed to stop audio capture:', err);
        }

        if (this.translationMode === 'local') {
            // Stop local pipeline
            try {
                await invoke('stop_local_pipeline');
            } catch (err) {
                console.error('Failed to stop local pipeline:', err);
            }
            this.localPipelineReady = false;
            this.transcriptUI.removeStatusMessage();
            this._updateStatus('disconnected');
        } else {
            // Disconnect Soniox
            sonioxClient.disconnect();
        }

        // Keep transcript visible — don't clear
        this.transcriptUI.clearProvisional();

        // Stop TTS
        elevenLabsTTS.disconnect();
        edgeTTSRust.disconnect();

        audioPlayer.stop();

        // Auto-save on stop (safety net)
        if (this.transcriptUI.hasSegments()) {
            await this._saveTranscriptFile();
        }

        this._updateSummaryButtonState();

        // Optional: write the MTG note without further interaction.
        if (
            settingsManager.get().mtg_auto_export &&
            !this._switchingSource &&
            this.transcriptUI.hasSegments()
        ) {
            this._showToast('Writing meeting note…', 'success');
            await this.meetingNote?.autoExport(this._buildMeetingContext());
        }
    }

    _updateStartButton() {
        const btn = document.getElementById('btn-start');
        const iconPlay = document.getElementById('icon-play');
        const iconStop = document.getElementById('icon-stop');

        btn.classList.toggle('recording', this.isRunning);
        iconPlay.style.display = this.isRunning ? 'none' : 'block';
        iconStop.style.display = this.isRunning ? 'block' : 'none';

        this._updateSummaryButtonState();
    }

    _updateSummaryButtonState() {
        const hasText = !!this.transcriptUI?.getPlainText()?.trim();
        const blocked = this.isRunning || this.isStarting || this.isSummarizing || !hasText;

        const btn = document.getElementById('btn-summary');
        if (btn) {
            btn.disabled = blocked;
            btn.classList.toggle('active', !btn.disabled);
        }

        const mtgBtn = document.getElementById('btn-meeting-note');
        if (mtgBtn) mtgBtn.disabled = blocked;
    }

    async _summarizeTranscript() {
        if (this.isRunning) {
            this._showToast('Stop the conversation first, then summarize.', 'info');
            return;
        }

        const transcript = this.transcriptUI?.getPlainText() || '';
        if (!transcript.trim()) {
            this._showToast('No transcript to summarize', 'info');
            return;
        }

        const settings = settingsManager.get();
        if (!settings.openai_api_key) {
            this._showToast('Add OpenAI API key in Settings (for Summary)', 'error');
            this._showView('settings');
            return;
        }

        this.isSummarizing = true;
        this._updateSummaryButtonState();
        this._showToast('Summarizing...', 'success');

        try {
            const result = await invoke('summarize_transcript', { transcript });
            this._showSummaryModal({
                title: 'Summary',
                desc: 'Generated with ChatGPT from your transcript.',
                text: result,
                showOpenSettings: false,
            });
        } catch (err) {
            console.error('[Summary] error:', err);
            this._showSummaryError(err);
        } finally {
            this.isSummarizing = false;
            this._updateSummaryButtonState();
        }
    }

    _showSummaryModal({ title, desc, text, showOpenSettings }) {
        const modal = document.getElementById('summary-modal');
        const textarea = document.getElementById('summary-text');
        const titleEl = document.getElementById('summary-title');
        const descEl = document.getElementById('summary-desc');
        const btnSettings = document.getElementById('btn-open-settings-from-summary');
        if (titleEl) titleEl.textContent = title || 'Summary';
        if (descEl) descEl.textContent = desc || '';
        if (textarea) textarea.value = text || '';
        if (btnSettings) btnSettings.style.display = showOpenSettings ? '' : 'none';
        if (modal) modal.style.display = 'flex';
    }

    _showSummaryError(err) {
        const friendly = this._formatSummaryError(err);
        this._showSummaryModal({
            title: friendly.title,
            desc: friendly.desc,
            text: friendly.detail,
            showOpenSettings: friendly.showOpenSettings,
        });
        this._showToast(friendly.toast, 'error');
    }

    _formatSummaryError(err) {
        const raw = (err ?? '').toString();
        const base = {
            title: 'Cannot generate summary',
            desc: 'Please check your OpenAI API key and billing.',
            toast: 'Summary failed',
            detail: raw,
            showOpenSettings: true,
        };

        // Try to extract JSON error body from "OpenAI error <code>: <json>"
        const m = raw.match(/OpenAI error\s+(\d+)\s*:\s*(\{[\s\S]*\})/);
        if (m) {
            const status = parseInt(m[1], 10);
            try {
                const payload = JSON.parse(m[2]);
                const code = payload?.error?.code;
                const msg = payload?.error?.message;
                if (status === 429 && code === 'insufficient_quota') {
                    return {
                        title: 'OpenAI quota exceeded',
                        desc: 'Your OpenAI account has no remaining quota or billing is not enabled.',
                        toast: 'OpenAI quota exceeded',
                        detail: [
                            'OpenAI API returned: insufficient_quota (429)',
                            '',
                            'Fix:',
                            '- Add/verify billing in OpenAI dashboard',
                            '- Or use another API key with active quota',
                            '',
                            msg ? `Message: ${msg}` : '',
                        ].filter(Boolean).join('\n'),
                        showOpenSettings: true,
                    };
                }
                return {
                    ...base,
                    title: `OpenAI error (${status})`,
                    desc: msg ? msg : base.desc,
                    toast: `OpenAI error ${status}`,
                    detail: JSON.stringify(payload, null, 2),
                    showOpenSettings: true,
                };
            } catch {
                return base;
            }
        }

        if (raw.includes('Missing OpenAI API key')) {
            return {
                title: 'Missing OpenAI API key',
                desc: 'Add your API key in Settings to use Summary.',
                toast: 'Missing OpenAI API key',
                detail: raw,
                showOpenSettings: true,
            };
        }

        return base;
    }

    // ─── Transcript Persistence ───────────────────────────────

    _formatDuration(ms) {
        const totalSec = Math.floor(ms / 1000);
        const min = Math.floor(totalSec / 60);
        const sec = totalSec % 60;
        return `${min}m ${sec}s`;
    }

    async _saveTranscriptFile() {
        const duration = this.recordingStartTime
            ? this._formatDuration(Date.now() - this.recordingStartTime)
            : 'unknown';

        const sourceLang = document.getElementById('select-source-lang')?.value || 'auto';
        const targetLang = document.getElementById('select-target-lang')?.value || 'vi';

        const content = this.transcriptUI.getFormattedContent({
            model: this.translationMode === 'soniox' ? 'Soniox Cloud API' : 'Local MLX Whisper',
            sourceLang,
            targetLang,
            duration,
            audioSource: this.currentSource,
            meetingTitle: this.activeMeeting?.title || '',
            meetingUrl: this.activeMeeting?.meetingUrl || '',
        });

        if (!content) return;

        try {
            const result = await invoke('save_transcript_session', {
                content,
                sessionId: this.currentSessionId || null,
            });
            const sid = result?.sessionId ?? result?.session_id;
            if (sid) this.currentSessionId = sid;
            const filename = (result?.path || '').split('/').pop() || 'transcript.md';
            this._showToast(`Saved: ${filename}`, 'success');
        } catch (err) {
            console.error('Failed to save transcript:', err);
            this._showToast('Failed to save transcript', 'error');
        }
    }

    async _startNewConversation() {
        if (this.isRunning) {
            this._showToast('Stop recording before starting a new conversation.', 'info');
            return;
        }
        if (this.transcriptUI.hasSegments()) {
            await this._saveTranscriptFile();
        }
        this.transcriptUI.clear();
        this.transcriptUI.showPlaceholder();
        this.recordingStartTime = null;
        this.recordingEndTime = null;
        this.currentSessionId = null;
        this.activeMeeting = null;
        this._updateActiveMeetingBar();
        this._updateSummaryButtonState();
        this._showView('overlay');
        this._showToast('New conversation — previous text saved.', 'success');
    }

    // ─── Meetings (calendar → session → MTG note) ─────────────

    /**
     * Attach a calendar event to a fresh session and start capturing.
     *
     * Anything already on screen is saved into its own conversation first, so one meeting's
     * transcript never bleeds into the next one's note.
     */
    async _startMeetingFromCalendar(ev) {
        if (this.isRunning) {
            this._showToast('Stop the current recording first.', 'info');
            return;
        }
        if (!ev) return;

        if (this.transcriptUI.hasSegments()) {
            await this._saveTranscriptFile();
            this.transcriptUI.clear();
            this.transcriptUI.showPlaceholder();
            this.currentSessionId = null;
            this.recordingStartTime = null;
        }

        this.activeMeeting = {
            uid: ev.uid || '',
            title: ev.title || '',
            meetingUrl: ev.meetingUrl || '',
            start: ev.start ?? null,
            end: ev.end ?? null,
            calendar: ev.calendar || '',
        };
        this.recordingEndTime = null;
        this._updateActiveMeetingBar();

        const settings = settingsManager.get();
        if (settings.calendar_open_link_on_start && ev.meetingUrl) {
            try {
                await window.__TAURI__.opener.openUrl(ev.meetingUrl);
            } catch (err) {
                console.error('[Meeting] could not open link:', err);
            }
        }

        this._showView('overlay');
        try {
            this.isStarting = true;
            await this.start();
            // `start()` bails out quietly (toast + jump to Settings) when a key is missing, so
            // claiming success here without checking would be a lie.
            if (this.isRunning) {
                this._showToast(`Recording “${this.activeMeeting.title}”`, 'success');
            }
        } catch (err) {
            console.error('[Meeting] start failed:', err);
            this._showToast(`Error: ${err}`, 'error');
            this.isRunning = false;
            this._updateStartButton();
            this._updateStatus('error');
        } finally {
            this.isStarting = false;
        }
    }

    _updateActiveMeetingBar() {
        const bar = document.getElementById('active-meeting-bar');
        const titleEl = document.getElementById('active-meeting-title');
        const linkEl = document.getElementById('active-meeting-link');
        if (!bar) return;

        if (!this.activeMeeting) {
            bar.hidden = true;
            return;
        }
        bar.hidden = false;
        if (titleEl) titleEl.textContent = this.activeMeeting.title || 'Meeting';
        if (linkEl) linkEl.hidden = !this.activeMeeting.meetingUrl;
    }

    /** Everything `export_meeting_note` / `summarize_meeting` need about this session. */
    _buildMeetingContext() {
        const startedAt = this.recordingStartTime ?? null;
        const endedAt = this.recordingEndTime ?? (this.isRunning ? null : Date.now());
        const duration =
            startedAt && endedAt ? this._formatDuration(endedAt - startedAt) : null;
        const stats = this.transcriptUI?.getStats?.() ?? { segments: 0 };

        return {
            title: this.activeMeeting?.title || '',
            meetingUrl: this.activeMeeting?.meetingUrl || '',
            startedAt,
            endedAt,
            durationLabel: duration,
            sourceLanguage:
                document.getElementById('select-source-lang')?.value ||
                settingsManager.get().source_language ||
                '',
            targetLanguage:
                document.getElementById('select-target-lang')?.value ||
                settingsManager.get().target_language ||
                '',
            sessionId: this.currentSessionId || '',
            segmentCount: stats.segments,
            // Full session, not the trimmed display buffer.
            transcript: this.transcriptUI?.getSummaryText?.() || '',
            transcriptWithOriginal: this.transcriptUI?.getFormattedContent?.({}) || '',
        };
    }

    _openMeetingNoteDialog() {
        if (this.isRunning) {
            this._showToast('Stop the recording first, then write the note.', 'info');
            return;
        }
        if (!this.transcriptUI?.hasSegments()) {
            this._showToast('No transcript yet.', 'info');
            return;
        }
        this.meetingNote?.open(this._buildMeetingContext());
    }

    async _refreshHistoryList() {
        const list = document.getElementById('history-list');
        const empty = document.getElementById('history-empty');
        const pag = document.getElementById('history-pagination');
        if (!list || !empty) return;

        const defaultEmptyText =
            empty.dataset.defaultText ||
            'No saved conversations yet. Stop recording or clear to save.';
        if (!empty.dataset.defaultText) empty.dataset.defaultText = defaultEmptyText;

        // Always read current text from the field (fixes debounce / stale state).
        const searchInput = document.getElementById('history-search');
        if (searchInput) {
            this.historySearchQuery = (searchInput.value || '').trim();
        }
        const searchQ = this.historySearchQuery || '';
        const noMatchText = 'No conversations match your search.';

        try {
            // Must match Rust param name `args` — flat { page, pageSize } fails IPC deserialize.
            const args = {
                page: this.historyPage,
                pageSize: this.historyPageSize,
            };
            if (searchQ) {
                args.search = searchQ;
            }
            const raw = await invoke('list_conversation_sessions', { args });
            const items = raw?.items ?? raw;
            const total = raw?.total ?? (Array.isArray(items) ? items.length : 0);
            const page = raw?.page ?? this.historyPage;
            const totalPages = raw?.totalPages ?? raw?.total_pages ?? 0;

            this.historyPage = page;
            this._historyTotalPages = totalPages;

            list.innerHTML = '';

            if (!items || items.length === 0) {
                empty.style.display = 'block';
                empty.textContent = total === 0 && searchQ ? noMatchText : defaultEmptyText;
                if (pag) pag.hidden = true;
                return;
            }
            empty.style.display = 'none';
            empty.textContent = defaultEmptyText;

            if (pag) {
                pag.hidden = false;
                const prev = document.getElementById('history-page-prev');
                const next = document.getElementById('history-page-next');
                const info = document.getElementById('history-page-info');
                if (prev) prev.disabled = page <= 1;
                if (next) next.disabled = totalPages <= 1 || page >= totalPages;
                if (info) {
                    info.textContent =
                        totalPages > 0
                            ? `Page ${page} of ${totalPages} · ${total} total`
                            : `${total} total`;
                }
            }

            for (const s of items) {
                const row = document.createElement('div');
                row.className = 'history-row';

                const main = document.createElement('div');
                main.className = 'history-row-main';

                const titleEl = document.createElement('div');
                titleEl.className = 'history-row-title';
                titleEl.textContent = s.title || s.id;

                const notesRaw = (s.notes ?? '').trim();
                let notesEl = null;
                if (notesRaw) {
                    notesEl = document.createElement('div');
                    notesEl.className = 'history-row-notes';
                    notesEl.textContent = notesRaw;
                }

                const metaEl = document.createElement('div');
                metaEl.className = 'history-row-meta';
                const updatedAt = s.updatedAt ?? s.updated_at;
                metaEl.textContent = new Date(updatedAt).toLocaleString(undefined, {
                    dateStyle: 'medium',
                    timeStyle: 'medium',
                });

                const previewEl = document.createElement('div');
                previewEl.className = 'history-row-preview';
                previewEl.textContent = s.preview || '';

                main.appendChild(titleEl);
                if (notesEl) main.appendChild(notesEl);
                main.appendChild(metaEl);
                main.appendChild(previewEl);

                const actions = document.createElement('div');
                actions.className = 'history-row-actions';

                const btnContinue = document.createElement('button');
                btnContinue.type = 'button';
                btnContinue.className = 'history-btn primary';
                btnContinue.dataset.action = 'continue';
                btnContinue.dataset.id = s.id;
                btnContinue.textContent = 'Continue';

                const btnEdit = document.createElement('button');
                btnEdit.type = 'button';
                btnEdit.className = 'history-btn';
                btnEdit.dataset.action = 'edit-meta';
                btnEdit.dataset.id = s.id;
                btnEdit.textContent = 'Edit';

                const btnFolder = document.createElement('button');
                btnFolder.type = 'button';
                btnFolder.className = 'history-btn';
                btnFolder.dataset.action = 'folder';
                btnFolder.dataset.id = s.id;
                btnFolder.textContent = 'Folder';

                actions.appendChild(btnContinue);
                actions.appendChild(btnEdit);
                actions.appendChild(btnFolder);

                row.appendChild(main);
                row.appendChild(actions);
                list.appendChild(row);
            }

            list.onclick = (e) => {
                const btn = e.target.closest('button[data-action]');
                if (!btn) return;
                const id = btn.dataset.id;
                const action = btn.dataset.action;
                if (!id) return;
                if (action === 'continue') this._continueConversationSession(id);
                if (action === 'edit-meta') this._openSessionMetaModal(id);
                if (action === 'folder') this._openConversationSessionFolder(id);
            };
        } catch (err) {
            console.error('Failed to list conversations:', err);
            list.innerHTML = '';
            empty.style.display = 'block';
            empty.textContent = 'Could not load history.';
            if (pag) pag.hidden = true;
            this._showToast('Failed to load conversation history', 'error');
        }
    }

    async _continueConversationSession(sessionId) {
        if (this.isRunning) {
            this._showToast('Stop recording before loading a conversation.', 'info');
            return;
        }
        try {
            const content = await invoke('read_transcript_session', { sessionId });
            this.transcriptUI.loadFromMarkdown(content);
            this.currentSessionId = sessionId;
            this._updateSummaryButtonState();
            this._showView('overlay');
            this._showToast('Conversation loaded — you can keep translating.', 'success');
        } catch (err) {
            console.error(err);
            this._showToast('Failed to load: ' + err, 'error');
        }
    }

    async _openConversationSessionFolder(sessionId) {
        try {
            await invoke('open_conversation_folder', { sessionId });
        } catch (err) {
            this._showToast('Failed to open folder: ' + err, 'error');
        }
    }

    async _openSessionMetaModal(sessionId) {
        try {
            const meta = await invoke('get_session_meta', { sessionId });
            this._sessionMetaEditId = sessionId;
            this._sessionMetaInitialTitle = meta.title ?? '';
            this._sessionMetaInitialNotes = meta.notes ?? '';
            const titleInput = document.getElementById('session-meta-title');
            const notesInput = document.getElementById('session-meta-notes');
            const modal = document.getElementById('session-meta-modal');
            if (titleInput) titleInput.value = meta.title || '';
            if (notesInput) notesInput.value = meta.notes || '';
            if (modal) modal.style.display = 'flex';
        } catch (err) {
            console.error(err);
            this._showToast('Failed to load session: ' + err, 'error');
        }
    }

    _closeSessionMetaModal() {
        const modal = document.getElementById('session-meta-modal');
        if (modal) modal.style.display = 'none';
        this._sessionMetaEditId = null;
        this._sessionMetaInitialTitle = '';
        this._sessionMetaInitialNotes = '';
    }

    async _saveSessionMeta() {
        const id = this._sessionMetaEditId;
        if (!id) return;
        const titleEl = document.getElementById('session-meta-title');
        const notesEl = document.getElementById('session-meta-notes');
        const titleNow = (titleEl?.value ?? '').trim();
        const notesNow = notesEl?.value ?? '';
        const args = { sessionId: id };
        if (titleNow !== this._sessionMetaInitialTitle) {
            args.title = titleNow;
        }
        if (notesNow !== this._sessionMetaInitialNotes) {
            args.notes = notesNow;
        }
        if (args.title === undefined && args.notes === undefined) {
            this._closeSessionMetaModal();
            return;
        }
        try {
            await invoke('update_session_meta', { args });
            this._closeSessionMetaModal();
            await this._refreshHistoryList();
            this._showToast('Session saved', 'success');
        } catch (err) {
            console.error(err);
            this._showToast('Failed to save: ' + err, 'error');
        }
    }

    async _revertSessionTitleFromTranscript() {
        const id = this._sessionMetaEditId;
        if (!id) return;
        try {
            await invoke('update_session_meta', {
                args: { sessionId: id, revertTitleToAuto: true },
            });
            const meta = await invoke('get_session_meta', { sessionId: id });
            this._sessionMetaInitialTitle = meta.title ?? '';
            const titleInput = document.getElementById('session-meta-title');
            if (titleInput) titleInput.value = meta.title || '';
            await this._refreshHistoryList();
            this._showToast('Title matched to transcript', 'success');
        } catch (err) {
            console.error(err);
            this._showToast('Failed to update title: ' + err, 'error');
        }
    }

    // ─── Status ────────────────────────────────────────────

    _updateStatus(status) {
        const dot = document.getElementById('status-indicator');
        const text = document.getElementById('status-text');

        dot.className = 'status-dot';

        switch (status) {
            case 'connecting':
                dot.classList.add('connecting');
                text.textContent = 'Connecting...';
                break;
            case 'connected':
                dot.classList.add('connected');
                text.textContent = 'Listening';
                break;
            case 'disconnected':
                dot.classList.add('disconnected');
                text.textContent = 'Ready';
                break;
            case 'error':
                dot.classList.add('error');
                text.textContent = 'Error';
                break;
        }
    }

    // ─── Window Position ───────────────────────────────────

    async _saveWindowPosition() {
        try {
            const factor = await this.appWindow.scaleFactor();
            const pos = await this.appWindow.outerPosition();
            const size = await this.appWindow.innerSize();
            // Save logical coordinates (physical / scaleFactor)
            localStorage.setItem('window_state', JSON.stringify({
                x: Math.round(pos.x / factor),
                y: Math.round(pos.y / factor),
                width: Math.round(size.width / factor),
                height: Math.round(size.height / factor),
            }));
        } catch (err) {
            console.error('Failed to save window position:', err);
        }
    }

    async _restoreWindowPosition() {
        try {
            const saved = localStorage.getItem('window_state');
            if (!saved) return;

            const state = JSON.parse(saved);
            const { LogicalPosition, LogicalSize } = window.__TAURI__.window;

            // Validate — don't restore if position seems off-screen
            if (state.x < -100 || state.y < -100 || state.x > 5000 || state.y > 3000) {
                console.warn('Saved window position looks off-screen, skipping restore');
                localStorage.removeItem('window_state');
                return;
            }

            if (state.width && state.height && state.width >= 300 && state.height >= 100) {
                await this.appWindow.setSize(new LogicalSize(state.width, state.height));
            }
            if (state.x !== undefined && state.y !== undefined) {
                await this.appWindow.setPosition(new LogicalPosition(state.x, state.y));
            }
        } catch (err) {
            console.error('Failed to restore window position:', err);
            localStorage.removeItem('window_state');
        }
    }

    // ─── Pin / Unpin (Always on Top) ────────────────────

    async _togglePin() {
        this.isPinned = !this.isPinned;
        await this.appWindow.setAlwaysOnTop(this.isPinned);
        const btn = document.getElementById('btn-pin');
        if (btn) {
            btn.classList.toggle('active', this.isPinned);
            btn.setAttribute('aria-checked', this.isPinned ? 'true' : 'false');
        }
        this._showToast(this.isPinned ? 'Pinned on top' : 'Unpinned — window can go behind other apps', 'success');
    }

    _toggleViewMode() {
        const isDual = this.transcriptUI.viewMode === 'dual';
        const newMode = isDual ? 'single' : 'dual';
        this.transcriptUI.configure({ viewMode: newMode });
        const btn = document.getElementById('btn-view-mode');
        if (btn) btn.classList.toggle('active', newMode === 'dual');
    }

    _adjustFontSize(delta) {
        const current = this.transcriptUI.fontSize || 16;
        const newSize = Math.max(12, Math.min(140, current + delta));
        this.transcriptUI.configure({ fontSize: newSize });

        // Update display
        const display = document.getElementById('font-size-display');
        if (display) display.textContent = newSize;

        // Sync with settings slider
        const slider = document.getElementById('range-font-size');
        if (slider) slider.value = newSize;
        const sliderVal = document.getElementById('font-size-value');
        if (sliderVal) sliderVal.textContent = `${newSize}px`;
    }

    // ─── Toast ─────────────────────────────────────────────

    _showToast(message, type = 'success') {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        document.body.appendChild(toast);

        // Trigger animation
        requestAnimationFrame(() => {
            toast.classList.add('show');
        });

        // Auto-remove (longer for errors)
        const duration = type === 'error' ? 5000 : 3000;
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }
}

// Initialize on DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init();
});
