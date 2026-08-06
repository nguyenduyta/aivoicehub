# Meetings — transcript record, MTG notes, calendar subscription

Three related features:

1. **Full transcript record** — the whole session is kept, not just what fits on screen.
2. **MTG note export** — the meeting written up as one Markdown file in a folder you choose.
3. **Calendar subscription** — your Google Calendar agenda inside the app, with one-click start.

---

## 1. The transcript record

The overlay trims what it displays (`Settings → Display → Max Lines`) so the window stays
readable. That trimming used to also decide what got **saved** — a long meeting was written to disk
as only its last few hundred characters.

There are now two buffers over the same segment objects:

| Buffer | Trimmed? | Used for |
|---|---|---|
| `segments` | yes — `maxLines × 160` chars | what the overlay draws |
| `fullSegments` | never | `transcript.md`, Copy, Summary, MTG note |

A translation that arrives after its original scrolled out of the display buffer still pairs with
the right original, because pairing runs against the record. An original whose translation never
arrives keeps its text in the note (marked `untranslated`) instead of silently swallowing the next
translation.

Regression test:

```bash
node scripts/test-transcript-record.mjs
```

---

## 2. MTG note export

**Where:** `⋯ → Meeting note (MTG)…` after you stop recording.

You get a dialog with the title, attendees, your own notes and the summary. **Generate with
ChatGPT** fills the summary from the full transcript; you can also just type it. **Save note**
writes the file and offers **Reveal file**. Saving again updates the same file rather than
creating a second one.

The note looks like this:

```markdown
---
type: meeting
date: 2026-08-06
title: Weekly Sync — Platform
meeting_url: https://meet.google.com/abc-defg-hij
session_id: 2026-08-06_10-00-00_ab12cd34
generated_by: AIVoiceHub
---

# Cuộc họp — Weekly Sync — Platform

| | |
|---|---|
| Ngày | 2026-08-06 (Thu) |
| Thời gian | 10:00 – 11:02 |
| Thời lượng | 62m 0s |
| Link | https://meet.google.com/abc-defg-hij |
| Ngôn ngữ | ja → vi |
| Số đoạn | 120 |
| File transcript | `transcripts/sessions/2026-08-06_10-00-00_ab12cd34/transcript.md` |

## Tóm tắt
…
## Quyết định
…
## Việc cần làm
…
## Câu hỏi / vấn đề mở
…

---

## Transcript đầy đủ
…
```

### Settings → Meeting

| Setting | Default | Notes |
|---|---|---|
| Export folder | *(empty)* | Absolute path. Empty → `<app data>/meeting-notes`. `~` is expanded. |
| Folder layout | `YYYY / MM` | Or everything in one folder. |
| Filename prefix | `mtg` | → `mtg-2026-08-06-weekly-sync.md` |
| Append full transcript | on | |
| Include original text | off | Adds the pre-translation lines too. |
| Auto-export on stop | off | Writes the note with no dialog when recording stops. |
| Summary language | `vi` | `vi` / `en` / `ja` — changes both the prompt and the note headings. |
| Summary model | `gpt-4o-mini` | Any chat-completions model. |
| Extra summary instructions | *(empty)* | Appended to the prompt, e.g. *"keep Jira ticket ids verbatim"*. |

Filenames are slugged from the title (unicode kept, so Japanese and Vietnamese titles stay
readable) and never overwrite an existing note — a second meeting the same day becomes `-2`.

The export folder is validated: it must be absolute and must not contain `..`.

---

## 3. Calendar subscription

### Setup

1. Google Calendar → **Settings**
2. Under *Settings for my calendars*, pick the calendar
3. Copy **Secret address in iCal format**
4. AIVoiceHub → `⋯ → Settings → Calendar` → **+** → paste → **Test** → **Save & Close**

Treat that URL as a password. It is stored only in this machine's `settings.json` and is fetched
directly by the app — there is no relay server.

An OAuth backend can be added later without migrating settings; that is what `calendar_source`
is for. Today only `"ics"` exists.

### Using it

`⋯ → Meetings` shows the agenda grouped by day. Each row has:

- **Start** — begins a new session, attaches the meeting to it (title + link land in the note),
  and opens the meeting link if that option is on
- **Join** — just opens the link

A meeting in progress is highlighted. Once attached, the meeting shows in a bar above the
transcript, with a **×** to detach it.

### Settings → Calendar

| Setting | Default | Notes |
|---|---|---|
| Subscribed calendars | *(none)* | Label + iCal URL + enabled. Multiple feeds are merged. |
| Days ahead | 7 | Also shows meetings that started up to 12h ago. |
| Auto-refresh | 15m | 0 = only on the reload button. |
| Only events with a link | off | Hides everything without a conference URL. |
| Open link on start | on | |
| Time zone | *(empty)* | IANA name, for all-day and floating-time entries. Empty = this computer. |

### What the parser handles

Fetching and parsing happen in Rust (`src-tauri/src/commands/calendar.rs`) — Google serves these
feeds without CORS headers, so the webview cannot fetch them.

- **Line folding**, quoted parameters containing `:`, escaped TEXT values
- **Three `DTSTART` forms**: `…Z` (UTC), `;TZID=Asia/Tokyo` (via `chrono-tz`), `;VALUE=DATE`
  (all-day). Mixing these up shifts the whole day, so each carries its zone until resolved.
- **`DTEND` / `DURATION`**, defaulting to 1 day for all-day entries
- **Recurrence**: `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`, `INTERVAL`, `COUNT`, `UNTIL`, `BYDAY`
  (including `2TU`, `-1FR`), `BYMONTHDAY` (including negatives), `BYMONTH`, `WKST`
- **`EXDATE`** — cancelled instances disappear
- **`RECURRENCE-ID`** — a moved instance shows at its new time, not the series time
- **`STATUS:CANCELLED`** — hidden
- **Meet links**, in priority order: `X-GOOGLE-CONFERENCE`, a URL in `LOCATION`, then a scan of
  `DESCRIPTION`. Zoom, Teams, Webex and Whereby are recognised too.
- **`VTIMEZONE` / `VALARM`** bodies are skipped rather than read as event data

**Not implemented:** `BYSETPOS`, `BYWEEKNO`, `BYYEARDAY`, `BYHOUR/BYMINUTE/BYSECOND`. An event
using one still appears, flagged *time may differ* in the list and reported as a warning at the
top of the agenda — it is not silently wrong.

### Offline

Every successful fetch is cached in `<app data>/calendar-cache/`. If a refresh fails the agenda
falls back to the cache and the failure is shown per feed (*"showing cached data …"*), because a
stale agenda beats an empty one.

---

## Tests

```bash
cd src-tauri && cargo test --lib      # ICS parsing, recurrence, note rendering, file writing
node scripts/test-transcript-record.mjs
```
