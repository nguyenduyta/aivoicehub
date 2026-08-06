<p align="center">
  <img src="banner.png?v=2" alt="AIVoiceHub — Real-time Speech Translation">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/built_with-Tauri-orange?logo=tauri" alt="Built with Tauri">
  <img src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%7C%20Intel-black?logo=apple" alt="macOS">
  <img src="https://img.shields.io/badge/Windows-10%2F11-blue?logo=windows" alt="Windows">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
</p>

**AIVoiceHub** is a lightweight desktop overlay that **transcribes and translates audio in real time** (system audio or microphone).

Easy to download [here](https://github.com/nguyenduyta/aivoicehub/releases) to install.

Docs: [Install (macOS)](docs/installation_guide.md) · [Install (Windows)](docs/installation_guide_win.md) · [TTS](docs/tts_guide.md) · [Meetings & MTG notes](docs/meetings.md) · [Developing](docs/developing.md)

## Features

- **Live overlay**: lightweight window that can stay on top while you watch/listen.
- **Two views**: Single (overlay) and Dual (source | translation).
- **TTS narration** (optional): Edge (free), Google, ElevenLabs.
- **Local mode** (Apple Silicon): offline pipeline using MLX (experimental).
- **Transcripts saved locally** as Markdown: each session in its own folder under `transcripts/sessions/`; open **Conversation history** (clock icon) to resume, **rename**, add **notes** (`meta.json`), or search (title / notes / preview). The saved file holds the **whole session** — the on-screen trimming (`Max Lines`) no longer limits what is written.
- **Meeting notes (MTG)**: turn a session into one Markdown file — summary (ChatGPT), decisions, action items, open questions, plus the full transcript — written into a folder you choose, e.g. your notes repo. Optionally written automatically when you stop recording. → [docs](docs/meetings.md#2-mtg-note-export)
- **Google Meet calendar**: subscribe to a calendar's **secret iCal address** and see your agenda in the app; **Start** begins a session already attached to that meeting (title + link go into the note). Handles recurring meetings, moved and cancelled instances, and time zones. → [docs](docs/meetings.md#3-calendar-subscription)
- **Context presets** (Settings): quick domain hints for Soniox — meeting, interview, medical, tech, etc. (fully editable before save).

## Quickstart (local dev)

```bash
git clone https://github.com/nguyenduyta/aivoicehub.git
cd aivoicehub
yarn install
yarn dev
```

## Build

```bash
yarn build
```

## Tests

```bash
cd src-tauri && cargo test --lib        # ICS parsing, recurrence, note rendering & writing
node scripts/test-transcript-record.mjs # transcript record is never truncated
```

## Keys & configuration

- **Translation (cloud)**: add your **Soniox API key** in Settings.
- **Summary (ChatGPT)**: add your **OpenAI API key** in Settings (optional) — also used for meeting summaries.
- **Local mode** (Apple Silicon): first run will download models (~5GB).
- **Meeting notes**: Settings → **Meeting** — export folder, folder layout, filename prefix, whether to append the transcript, summary language/model, extra prompt, auto-export on stop.
- **Calendar**: Settings → **Calendar** — one or more iCal feed URLs, days ahead, auto-refresh interval, time zone.

## Privacy

- Audio is captured locally on your machine.
- The app connects directly to the APIs you configure (no relay server).
- Transcripts and meeting notes are saved locally, in folders you choose.
- A calendar's secret iCal URL is stored only in this machine's `settings.json`; feeds are fetched directly from the provider.

## License

MIT
