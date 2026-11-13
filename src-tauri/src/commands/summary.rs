use crate::settings::SettingsState;
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Debug, Serialize)]
struct ChatCompletionRequest {
    model: String,
    messages: Vec<Message>,
    temperature: f64,
}

#[derive(Debug, Serialize)]
struct Message {
    role: String,
    content: String,
}

#[derive(Debug, Deserialize)]
struct ChatCompletionResponse {
    choices: Vec<Choice>,
}

#[derive(Debug, Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Debug, Deserialize)]
struct ChoiceMessage {
    content: String,
}

fn chunk_text(s: &str, max_chars: usize) -> Vec<String> {
    if s.len() <= max_chars {
        return vec![s.to_string()];
    }

    // Offsets are bytes, so every slice point is snapped back to a char boundary. Without this a
    // long Japanese/Vietnamese transcript panics on `s[a..b]` and the command never returns.
    let floor = |mut i: usize| {
        while !s.is_char_boundary(i) {
            i -= 1;
        }
        i
    };

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < s.len() {
        let end = floor((start + max_chars).min(s.len()));
        let mut cut = end;

        // Try to cut on a paragraph boundary near the end
        let window_start = floor(start.saturating_add((max_chars as f32 * 0.7) as usize));
        if window_start < end {
            if let Some(pos) = s[window_start..end].rfind("\n\n") {
                cut = window_start + pos + 2;
            } else if let Some(pos) = s[window_start..end].rfind('\n') {
                cut = window_start + pos + 1;
            }
        }

        // Safety: ensure progress (a single char wider than max_chars still moves forward)
        if cut <= start {
            cut = end;
        }
        if cut <= start {
            cut = start + s[start..].chars().next().map_or(1, char::len_utf8);
        }

        chunks.push(s[start..cut].to_string());
        start = cut;
    }

    chunks
}

async fn call_openai(api_key: &str, model: &str, system: &str, user: &str) -> Result<String, String> {
    // A stalled request would otherwise hang Stop/Close, which wait for the meeting note.
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;
    let req = ChatCompletionRequest {
        model: model.to_string(),
        messages: vec![
            Message {
                role: "system".to_string(),
                content: system.to_string(),
            },
            Message {
                role: "user".to_string(),
                content: user.to_string(),
            },
        ],
        temperature: 0.2,
    };

    let resp = client
        .post("https://api.openai.com/v1/chat/completions")
        .bearer_auth(api_key)
        .json(&req)
        .send()
        .await
        .map_err(|e| format!("Request failed: {}", e))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("OpenAI error {}: {}", status, body));
    }

    let data: ChatCompletionResponse = resp
        .json()
        .await
        .map_err(|e| format!("Bad response JSON: {}", e))?;

    data.choices
        .get(0)
        .map(|c| c.message.content.clone())
        .ok_or_else(|| "No choices returned".to_string())
}

/// Summarize a transcript using ChatGPT (OpenAI API).
#[tauri::command]
pub async fn summarize_transcript(
    transcript: String,
    state: State<'_, SettingsState>,
) -> Result<String, String> {
    let key_from_env = std::env::var("OPENAI_API_KEY").ok();
    let key_from_settings = state
        .0
        .lock()
        .map_err(|e| format!("Lock error: {}", e))?
        .openai_api_key
        .clone();

    let api_key = key_from_env
        .filter(|k| !k.trim().is_empty())
        .or_else(|| {
            if key_from_settings.trim().is_empty() {
                None
            } else {
                Some(key_from_settings)
            }
        })
        .ok_or_else(|| "Missing OpenAI API key (set OPENAI_API_KEY or add it in Settings)".to_string())?;

    let model = std::env::var("OPENAI_SUMMARY_MODEL").unwrap_or_else(|_| "gpt-4o-mini".to_string());

    // Use concat! — raw string r#"..."# cannot contain the substring "# (ends the literal early).
    let system = concat!(
        "You summarize meeting transcripts.\n",
        "Return concise Vietnamese output in Markdown with:\n",
        "- ## Tóm tắt (3-7 bullets)\n",
        "- ## Quyết định (if any)\n",
        "- ## Việc cần làm (action items, with owners if mentioned)\n",
        "- ## Câu hỏi / mở (open questions)\n",
        "Be faithful to the transcript; do not invent facts.",
    );

    let cleaned = transcript.trim();
    if cleaned.is_empty() {
        return Err("Transcript is empty".to_string());
    }

    // Basic chunking for long transcripts
    let chunks = chunk_text(cleaned, 10_000);
    if chunks.len() == 1 {
        let user = format!("Transcript:\n\n{}", cleaned);
        return call_openai(&api_key, &model, system, &user).await;
    }

    // 1) Summarize each chunk
    let mut partials = Vec::new();
    for (i, ch) in chunks.iter().enumerate() {
        let user = format!(
            "Chunk {}/{} (part of a longer transcript). Summarize key points, decisions, and action items.\n\n{}",
            i + 1,
            chunks.len(),
            ch
        );
        let out = call_openai(&api_key, &model, system, &user).await?;
        partials.push(out);
    }

    // 2) Merge summaries into final
    let merged_input = partials
        .iter()
        .enumerate()
        .map(|(i, s)| format!("---\nChunk summary {}:\n{}\n", i + 1, s))
        .collect::<Vec<_>>()
        .join("\n");

    let user = format!(
        "You are given summaries of transcript chunks. Merge them into one coherent final result, removing duplicates.\n\n{}",
        merged_input
    );
    call_openai(&api_key, &model, system, &user).await
}

