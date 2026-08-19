//! LLM proxy for the AI forge. Requests go out from Rust (reqwest), never
//! from the WebView: that keeps the strict CSP intact and sidesteps CORS.
//!
//! Two provider shapes: any OpenAI-compatible `/chat/completions` endpoint
//! (the configured `base_url` includes its version prefix, e.g. `…/v1`), and
//! native Anthropic `/v1/messages`.
//!
//! Every call STREAMS (`stream: true` + SSE). This is not a cosmetic choice:
//! a drafted card is one long unbounded generation, and the proxies people
//! actually put in front of these APIs buffer a non-streaming response until
//! their own patience runs out — one real gateway converted the upstream call
//! to a stream, lost it mid-generation, and wrapped the loss as an instant
//! `408 "stream disconnected before response.completed"`. Streaming end to end
//! means nobody between here and the model ever has to hold a whole reply.
//! Deltas are forwarded to the WebView as `loreweaver://llm-stream` events
//! (matched by `requestId`); the command still resolves with the full text.
//! A gateway that ignores `stream: true` and answers with one JSON body is
//! detected and parsed as such — the stream path degrades, never fails, on
//! a non-streaming peer.
//!
//! The API key arrives in the config, from the frontend's own settings. It used
//! to come from the OS credential store; that cost a per-platform integration
//! the app cannot finish (the `keyring` crate has nothing for Android, and its
//! Linux backend needs a running Secret Service daemon), and on macOS it
//! re-prompted after every rebuild with a modal that could hang a draft for
//! eighteen minutes. One storage path that works everywhere the app runs beats
//! a stronger one that works on two platforms out of five.

use serde::Deserialize;
use serde_json::{json, Value};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Streamed text deltas ride this event: `{ requestId, text }`.
pub const LLM_STREAM_EVENT: &str = "loreweaver://llm-stream";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
/// A live stream ticks at least this often (providers send keep-alive comments
/// between tokens); silence this long means the peer is gone.
const IDLE_TIMEOUT: Duration = Duration::from_secs(90);
/// Ceiling on one whole generation, ticking or not.
const TOTAL_TIMEOUT: Duration = Duration::from_secs(600);
const MAX_ERROR_BODY_CHARS: usize = 600;
/// The Anthropic Messages API REQUIRES `max_tokens`, so that shape alone needs a
/// number when the caller names none. The engine picks its own the same way
/// (`infra/providers.py:498` — the only `max_tokens` in its whole provider
/// layer, and it is inside the Anthropic adapter). This sits above a whole
/// drafted card and inside the output ceiling of every current Claude model.
const ANTHROPIC_DEFAULT_MAX_TOKENS: u32 = 32768;

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LlmProviderConfig {
    /// "openai" (OpenAI-compatible) or "anthropic".
    pub kind: String,
    pub base_url: String,
    pub model: String,
    /// The API key itself. Never logged, and never put in an error message.
    pub api_key: String,
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
        "stream": true,
    });
    // No `max_tokens` unless the caller asked for one. It is optional on this
    // shape, and omitting it means the provider applies ITS OWN maximum — which
    // is always right and never guessable from here. A number invented here can
    // only be wrong in one of two directions: too low truncates the document
    // mid-JSON, too high is a 400 from a model whose output ceiling is lower
    // than its context window (they are different limits; kimi-k3 is 1M context
    // and nothing like 1M output).
    if let Some(cap) = config.max_tokens {
        body["max_tokens"] = json!(cap);
    }
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
        "max_tokens": config.max_tokens.unwrap_or(ANTHROPIC_DEFAULT_MAX_TOKENS),
        "messages": wire_messages,
        "stream": true,
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

/// One parsed SSE `data:` payload, reduced to what the assembler needs.
/// `Nothing` still proves the peer is alive — a reasoning model can think for
/// minutes emitting only `reasoning_content` deltas before the first visible
/// token, and that heartbeat must reach the WebView's own idle timer.
enum StreamPiece {
    Text(String),
    Done,
    Nothing,
}

