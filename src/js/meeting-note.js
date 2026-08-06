/**
 * Meeting note (MTG) dialog — turns a finished session into a Markdown note on disk.
 *
 * The note is written by `commands/meeting.rs` into the folder configured in
 * Settings → Meeting (typically a notes repo), and the summary comes from
 * `commands/summary.rs::summarize_meeting`.
 *
 * The transcript handed in here comes from `TranscriptUI.fullSegments`, i.e. the whole session —
 * not the trimmed on-screen buffer.
 */

const { invoke } = window.__TAURI__.core;

export class MeetingNoteDialog {
    /**
     * @param {object} opts
     * @param {(msg: string, kind?: string) => void} opts.onToast
     * @param {() => object} opts.getSettings
     * @param {() => void} opts.onOpenSettings
     */
    constructor({ onToast, getSettings, onOpenSettings }) {
        this.onToast = onToast;
        this.getSettings = getSettings;
        this.onOpenSettings = onOpenSettings;

        /** Context of the session currently being written up. */
        this.ctx = null;
        /** Path of the note already written for this context, so Save updates instead of duplicating. */
        this.savedPath = null;
        this.isGenerating = false;
        this.isSaving = false;

        this._bind();
    }

    _bind() {
        document.getElementById('btn-meeting-note-cancel')?.addEventListener('click', () =>
            this.close(),
        );
        document.getElementById('btn-meeting-note-save')?.addEventListener('click', () =>
            this.save(),
        );
        document.getElementById('btn-meeting-note-generate')?.addEventListener('click', () =>
            this.generate(),
        );
        document.getElementById('btn-meeting-note-reveal')?.addEventListener('click', () =>
            this.reveal(),
        );
        document.getElementById('meeting-note-modal')?.addEventListener('click', (e) => {
            if (e.target?.id === 'meeting-note-modal') this.close();
        });
    }

    get isOpen() {
        const m = document.getElementById('meeting-note-modal');
        return !!m && m.style.display !== 'none';
    }

    /**
     * @param {object} ctx  session details — see `_buildArgs` for the fields used
     */
    open(ctx) {
        this.ctx = ctx;
        this.savedPath = null;

        const titleEl = document.getElementById('meeting-note-title');
        const attendeesEl = document.getElementById('meeting-note-attendees');
        const notesEl = document.getElementById('meeting-note-notes');
        const summaryEl = document.getElementById('meeting-note-summary');

        if (titleEl) titleEl.value = ctx.title || '';
        if (attendeesEl) attendeesEl.value = ctx.attendees || '';
        if (notesEl) notesEl.value = '';
        if (summaryEl) summaryEl.value = '';

        this._setPathHint(
            ctx.transcript?.trim()
                ? 'Nothing has been written yet — press “Save note”.'
                : 'This session has no transcript yet.',
        );
        this._setRevealVisible(false);

        const modal = document.getElementById('meeting-note-modal');
        if (modal) modal.style.display = 'flex';
    }

    close() {
        const modal = document.getElementById('meeting-note-modal');
        if (modal) modal.style.display = 'none';
    }

    /** Ask ChatGPT for the structured summary and drop it into the textarea. */
    async generate() {
        if (this.isGenerating || !this.ctx) return;

        const transcript = (this.ctx.transcript || '').trim();
        if (!transcript) {
            this.onToast?.('No transcript to summarize', 'info');
            return;
        }

        const settings = this.getSettings?.() || {};
        if (!settings.openai_api_key) {
            this.onToast?.('Add an OpenAI API key in Settings → Translation', 'error');
            this.onOpenSettings?.();
            return;
        }

        const btn = document.getElementById('btn-meeting-note-generate');
        const summaryEl = document.getElementById('meeting-note-summary');
        this.isGenerating = true;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Generating…';
        }

