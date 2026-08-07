/**
 * Transcript UI — continuous paragraph flow display with speaker diarization
 *
 * Design: All text flows as one continuous paragraph.
 * - Translated text: white (primary color)
 * - Original text (pending translation): cyan/accent color
 * - Provisional text (being recognized): dimmed
 * - Speaker labels: shown when speaker changes (e.g. "Speaker 1:")
 *
 * Two buffers, one set of segment objects
 * ---------------------------------------
 * `segments` is the *display* buffer — trimmed to `maxChars` and pruned of stale
 * originals so the overlay stays readable. `fullSegments` is the *record*: strictly
 * append-only, never trimmed. Both hold the **same object references**, so a
 * translation arriving late mutates the segment in place and shows up in both.
 *
 * Everything that persists or summarizes (save, copy, summary, MTG export) must read
 * `fullSegments` — reading `segments` would capture only the tail of a meeting.
 */

/** A pending original stops accepting translations after this long (see `_sealStaleOriginals`). */
const TRANSLATION_BIND_WINDOW_MS = 20000;

export class TranscriptUI {
    constructor(container) {
        this.container = container;
        this.contentEl = null;
        this.maxChars = 1200;
        this.fontSize = 16;
        this.viewMode = 'single'; // 'single' or 'dual'
        this.showOriginal = true;
        // When false, segments never receive a translation, so the original IS the subtitle:
        // render it on its own with no "..." placeholder and no second column.
        this.translationEnabled = true;

        // Display buffer — trimmed. Each entry: { seq, original, translation, status, speaker, createdAt }
        this.segments = [];
        // Full record — append-only, shares object refs with `segments`.
        this.fullSegments = [];
        this._seq = 0;
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.currentSpeaker = null; // Track current speaker to detect changes
    }

    /**
     * Update display settings
     */
    configure({ maxLines, showOriginal, translationEnabled, fontSize, viewMode }) {
        if (maxLines !== undefined) this.maxChars = maxLines * 160;
        if (showOriginal !== undefined) this.showOriginal = !!showOriginal;
        if (translationEnabled !== undefined) this.translationEnabled = !!translationEnabled;
        if (fontSize !== undefined) {
            this.fontSize = fontSize;
            this.container.style.setProperty('--transcript-font-size', `${fontSize}px`);
        }
        if (viewMode !== undefined) {
            this.viewMode = viewMode;
            const overlay = document.getElementById('overlay-view');
            if (overlay) {
                overlay.classList.toggle('dual-view', viewMode === 'dual');
            }
        }
        this._render();
    }

    /**
     * Add finalized original text (pending translation)
     */
    addOriginal(text, speaker) {
        this._removeListening();
        const seg = {
            seq: ++this._seq,
            original: text,
            translation: null,
            status: 'original',
            speaker: speaker || null,
            createdAt: Date.now(),
        };
        this.segments.push(seg);
        this.fullSegments.push(seg);
        if (speaker) this.currentSpeaker = speaker;
        this._cleanupStaleOriginals();
        this._render();
    }

    /**
     * Apply translation to the oldest untranslated segment.
     *
     * Matched against `fullSegments`, not `segments` — the original may already have been
     * trimmed out of the display buffer while its translation was still in flight. Since both
     * arrays share segment objects, mutating here also updates the overlay when still visible.
     */
    addTranslation(text) {
        this._sealStaleOriginals();
        const seg = this.fullSegments.find(s => s.status === 'original');
        if (seg) {
            seg.translation = text;
            seg.status = 'translated';
        } else {
            // Translation with no pending original (e.g. resumed session) — keep it as its own segment.
            const orphan = {
                seq: ++this._seq,
                original: '',
                translation: text,
                status: 'translated',
                speaker: null,
                createdAt: Date.now(),
            };
            this.segments.push(orphan);
            this.fullSegments.push(orphan);
        }
        this._render();
    }

    /**
     * Update provisional (in-progress) text
     */
    setProvisional(text, speaker) {
        this._removeListening();
        this.provisionalText = text;
        this.provisionalSpeaker = speaker || null;
        this._render();
    }

    /**
     * Clear provisional text
     */
    clearProvisional() {
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this._render();
    }

