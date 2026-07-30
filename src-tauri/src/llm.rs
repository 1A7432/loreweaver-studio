//! LLM proxy for the AI forge. Requests go out from Rust (reqwest), never
//! from the WebView: that keeps the strict CSP intact, sidesteps CORS, and —
//! most importantly — means the API key is read from the OS credential store
//! here and never crosses into JavaScript.
//!
//! Two provider shapes: any OpenAI-compatible `/chat/completions` endpoint
//! (the configured `base_url` includes its version prefix, e.g. `…/v1`), and
//! native Anthropic `/v1/messages`.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;

use crate::secrets::read_secret;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(180);
const MAX_ERROR_BODY_CHARS: usize = 600;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderConfig {
    /// "openai" (OpenAI-compatible) or "anthropic".
    pub kind: String,
    pub base_url: String,
    pub model: String,
    /// Credential-store account name holding the API key.
    pub secret_account: String,
    pub max_tokens: Option<u32>,
}

#[derive(Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

fn trimmed_base(base_url: &str) -> String {
    base_url.trim_end_matches('/').to_owned()
}

fn error_snippet(body: &str) -> String {
    let mut snippet = body.trim().to_owned();
    if snippet.len() > MAX_ERROR_BODY_CHARS {
        let mut cut = MAX_ERROR_BODY_CHARS;
        while !snippet.is_char_boundary(cut) {
            cut -= 1;
        }
        snippet.truncate(cut);
        snippet.push('…');
    }
    snippet
}

async fn post_json(
    url: &str,
    headers: Vec<(&'static str, String)>,
    body: Value,
) -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())?;
    let mut request = client.post(url).json(&body);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = request
        .send()
        .await
        .map_err(|err| format!("request failed: {err}"))?;
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|err| format!("reading response failed: {err}"))?;
    if !status.is_success() {
        return Err(format!("{status}: {}", error_snippet(&text)));
    }
    serde_json::from_str(&text).map_err(|err| format!("non-JSON response: {err}"))
}

fn extract_openai_text(payload: &Value) -> Result<String, String> {
    payload["choices"][0]["message"]["content"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "response carried no choices[0].message.content".to_owned())
}

fn extract_anthropic_text(payload: &Value) -> Result<String, String> {
    let blocks = payload["content"]
        .as_array()
        .ok_or_else(|| "response carried no content blocks".to_owned())?;
    let text: String = blocks
        .iter()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect();
    if text.is_empty() {
        return Err("response carried no text blocks".to_owned());
    }
    Ok(text)
}

/// One non-streaming chat completion. Returns the assistant text.
#[tauri::command]
pub async fn llm_chat(
    config: LlmProviderConfig,
    system: Option<String>,
    messages: Vec<ChatMessage>,
) -> Result<String, String> {
    let account = config.secret_account.clone();
    let key = tauri::async_runtime::spawn_blocking(move || read_secret(&account))
        .await
        .map_err(|err| err.to_string())??;
    let base = trimmed_base(&config.base_url);
    let max_tokens = config.max_tokens.unwrap_or(4096);

    match config.kind.as_str() {
        "openai" => {
            let mut wire_messages: Vec<Value> = Vec::new();
            if let Some(system_text) = &system {
                wire_messages.push(json!({ "role": "system", "content": system_text }));
            }
            for message in &messages {
                wire_messages.push(json!({ "role": message.role, "content": message.content }));
            }
            let payload = post_json(
                &format!("{base}/chat/completions"),
                vec![("authorization", format!("Bearer {key}"))],
                json!({ "model": config.model, "messages": wire_messages, "max_tokens": max_tokens }),
            )
            .await?;
            extract_openai_text(&payload)
        }
        "anthropic" => {
            let wire_messages: Vec<Value> = messages
                .iter()
                .map(|message| json!({ "role": message.role, "content": message.content }))
                .collect();
            let mut body = json!({
                "model": config.model,
                "max_tokens": max_tokens,
                "messages": wire_messages,
            });
            if let Some(system_text) = &system {
                body["system"] = json!(system_text);
            }
            let payload = post_json(
                &format!("{base}/v1/messages"),
                vec![
                    ("x-api-key", key),
                    ("anthropic-version", "2023-06-01".to_owned()),
                ],
                body,
            )
            .await?;
            extract_anthropic_text(&payload)
        }
        other => Err(format!("unknown provider kind {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{extract_anthropic_text, extract_openai_text, trimmed_base};
    use serde_json::json;

    #[test]
    fn base_url_trims_trailing_slashes() {
        assert_eq!(
            trimmed_base("https://api.example.com/v1/"),
            "https://api.example.com/v1"
        );
    }

    #[test]
    fn openai_text_extracts() {
        let payload = json!({"choices": [{"message": {"content": "hi"}}]});
        assert_eq!(extract_openai_text(&payload).unwrap(), "hi");
        assert!(extract_openai_text(&json!({})).is_err());
    }

    #[test]
    fn anthropic_text_joins_blocks() {
        let payload = json!({"content": [
            {"type": "text", "text": "a"},
            {"type": "tool_use"},
            {"type": "text", "text": "b"}
        ]});
        assert_eq!(extract_anthropic_text(&payload).unwrap(), "ab");
        assert!(extract_anthropic_text(&json!({"content": []})).is_err());
    }
}
