use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// Translation term: source → target mapping for Soniox
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranslationTerm {
    pub source: String,
    pub target: String,
}

/// Custom context for Soniox — provides domain-specific hints
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CustomContext {
    pub domain: Option<String>,
    pub translation_terms: Vec<TranslationTerm>,
}

/// One subscribed calendar feed (Google Calendar "secret address in iCal format").
#[derive(Debug, Serialize, Deserialize, Clone, Default)]
#[serde(default)]
pub struct CalendarFeed {
    /// Display label shown in the calendar list.
    pub label: String,
    /// `https://calendar.google.com/calendar/ical/<id>/private-<key>/basic.ics`
    pub url: String,
    /// Unchecked feeds stay configured but are skipped when refreshing.
    pub enabled: bool,
}

/// App settings — persisted to JSON
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(default)]
pub struct Settings {
    /// Soniox API key
    pub soniox_api_key: String,
    /// OpenAI API key (for ChatGPT summary)
    pub openai_api_key: String,
    /// Source language: "auto" or ISO 639-1 code
    pub source_language: String,
    /// Target language: ISO 639-1 code
    pub target_language: String,
    /// Audio source: "system" | "microphone" | "both"
    pub audio_source: String,
    /// Overlay opacity: 0.0 - 1.0
    pub overlay_opacity: f64,
    /// Font size in px
    pub font_size: u32,
    /// Max transcript lines to display
    pub max_lines: u32,
    /// Whether to show original text alongside translation
    pub show_original: bool,
    /// Translation mode: "soniox" (cloud API) or "local" (MLX models)
    pub translation_mode: String,
    /// Optional custom context for better transcription
    pub custom_context: Option<CustomContext>,
    /// ElevenLabs API key for TTS narration
    pub elevenlabs_api_key: String,
    /// Whether TTS narration is enabled
    pub tts_enabled: bool,
    /// TTS provider: "edge" | "elevenlabs" | "google"
    pub tts_provider: String,
    /// ElevenLabs voice ID
    pub tts_voice_id: String,
    /// TTS speed multiplier (Web Speech)
    pub tts_speed: f64,
    /// Edge TTS voice name
    pub edge_tts_voice: String,
    /// Edge TTS speed percentage
    pub edge_tts_speed: i32,
    /// Auto-read new translations aloud
    pub tts_auto_read: bool,
    /// Google Cloud TTS API key
    pub google_tts_api_key: String,
    /// Google TTS voice name
    pub google_tts_voice: String,
    /// Google TTS speaking rate
    pub google_tts_speed: f64,

    // ─── Meeting notes (MTG) ────────────────────────────────────────────────
    /// Absolute directory the MTG note is written to. Empty = `<app_data_dir>/meeting-notes`.
    pub mtg_export_dir: String,
    /// Folder layout inside the export dir: "year_month" (`YYYY/MM/`) or "flat".
    pub mtg_folder_layout: String,
    /// Filename prefix, e.g. `mtg` → `mtg-2026-08-06-weekly-sync.md`.
    pub mtg_filename_prefix: String,
    /// Append the full transcript below the summary.
    pub mtg_include_transcript: bool,
    /// Include the original (pre-translation) text in the transcript section.
    pub mtg_include_original: bool,
    /// Write the MTG note automatically when recording stops.
    pub mtg_auto_export: bool,
    /// Output language for the summary: "vi" | "en" | "ja".
    pub mtg_summary_language: String,
    /// Extra instructions appended to the summary system prompt (e.g. "focus on release risks").
    pub mtg_summary_prompt: String,
    /// OpenAI model used for the meeting summary.
    pub mtg_summary_model: String,

    // ─── Calendar / Google Meet ─────────────────────────────────────────────
    /// Feed mechanism. Only "ics" is implemented; the field exists so an OAuth
    /// source can be added later without migrating stored settings.
    pub calendar_source: String,
    /// Subscribed iCal feeds.
    pub calendar_feeds: Vec<CalendarFeed>,
    /// How many days ahead the agenda covers (1 = today only).
    pub calendar_days_ahead: u32,
    /// Re-fetch feeds automatically after this many minutes. 0 = manual only.
    pub calendar_refresh_minutes: u32,
    /// Hide events with no video-conference link.
    pub calendar_only_with_meet: bool,
    /// IANA name used for floating/DATE values and display. Empty = system local zone.
    pub calendar_timezone: String,
    /// Starting a meeting from the agenda also opens its Meet/Zoom link in the browser.
    pub calendar_open_link_on_start: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            soniox_api_key: String::new(),
            openai_api_key: String::new(),
            source_language: "auto".to_string(),
            target_language: "vi".to_string(),
            audio_source: "system".to_string(),
            overlay_opacity: 0.85,
            font_size: 16,
            max_lines: 5,
            show_original: true,
            translation_mode: "soniox".to_string(),
            custom_context: None,
            elevenlabs_api_key: String::new(),
            tts_enabled: false,
            tts_provider: "edge".to_string(),
            tts_voice_id: "21m00Tcm4TlvDq8ikWAM".to_string(),
            tts_speed: 1.2,
            edge_tts_voice: "vi-VN-HoaiMyNeural".to_string(),
            edge_tts_speed: 50,
            tts_auto_read: true,
            google_tts_api_key: String::new(),
            google_tts_voice: "vi-VN-Chirp3-HD-Aoede".to_string(),
            google_tts_speed: 1.0,

            mtg_export_dir: String::new(),
            mtg_folder_layout: "year_month".to_string(),
            mtg_filename_prefix: "mtg".to_string(),
            mtg_include_transcript: true,
            mtg_include_original: false,
            mtg_auto_export: false,
            mtg_summary_language: "vi".to_string(),
            mtg_summary_prompt: String::new(),
            mtg_summary_model: "gpt-4o-mini".to_string(),

            calendar_source: "ics".to_string(),
            calendar_feeds: Vec::new(),
            calendar_days_ahead: 7,
            calendar_refresh_minutes: 15,
            calendar_only_with_meet: false,
            calendar_timezone: String::new(),
            calendar_open_link_on_start: true,
        }
    }
}

/// Get the settings file path
/// ~/Library/Application Support/com.aivoicehub.app/settings.json
fn settings_path() -> PathBuf {
    let mut path = dirs::config_dir().unwrap_or_else(|| PathBuf::from("."));
    path.push("com.aivoicehub.app");
    path.push("settings.json");
    path
}

impl Settings {
    /// Load settings from disk, or return defaults
    pub fn load() -> Self {
        let path = settings_path();
        if path.exists() {
            match fs::read_to_string(&path) {
                Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
                Err(_) => Self::default(),
            }
        } else {
            Self::default()
        }
    }

    /// Save settings to disk
    pub fn save(&self) -> Result<(), String> {
        let path = settings_path();

        // Ensure parent directory exists
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("Failed to create config dir: {}", e))?;
        }

        let json =
            serde_json::to_string_pretty(self).map_err(|e| format!("Failed to serialize: {}", e))?;

        fs::write(&path, json).map_err(|e| format!("Failed to write settings: {}", e))?;

        Ok(())
    }
}

/// Thread-safe settings state managed by Tauri
pub struct SettingsState(pub Mutex<Settings>);