/// OpenAI-compatible stream chunk → piece. A `data:` line is either the
/// `[DONE]` sentinel, an error object (some gateways report mid-stream failure
/// as a data line, not an HTTP status), or a chunk whose delta MAY carry text
/// (role-only and finish_reason-only chunks are normal and carry none).
fn openai_stream_piece(data: &str) -> Result<StreamPiece, String> {
    if data.trim() == "[DONE]" {
        return Ok(StreamPiece::Done);
    }
    let value: Value =
        serde_json::from_str(data).map_err(|err| format!("bad stream chunk: {err}"))?;
    if let Some(error) = value.get("error") {
        return Err(format!(
            "provider error mid-stream: {}",
            error_snippet(&error.to_string())
        ));
    }
    match value["choices"][0]["delta"]["content"].as_str() {
        Some(text) if !text.is_empty() => Ok(StreamPiece::Text(text.to_owned())),
        _ => Ok(StreamPiece::Nothing),
    }
}

/// Anthropic stream event → piece. Only `content_block_delta`'s `text_delta`
/// carries text; `message_stop` ends the stream; an `error` event is fatal.
fn anthropic_stream_piece(data: &str) -> Result<StreamPiece, String> {
    let value: Value =
        serde_json::from_str(data).map_err(|err| format!("bad stream chunk: {err}"))?;
    match value["type"].as_str() {
        Some("content_block_delta") => match value["delta"]["text"].as_str() {
            Some(text) if !text.is_empty() => Ok(StreamPiece::Text(text.to_owned())),
            _ => Ok(StreamPiece::Nothing),
        },
        Some("message_stop") => Ok(StreamPiece::Done),
        Some("error") => Err(format!(
            "provider error mid-stream: {}",
            error_snippet(&value["error"].to_string())
        )),
        _ => Ok(StreamPiece::Nothing),
    }
}

/// Drain complete lines out of the byte buffer and return SSE `data:` payloads.
/// Splitting at `\n` is UTF-8-safe (no multi-byte sequence contains 0x0A), so a
/// network chunk that cuts a CJK character in half heals at the line boundary.
/// Comment lines (`:` keep-alives) and `event:` lines are dropped here — the
/// per-provider piece parsers read the JSON, not the event name.
fn drain_sse_data_lines(buffer: &mut Vec<u8>) -> Vec<String> {
    let mut lines = Vec::new();
    while let Some(newline) = buffer.iter().position(|byte| *byte == b'\n') {
        let raw: Vec<u8> = buffer.drain(..=newline).collect();
        let line = String::from_utf8_lossy(&raw);
        let line = line.trim_end_matches(['\n', '\r']);
        if let Some(data) = line.strip_prefix("data:") {
            lines.push(data.trim_start().to_owned());
        }
    }
    lines
}

/// Bytes kept for the non-streaming fallback. Accumulation stops the moment a
/// real SSE `data:` line shows up (a streaming peer never needs the fallback),
/// and the cap only guards against a peer pouring out garbage that is neither
/// SSE nor a completion — a real completion body sits far under it. The buffer
/// stays BYTES until the end: one lossy conversion over the whole body, so a
/// chunk boundary that split a multi-byte character heals instead of turning
/// into replacement characters that break the JSON parse.
struct RawBody {
    bytes: Vec<u8>,
}

const RAW_BODY_CAP: usize = 8 * 1024 * 1024;

impl RawBody {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn push(&mut self, chunk: &[u8]) {
        let room = RAW_BODY_CAP.saturating_sub(self.bytes.len());
        self.bytes
            .extend_from_slice(&chunk[..chunk.len().min(room)]);
    }

    fn text(&self) -> String {
        String::from_utf8_lossy(&self.bytes).into_owned()
    }
}

/// Recover the text from a peer that ignored `stream: true` and answered with
/// one ordinary JSON completion body (either API shape).
fn non_streaming_text(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    if let Some(text) = value["choices"][0]["message"]["content"].as_str() {
        return Some(text.to_owned());
    }
    let blocks = value["content"].as_array()?;
    let text: String = blocks
        .iter()
        .filter(|block| block["type"] == "text")
        .filter_map(|block| block["text"].as_str())
        .collect();
    (!text.is_empty()).then_some(text)
}

