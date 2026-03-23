use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

/// Root: app_data_dir/transcripts/
fn transcripts_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?
        .join("transcripts");

    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create transcript dir: {}", e))?;
    Ok(dir)
}

/// Per-conversation folders: transcripts/sessions/<session_id>/
fn sessions_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = transcripts_root(app)?.join("sessions");
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create sessions dir: {}", e))?;
    Ok(dir)
}

fn sanitize_session_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 256 {
        return Err("Invalid session id".to_string());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Invalid session id characters".to_string());
    }
    Ok(())
}

fn strip_frontmatter(content: &str) -> &str {
    let t = content.trim_start();
    if !t.starts_with("---") {
        return content;
    }
    let rest = t.strip_prefix("---").unwrap_or(t);
    let rest = rest.trim_start_matches(|c| c == '\n' || c == '\r');
    if let Some(end) = rest.find("\n---") {
        let body = &rest[end + 4..];
        body.trim_start_matches(|c| c == '\n' || c == '\r')
    } else {
        content
    }
}

/// Parsed segment: (original from blockquote, translation lines)
fn parse_markdown_segments(body: &str) -> Vec<(String, String)> {
    let lines: Vec<&str> = body.lines().collect();
    let mut i = 0;
    let mut out = Vec::new();

    while i < lines.len() {
        let trimmed = lines[i].trim();
        if trimmed.is_empty() {
            i += 1;
            continue;
        }
        if trimmed.starts_with("**Speaker") {
            i += 1;
            continue;
        }
        if trimmed.starts_with('>') {
            let original = trimmed
                .strip_prefix('>')
                .map(str::trim)
                .unwrap_or("")
                .to_string();
            i += 1;
            let mut trans_lines: Vec<&str> = Vec::new();
            while i < lines.len() {
                let l = lines[i];
                let t = l.trim();
                if t.is_empty() {
                    break;
                }
                if t.starts_with('>') {
                    break;
                }
                if t.starts_with("**Speaker") {
                    break;
                }
                trans_lines.push(l.trim());
                i += 1;
            }
            if i < lines.len() && lines[i].trim().is_empty() {
                i += 1;
            }
            let translation = trans_lines.join("\n").trim().to_string();
            out.push((original, translation));
            continue;
        }
        out.push((String::new(), trimmed.to_string()));
        i += 1;
    }
    out
}

/// Very short standalone fillers — skip when building a multi-segment title (still used as fallback).
fn is_weak_fragment(s: &str) -> bool {
    let t = s.trim();
    let n = t.chars().count();
    if n < 2 {
        return true;
    }
    if n <= 4 {
        // single syllables / はい / ok
        let lower = t.to_lowercase();
        for w in [
            "hi", "ok", "yes", "no", "oh", "uh", "ah", "嗯", "啊", "是", "好", "嗯",
        ] {
            if lower == w {
                return true;
            }
        }
    }
    if n <= 12 {
        let lower = t.to_lowercase();
        for w in [
            "hello",
            "thanks",
            "thank you",
            "okay",
            "はい",
            "ええ",
            "うん",
            "こんにちは",
        ] {
            if lower == w || lower.starts_with(&format!("{w}、")) || lower.starts_with(&format!("{w},")) {
                return true;
            }
        }
    }
    false
}

fn truncate_at_wordish_boundary(s: &str, max_chars: usize) -> String {
    let count = s.chars().count();
    if count <= max_chars {
        return s.trim().to_string();
    }
    let slice: String = s.chars().take(max_chars).collect();
    // Prefer breaking after punctuation or space (CJK-friendly)
    let breakers: &[char] = &[
        ' ', '　', '。', '、', ',', ';', '；', '.', '!', '?', '！', '？', '·', '—', '–',
    ];
    let mut best = 0usize;
    for (idx, ch) in slice.char_indices() {
        if breakers.contains(&ch) && idx > max_chars * 3 / 10 {
            best = idx + ch.len_utf8();
        }
    }
    if best > 0 {
        return slice[..best].trim_end().to_string();
    }
    slice
}

