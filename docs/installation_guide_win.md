# Installation (Windows)

Install and use **AIVoiceHub** on Windows 10/11.

## Requirements

- Windows 10+
- **Soniox API key** (cloud translation)
- WebView2 Runtime (usually preinstalled on Windows 10/11)

## Install

1. Download the latest installer from [**Releases — Windows**](https://github.com/phuc-nt/aivoicehub/releases/latest)
2. Run the `.exe`
3. If SmartScreen blocks it: click **More info** → **Run anyway**

## Setup (in the app)

Open **Settings** and set:

- **Soniox API key**
- **Source / Target languages**
- **Audio source**: System Audio or Microphone
- **OpenAI API key** (optional, used by the Summary button)

## Start translating

- Press **`Ctrl+Enter`** to start/stop
- Toggle TTS with **`Ctrl+T`** (optional)

## Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Enter` | Start / Stop |
| `Ctrl+,` | Open Settings |
| `Esc` | Close Settings |
| `Ctrl+T` | Toggle TTS |

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

See [Developing](developing.md) for prerequisites.

## Troubleshooting

- **No text appears**: check your Soniox key in Settings.
- **No system audio**: ensure audio is playing; some apps use exclusive mode.
- **App won’t start**: install WebView2 Runtime from Microsoft.