    /**
     * Check if there is any content to display
     */
    hasContent() {
        return this.segments.length > 0 || this.provisionalText ||
            !!this.container.querySelector('.listening-indicator');
    }

    /**
     * Show placeholder state
     */
    showPlaceholder() {
        this.container.innerHTML = `
      <div class="transcript-placeholder">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.4">
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
          <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
          <line x1="12" y1="19" x2="12" y2="23"/>
          <line x1="8" y1="23" x2="16" y2="23"/>
        </svg>
        <p>Press ▶ to start translating</p>
        <p class="shortcut-hint">⌘ Enter</p>
      </div>
    `;
        this.segments = [];
        this.fullSegments = [];
        this._seq = 0;
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.currentSpeaker = null;
        this.contentEl = null;
    }

    /**
     * Show listening state
     */
    showListening() {
        // Remove existing indicators first (prevent duplicates)
        this.container.querySelectorAll('.listening-indicator').forEach(el => el.remove());

        const placeholder = this.container.querySelector('.transcript-placeholder');
        if (placeholder) placeholder.remove();

        this._ensureContent();

        const indicator = document.createElement('div');
        indicator.className = 'listening-indicator';
        indicator.innerHTML = `
            <div class="listening-waves">
                <span></span><span></span><span></span><span></span><span></span>
            </div>
            <p>Listening...</p>
        `;
        this.contentEl.appendChild(indicator);
    }

    /**
     * Show status message in transcript area (e.g. loading model)
     */
    showStatusMessage(message) {
        this._ensureContent();
        let statusEl = this.contentEl.querySelector('.pipeline-status');
        if (!statusEl) {
            statusEl = document.createElement('div');
            statusEl.className = 'pipeline-status';
            statusEl.style.cssText = 'text-align:center; padding:8px; color:rgba(255,255,255,0.5); font-size:13px;';
            this.contentEl.appendChild(statusEl);
        }
        statusEl.textContent = message;
    }

    /**
     * Remove status message
     */
    removeStatusMessage() {
        if (this.contentEl) {
            const statusEl = this.contentEl.querySelector('.pipeline-status');
            if (statusEl) statusEl.remove();
        }
    }

    /**
     * Get the full transcript as plain text for copying — whole session, not just what is on screen.
     */
    getPlainText() {
        let lines = [];
        for (const seg of this.fullSegments) {
            if (seg.original) lines.push(seg.original);
            if (seg.translation) lines.push(seg.translation);
            if (seg.original || seg.translation) lines.push('');
        }
        if (this.provisionalText) lines.push(this.provisionalText);
        return lines.join('\n').trim();
    }

    /**
     * Transcript shaped for the summarizer: speaker-attributed, one turn per line.
     *
     * Uses the translation when present and falls back to the original, so a segment whose
     * translation never arrived still contributes to the meeting summary.
     */
    getSummaryText() {
        const lines = [];
        let lastSpeaker = null;
        for (const seg of this.fullSegments) {
            const text = (seg.translation || seg.original || '').trim();
            if (!text) continue;
            if (seg.speaker && seg.speaker !== lastSpeaker) {
                lines.push('');
                lines.push(`Speaker ${seg.speaker}:`);
                lastSpeaker = seg.speaker;
            }
            lines.push(text);
        }
        return lines.join('\n').trim();
    }

    /** Counts for the MTG note header. */
    getStats() {
        const speakers = new Set();
        let chars = 0;
        let translated = 0;
        for (const seg of this.fullSegments) {
            if (seg.speaker) speakers.add(seg.speaker);
            chars += (seg.translation || seg.original || '').length;
            if (seg.status === 'translated') translated++;
        }
        return {
            segments: this.fullSegments.length,
            translated,
            chars,
            speakers: speakers.size,
        };
    }

