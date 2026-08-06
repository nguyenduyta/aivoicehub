//! Meeting note (MTG) export — writes the aggregated meeting record as a Markdown file into a
//! user-configured folder (typically a notes repo such as `~/Documents/Sources/Note`).
//!
//! This deliberately writes **outside** the Tauri app-data dir, so it cannot reuse
//! `transcript.rs`'s `sanitize_session_id` model of "one safe root, opaque ids". The target is an
//! absolute path the user chose, which needs its own validation: absolute, no `..` traversal,
//! existing (or creatable) parent. See `resolve_export_dir` / `validate_export_dir`.

use crate::settings::SettingsState;
use chrono::{DateTime, Datelike, Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMeetingArgs {
    /// Meeting title — from the calendar event when started from the agenda.
    #[serde(default)]
    pub title: Option<String>,
    /// Markdown summary produced by `summarize_meeting`.
    #[serde(default)]
    pub summary: Option<String>,
    /// Full transcript, translation-only, one turn per line.
    #[serde(default)]
    pub transcript: Option<String>,
    /// Full transcript in the saved `transcript.md` shape (`> original` + translation).
    #[serde(default)]
    pub transcript_with_original: Option<String>,
    #[serde(default)]
    pub meeting_url: Option<String>,
    /// Epoch ms.
    #[serde(default)]
    pub started_at: Option<i64>,
    #[serde(default)]
    pub ended_at: Option<i64>,
    #[serde(default)]
    pub duration_label: Option<String>,
    #[serde(default)]
    pub source_language: Option<String>,
    #[serde(default)]
    pub target_language: Option<String>,
    /// Session folder under `transcripts/sessions/`, linked from the note.
    #[serde(default)]
    pub session_id: Option<String>,
    /// Free-text attendees line.
    #[serde(default)]
    pub attendees: Option<String>,
    /// User's own notes, placed above the generated summary.
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub segment_count: Option<u64>,
    /// Overwrite the file at this exact path instead of allocating a new one.
    #[serde(default)]
    pub overwrite_path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportMeetingResult {
    pub path: String,
    pub dir: String,
    pub file_name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MtgDirInfo {
    /// Directory that will actually be used.
    pub dir: String,
    /// True when it came from settings rather than the app-data fallback.
    pub configured: bool,
    pub exists: bool,
    /// Example of the next file name, for the Settings preview.
    pub sample_path: String,
    pub error: String,
}

// ════════════════════════════════════════════════════════════════════════════
// Paths
// ════════════════════════════════════════════════════════════════════════════

/// Reject anything that is not a plain absolute path.
///
/// `..` is refused rather than normalised: a config value containing traversal is far more likely
/// to be a mistake than an intent, and silently resolving it would write somewhere the user did
/// not name.
fn validate_export_dir(dir: &Path) -> Result<(), String> {
    if !dir.is_absolute() {
        return Err(format!(
            "Export folder must be an absolute path (got '{}')",
            dir.display()
        ));
    }
    if dir
        .components()
        .any(|c| matches!(c, Component::ParentDir))
    {
        return Err("Export folder must not contain '..'".to_string());
    }
    Ok(())
}

/// Directory MTG notes go into: the configured path, else `<app_data_dir>/meeting-notes`.
fn resolve_export_dir(app: &AppHandle, configured: &str) -> Result<(PathBuf, bool), String> {
    let trimmed = configured.trim();
    if trimmed.is_empty() {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?
            .join("meeting-notes");
        return Ok((dir, false));
    }

    // Support a leading `~`.
    let expanded = if trimmed == "~" || trimmed.starts_with("~/") {
        let home = dirs::home_dir().ok_or_else(|| "Cannot resolve home directory".to_string())?;
        if trimmed == "~" {
            home
        } else {
            home.join(&trimmed[2..])
        }
    } else {
        PathBuf::from(trimmed)
    };

    validate_export_dir(&expanded)?;
    Ok((expanded, true))
}

/// Add the `YYYY/MM` sub-folders when the layout calls for it.
fn apply_layout(base: &Path, layout: &str, when: DateTime<Local>) -> PathBuf {
    if layout == "flat" {
        return base.to_path_buf();
    }
    base.join(format!("{:04}", when.year()))
        .join(format!("{:02}", when.month()))
}

/// Filename-safe slug. Keeps unicode letters (so Japanese/Vietnamese titles stay readable) and
/// collapses everything else into single hyphens.
fn slugify(title: &str, max_chars: usize) -> String {
    let mut out = String::new();
    let mut last_dash = true; // suppress a leading dash
    for ch in title.trim().chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                out.push(lc);
            }
            last_dash = false;
        } else if !last_dash {
            out.push('-');
            last_dash = true;
        }
        if out.chars().count() >= max_chars {
            break;
        }
    }
    let s = out.trim_matches('-').to_string();
    if s.is_empty() {
        "meeting".to_string()
    } else {
        s
    }
}

