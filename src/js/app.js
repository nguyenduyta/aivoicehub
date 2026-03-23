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

const { invoke } = window.__TAURI__.core;
const { getCurrentWindow } = window.__TAURI__.window;

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
        this.currentSource = 'system'; // 'system' | 'microphone'
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

        console.log('🌐 AIVoiceHub v0.4.5 initialized');
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
        document.getElementById('btn-close').addEventListener('click', async () => {
            if (this.transcriptUI.hasSegments()) {
                await this._saveTranscriptFile();
            }
            await this._saveWindowPosition();
            await this.stop();
            await this.appWindow.close();
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

        // Source buttons
        document.getElementById('btn-source-system').addEventListener('click', () => {
            this._setSource('system');
        });

        document.getElementById('btn-source-mic').addEventListener('click', () => {
            this._setSource('microphone');
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
                const settingsVisible = document.getElementById('settings-view').classList.contains('active');
                if (settingsVisible) {
                    this._showView('overlay');
                }
            }

            // Cmd/Ctrl + ,: Open settings
            if ((e.metaKey || e.ctrlKey) && e.key === ',') {
                e.preventDefault();
                this._showView('settings');
            }

            // Cmd/Ctrl + 1: Switch to System Audio
            if ((e.metaKey || e.ctrlKey) && e.key === '1') {
                e.preventDefault();
                this._setSource('system');
            }

            // Cmd/Ctrl + 2: Switch to Microphone
            if ((e.metaKey || e.ctrlKey) && e.key === '2') {
                e.preventDefault();
                this._setSource('microphone');
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

        if (view === 'settings') {
            this._populateSettingsForm();
        }
        if (view === 'history') {
            this._refreshHistoryList();
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
    }

    async _saveSettingsFromForm() {
        const settings = {
            soniox_api_key: document.getElementById('input-api-key').value.trim(),
            openai_api_key: document.getElementById('input-openai-key')?.value.trim() || '',
            source_language: document.getElementById('select-source-lang').value,
            target_language: document.getElementById('select-target-lang').value,
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
                fontSize: settings.font_size || 16,
            });
        }

        // Update current source button states
        this.currentSource = settings.audio_source === 'both' ? 'system' : (settings.audio_source || 'system');
        this._updateSourceButtons();

        // TTS is always OFF on app start — user must toggle on each session
        this.ttsEnabled = false;
        this._updateTTSButton();
    }

    // ─── TTS Control ──────────────────────────────────────

    _toggleTTS() {
        const settings = settingsManager.get();
        const provider = settings.tts_provider || 'edge';

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
        const wasRunning = this.isRunning;

        // If currently running, restart with new source
        if (wasRunning) {
            this.stop().then(() => {
                this.currentSource = source;
                this._updateSourceButtons();
                this._showToast(`Switched to ${source === 'system' ? 'System Audio' : 'Microphone'}`, 'success');
                this.start();
            });
        } else {
            this.currentSource = source;
            this._updateSourceButtons();
            this._showToast(`Source: ${source === 'system' ? 'System Audio' : 'Microphone'}`, 'success');
        }
    }

    _updateSourceButtons() {
        document.getElementById('btn-source-system').classList.toggle('active',
            this.currentSource === 'system');
        document.getElementById('btn-source-mic').classList.toggle('active',
            this.currentSource === 'microphone');
    }

    _updateModeUI(mode) {
        const hintSoniox = document.getElementById('hint-mode-soniox');
        const hintLocal = document.getElementById('hint-mode-local');

        if (hintSoniox) hintSoniox.style.display = mode === 'soniox' ? '' : 'none';
        if (hintLocal) hintLocal.style.display = mode === 'local' ? '' : 'none';
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
            targetLanguage: settings.target_language,
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
            await invoke('start_capture', {
                source: this.currentSource,
                channel: channel,
            });
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
            await invoke('start_capture', {
                source: this.currentSource,
                channel: new window.__TAURI__.core.Channel(), // dummy channel for permission check
            });
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
                targetLang: settings.target_language || 'vi',
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

            await invoke('start_capture', {
                source: this.currentSource,
                channel: audioChannel,
            });
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
        this.isRunning = false;
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
        const btn = document.getElementById('btn-summary');
        if (!btn) return;
        const hasText = !!this.transcriptUI?.getPlainText()?.trim();
        btn.disabled = this.isRunning || this.isStarting || this.isSummarizing || !hasText;
        btn.classList.toggle('active', !btn.disabled);
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
        this.currentSessionId = null;
        this._updateSummaryButtonState();
        this._showView('overlay');
        this._showToast('New conversation — previous text saved.', 'success');
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