    /**
     * Get formatted content for saving to file (markdown with metadata).
     * Reads the full record so the saved file holds the entire session.
     */
    getFormattedContent(metadata = {}) {
        if (this.fullSegments.length === 0) return null;

        const lines = [];

        // Metadata header
        lines.push('---');
        lines.push(`date: ${new Date().toISOString()}`);
        if (metadata.model) lines.push(`model: ${metadata.model}`);
        if (metadata.sourceLang) lines.push(`source_language: ${metadata.sourceLang}`);
        if (metadata.targetLang) lines.push(`target_language: ${metadata.targetLang}`);
        if (metadata.duration) lines.push(`recording_duration: ${metadata.duration}`);
        if (metadata.audioSource) lines.push(`audio_source: ${metadata.audioSource}`);
        if (metadata.meetingTitle) lines.push(`meeting_title: ${metadata.meetingTitle}`);
        if (metadata.meetingUrl) lines.push(`meeting_url: ${metadata.meetingUrl}`);
        lines.push(`segments: ${this.fullSegments.length}`);
        lines.push('---');
        lines.push('');

        // Transcript entries
        for (const seg of this.fullSegments) {
            if (seg.speaker) lines.push(`**Speaker ${seg.speaker}:**`);
            if (seg.original) lines.push(`> ${seg.original}`);
            if (seg.translation) lines.push(seg.translation);
            lines.push('');
        }

        return lines.join('\n').trim();
    }

    /**
     * Check if there are segments to save
     */
    hasSegments() {
        return this.fullSegments.length > 0;
    }

    /**
     * Clear all
     */
    clear() {
        this.container.innerHTML = '';
        this.segments = [];
        this.fullSegments = [];
        this._seq = 0;
        this.provisionalText = '';
        this.provisionalSpeaker = null;
        this.currentSpeaker = null;
        this.contentEl = null;
    }

    /**
     * Restore segments from saved markdown (same format as getFormattedContent).
     */
    loadFromMarkdown(content) {
        if (!content || typeof content !== 'string') return;

        this.clear();

        let body = content;
        const t = content.trimStart();
        if (t.startsWith('---')) {
            const close = t.indexOf('\n---', 3);
            if (close !== -1) {
                body = t.slice(close + 4).replace(/^\s*/, '');
            }
        }

        const lines = body.split('\n');
        let i = 0;
        let speaker = null;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();
            if (!trimmed) {
                i++;
                continue;
            }

            const speakerMatch = trimmed.match(/^\*\*Speaker (\d+):\*\*\s*$/);
            if (speakerMatch) {
                speaker = parseInt(speakerMatch[1], 10);
                i++;
                continue;
            }

            if (trimmed.startsWith('>')) {
                const original = trimmed.replace(/^>\s?/, '').trim();
                i++;
                const transLines = [];
                while (i < lines.length) {
                    const L = lines[i];
                    const T = L.trim();
                    if (!T) break;
                    if (T.startsWith('>')) break;
                    if (/^\*\*Speaker \d+:\*\*/.test(T)) break;
                    transLines.push(L);
                    i++;
                }
                if (i < lines.length && !lines[i].trim()) i++;

                const translation = transLines.join('\n').trim();
                // 'untranslated', not 'original' — a restored line must never capture a translation
                // produced later in the resumed session.
                this._pushRestored({
                    original: original || '',
                    translation: translation || null,
                    status: translation ? 'translated' : 'untranslated',
                    speaker,
                });
                speaker = null;
                continue;
            }

            // Translation-only line (no blockquote), or continuation
            this._pushRestored({
                original: '',
                translation: trimmed,
                status: 'translated',
                speaker,
            });
            speaker = null;
            i++;
        }

        if (this.fullSegments.length === 0) {
            this.showPlaceholder();
            return;
        }

        const last = this.fullSegments[this.fullSegments.length - 1];
        if (last && last.speaker) this.currentSpeaker = last.speaker;