/// First free `<prefix>-<date>-<slug>.md`, appending `-2`, `-3`… on collision.
///
/// Two meetings on one day must not overwrite each other, and the second one is usually the one
/// you would notice missing only much later.
fn allocate_path(dir: &Path, prefix: &str, date_part: &str, slug: &str) -> PathBuf {
    let prefix = if prefix.trim().is_empty() {
        "mtg".to_string()
    } else {
        slugify(prefix, 24)
    };
    let base = format!("{}-{}-{}", prefix, date_part, slug);
    let first = dir.join(format!("{}.md", base));
    if !first.exists() {
        return first;
    }
    for n in 2..1000 {
        let candidate = dir.join(format!("{}-{}.md", base, n));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{}-{}.md", base, chrono::Local::now().timestamp()))
}

// ════════════════════════════════════════════════════════════════════════════
// Note rendering
// ════════════════════════════════════════════════════════════════════════════

/// Section headings per output language, matching `mtg_summary_language`.
struct Labels {
    meeting: &'static str,
    date: &'static str,
    time: &'static str,
    duration: &'static str,
    link: &'static str,
    languages: &'static str,
    attendees: &'static str,
    transcript_file: &'static str,
    segments: &'static str,
    my_notes: &'static str,
    summary: &'static str,
    transcript: &'static str,
    no_summary: &'static str,
}

fn labels_for(lang: &str) -> Labels {
    match lang {
        "en" => Labels {
            meeting: "Meeting",
            date: "Date",
            time: "Time",
            duration: "Duration",
            link: "Link",
            languages: "Languages",
            attendees: "Attendees",
            transcript_file: "Transcript file",
            segments: "Segments",
            my_notes: "My notes",
            summary: "Summary",
            transcript: "Full transcript",
            no_summary: "_No summary generated — add an OpenAI API key in Settings to enable it._",
        },
        "ja" => Labels {
            meeting: "会議",
            date: "日付",
            time: "時間",
            duration: "所要時間",
            link: "リンク",
            languages: "言語",
            attendees: "参加者",
            transcript_file: "書き起こしファイル",
            segments: "セグメント数",
            my_notes: "メモ",
            summary: "要約",
            transcript: "全文書き起こし",
            no_summary: "_要約は生成されていません — 設定で OpenAI API キーを追加してください。_",
        },
        _ => Labels {
            meeting: "Cuộc họp",
            date: "Ngày",
            time: "Thời gian",
            duration: "Thời lượng",
            link: "Link",
            languages: "Ngôn ngữ",
            attendees: "Người tham dự",
            transcript_file: "File transcript",
            segments: "Số đoạn",
            my_notes: "Ghi chú của tôi",
            summary: "Tóm tắt",
            transcript: "Transcript đầy đủ",
            no_summary: "_Chưa tạo tóm tắt — thêm OpenAI API key trong Settings để bật._",
        },
    }
}

fn fmt_local(ms: i64) -> Option<DateTime<Local>> {
    Local.timestamp_millis_opt(ms).single()
}

#[allow(clippy::too_many_arguments)]
fn render_note(
    args: &ExportMeetingArgs,
    labels: &Labels,
    title: &str,
    started: DateTime<Local>,
    include_transcript: bool,
    include_original: bool,
) -> String {
    let mut out = String::new();
    let date_str = started.format("%Y-%m-%d").to_string();

    // Front matter — makes the note greppable alongside the rest of the notes repo.
    out.push_str("---\n");
    out.push_str("type: meeting\n");
    out.push_str(&format!("date: {}\n", date_str));
    out.push_str(&format!("title: {}\n", title.replace('\n', " ")));
    if let Some(url) = args.meeting_url.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("meeting_url: {}\n", url.trim()));
    }
    if let Some(sid) = args.session_id.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("session_id: {}\n", sid.trim()));
    }
    out.push_str(&format!("generated_by: AIVoiceHub\n"));
    out.push_str("---\n\n");

    out.push_str(&format!("# {} — {}\n\n", labels.meeting, title));

    // Metadata table
    out.push_str("| | |\n|---|---|\n");
    out.push_str(&format!(
        "| {} | {} ({}) |\n",
        labels.date,
        date_str,
        started.format("%a")
    ));

    let time_cell = match args.ended_at.and_then(fmt_local) {
        Some(end) => format!("{} – {}", started.format("%H:%M"), end.format("%H:%M")),
        None => started.format("%H:%M").to_string(),
    };
    out.push_str(&format!("| {} | {} |\n", labels.time, time_cell));

    if let Some(d) = args.duration_label.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("| {} | {} |\n", labels.duration, d.trim()));
    }
    if let Some(url) = args.meeting_url.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("| {} | {} |\n", labels.link, url.trim()));
    }
    let src = args.source_language.as_deref().unwrap_or("");
    let tgt = args.target_language.as_deref().unwrap_or("");
    if !src.is_empty() || !tgt.is_empty() {
        out.push_str(&format!("| {} | {} → {} |\n", labels.languages, src, tgt));
    }
    if let Some(a) = args.attendees.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("| {} | {} |\n", labels.attendees, a.trim()));
    }
    if let Some(n) = args.segment_count {
        out.push_str(&format!("| {} | {} |\n", labels.segments, n));
    }
    if let Some(sid) = args.session_id.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!(
            "| {} | `transcripts/sessions/{}/transcript.md` |\n",
            labels.transcript_file,
            sid.trim()
        ));
    }
    out.push('\n');

    if let Some(notes) = args.notes.as_deref().filter(|s| !s.trim().is_empty()) {
        out.push_str(&format!("## {}\n\n{}\n\n", labels.my_notes, notes.trim()));
    }

    // The summary already carries its own `## …` headings from the model prompt, so it is
    // inserted as-is rather than nested under another heading.
    match args.summary.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(s) => {
            out.push_str(s);
            out.push_str("\n\n");
        }
        None => {
            out.push_str(&format!("## {}\n\n{}\n\n", labels.summary, labels.no_summary));
        }
    }

    if include_transcript {
        let body = if include_original {
            args.transcript_with_original
                .as_deref()
                .or(args.transcript.as_deref())
        } else {
            args.transcript.as_deref()
        };
        if let Some(t) = body.map(str::trim).filter(|s| !s.is_empty()) {
            out.push_str("---\n\n");
            out.push_str(&format!("## {}\n\n", labels.transcript));
            out.push_str(t);
            out.push('\n');
        }
    }

    out
}

