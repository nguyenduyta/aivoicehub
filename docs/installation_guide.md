# Installation (macOS)

Install and use **AIVoiceHub** on macOS.

## Requirements

- macOS 13+
- **Cloud translation**: a **Soniox API key**
- **Local mode (Apple Silicon)**: ~5GB disk for on-device models (one-time download)
- **TTS** (optional): see [TTS Guide](tts_guide.md)

## Install (recommended)

1. Download the latest `.dmg` from [**Releases — macOS**](https://github.com/phuc-nt/aivoicehub/releases/latest)
2. Open the `.dmg` → drag **AIVoiceHub** to **Applications**
3. Launch **AIVoiceHub**

## Permissions (required for system audio)

macOS will ask for **Screen Recording** permission (used to capture system audio):

1. Open **System Settings** when prompted
2. Find **AIVoiceHub** → toggle **ON**
3. Quit & reopen when macOS asks

## Setup (in the app)

Open **Settings** (`⌘ ,`) and configure:

- **Soniox API key** (required for cloud mode)
- **Source / Target languages**
- **Engine**: Cloud (Soniox) or Local MLX (Apple Silicon)
- **OpenAI API key** (optional, used by the Summary button)

## Start translating

- Press **`⌘ Enter`** to start/stop
- Choose **System Audio** or **Microphone**
- Toggle TTS with **`⌘ T`** (optional)

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘ Enter` | Start / Stop |
| `⌘ ,` | Open Settings |
| `Esc` | Close Settings |
| `⌘ 1` | System Audio |
| `⌘ 2` | Microphone |
| `⌘ T` | Toggle TTS |

## Build from source (developers)

```bash
git clone https://github.com/phuc-nt/aivoicehub.git
cd aivoicehub
yarn install
yarn dev
```

Production build:

```bash
yarn build
```

See [Developing](developing.md) for Rust + Xcode prerequisites.

## Troubleshooting

- **No text appears**: confirm Screen Recording permission is enabled for AIVoiceHub.
- **No API key**: paste your Soniox key in Settings.
- **No microphone**: connect an external mic (Mac mini has no built-in mic).