        try {
            const titleEl = document.getElementById('meeting-note-title');
            const res = await invoke('summarize_meeting', {
                args: {
                    transcript,
                    titleHint: titleEl?.value?.trim() || this.ctx.title || '',
                },
            });
            if (summaryEl) summaryEl.value = res?.summary || '';
            // Only adopt the model's title when the user hasn't supplied one.
            if (titleEl && !titleEl.value.trim() && res?.title) {
                titleEl.value = res.title;
            }
            const chunks = res?.chunks ?? 1;
            this.onToast?.(
                chunks > 1
                    ? `Summary ready (${chunks} passes over a long transcript)`
                    : 'Summary ready',
                'success',
            );
        } catch (err) {
            console.error('[MTG] summarize failed:', err);
            this.onToast?.('Summary failed: ' + err, 'error');
        } finally {
            this.isGenerating = false;
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Generate with ChatGPT';
            }
        }
    }

    _buildArgs({ title, attendees, notes, summary }) {
        const c = this.ctx || {};
        return {
            title: title || c.title || '',
            attendees: attendees || '',
            notes: notes || '',
            summary: summary || '',
            transcript: c.transcript || '',
            transcriptWithOriginal: c.transcriptWithOriginal || '',
            meetingUrl: c.meetingUrl || '',
            startedAt: c.startedAt ?? null,
            endedAt: c.endedAt ?? null,
            durationLabel: c.durationLabel || '',
            sourceLanguage: c.sourceLanguage || '',
            targetLanguage: c.targetLanguage || '',
            sessionId: c.sessionId || '',
            segmentCount: c.segmentCount ?? null,
            // Re-saving updates the same file rather than leaving a trail of near-duplicates.
            overwritePath: this.savedPath || '',
        };
    }

    async save() {
        if (this.isSaving || !this.ctx) return;

        const title = document.getElementById('meeting-note-title')?.value?.trim() || '';
        const attendees = document.getElementById('meeting-note-attendees')?.value?.trim() || '';
        const notes = document.getElementById('meeting-note-notes')?.value || '';
        const summary = document.getElementById('meeting-note-summary')?.value || '';

        if (!this.ctx.transcript?.trim() && !summary.trim() && !notes.trim()) {
            this.onToast?.('Nothing to save yet', 'info');
            return;
        }

        const btn = document.getElementById('btn-meeting-note-save');
        this.isSaving = true;
        if (btn) {
            btn.disabled = true;
            btn.textContent = 'Saving…';
        }

        try {
            const res = await invoke('export_meeting_note', {
                args: this._buildArgs({ title, attendees, notes, summary }),
            });
            this.savedPath = res?.path || null;
            this._setPathHint(`Saved to ${res?.path || '(unknown path)'}`);
            this._setRevealVisible(true);
            this.onToast?.(`Meeting note saved: ${res?.fileName || ''}`, 'success');
        } catch (err) {
            console.error('[MTG] export failed:', err);
            this._setPathHint(String(err));
            this.onToast?.('Could not save the note: ' + err, 'error');
        } finally {
            this.isSaving = false;
            if (btn) {
                btn.disabled = false;
                btn.textContent = 'Save note';
            }
        }
    }

    /**
     * Write the note without showing the dialog (Settings → Meeting → auto-export).
     *
     * Summary generation is best-effort: with no API key or a failing call the note is still
     * written with the transcript, because losing the meeting record is the worse outcome.
     */
    async autoExport(ctx) {
        this.ctx = ctx;
        this.savedPath = null;

        const transcript = (ctx.transcript || '').trim();
        if (!transcript) return null;

        let summary = '';
        const settings = this.getSettings?.() || {};
        if (settings.openai_api_key) {
            try {
                const res = await invoke('summarize_meeting', {
                    args: { transcript, titleHint: ctx.title || '' },
                });
                summary = res?.summary || '';
                if (!ctx.title && res?.title) ctx.title = res.title;
            } catch (err) {
                console.error('[MTG] auto summary failed:', err);
                this.onToast?.('Auto-summary failed — saving note without it', 'error');
            }
        }

        try {
            const res = await invoke('export_meeting_note', {
                args: this._buildArgs({
                    title: ctx.title || '',
                    attendees: '',
                    notes: '',
                    summary,
                }),
            });
            this.savedPath = res?.path || null;
            this.onToast?.(`Meeting note saved: ${res?.fileName || ''}`, 'success');
            return res;
        } catch (err) {
            console.error('[MTG] auto export failed:', err);
            this.onToast?.('Could not write the meeting note: ' + err, 'error');
            return null;
        }
    }

    async reveal() {
        try {
            await invoke('open_mtg_location', { path: this.savedPath || null });
        } catch (err) {
            this.onToast?.('Could not open the folder: ' + err, 'error');
        }
    }

    _setPathHint(text) {
        const el = document.getElementById('meeting-note-path-hint');
        if (el) el.textContent = text;
    }

    _setRevealVisible(visible) {
        const btn = document.getElementById('btn-meeting-note-reveal');
        if (btn) btn.style.display = visible ? '' : 'none';
    }
}