// ════════════════════════════════════════════════════════════════════════════
// Commands
// ════════════════════════════════════════════════════════════════════════════

/// Where the note would be written, for display in Settings.
#[tauri::command]
pub fn get_mtg_dir_info(
    app: AppHandle,
    state: State<'_, SettingsState>,
) -> Result<MtgDirInfo, String> {
    let (configured_raw, layout, prefix) = {
        let s = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (
            s.mtg_export_dir.clone(),
            s.mtg_folder_layout.clone(),
            s.mtg_filename_prefix.clone(),
        )
    };

    match resolve_export_dir(&app, &configured_raw) {
        Ok((dir, configured)) => {
            let now = Local::now();
            let full = apply_layout(&dir, &layout, now);
            let sample = full.join(format!(
                "{}-{}-{}.md",
                if prefix.trim().is_empty() { "mtg" } else { prefix.trim() },
                now.format("%Y-%m-%d"),
                "weekly-sync"
            ));
            Ok(MtgDirInfo {
                dir: dir.to_string_lossy().to_string(),
                configured,
                exists: dir.exists(),
                sample_path: sample.to_string_lossy().to_string(),
                error: String::new(),
            })
        }
        Err(e) => Ok(MtgDirInfo {
            dir: configured_raw,
            configured: true,
            exists: false,
            sample_path: String::new(),
            error: e,
        }),
    }
}