/// Title from several segments (translations preferred), not only the first line.
fn extract_title_from_transcript(content: &str) -> String {
    let body = strip_frontmatter(content);
    let segments = parse_markdown_segments(body);
    if segments.is_empty() {
        return "Conversation".to_string();
    }

    const MAX_TITLE: usize = 88;
    const MAX_SEGMENTS: usize = 5;
    const MAX_RAW_BEFORE_JOIN: usize = 420;

    let mut pieces: Vec<String> = Vec::new();
    let mut raw_len = 0usize;

    for (orig, trans) in segments.iter().take(MAX_SEGMENTS) {
        let text = if !trans.is_empty() {
            trans.as_str()
        } else {
            orig.as_str()
        };
        let t = text.trim();
        if t.is_empty() {
            continue;
        }
        // Drop fillers (はい, ok…) once we already have substantive text; keep if it's the only line.
        if is_weak_fragment(t) && !pieces.is_empty() {
            continue;
        }
        if is_weak_fragment(t) && pieces.len() >= 3 {
            continue;
        }
        pieces.push(t.to_string());
        raw_len += t.chars().count();
        if raw_len >= MAX_RAW_BEFORE_JOIN {
            break;
        }
    }

    if pieces.is_empty() {
        let (o, t) = &segments[0];
        let text = if !t.is_empty() {
            t.as_str()
        } else {
            o.as_str()
        };
        let t = text.trim();
        if t.is_empty() {
            return "Conversation".to_string();
        }
        return truncate_at_wordish_boundary(t, MAX_TITLE);
    }

    let joined = pieces.join(" · ");
    truncate_at_wordish_boundary(&joined, MAX_TITLE)
}

fn truncate_chars(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

fn extract_preview(content: &str) -> String {
    let body = strip_frontmatter(content);
    let collapsed: String = body
        .lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with("**Speaker"))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    truncate_chars(&collapsed, 200)
}