// ════════════════════════════════════════════════════════════════════════════
// Meeting aggregation
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummarizeMeetingArgs {
    pub transcript: String,
    /// Output language: "vi" | "en" | "ja". Falls back to `mtg_summary_language`.
    #[serde(default)]
    pub language: Option<String>,
    /// Extra instructions appended to the system prompt.
    #[serde(default)]
    pub extra_prompt: Option<String>,
    #[serde(default)]
    pub model: Option<String>,
    /// Known meeting title — steers the summary and is echoed back when the model finds nothing better.
    #[serde(default)]
    pub title_hint: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingSummary {
    /// Markdown body, already carrying its own `## …` headings.
    pub summary: String,
    /// Short topic the model inferred, used to name the MTG file.
    pub title: String,
    pub model: String,
    /// Number of chunks the transcript was split into (1 = single pass).
    pub chunks: usize,
}

/// Section headings the model must produce, per output language.
fn meeting_sections(lang: &str) -> &'static str {
    match lang {
        "en" => concat!(
            "- ## Summary (3-7 bullets)\n",
            "- ## Decisions (omit the section if there were none)\n",
            "- ## Action items (one bullet each, with owner and due date when mentioned)\n",
            "- ## Open questions\n",
        ),
        "ja" => concat!(
            "- ## 要約 (3-7 個の箇条書き)\n",
            "- ## 決定事項 (なければ省略)\n",
            "- ## ネクストアクション (担当者と期限が言及されていれば併記)\n",
            "- ## 未解決の論点\n",
        ),
        _ => concat!(
            "- ## Tóm tắt (3-7 bullets)\n",
            "- ## Quyết định (bỏ section nếu không có)\n",
            "- ## Việc cần làm (mỗi việc 1 bullet, kèm người phụ trách + deadline nếu có nhắc)\n",
            "- ## Câu hỏi / vấn đề mở\n",
        ),
    }
}

fn language_name(lang: &str) -> &'static str {
    match lang {
        "en" => "English",
        "ja" => "Japanese",
        _ => "Vietnamese",
    }
}

/// Build the system prompt for the final (or single-pass) meeting summary.
fn meeting_system_prompt(lang: &str, extra: &str, want_title: bool) -> String {
    let mut p = String::new();
    p.push_str("You summarize meeting transcripts produced by live speech translation.\n");
    p.push_str(
        "The transcript may contain recognition errors, duplicated phrases and broken sentences — \
         infer intent, but never invent facts, names, numbers or commitments that are not there.\n",
    );
    p.push_str(&format!(
        "Write the output in {}, as Markdown, with these sections:\n",
        language_name(lang)
    ));
    p.push_str(meeting_sections(lang));
    p.push_str("Speaker labels (\"Speaker 1\") are diarization output, not real names — refer to them only if useful.\n");
    if want_title {
        p.push_str(
            "\nBegin your reply with a single line of the exact form:\nTITLE: <short topic, max 8 words, no quotes>\n\
             Then a blank line, then the sections. Do not mention the TITLE line anywhere else.\n",
        );
    }
    let extra = extra.trim();
    if !extra.is_empty() {
        p.push_str("\nAdditional instructions from the user:\n");
        p.push_str(extra);
        p.push('\n');
    }
    p
}

/// Split a leading `TITLE: …` line off the model output.
fn split_title(raw: &str) -> (String, String) {
    let trimmed = raw.trim_start();
    let Some(rest) = trimmed.strip_prefix("TITLE:") else {
        return (String::new(), raw.trim().to_string());
    };
    let (line, body) = match rest.split_once('\n') {
        Some((l, b)) => (l, b),
        None => (rest, ""),
    };
    let title = line
        .trim()
        .trim_matches(|c| c == '"' || c == '\'' || c == '*' || c == '#')
        .trim()
        .to_string();
    (title, body.trim().to_string())
}

