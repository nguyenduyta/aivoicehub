/**
 * Calendar panel — renders the subscribed-calendar agenda and lets you start a session for a
 * specific meeting.
 *
 * Fetching, ICS parsing and recurrence expansion all happen in Rust (`commands/calendar.rs`);
 * this module only formats what comes back. Google serves iCal feeds without CORS headers, so
 * fetching here in the webview would fail.
 */

const { invoke } = window.__TAURI__.core;

/** A meeting counts as "startable now" from this long before its start time. */
const UPCOMING_LEAD_MS = 10 * 60 * 1000;

export class CalendarPanel {
    /**
     * @param {object} opts
     * @param {(event: object) => void} opts.onStart   — user pressed Start on a meeting
     * @param {(msg: string, kind?: string) => void} opts.onToast
     * @param {() => void} opts.onOpenSettings
     */
    constructor({ onStart, onToast, onOpenSettings }) {
        this.onStart = onStart;
        this.onToast = onToast;
        this.onOpenSettings = onOpenSettings;

        this.listEl = document.getElementById('calendar-list');
        this.emptyEl = document.getElementById('calendar-empty');
        this.statusEl = document.getElementById('calendar-status');

        this.events = [];
        this.feeds = [];
        this.warnings = [];
        this.isLoading = false;
        this.lastLoadedAt = 0;
        this._refreshTimer = null;
        this._clockTimer = null;

        this._bind();
    }

    _bind() {
        document.getElementById('btn-calendar-refresh')?.addEventListener('click', () => {
            this.refresh({ force: true });
        });

        this.listEl?.addEventListener('click', (e) => {
            const btn = e.target.closest('button[data-action]');
            if (!btn) return;
            const idx = parseInt(btn.dataset.idx, 10);
            const ev = this.events[idx];
            if (!ev) return;
            if (btn.dataset.action === 'start') this.onStart?.(ev);
            if (btn.dataset.action === 'join') this._openLink(ev.meetingUrl);
        });
    }

    async _openLink(url) {
        if (!url) return;
        try {
            await window.__TAURI__.opener.openUrl(url);
        } catch (err) {
            this.onToast?.('Could not open the link: ' + err, 'error');
        }
    }

    /** Called when the Meetings view becomes visible. */
    async onShow(refreshMinutes) {
        // Re-render every 30s so the "now" highlight and relative labels stay honest.
        clearInterval(this._clockTimer);
        this._clockTimer = setInterval(() => this.render(), 30_000);

        clearInterval(this._refreshTimer);
        const mins = Number(refreshMinutes) || 0;
        if (mins > 0) {
            this._refreshTimer = setInterval(() => this.refresh({ force: false }), mins * 60_000);
        }

        // Reuse what we already have; the Rust side decides whether its cache is still fresh.
        await this.refresh({ force: false });
    }

    onHide() {
        clearInterval(this._clockTimer);
        clearInterval(this._refreshTimer);
        this._clockTimer = null;
        this._refreshTimer = null;
    }

    async refresh({ force }) {
        if (this.isLoading) return;
        this.isLoading = true;
        this._renderLoading();

        try {
            const res = await invoke('get_calendar_events', { args: { refresh: !!force } });
            this.events = res?.events ?? [];
            this.feeds = res?.feeds ?? [];
            this.warnings = res?.warnings ?? [];
            this.lastLoadedAt = Date.now();
        } catch (err) {
            console.error('[Calendar] load failed:', err);
            this.events = [];
            this.feeds = [];
            this.warnings = [String(err)];
            this.onToast?.('Could not load calendars: ' + err, 'error');
        } finally {
            this.isLoading = false;
            this.render();
        }
    }

    _renderLoading() {
        if (!this.listEl) return;
        if (this.events.length === 0) {
            this.listEl.innerHTML = '';
            if (this.emptyEl) {
                this.emptyEl.style.display = 'block';
                this.emptyEl.textContent = 'Loading meetings…';
            }
        }
    }

    /** The meeting to offer first: happening now, else the next one that hasn't ended. */
    getCurrentOrNext() {
        const now = Date.now();
        return (
            this.events.find((e) => e.start <= now && e.end >= now) ||
            this.events.find((e) => e.start >= now - UPCOMING_LEAD_MS) ||
            null
        );
    }

    render() {
        if (!this.listEl) return;
        this._renderStatus();

        const now = Date.now();
        this.listEl.innerHTML = '';

        if (this.events.length === 0) {
            if (this.emptyEl) {
                this.emptyEl.style.display = 'block';
                this.emptyEl.textContent = this.feeds.length
                    ? 'No meetings in this window.'
                    : 'No calendar subscribed yet — add one in Settings → Calendar.';
            }
            return;
        }
        if (this.emptyEl) this.emptyEl.style.display = 'none';

        let lastDayKey = null;
        this.events.forEach((ev, idx) => {
            const start = new Date(ev.start);
            const dayKey = start.toDateString();
            if (dayKey !== lastDayKey) {
                lastDayKey = dayKey;
                const header = document.createElement('div');
                header.className = 'calendar-day-header';
                header.textContent = this._dayLabel(start);
                this.listEl.appendChild(header);
            }
            this.listEl.appendChild(this._renderRow(ev, idx, now));
        });
    }

