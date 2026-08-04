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
    pub sampling: Option<SamplingParams>,
}

/// Optional sampling knobs. Every key is written into the payload only when
/// set AND only into the API shape that accepts it — strict endpoints reject
/// unknown keys, so seed/penalties stay OpenAI-only and top_k Anthropic-only.
#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct SamplingParams {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<u32>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub seed: Option<i64>,
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

fn openai_payload(
    config: &LlmProviderConfig,
    system: &Option<String>,
    messages: &[ChatMessage],
) -> Value {
    let mut wire_messages: Vec<Value> = Vec::new();
    if let Some(system_text) = system {
        wire_messages.push(json!({ "role": "system", "content": system_text }));
    }
    for message in messages {
        wire_messages.push(json!({ "role": message.role, "content": message.content }));
    }
    let mut body = json!({
        "model": config.model,
        "messages": wire_messages,
        "max_tokens": config.max_tokens.unwrap_or(4096),
    });
    if let Some(sampling) = &config.sampling {
        if let Some(v) = sampling.temperature {
            body["temperature"] = json!(v);
        }
        if let Some(v) = sampling.top_p {
            body["top_p"] = json!(v);
        }
        if let Some(v) = sampling.frequency_penalty {
            body["frequency_penalty"] = json!(v);
        }
        if let Some(v) = sampling.presence_penalty {
            body["presence_penalty"] = json!(v);
        }
        if let Some(v) = sampling.seed {
            body["seed"] = json!(v);
        }
    }
    body
}

fn anthropic_payload(
    config: &LlmProviderConfig,
    system: &Option<String>,
    messages: &[ChatMessage],
) -> Value {
    let wire_messages: Vec<Value> = messages
        .iter()
        .map(|message| json!({ "role": message.role, "content": message.content }))
        .collect();
    let mut body = json!({
        "model": config.model,
        "max_tokens": config.max_tokens.unwrap_or(4096),
        "messages": wire_messages,
    });
    if let Some(system_text) = system {
        body["system"] = json!(system_text);
    }
    if let Some(sampling) = &config.sampling {
        if let Some(v) = sampling.temperature {
            body["temperature"] = json!(v);
        }
        if let Some(v) = sampling.top_p {
            body["top_p"] = json!(v);
        }
        if let Some(v) = sampling.top_k {
            body["top_k"] = json!(v);
        }
    }
    body
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

    match config.kind.as_str() {
        "openai" => {
            let payload = post_json(
                &format!("{base}/chat/completions"),
                vec![("authorization", format!("Bearer {key}"))],
                openai_payload(&config, &system, &messages),
            )
            .await?;
            extract_openai_text(&payload)
        }
        "anthropic" => {
            let payload = post_json(
                &format!("{base}/v1/messages"),
                vec![
                    ("x-api-key", key),
                    ("anthropic-version", "2023-06-01".to_owned()),
                ],
                anthropic_payload(&config, &system, &messages),
            )
            .await?;
            extract_anthropic_text(&payload)
        }
        other => Err(format!("unknown provider kind {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        anthropic_payload, extract_anthropic_text, extract_openai_text, openai_payload,
        trimmed_base, ChatMessage, LlmProviderConfig, SamplingParams,
    };
    use serde_json::json;

    fn config(kind: &str, sampling: Option<SamplingParams>) -> LlmProviderConfig {
        LlmProviderConfig {
            kind: kind.to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            model: "test-model".to_owned(),
            secret_account: "acct".to_owned(),
            max_tokens: Some(1024),
            sampling,
        }
    }

    fn full_sampling() -> SamplingParams {
        SamplingParams {
            temperature: Some(0.7),
            top_p: Some(0.9),
            top_k: Some(40),
            frequency_penalty: Some(0.1),
            presence_penalty: Some(0.2),
            seed: Some(42),
        }
    }

    #[test]
    fn payloads_omit_sampling_when_unset() {
        let messages = vec![ChatMessage {
            role: "user".to_owned(),
            content: "hi".to_owned(),
        }];
        let openai = openai_payload(&config("openai", None), &None, &messages);
        assert!(openai.get("temperature").is_none());
        assert!(openai.get("seed").is_none());
        assert_eq!(openai["max_tokens"], json!(1024));
        let anthropic = anthropic_payload(&config("anthropic", None), &None, &messages);
        assert!(anthropic.get("temperature").is_none());
        assert!(anthropic.get("top_k").is_none());
    }

    #[test]
    fn openai_payload_sends_only_openai_keys() {
        let messages = vec![ChatMessage {
            role: "user".to_owned(),
            content: "hi".to_owned(),
        }];
        let body = openai_payload(
            &config("openai", Some(full_sampling())),
            &Some("sys".to_owned()),
            &messages,
        );
        assert_eq!(body["temperature"], json!(0.7));
        assert_eq!(body["top_p"], json!(0.9));
        assert_eq!(body["frequency_penalty"], json!(0.1));
        assert_eq!(body["presence_penalty"], json!(0.2));
        assert_eq!(body["seed"], json!(42));
        assert!(body.get("top_k").is_none(), "top_k is not an OpenAI knob");
        assert_eq!(body["messages"][0]["role"], json!("system"));
    }

    #[test]
    fn anthropic_payload_sends_only_anthropic_keys() {
        let messages = vec![ChatMessage {
            role: "user".to_owned(),
            content: "hi".to_owned(),
        }];
        let body = anthropic_payload(
            &config("anthropic", Some(full_sampling())),
            &Some("sys".to_owned()),
            &messages,
        );
        assert_eq!(body["temperature"], json!(0.7));
        assert_eq!(body["top_p"], json!(0.9));
        assert_eq!(body["top_k"], json!(40));
        assert!(body.get("seed").is_none(), "seed is OpenAI-only");
        assert!(body.get("frequency_penalty").is_none());
        assert_eq!(body["system"], json!("sys"));
    }

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