/// Aggregate a full meeting transcript into a structured Markdown summary plus a short title.
///
/// Long transcripts are summarized per chunk and then merged, so a two-hour meeting does not blow
/// the context window. Only the final pass is asked for a TITLE line.
#[tauri::command]
pub async fn summarize_meeting(
    args: SummarizeMeetingArgs,
    state: State<'_, SettingsState>,
) -> Result<MeetingSummary, String> {
    let (settings_key, settings_lang, settings_extra, settings_model) = {
        let s = state.0.lock().map_err(|e| format!("Lock error: {}", e))?;
        (
            s.openai_api_key.clone(),
            s.mtg_summary_language.clone(),
            s.mtg_summary_prompt.clone(),
            s.mtg_summary_model.clone(),
        )
    };

    let api_key = std::env::var("OPENAI_API_KEY")
        .ok()
        .filter(|k| !k.trim().is_empty())
        .or_else(|| {
            if settings_key.trim().is_empty() {
                None
            } else {
                Some(settings_key)
            }
        })
        .ok_or_else(|| {
            "Missing OpenAI API key (set OPENAI_API_KEY or add it in Settings)".to_string()
        })?;

    let lang = args
        .language
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&settings_lang)
        .to_string();
    let extra = args
        .extra_prompt
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&settings_extra)
        .to_string();
    let model = args
        .model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(if settings_model.trim().is_empty() {
            "gpt-4o-mini"
        } else {
            &settings_model
        })
        .to_string();

    let cleaned = args.transcript.trim();
    if cleaned.is_empty() {
        return Err("Transcript is empty".to_string());
    }

    let hint = args
        .title_hint
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");

    let chunks = chunk_text(cleaned, 12_000);

    let raw = if chunks.len() == 1 {
        let system = meeting_system_prompt(&lang, &extra, true);
        let user = if hint.is_empty() {
            format!("Meeting transcript:\n\n{}", cleaned)
        } else {
            format!(
                "Meeting title (from the calendar): {}\n\nMeeting transcript:\n\n{}",
                hint, cleaned
            )
        };
        call_openai(&api_key, &model, &system, &user).await?
    } else {
        // Pass 1 — condense each chunk without imposing the final structure.
        let chunk_system = meeting_system_prompt(&lang, &extra, false);
        let mut partials = Vec::new();
        for (i, ch) in chunks.iter().enumerate() {
            let user = format!(
                "Part {}/{} of one meeting transcript. Capture key points, decisions and action items from this part only.\n\n{}",
                i + 1,
                chunks.len(),
                ch
            );
            partials.push(call_openai(&api_key, &model, &chunk_system, &user).await?);
        }

        // Pass 2 — merge into the final note.
        let merged = partials
            .iter()
            .enumerate()
            .map(|(i, s)| format!("---\nPart {} summary:\n{}\n", i + 1, s))
            .collect::<Vec<_>>()
            .join("\n");
        let system = meeting_system_prompt(&lang, &extra, true);
        let user = format!(
            "{}These are sequential summaries of one meeting. Merge them into a single coherent note, \
             de-duplicating repeated points and keeping chronological order where it matters.\n\n{}",
            if hint.is_empty() {
                String::new()
            } else {
                format!("Meeting title (from the calendar): {}\n\n", hint)
            },
            merged
        );
        call_openai(&api_key, &model, &system, &user).await?
    };

    let (mut title, summary) = split_title(&raw);
    if title.is_empty() {
        title = hint.to_string();
    }

    Ok(MeetingSummary {
        summary,
        title,
        model,
        chunks: chunks.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_the_title_line_off_the_summary() {
        let (title, body) = split_title("TITLE: Weekly platform sync\n\n## Tóm tắt\n- a");
        assert_eq!(title, "Weekly platform sync");
        assert_eq!(body, "## Tóm tắt\n- a");
    }

    #[test]
    fn missing_title_line_leaves_body_untouched() {
        let (title, body) = split_title("## Tóm tắt\n- a");
        assert!(title.is_empty());
        assert_eq!(body, "## Tóm tắt\n- a");
    }

    #[test]
    fn strips_decoration_around_the_title() {
        let (title, _) = split_title("TITLE: **\"Release readiness\"**\n\nbody");
        assert_eq!(title, "Release readiness");
    }

    #[test]
    fn prompt_requests_title_only_for_the_final_pass() {
        assert!(meeting_system_prompt("vi", "", true).contains("TITLE:"));
        assert!(!meeting_system_prompt("vi", "", false).contains("TITLE:"));
    }

    #[test]
    fn prompt_switches_section_language() {
        assert!(meeting_system_prompt("vi", "", false).contains("## Tóm tắt"));
        assert!(meeting_system_prompt("en", "", false).contains("## Summary"));
        assert!(meeting_system_prompt("ja", "", false).contains("## 要約"));
    }

    #[test]
    fn extra_instructions_are_appended() {
        let p = meeting_system_prompt("vi", "focus on release risks", false);
        assert!(p.contains("focus on release risks"));
    }

    #[test]
    fn chunking_splits_long_input_on_paragraph_boundaries() {
        let text = "para one\n\n".repeat(3000);
        let chunks = chunk_text(&text, 12_000);
        assert!(chunks.len() > 1);
        // No content lost.
        assert_eq!(chunks.concat().len(), text.len());
    }

    #[test]
    fn chunking_multibyte_text_does_not_panic() {
        // 3-byte chars with no newlines: byte offsets land mid-char unless snapped.
        let text = "会議の内容を記録します。".repeat(2000);
        let chunks = chunk_text(&text, 12_000);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.concat(), text);

        let vi = "Cuộc họp dài quá không lưu được\n".repeat(1500);
        assert_eq!(chunk_text(&vi, 12_000).concat(), vi);
    }
}