        this._ensureContent();
        this._render();
    }

    /** Append a segment restored from markdown to both the display buffer and the full record. */
    _pushRestored({ original, translation, status, speaker }) {
        const seg = {
            seq: ++this._seq,
            original,
            translation,
            status,
            speaker,
            createdAt: Date.now(),
        };
        this.segments.push(seg);
        this.fullSegments.push(seg);
    }

    // ─── Internal ──────────────────────────────────────────

    _ensureContent() {
        if (!this.contentEl) {
            this.container.innerHTML = '';
            this.contentEl = document.createElement('div');
            this.contentEl.className = 'transcript-flow';
            this.container.appendChild(this.contentEl);
        }
    }

    _removeListening() {
        const indicator = this.container.querySelector('.listening-indicator');
        if (indicator) indicator.remove();
    }

    _render() {
        this._ensureContent();
        this._trimSegments();

        // Dual view is a source/translation split — pointless with translation off.
        if (this.viewMode === 'dual' && this.translationEnabled) {
            this._renderDual();
        } else {
            this._renderSingle();
        }
    }

    _renderSingle() {
        let html = '';
        let lastRenderedSpeaker = null;

        for (const seg of this.segments) {
            if (seg.speaker && seg.speaker !== lastRenderedSpeaker) {
                html += `<span class="speaker-label">Speaker ${seg.speaker}:</span> `;
                lastRenderedSpeaker = seg.speaker;
            }

            // Transcribe-only: the original is the subtitle. No pending placeholder — nothing
            // is coming — and no `parallel` layout, which would leave an empty second column.
            if (!this.translationEnabled) {
                if (seg.original) {
                    html += `<div class="seg-block"><div class="seg-original">${this._esc(seg.original)}</div></div>`;
                }
                continue;
            }

            if (seg.status === 'translated' && seg.translation) {
                const parallel = this.showOriginal ? ' parallel' : '';
                html += `<div class="seg-block${parallel}">`;
                if (this.showOriginal) {
                    html += `<div class="seg-original">${this._esc(seg.original || '')}</div>`;
                }
                html += `<div class="seg-translated">${this._esc(seg.translation)}</div>`;
                html += `</div>`;
            } else if (seg.status === 'original' && seg.original) {
                // When enabled, show original immediately even before translation arrives
                if (this.showOriginal) {
                    html += `<div class="seg-block parallel">`;
                    html += `<div class="seg-original pending">${this._esc(seg.original)}</div>`;
                    html += `<div class="seg-translated pending">...</div>`;
                    html += `</div>`;
                }
            } else if (seg.status === 'untranslated' && seg.original) {
                // Translation never arrived — show the original alone, no pending placeholder.
                html += `<div class="seg-block">`;
                html += `<div class="seg-original">${this._esc(seg.original)}</div>`;
                html += `</div>`;
            }
        }

        if (this.provisionalText) {
            if (this.provisionalSpeaker && this.provisionalSpeaker !== lastRenderedSpeaker) {
                html += `<span class="speaker-label">Speaker ${this.provisionalSpeaker}:</span> `;
            }
            if (!this.translationEnabled) {
                html += `<div class="seg-block"><div class="seg-provisional">${this._esc(this.provisionalText)}</div></div>`;
            } else if (this.showOriginal) {
                html += `<div class="seg-block parallel">`;
                html += `<div class="seg-provisional">${this._esc(this.provisionalText)}</div>`;
                html += `<div class="seg-translated pending">...</div>`;
                html += `</div>`;
            }
        }

        this.contentEl.innerHTML = html;
        this._smartScroll(this.container.parentElement || this.container);
    }

    _renderDual() {
        // Save scroll state before re-render
        const oldSrcPanel = this.contentEl.querySelector('.panel-source');
        const oldTgtPanel = this.contentEl.querySelector('.panel-translation');
        const srcScrollState = oldSrcPanel ? this._getScrollState(oldSrcPanel) : { nearBottom: true, scrollTop: 0 };
        const tgtScrollState = oldTgtPanel ? this._getScrollState(oldTgtPanel) : { nearBottom: true, scrollTop: 0 };

        let srcHtml = '';
        let tgtHtml = '';
        let lastSpeaker = null;

        for (const seg of this.segments) {
            let speakerHtml = '';
            if (seg.speaker && seg.speaker !== lastSpeaker) {
                speakerHtml = `<div class="speaker-label">Speaker ${seg.speaker}:</div>`;
                lastSpeaker = seg.speaker;
            }

            if (seg.status === 'translated' && seg.translation) {
                srcHtml += speakerHtml;
                srcHtml += `<div class="seg-text">${this._esc(seg.original || '')}</div>`;
                tgtHtml += speakerHtml ? '<div class="speaker-label">&nbsp;</div>' : '';
                tgtHtml += `<div class="seg-text">${this._esc(seg.translation)}</div>`;
            } else if (seg.status === 'original' && seg.original) {
                srcHtml += speakerHtml;
                srcHtml += `<div class="seg-text pending">${this._esc(seg.original)}</div>`;
                tgtHtml += speakerHtml ? '<div class="speaker-label">&nbsp;</div>' : '';
                tgtHtml += `<div class="seg-text pending">...</div>`;
            } else if (seg.status === 'untranslated' && seg.original) {
                srcHtml += speakerHtml;
                srcHtml += `<div class="seg-text">${this._esc(seg.original)}</div>`;
                tgtHtml += speakerHtml ? '<div class="speaker-label">&nbsp;</div>' : '';
                tgtHtml += `<div class="seg-text pending">—</div>`;
            }
        }

        if (this.provisionalText) {
            srcHtml += `<div class="seg-text pending">${this._esc(this.provisionalText)}</div>`;
            tgtHtml += `<div class="seg-text pending">...</div>`;
        }

        this.contentEl.innerHTML = `
            <div class="panel-source">${srcHtml}</div>
            <div class="panel-translation">${tgtHtml}</div>
        `;

        // Restore scroll: auto-scroll if was near bottom, otherwise keep position
        const srcPanel = this.contentEl.querySelector('.panel-source');
        const tgtPanel = this.contentEl.querySelector('.panel-translation');
        if (srcPanel) {
            if (srcScrollState.nearBottom) {
                srcPanel.scrollTop = srcPanel.scrollHeight;
            } else {
                srcPanel.scrollTop = srcScrollState.scrollTop;
            }
        }
        if (tgtPanel) {
            if (tgtScrollState.nearBottom) {
                tgtPanel.scrollTop = tgtPanel.scrollHeight;
            } else {
                tgtPanel.scrollTop = tgtScrollState.scrollTop;
            }
        }
    }

    _getScrollState(el) {
        return {
            nearBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < 100,
            scrollTop: el.scrollTop
        };
    }

    _smartScroll(el) {
        const isNearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 100;
        if (isNearBottom) {
            el.scrollTop = el.scrollHeight;
        }
    }

    /** Trim the *display* buffer only — `fullSegments` keeps every segment. */
    _trimSegments() {
        let totalLen = 0;
        for (const seg of this.segments) {
            totalLen += (seg.translation || seg.original || '').length;
        }
        while (totalLen > this.maxChars && this.segments.length > 2) {
            const removed = this.segments.shift();
            totalLen -= (removed.translation || removed.original || '').length;
        }
    }

    /**
     * Close the translation-binding window on originals that have waited too long.
     *
     * Without this, an original that never gets a translation stays first in line forever and
     * swallows the next unrelated translation, shifting every later pairing by one. Marking it
     * 'untranslated' keeps its text in the record while taking it out of the queue.
     */
    _sealStaleOriginals() {
        const now = Date.now();
        for (const seg of this.fullSegments) {
            if (seg.status !== 'original') continue;
            if (now - seg.createdAt > TRANSLATION_BIND_WINDOW_MS) {
                seg.status = 'untranslated';
            }
        }
    }

    /**
     * Remove stale original segments from the *display* buffer so the overlay doesn't fill with
     * pending lines. The segments survive in `fullSegments`, so nothing is lost from the record.
     * - Originals older than 10s are removed
     * - Max 3 pending originals allowed (oldest dropped)
     */
    _cleanupStaleOriginals() {
        // With translation off, `original` is the final state of every segment rather than a
        // pending one — dropping them here would wipe the overlay after 10s and cap it at 3
        // lines. `_trimSegments()` already bounds the display buffer in that mode.
        if (!this.translationEnabled) return;

        const now = Date.now();
        const STALE_MS = 10000; // 10 seconds
        const MAX_PENDING = 3;

        // Remove originals older than STALE_MS
        this.segments = this.segments.filter(seg => {
            if (seg.status === 'original' && (now - seg.createdAt) > STALE_MS) {
                return false; // drop stale
            }
            return true;
        });

        // If still too many pending originals, drop oldest
        let pending = this.segments.filter(s => s.status === 'original');
        while (pending.length > MAX_PENDING) {
            const oldest = pending.shift();
            const idx = this.segments.indexOf(oldest);
            if (idx !== -1) this.segments.splice(idx, 1);
        }
    }

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
}