/// Write the meeting note and return its path.
#[tauri::command]
pub fn export_meeting_note(
    app: AppHandle,
    state: State<'_, SettingsState>,
    args: ExportMeetingArgs,
) -> Result<ExportMeetingResult, String> {
    let (configured_raw, layout, prefix, include_transcript, include_original, lang) = {
        let s = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (
            s.mtg_export_dir.clone(),
            s.mtg_folder_layout.clone(),
            s.mtg_filename_prefix.clone(),
            s.mtg_include_transcript,
            s.mtg_include_original,
            s.mtg_summary_language.clone(),
        )
    };

    let labels = labels_for(&lang);
    let started = args
        .started_at
        .and_then(fmt_local)
        .unwrap_or_else(Local::now);

    let title = args
        .title
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Untitled meeting")
        .to_string();

    let content = render_note(
        &args,
        &labels,
        &title,
        started,
        include_transcript,
        include_original,
    );

    // Re-exporting an already-written note updates it in place instead of piling up files.
    if let Some(existing) = args
        .overwrite_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        let path = PathBuf::from(existing);
        validate_export_dir(path.parent().unwrap_or(Path::new("/")))?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create '{}': {}", parent.display(), e))?;
        }
        fs::write(&path, &content)
            .map_err(|e| format!("Failed to write '{}': {}", path.display(), e))?;
        return Ok(ExportMeetingResult {
            file_name: path
                .file_name()
                .map(|f| f.to_string_lossy().to_string())
                .unwrap_or_default(),
            dir: path
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_default(),
            path: path.to_string_lossy().to_string(),
        });
    }

    let (base_dir, _) = resolve_export_dir(&app, &configured_raw)?;
    write_note(&base_dir, &layout, &prefix, &title, started, &content)
}

/// Create the target folder, pick a free filename and write the note.
///
/// Split out from `export_meeting_note` so the whole write path can be exercised in tests
/// without a Tauri `AppHandle`.
fn write_note(
    base_dir: &Path,
    layout: &str,
    prefix: &str,
    title: &str,
    started: DateTime<Local>,
    content: &str,
) -> Result<ExportMeetingResult, String> {
    let dir = apply_layout(base_dir, layout, started);
    fs::create_dir_all(&dir).map_err(|e| {
        format!(
            "Failed to create export folder '{}': {}. Check Settings → Meeting → Export folder.",
            dir.display(),
            e
        )
    })?;

    let path = allocate_path(
        &dir,
        prefix,
        &started.format("%Y-%m-%d").to_string(),
        &slugify(title, 60),
    );

    fs::write(&path, content)
        .map_err(|e| format!("Failed to write '{}': {}", path.display(), e))?;

    Ok(ExportMeetingResult {
        file_name: path
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_default(),
        dir: dir.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
    })
}

