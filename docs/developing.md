# Local development

Use **[Yarn](https://yarnpkg.com/)** to install JavaScript dependencies and run Tauri.

## Prerequisites

- **Node.js** 18+ ([nodejs.org](https://nodejs.org/) or `brew install node`)
- **Yarn** — recommended via Corepack (ships with Node 16.10+):

  ```bash
  corepack enable
  corepack prepare yarn@stable --activate
  yarn -v
  ```

- **Rust** (stable): [rustup](https://rustup.rs/)
- **macOS**: **Xcode** from the App Store (needed for `ScreenCaptureKit` / Swift bridge when building). Then:

  ```bash
  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
  ```

- **Windows**: usual Tauri prerequisites (WebView2, MSVC build tools) — see [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

## Commands

From the repository root (e.g. `aivoicehub/` after clone):

| Command        | Description                                      |
|----------------|--------------------------------------------------|
| `yarn install` | Install JS deps (including `@tauri-apps/cli`)   |
| `yarn dev`     | Run app in dev mode (Vite + `tauri dev`)        |
| `yarn build`   | Production build (`tauri build`)                 |
| `yarn tauri …` | Pass through to Tauri CLI, e.g. `yarn tauri info` |

## First run

1. `yarn install`
2. `yarn dev`
3. In **Settings**, add your **Soniox** API key (cloud mode). For **Local MLX** (Apple Silicon only), follow the in-app one-time model setup.

Optional — **Summary (ChatGPT)**: set **OpenAI API key** in Settings or export `OPENAI_API_KEY` before starting the app.

## Session files (`transcripts/sessions/`)

Each conversation folder contains:

| File | Purpose |
|------|---------|
| `transcript.md` | Saved transcript (Markdown). |
| `meta.json` | Local metadata: `title`, optional `notes`, `title_locked` (if the user renamed the session in History — auto title from transcript won’t overwrite it until reverted), timestamps. |

**Context presets** (Settings → Quick preset) map to the same domain strings as in `src/js/app.js` (`CONTEXT_DOMAIN_PRESETS`) and `index.html` (`#select-context-preset`). Add new options in both places for contributors.