    _renderRow(ev, idx, now) {
        const row = document.createElement('div');
        const isNow = ev.start <= now && ev.end >= now;
        const isPast = ev.end < now;
        row.className =
            'calendar-row' + (isNow ? ' is-now' : '') + (isPast ? ' is-past' : '');

        // Time column
        const time = document.createElement('div');
        time.className = 'calendar-time';
        if (ev.allDay) {
            time.textContent = 'All day';
        } else {
            time.textContent = this._hhmm(ev.start);
            const end = document.createElement('span');
            end.className = 'calendar-time-end';
            end.textContent = this._hhmm(ev.end);
            time.appendChild(end);
        }

        // Main column
        const main = document.createElement('div');
        main.className = 'calendar-row-main';

        const title = document.createElement('div');
        title.className = 'calendar-row-title';
        title.textContent = ev.title;
        main.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'calendar-row-meta';

        if (isNow) meta.appendChild(this._badge('now', 'badge-now'));
        if (ev.meetingKind) {
            const label = { meet: 'Google Meet', zoom: 'Zoom', teams: 'Teams', webex: 'Webex' }[
                ev.meetingKind
            ] || 'Link';
            meta.appendChild(this._badge(label, 'kind-' + ev.meetingKind));
        }
        if (ev.calendar) meta.appendChild(this._badge(ev.calendar));
        if (ev.recurring) meta.appendChild(this._badge('repeats'));
        if (ev.approximate) {
            meta.appendChild(this._badge('time may differ', 'badge-now'));
        }
        if (ev.attendeeCount > 0) {
            const people = document.createElement('span');
            people.textContent = `${ev.attendeeCount} invited`;
            meta.appendChild(people);
        }
        if (!isNow && !isPast) {
            const rel = document.createElement('span');
            rel.textContent = this._relative(ev.start - now);
            meta.appendChild(rel);
        }
        main.appendChild(meta);

        // Actions
        const actions = document.createElement('div');
        actions.className = 'calendar-row-actions';

        const btnStart = document.createElement('button');
        btnStart.type = 'button';
        btnStart.className = 'history-btn primary';
        btnStart.dataset.action = 'start';
        btnStart.dataset.idx = String(idx);
        btnStart.textContent = 'Start';
        btnStart.title = 'Start translating and attach this meeting to the note';
        actions.appendChild(btnStart);

        if (ev.meetingUrl) {
            const btnJoin = document.createElement('button');
            btnJoin.type = 'button';
            btnJoin.className = 'history-btn';
            btnJoin.dataset.action = 'join';
            btnJoin.dataset.idx = String(idx);
            btnJoin.textContent = 'Join';
            actions.appendChild(btnJoin);
        }

        row.appendChild(time);
        row.appendChild(main);
        row.appendChild(actions);
        return row;
    }

    _badge(text, extraClass = '') {
        const el = document.createElement('span');
        el.className = 'calendar-badge' + (extraClass ? ' ' + extraClass : '');
        el.textContent = text;
        return el;
    }

    _renderStatus() {
        if (!this.statusEl) return;
        const bits = [];

        for (const f of this.feeds) {
            if (!f.ok) {
                bits.push(
                    `<span class="calendar-status-error">✕ ${this._esc(f.label)}: ${this._esc(
                        f.error || 'failed',
                    )}</span>`,
                );
                continue;
            }
            // A feed can succeed from cache *and* carry the error that forced the fallback.
            if (f.error) {
                bits.push(
                    `<span class="calendar-status-warn">⚠ ${this._esc(
                        f.label,
                    )}: showing cached data (${this._esc(f.error)})</span>`,
                );
            } else if (f.fromCache) {
                bits.push(
                    `${this._esc(f.label)}: ${f.eventCount} · cached ${this._ago(f.fetchedAt)}`,
                );
            } else {
                bits.push(`${this._esc(f.label)}: ${f.eventCount} · updated just now`);
            }
        }

        for (const w of this.warnings) {
            bits.push(`<span class="calendar-status-warn">⚠ ${this._esc(w)}</span>`);
        }

        if (bits.length === 0) {
            this.statusEl.hidden = true;
            this.statusEl.innerHTML = '';
            return;
        }
        this.statusEl.hidden = false;
        this.statusEl.innerHTML = bits.join('<br>');
    }

    // ─── formatting ─────────────────────────────────────────

    _hhmm(ms) {
        return new Date(ms).toLocaleTimeString(undefined, {
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    _dayLabel(date) {
        const today = new Date();
        const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const diffDays = Math.round((startOfDay(date) - startOfDay(today)) / 86_400_000);
        const pretty = date.toLocaleDateString(undefined, {
            weekday: 'short',
            day: 'numeric',
            month: 'short',
        });
        if (diffDays === 0) return `Today · ${pretty}`;
        if (diffDays === 1) return `Tomorrow · ${pretty}`;
        if (diffDays === -1) return `Yesterday · ${pretty}`;
        return pretty;
    }

    _relative(ms) {
        const mins = Math.round(ms / 60000);
        if (mins < 1) return 'starting now';
        if (mins < 60) return `in ${mins}m`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `in ${hours}h ${mins % 60}m`;
        return `in ${Math.floor(hours / 24)}d`;
    }

    _ago(ms) {
        if (!ms) return 'unknown';
        const mins = Math.round((Date.now() - ms) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.floor(hours / 24)}d ago`;
    }

    _esc(text) {
        const div = document.createElement('div');
        div.textContent = text ?? '';
        return div.innerHTML;
    }
}