/// Reveal the MTG folder (or a specific note) in Finder / Explorer.
#[tauri::command]
pub fn open_mtg_location(
    app: AppHandle,
    state: State<'_, SettingsState>,
    path: Option<String>,
) -> Result<(), String> {
    let target = match path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(p) => {
            let pb = PathBuf::from(p);
            validate_export_dir(pb.parent().unwrap_or(Path::new("/")))?;
            pb
        }
        None => {
            let configured = {
                let s = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
                s.mtg_export_dir.clone()
            };
            let (dir, _) = resolve_export_dir(&app, &configured)?;
            fs::create_dir_all(&dir)
                .map_err(|e| format!("Failed to create '{}': {}", dir.display(), e))?;
            dir
        }
    };

    if !target.exists() {
        return Err(format!("Not found: {}", target.display()));
    }

    #[cfg(target_os = "macos")]
    let (cmd, args): (&str, Vec<String>) = if target.is_dir() {
        ("open", vec![target.to_string_lossy().to_string()])
    } else {
        ("open", vec!["-R".into(), target.to_string_lossy().to_string()])
    };
    #[cfg(target_os = "windows")]
    let (cmd, args): (&str, Vec<String>) = if target.is_dir() {
        ("explorer", vec![target.to_string_lossy().to_string()])
    } else {
        (
            "explorer",
            vec![format!("/select,{}", target.to_string_lossy())],
        )
    };
    #[cfg(target_os = "linux")]
    let (cmd, args): (&str, Vec<String>) = (
        "xdg-open",
        vec![if target.is_dir() {
            target.to_string_lossy().to_string()
        } else {
            target
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or_else(|| target.to_string_lossy().to_string())
        }],
    );

    std::process::Command::new(cmd)
        .args(&args)
        .spawn()
        .map_err(|e| format!("Failed to open location: {}", e))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slug_keeps_unicode_and_collapses_punctuation() {
        assert_eq!(slugify("Weekly Sync — Platform / API", 60), "weekly-sync-platform-api");
        assert_eq!(slugify("週次ミーティング", 60), "週次ミーティング");
        assert_eq!(slugify("   ", 60), "meeting");
        assert_eq!(slugify("Họp tuần: WD-123", 60), "họp-tuần-wd-123");
    }

    #[test]
    fn slug_respects_max_length() {
        let s = slugify(&"a".repeat(200), 20);
        assert!(s.chars().count() <= 20, "got {} chars", s.chars().count());
    }

    #[test]
    fn rejects_relative_and_traversal_dirs() {
        assert!(validate_export_dir(Path::new("relative/notes")).is_err());
        assert!(validate_export_dir(Path::new("/Users/x/../../etc")).is_err());
        assert!(validate_export_dir(Path::new("/Users/x/Note")).is_ok());
    }

    #[test]
    fn layout_adds_year_month_only_when_requested() {
        let when = Local
            .with_ymd_and_hms(2026, 8, 6, 10, 0, 0)
            .single()
            .expect("valid local time");
        let base = Path::new("/tmp/Note");
        assert_eq!(
            apply_layout(base, "year_month", when),
            PathBuf::from("/tmp/Note/2026/08")
        );
        assert_eq!(apply_layout(base, "flat", when), PathBuf::from("/tmp/Note"));
    }

    #[test]
    fn allocate_path_does_not_overwrite_a_same_day_meeting() {
        let dir = std::env::temp_dir().join(format!(
            "aivoicehub-mtg-test-{}",
            std::process::id()
        ));
        fs::create_dir_all(&dir).unwrap();
        let first = allocate_path(&dir, "mtg", "2026-08-06", "sync");
        fs::write(&first, "x").unwrap();
        let second = allocate_path(&dir, "mtg", "2026-08-06", "sync");
        assert_ne!(first, second);
        assert!(second.to_string_lossy().ends_with("mtg-2026-08-06-sync-2.md"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn note_includes_summary_and_transcript_sections() {
        let args = ExportMeetingArgs {
            title: Some("Weekly Sync".into()),
            summary: Some("## Tóm tắt\n- điểm 1".into()),
            transcript: Some("Xin chào\nCảm ơn".into()),
            transcript_with_original: None,
            meeting_url: Some("https://meet.google.com/abc-defg-hij".into()),
            started_at: None,
            ended_at: None,
            duration_label: Some("62m 0s".into()),
            source_language: Some("ja".into()),
            target_language: Some("vi".into()),
            session_id: Some("2026-08-06_10-00-00_abcd1234".into()),
            attendees: None,
            notes: Some("cần follow-up với CS".into()),
            segment_count: Some(120),
            overwrite_path: None,
        };
        let out = render_note(
            &args,
            &labels_for("vi"),
            "Weekly Sync",
            Local::now(),
            true,
            false,
        );
        assert!(out.starts_with("---\ntype: meeting\n"));
        assert!(out.contains("# Cuộc họp — Weekly Sync"));
        assert!(out.contains("## Tóm tắt"));
        assert!(out.contains("## Ghi chú của tôi"));
        assert!(out.contains("## Transcript đầy đủ"));
        assert!(out.contains("Xin chào"));
        assert!(out.contains("meet.google.com/abc-defg-hij"));
    }

    /// Full write path against a Note-shaped folder: `<base>/YYYY/MM/mtg-<date>-<slug>.md`.
    #[test]
    fn writes_the_note_into_the_year_month_folder() {
        let base = std::env::temp_dir().join(format!(
            "aivoicehub-note-test-{}-{}",
            std::process::id(),
            "write"
        ));
        let _ = fs::remove_dir_all(&base);

        let started = Local
            .with_ymd_and_hms(2026, 8, 6, 10, 0, 0)
            .single()
            .expect("valid local time");
        let args = ExportMeetingArgs {
            title: Some("Weekly Sync — Platform".into()),
            summary: Some("## Tóm tắt\n- chốt ngày release".into()),
            transcript: Some("Xin chào mọi người\nChúng ta bắt đầu".into()),
            transcript_with_original: None,
            meeting_url: Some("https://meet.google.com/abc-defg-hij".into()),
            started_at: None,
            ended_at: None,
            duration_label: Some("62m 0s".into()),
            source_language: Some("ja".into()),
            target_language: Some("vi".into()),
            session_id: None,
            attendees: None,
            notes: None,
            segment_count: Some(120),
            overwrite_path: None,
        };
        let content = render_note(&args, &labels_for("vi"), "Weekly Sync — Platform", started, true, false);

        let res = write_note(&base, "year_month", "mtg", "Weekly Sync — Platform", started, &content)
            .expect("write failed");

        let expected = base
            .join("2026")
            .join("08")
            .join("mtg-2026-08-06-weekly-sync-platform.md");
        assert_eq!(PathBuf::from(&res.path), expected, "unexpected path");
        assert!(expected.exists(), "file was not created");

        let on_disk = fs::read_to_string(&expected).unwrap();
        assert!(on_disk.contains("# Cuộc họp — Weekly Sync — Platform"));
        assert!(on_disk.contains("chốt ngày release"));
        assert!(on_disk.contains("Xin chào mọi người"));

        // A second meeting the same day must not clobber the first.
        let res2 = write_note(&base, "year_month", "mtg", "Weekly Sync — Platform", started, &content)
            .expect("second write failed");
        assert!(res2.path.ends_with("mtg-2026-08-06-weekly-sync-platform-2.md"));
        assert!(expected.exists(), "first note was overwritten");

        let _ = fs::remove_dir_all(&base);
    }

    #[test]
    fn note_omits_transcript_when_disabled() {
        let args = ExportMeetingArgs {
            title: None,
            summary: None,
            transcript: Some("secret talk".into()),
            transcript_with_original: None,
            meeting_url: None,
            started_at: None,
            ended_at: None,
            duration_label: None,
            source_language: None,
            target_language: None,
            session_id: None,
            attendees: None,
            notes: None,
            segment_count: None,
            overwrite_path: None,
        };
        let out = render_note(&args, &labels_for("en"), "Untitled", Local::now(), false, false);
        assert!(!out.contains("secret talk"));
        assert!(out.contains("No summary generated"));
    }
}
