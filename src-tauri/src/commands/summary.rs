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

    let mut chunks = Vec::new();
    let mut start = 0usize;
    while start < s.len() {
        let end = (start + max_chars).min(s.len());
        let mut cut = end;

        // Try to cut on a paragraph boundary near the end
        let window_start = start.saturating_add((max_chars as f32 * 0.7) as usize);
        if window_start < end {
            if let Some(pos) = s[window_start..end].rfind("\n\n") {
                cut = window_start + pos + 2;
            } else if let Some(pos) = s[window_start..end].rfind('\n') {
                cut = window_start + pos + 1;
            }
        }

        // Safety: ensure progress
        if cut <= start {
            cut = end;
        }

        chunks.push(s[start..cut].to_string());
        start = cut;
    }

    chunks
}

async fn call_openai(api_key: &str, model: &str, system: &str, user: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
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