/// POST, then consume the SSE stream: each text delta goes to `sink`, the
/// assembled full text is the return value. Timeouts are stream-shaped — a
/// connect cap, an idle cap between chunks, and a total ceiling — because one
/// fixed whole-request timeout is wrong in both directions for a generation
/// whose length nobody here can predict.
async fn post_sse(
    url: &str,
    headers: Vec<(&'static str, String)>,
    body: Value,
    parse: fn(&str) -> Result<StreamPiece, String>,
    mut sink: impl FnMut(&str),
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|err| err.to_string())?;
    let mut request = client.post(url).json(&body);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    let response = tokio::time::timeout(IDLE_TIMEOUT, request.send())
        .await
        .map_err(|_| "request timed out before the provider answered".to_owned())?
        .map_err(|err| format!("request failed: {err}"))?;
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(format!("{status}: {}", error_snippet(&text)));
    }

    let started = tokio::time::Instant::now();
    let mut response = response;
    let mut buffer: Vec<u8> = Vec::new();
    let mut raw_body = RawBody::new();
    let mut assembled = String::new();
    let mut saw_data_line = false;
    loop {
        if started.elapsed() > TOTAL_TIMEOUT {
            return Err(format!(
                "generation exceeded {}s — giving up on this stream",
                TOTAL_TIMEOUT.as_secs()
            ));
        }
        let chunk = tokio::time::timeout(IDLE_TIMEOUT, response.chunk())
            .await
            .map_err(|_| format!("stream went silent for {}s", IDLE_TIMEOUT.as_secs()))?
            .map_err(|err| format!("stream failed: {err}"))?;
        let Some(bytes) = chunk else { break };
        if !saw_data_line {
            raw_body.push(&bytes);
        }
        buffer.extend_from_slice(&bytes);
        for data in drain_sse_data_lines(&mut buffer) {
            saw_data_line = true;
            match parse(&data)? {
                StreamPiece::Text(text) => {
                    sink(&text);
                    assembled.push_str(&text);
                }
                StreamPiece::Done => return Ok(assembled),
                // An empty delta is a heartbeat: it re-arms the frontend's idle
                // belt (reasoning deltas carry no text but prove liveness) and
                // adds nothing to the draft.
                StreamPiece::Nothing => sink(""),
            }
        }
    }
    if !assembled.is_empty() {
        return Ok(assembled);
    }
    // No streamed text at all. A gateway that ignored `stream: true` answered
    // with one plain JSON completion — recover it, WHOLE, rather than failing a
    // reply that arrived intact. (An early cut of this parsed a 2400-byte error
    // snippet instead of the body: every card-sized completion overflowed it,
    // and the fallback died exactly where it was meant to save the draft.)
    if !saw_data_line {
        let body = raw_body.text();
        if let Some(text) = non_streaming_text(&body) {
            return Ok(text);
        }
        if !body.trim().is_empty() {
            return Err(format!(
                "stream ended without any text; the body was not a completion either: {}",
                error_snippet(&body)
            ));
        }
    }
    Err("stream ended without any text".to_owned())
}

/// One chat completion, streamed. Text deltas are emitted as
/// `loreweaver://llm-stream` events carrying `{ requestId, text }`; the command
/// resolves with the full assembled text.
#[tauri::command]
pub async fn llm_chat(
    app: AppHandle,
    config: LlmProviderConfig,
    system: Option<String>,
    messages: Vec<ChatMessage>,
    request_id: Option<String>,
) -> Result<String, String> {
    let key = config.api_key.trim().to_owned();
    if key.is_empty() {
        return Err("no API key configured".to_owned());
    }
    let base = trimmed_base(&config.base_url);
    let request_id = request_id.unwrap_or_default();
    let sink = |text: &str| {
        if !request_id.is_empty() {
            let _ = app.emit(
                LLM_STREAM_EVENT,
                json!({ "requestId": request_id, "text": text }),
            );
        }
    };

    match config.kind.as_str() {
        "openai" => {
            post_sse(
                &format!("{base}/chat/completions"),
                vec![("authorization", format!("Bearer {key}"))],
                openai_payload(&config, &system, &messages),
                openai_stream_piece,
                sink,
            )
            .await
        }
        "anthropic" => {
            post_sse(
                &format!("{base}/v1/messages"),
                vec![
                    ("x-api-key", key),
                    ("anthropic-version", "2023-06-01".to_owned()),
                ],
                anthropic_payload(&config, &system, &messages),
                anthropic_stream_piece,
                sink,
            )
            .await
        }
        other => Err(format!("unknown provider kind {other:?}")),
    }
}