#[derive(Debug, Serialize, Deserialize)]
struct SessionMeta {
    id: String,
    created_at: i64,
    updated_at: i64,
    title: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTranscriptResult {
    pub session_id: String,
    pub path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSession {
    pub id: String,
    pub title: String,
    pub updated_at: i64,
    pub preview: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationListPage {
    pub items: Vec<ConversationSession>,
    pub total: usize,
    pub page: u32,
    pub page_size: u32,
    pub total_pages: u32,
}

/// IPC payload — explicit camelCase so JS `invoke` matches reliably.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListConversationArgs {
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub page_size: Option<u32>,
    #[serde(default)]
    pub search: Option<String>,
}

fn new_session_id() -> String {
    let now = Local::now();
    let short = Uuid::new_v4().as_simple().to_string();
    let short = &short[..8];
    format!("{}_{}", now.format("%Y-%m-%d_%H-%M-%S"), short)
}

fn file_mtime_ms(path: &Path) -> i64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Save transcript into a session folder. Creates a new folder when `session_id` is None or empty.
#[tauri::command]
pub fn save_transcript_session(
    app: AppHandle,
    session_id: Option<String>,
    content: String,
) -> Result<SaveTranscriptResult, String> {
    let sessions = sessions_root(&app)?;

    let sid = match session_id.as_deref().map(str::trim) {
        None | Some("") => new_session_id(),
        Some(id) => {
            sanitize_session_id(id)?;
            id.to_string()
        }
    };

    let folder = sessions.join(&sid);
    fs::create_dir_all(&folder).map_err(|e| format!("Failed to create session folder: {}", e))?;

    let md_path = folder.join("transcript.md");
    fs::write(&md_path, &content).map_err(|e| format!("Failed to save transcript: {}", e))?;

    let meta_path = folder.join("meta.json");
    let now = chrono::Utc::now().timestamp_millis();
    let title = extract_title_from_transcript(&content);

    let meta = if meta_path.exists() {
        let mut m: SessionMeta = serde_json::from_str(
            &fs::read_to_string(&meta_path).map_err(|e| format!("meta.json: {}", e))?,
        )
        .map_err(|e| format!("meta.json parse: {}", e))?;
        m.updated_at = now;
        m.title = title;
        m
    } else {
        SessionMeta {
            id: sid.clone(),
            created_at: now,
            updated_at: now,
            title,
        }
    };

    fs::write(
        &meta_path,
        serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("Failed to write meta: {}", e))?;

    Ok(SaveTranscriptResult {
        session_id: sid,
        path: md_path.to_string_lossy().to_string(),
    })
}

/// All sessions, newest first (internal).
fn collect_all_sessions(app: &AppHandle) -> Result<Vec<ConversationSession>, String> {
    let root = sessions_root(app)?;
    let mut out: Vec<ConversationSession> = Vec::new();

    let entries = match fs::read_dir(&root) {
        Ok(e) => e,
        Err(e) => return Err(format!("Failed to read sessions: {}", e)),
    };

    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let md = path.join("transcript.md");
        if !md.exists() {
            continue;
        }

        let id = entry.file_name().to_string_lossy().to_string();
        let meta_path = path.join("meta.json");

        let (title, updated_at) = if meta_path.exists() {
            match fs::read_to_string(&meta_path) {
                Ok(s) => match serde_json::from_str::<SessionMeta>(&s) {
                    Ok(m) => (m.title, m.updated_at),
                    Err(_) => (id.clone(), file_mtime_ms(&md)),
                },
                Err(_) => (id.clone(), file_mtime_ms(&md)),
            }
        } else {
            (
                extract_title_from_transcript(
                    &fs::read_to_string(&md).unwrap_or_default(),
                ),
                file_mtime_ms(&md),
            )
        };

        let preview = extract_preview(&fs::read_to_string(&md).unwrap_or_default());

        out.push(ConversationSession {
            id,
            title,
            updated_at,
            preview,
        });
    }

    let mut seen = HashSet::new();
    out.retain(|s| seen.insert(s.id.clone()));

    out.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(out)
}

/// Paginated list (default 10 per page) with optional search (title, id, preview — case-insensitive).
///
/// **IPC:** frontend must call `invoke(..., { args: { page, pageSize, search? } })` — the key `args`
/// matches this parameter name; a flat object will not deserialize.
#[tauri::command]
pub fn list_conversation_sessions(
    app: AppHandle,
    args: ListConversationArgs,
) -> Result<ConversationListPage, String> {
    let page_size = args.page_size.unwrap_or(10).clamp(1, 50);
    let page_req = args.page.unwrap_or(1).max(1);

    let mut all = collect_all_sessions(&app)?;

    if let Some(q) = args.search {
        let q = q.trim();
        if !q.is_empty() {
            let q_lower = q.to_lowercase();
            all.retain(|s| {
                s.title.to_lowercase().contains(&q_lower)
                    || s.id.to_lowercase().contains(&q_lower)
                    || s.preview.to_lowercase().contains(&q_lower)
            });
        }
    }

    let total = all.len();
    let total_pages = if total == 0 {
        0u32
    } else {
        ((total - 1) / page_size as usize) as u32 + 1
    };

    let page = if total_pages == 0 {
        1u32
    } else {
        page_req.min(total_pages)
    };

    let start = ((page - 1) as usize) * (page_size as usize);
    let items: Vec<ConversationSession> = all.into_iter().skip(start).take(page_size as usize).collect();

    Ok(ConversationListPage {
        items,
        total,
        page,
        page_size,
        total_pages,
    })
}

/// Read `transcript.md` for a session (for resume).
#[tauri::command]
pub fn read_transcript_session(app: AppHandle, session_id: String) -> Result<String, String> {
    sanitize_session_id(&session_id)?;
    let path = sessions_root(&app)?.join(&session_id).join("transcript.md");
    if !path.exists() {
        return Err("Transcript not found".to_string());
    }
    fs::read_to_string(&path).map_err(|e| format!("Failed to read transcript: {}", e))
}

/// Open the transcripts root folder (sessions + any legacy flat files).
#[tauri::command]
pub fn open_transcript_dir(app: AppHandle) -> Result<(), String> {
    let dir = transcripts_root(&app)?;

    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    std::process::Command::new(cmd)
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("Failed to open transcript dir: {}", e))?;
    Ok(())
}

/// Open one conversation folder in Finder / Explorer.
#[tauri::command]
pub fn open_conversation_folder(app: AppHandle, session_id: String) -> Result<(), String> {
    sanitize_session_id(&session_id)?;
    let folder = sessions_root(&app)?.join(&session_id);
    if !folder.exists() {
        return Err("Session folder not found".to_string());
    }

    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "linux")]
    let cmd = "xdg-open";

    std::process::Command::new(cmd)
        .arg(&folder)
        .spawn()
        .map_err(|e| format!("Failed to open folder: {}", e))?;
    Ok(())
}