#[cfg(test)]
mod tests {
    use super::{
        anthropic_payload, anthropic_stream_piece, drain_sse_data_lines, non_streaming_text,
        openai_payload, openai_stream_piece, trimmed_base, ChatMessage, LlmProviderConfig,
        SamplingParams, StreamPiece, ANTHROPIC_DEFAULT_MAX_TOKENS,
    };
    use serde_json::json;

    fn config(kind: &str, sampling: Option<SamplingParams>) -> LlmProviderConfig {
        LlmProviderConfig {
            kind: kind.to_owned(),
            base_url: "https://api.example.com/v1".to_owned(),
            model: "test-model".to_owned(),
            api_key: "sk-test".to_owned(),
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
    fn both_payloads_ask_for_a_stream() {
        // The whole point of this module's shape: a non-streaming POST makes a
        // buffering gateway hold an unbounded generation, and one real proxy
        // answered that with an instant 408. Never regress to stream-less.
        let messages = vec![ChatMessage {
            role: "user".to_owned(),
            content: "hi".to_owned(),
        }];
        let openai = openai_payload(&config("openai", None), &None, &messages);
        assert_eq!(openai["stream"], json!(true));
        let anthropic = anthropic_payload(&config("anthropic", None), &None, &messages);
        assert_eq!(anthropic["stream"], json!(true));
    }

    #[test]
    fn openai_omits_max_tokens_unless_the_caller_sets_one() {
        // The provider's own maximum is always right and never guessable from
        // here; a number invented in this app truncates a drafted card mid-JSON
        // when low, and 400s when above the model's OUTPUT ceiling — which is a
        // different, much smaller limit than its context window.
        let messages = vec![ChatMessage {
            role: "user".to_owned(),
            content: "hi".to_owned(),
        }];
        let mut uncapped = config("openai", None);
        uncapped.max_tokens = None;
        let body = openai_payload(&uncapped, &None, &messages);
        assert!(body.get("max_tokens").is_none());

        let capped = openai_payload(&config("openai", None), &None, &messages);
        assert_eq!(capped["max_tokens"], json!(1024));
    }

    #[test]
    fn anthropic_always_carries_max_tokens_because_that_api_requires_it() {
        let messages = vec![ChatMessage {
            role: "user".to_owned(),
            content: "hi".to_owned(),
        }];
        let mut uncapped = config("anthropic", None);
        uncapped.max_tokens = None;
        let body = anthropic_payload(&uncapped, &None, &messages);
        assert_eq!(body["max_tokens"], json!(ANTHROPIC_DEFAULT_MAX_TOKENS));
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
    fn sse_lines_survive_chunks_that_split_multibyte_text() {
        // A network chunk may cut a CJK character in half; the line buffer heals
        // it because 0x0A never appears inside a UTF-8 sequence.
        let mut buffer: Vec<u8> = Vec::new();
        let whole = "data: {\"t\":\"夜航灯塔\"}\n".as_bytes();
        let (first, second) = whole.split_at(12); // mid-way through the CJK bytes
        buffer.extend_from_slice(first);
        assert!(
            drain_sse_data_lines(&mut buffer).is_empty(),
            "no full line yet"
        );
        buffer.extend_from_slice(second);
        let lines = drain_sse_data_lines(&mut buffer);
        assert_eq!(lines, vec!["{\"t\":\"夜航灯塔\"}".to_owned()]);
    }

    #[test]
    fn sse_lines_skip_comments_events_and_crlf() {
        let mut buffer =
            b": keep-alive\r\nevent: message_start\r\ndata: {\"a\":1}\r\n\r\n".to_vec();
        let lines = drain_sse_data_lines(&mut buffer);
        assert_eq!(lines, vec!["{\"a\":1}".to_owned()]);
    }

    #[test]
    fn openai_pieces_extract_text_done_and_errors() {
        let text = openai_stream_piece(r#"{"choices":[{"delta":{"content":"hi"}}]}"#).unwrap();
        assert!(matches!(text, StreamPiece::Text(t) if t == "hi"));
        let role_only = openai_stream_piece(r#"{"choices":[{"delta":{"role":"assistant"}}]}"#);
        assert!(matches!(role_only.unwrap(), StreamPiece::Nothing));
        // A reasoning model thinks in `reasoning_content` deltas long before
        // the first visible token: not text, but a liveness heartbeat.
        let reasoning = openai_stream_piece(
            r#"{"choices":[{"delta":{"role":"assistant","reasoning_content":"The"}}]}"#,
        );
        assert!(matches!(reasoning.unwrap(), StreamPiece::Nothing));
        assert!(matches!(
            openai_stream_piece("[DONE]").unwrap(),
            StreamPiece::Done
        ));
        let error = openai_stream_piece(r#"{"error":{"message":"boom"}}"#);
        assert!(error.is_err(), "a data-line error is fatal, not text");
    }

    #[test]
    fn anthropic_pieces_extract_text_stop_and_errors() {
        let text = anthropic_stream_piece(
            r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}"#,
        )
        .unwrap();
        assert!(matches!(text, StreamPiece::Text(t) if t == "hi"));
        let stop = anthropic_stream_piece(r#"{"type":"message_stop"}"#).unwrap();
        assert!(matches!(stop, StreamPiece::Done));
        let other = anthropic_stream_piece(r#"{"type":"message_start"}"#).unwrap();
        assert!(matches!(other, StreamPiece::Nothing));
        assert!(anthropic_stream_piece(r#"{"type":"error","error":{"message":"boom"}}"#).is_err());
    }

    #[test]
    fn the_fallback_buffer_keeps_a_card_sized_body_whole() {
        // The fallback parses the WHOLE body: an early cut kept only a
        // 2400-byte snippet, so every card-sized completion overflowed it and
        // the recovery failed exactly where it was meant to help. Feed a body
        // far past that size in awkward chunks — one of them splitting a CJK
        // character — and the parse must still see one intact document.
        let long_card = format!("{}「夜航灯塔」{}", "x".repeat(3000), "y".repeat(3000));
        let body = format!("{{\"choices\":[{{\"message\":{{\"content\":\"{long_card}\"}}}}]}}");
        let bytes = body.as_bytes();
        let mut raw = super::RawBody::new();
        let mut at = 0;
        for size in [7usize, 3001, 1, 2, 4096] {
            let end = (at + size).min(bytes.len());
            raw.push(&bytes[at..end]);
            at = end;
        }
        raw.push(&bytes[at..]);
        let recovered = non_streaming_text(&raw.text()).expect("whole body parses");
        assert_eq!(recovered, long_card);
    }

    #[test]
    fn the_fallback_buffer_is_capped_not_unbounded() {
        let mut raw = super::RawBody::new();
        let chunk = vec![b'a'; 1024 * 1024];
        for _ in 0..10 {
            raw.push(&chunk);
        }
        assert_eq!(raw.text().len(), super::RAW_BODY_CAP);
    }

    #[test]
    fn a_non_streaming_peer_is_recovered_not_failed() {
        // `stream: true` is a request, not a contract: an OpenAI-compatible
        // gateway may answer with one ordinary completion body. Both shapes.
        let openai = r#"{"choices":[{"message":{"content":"whole"}}]}"#;
        assert_eq!(non_streaming_text(openai).unwrap(), "whole");
        let anthropic = r#"{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}"#;
        assert_eq!(non_streaming_text(anthropic).unwrap(), "ab");
        assert!(non_streaming_text("not json").is_none());
    }
}
