//! The byte channel (protocol 3.0 §11): content-addressed GET and PUT, each on
//! a bidirectional stream of its own beside the control stream.
//!
//! ```text
//! GET  client: {"op":"get","hash":"<64 hex>"}\n             (then finishes its side)
//!      server: {"op":"get","ok":true,"hash","size","mime","name"}\n then exactly `size` bytes
//! PUT  client: {"op":"put","upload_id":"<id>"}\n then exactly the offered bytes, then finishes
//!      server: {"op":"put","ok":true,"hash","size","mime","name"}\n
//! err  server: {"ok":false,"code":"<stable code>","message":"<in the member's language>"}\n
//! ```
//!
//! Every read is bounded: the reply header by [`MAX_BYTE_HEADER_BYTES`], a GET
//! body by the size its header declared (itself capped by the ceiling the
//! caller named — [`crate::MAX_BLOB_BYTES`] unless it is a room save), and a stream that sends one byte more than it
//! promised is an error. A read that waits longer than the stall bound for
//! anything at all gives up as `stalled`. The bytes are not hashed here: the
//! caller verifies them where it stores them (`src-tauri`'s verified caches).
//!
//! The shapes and limits mirror the protocol package's `bytes.ts`; the
//! operations mirror the terminal client's `byteGet` / `bytePut`.

use std::time::Duration;

use iroh::endpoint::{RecvStream, SendStream};
use serde_json::{json, Value};

use crate::codec::encode_line;
use crate::limits::accepted_size;

/// Byte streams one connection may have open at once (the control stream not
/// counted). More are queued in order, never refused.
pub const MAX_BYTE_STREAMS: usize = 4;
/// The longest reply header line, in bytes, newline included.
pub const MAX_BYTE_HEADER_BYTES: usize = 2048;
/// How long one read may wait for anything before the stream counts as stalled.
pub const BYTE_STALL: Duration = Duration::from_secs(30);
/// The most asked of one read, and the most written in one write.
pub const BYTE_CHUNK: usize = 64 * 1024;
/// The longest `upload_id` the protocol hands out, in characters.
pub const MAX_UPLOAD_ID_CHARS: usize = 64;

/// What a stream's answer says about the file: the GET header or the PUT receipt.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
pub struct ByteFile {
    pub hash: String,
    pub size: u64,
    pub mime: String,
    pub name: String,
}

/// A file fetched by GET: what the server said about it, and exactly its bytes
/// (not yet checked against the hash — the caller does that).
#[derive(Debug, Clone)]
pub struct FetchedFile {
    pub file: ByteFile,
    pub bytes: Vec<u8>,
}

/// A byte operation that failed. `Server` carries the server's own error line
/// (its message is already in the member's language); every other variant is
/// this client's verdict. `Display` starts with the stable code.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ByteError {
    #[error("{code}: {message}")]
    Server { code: String, message: String },
    /// There is no live link to open a stream on.
    #[error("not_connected")]
    NotConnected,
    /// The hash asked for is not 64 lowercase hex digits; nothing was sent.
    #[error("bad_hash")]
    BadHash,
    /// The upload id is not 1–64 characters; nothing was sent.
    #[error("bad_upload_id")]
    BadUploadId,
    /// The reply header is not a reply this channel knows, is for another
    /// operation or another file, or is over the header limit.
    #[error("bad_reply: {0}")]
    BadReply(String),
    /// The GET header declares more than this client accepts.
    #[error("too_large: {0}")]
    TooLarge(String),
    /// The stream carried more bytes than its header promised.
    #[error("too_much")]
    TooMuch,
    /// The stream ended before everything promised arrived.
    #[error("stream_ended")]
    StreamEnded,
    /// Nothing arrived within the stall bound.
    #[error("stalled")]
    Stalled,
    /// The whole operation outran its end-to-end bound.
    #[error("timeout")]
    Timeout,
}

impl ByteError {
    /// The stable code, for programs (the `Display` text starts with it too).
    pub fn code(&self) -> &str {
        match self {
            Self::Server { code, .. } => code,
            Self::NotConnected => "not_connected",
            Self::BadHash => "bad_hash",
            Self::BadUploadId => "bad_upload_id",
            Self::BadReply(_) => "bad_reply",
            Self::TooLarge(_) => "too_large",
            Self::TooMuch => "too_much",
            Self::StreamEnded => "stream_ended",
            Self::Stalled => "stalled",
            Self::Timeout => "timeout",
        }
    }
}

/// Whether `value` is a content hash as the protocol writes one.
pub fn is_content_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// Whether `value` may be sent as an `upload_id`.
pub fn is_upload_id(value: &str) -> bool {
    let chars = value.chars().count();
    (1..=MAX_UPLOAD_ID_CHARS).contains(&chars)
}

/// The `{op:"get"}` request line.
pub fn get_request(hash: &str) -> Vec<u8> {
    encode_line(&json!({ "op": "get", "hash": hash }))
}

/// The `{op:"put"}` request line.
pub fn put_request(upload_id: &str) -> Vec<u8> {
    encode_line(&json!({ "op": "put", "upload_id": upload_id }))
}

/// A parsed reply header for operation `op`: the file it describes, or the
/// coded failure it carries.
pub fn decode_reply(value: &Value, op: &str) -> Result<ByteFile, ByteError> {
    let Some(record) = value.as_object() else {
        return Err(ByteError::BadReply("not an object".to_owned()));
    };
    if record.get("ok") == Some(&Value::Bool(false)) {
        return match (
            record.get("code").and_then(Value::as_str),
            record.get("message").and_then(Value::as_str),
        ) {
            (Some(code), Some(message)) => Err(ByteError::Server {
                code: code.to_owned(),
                message: message.to_owned(),
            }),
            _ => Err(ByteError::BadReply(
                "an error reply without code and message".to_owned(),
            )),
        };
    }
    if record.get("ok") != Some(&Value::Bool(true)) {
        return Err(ByteError::BadReply("no ok field".to_owned()));
    }
    let said = record.get("op").and_then(Value::as_str).unwrap_or("");
    if said != op {
        return Err(ByteError::BadReply(format!("a {said:?} reply to a {op:?}")));
    }
    let hash = record.get("hash").and_then(Value::as_str);
    let size = record.get("size").and_then(Value::as_u64);
    let mime = record.get("mime").and_then(Value::as_str);
    let name = record.get("name").and_then(Value::as_str);
    match (hash, size, mime, name) {
        (Some(hash), Some(size), Some(mime), Some(name)) if is_content_hash(hash) => Ok(ByteFile {
            hash: hash.to_owned(),
            size,
            mime: mime.to_owned(),
            name: name.to_owned(),
        }),
        _ => Err(ByteError::BadReply(
            "a reply without hash, size, mime and name".to_owned(),
        )),
    }
}

/// One read, given up on as `stalled` when nothing arrives within `stall`;
/// `None` at the end of the stream. A reset stream reads as its end: what was
/// missing is said by the caller.
async fn read_some(
    recv: &mut RecvStream,
    buf: &mut [u8],
    stall: Duration,
) -> Result<Option<usize>, ByteError> {
    match tokio::time::timeout(stall, recv.read(buf)).await {
        Err(_) => Err(ByteError::Stalled),
        Ok(Ok(Some(n))) => Ok(Some(n)),
        Ok(Ok(None)) | Ok(Err(_)) => Ok(None),
    }
}

/// The one reply header of a stream, and whatever body bytes came with it.
async fn read_header(
    recv: &mut RecvStream,
    op: &str,
    stall: Duration,
) -> Result<(ByteFile, Vec<u8>), ByteError> {
    let mut buf: Vec<u8> = Vec::new();
    let mut chunk = vec![0u8; BYTE_CHUNK];
    loop {
        if let Some(at) = buf.iter().position(|&b| b == b'\n') {
            if at + 1 > MAX_BYTE_HEADER_BYTES {
                return Err(ByteError::BadReply("header over the limit".to_owned()));
            }
            let value: Value = serde_json::from_slice(&buf[..at])
                .map_err(|_| ByteError::BadReply("header is not JSON".to_owned()))?;
            let file = decode_reply(&value, op)?;
            return Ok((file, buf[at + 1..].to_vec()));
        }
        if buf.len() >= MAX_BYTE_HEADER_BYTES {
            return Err(ByteError::BadReply("header over the limit".to_owned()));
        }
        match read_some(recv, &mut chunk, stall).await? {
            Some(n) => buf.extend_from_slice(&chunk[..n]),
            None => return Err(ByteError::StreamEnded),
        }
    }
}

/// The stream must end here: one byte more than promised is a fault.
async fn expect_end(recv: &mut RecvStream, stall: Duration) -> Result<(), ByteError> {
    let mut one = [0u8; 1];
    match read_some(recv, &mut one, stall).await? {
        Some(_) => Err(ByteError::TooMuch),
        None => Ok(()),
    }
}

fn stop_quietly(recv: &mut RecvStream) {
    let _ = recv.stop(0u32.into());
}

/// GET `hash` on a fresh stream: the request, the header, then exactly the
/// declared bytes and the end of the stream. A header declaring more than
/// `max` bytes is refused before the body is read.
pub async fn get(
    send: &mut SendStream,
    recv: &mut RecvStream,
    hash: &str,
    max: u64,
    stall: Duration,
) -> Result<FetchedFile, ByteError> {
    let result = async {
        send.write_all(&get_request(hash))
            .await
            .map_err(|_| ByteError::StreamEnded)?;
        // The request is the header line alone; finishing tells the server so.
        let _ = send.finish();
        let (file, rest) = read_header(recv, "get", stall).await?;
        if file.hash != hash {
            return Err(ByteError::BadReply(
                "the reply names another file".to_owned(),
            ));
        }
        let size = accepted_size(file.size, max).map_err(ByteError::TooLarge)?;
        if rest.len() > size {
            return Err(ByteError::TooMuch);
        }
        let mut body = rest;
        body.reserve_exact(size - body.len());
        let mut chunk = vec![0u8; BYTE_CHUNK];
        while body.len() < size {
            let want = (size - body.len()).min(BYTE_CHUNK);
            match read_some(recv, &mut chunk[..want], stall).await? {
                Some(n) => body.extend_from_slice(&chunk[..n]),
                None => return Err(ByteError::StreamEnded),
            }
        }
        expect_end(recv, stall).await?;
        Ok(FetchedFile { file, bytes: body })
    }
    .await;
    if result.is_err() {
        stop_quietly(recv);
    }
    result
}

/// PUT the bytes of an accepted offer on a fresh stream: the header line,
/// exactly `bytes` in chunks, the end of this side; then the one reply line.
/// When the server refuses part-way (it stops reading), its error line is what
/// the caller gets.
pub async fn put(
    send: &mut SendStream,
    recv: &mut RecvStream,
    upload_id: &str,
    bytes: &[u8],
    stall: Duration,
) -> Result<ByteFile, ByteError> {
    let wrote = async {
        send.write_all(&put_request(upload_id)).await?;
        for chunk in bytes.chunks(BYTE_CHUNK) {
            send.write_all(chunk).await?;
        }
        Ok::<_, iroh::endpoint::WriteError>(())
    }
    .await;
    // The server confirms the end of the body by reading the end of the stream.
    let _ = send.finish();
    let result = async {
        let (file, rest) = read_header(recv, "put", stall).await?;
        if wrote.is_err() {
            return Err(ByteError::StreamEnded);
        }
        if !rest.is_empty() {
            return Err(ByteError::TooMuch);
        }
        expect_end(recv, stall).await?;
        Ok(file)
    }
    .await;
    if result.is_err() {
        stop_quietly(recv);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    const HASH: &str = "3f9a0c7d2b1e4f5a6c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";

    #[test]
    fn the_limits_are_the_protocol_s() {
        // `loreweaver-protocol/v3` `bytes.ts`.
        assert_eq!(MAX_BYTE_STREAMS, 4);
        assert_eq!(MAX_BYTE_HEADER_BYTES, 2048);
        assert_eq!(BYTE_STALL, Duration::from_secs(30));
        assert_eq!(MAX_UPLOAD_ID_CHARS, 64);
    }

    #[test]
    fn requests_are_one_compact_line() {
        let get = String::from_utf8(get_request(HASH)).expect("utf-8");
        assert!(get.ends_with('\n') && !get.trim_end().contains('\n'));
        let value: Value = serde_json::from_str(get.trim_end()).expect("json");
        assert_eq!(value, json!({"op": "get", "hash": HASH}));
        let put = String::from_utf8(put_request("u-1")).expect("utf-8");
        assert!(put.ends_with('\n'));
        let value: Value = serde_json::from_str(put.trim_end()).expect("json");
        assert_eq!(value, json!({"op": "put", "upload_id": "u-1"}));
    }

    #[test]
    fn content_hashes_are_64_lowercase_hex() {
        assert!(is_content_hash(HASH));
        assert!(!is_content_hash(&HASH.to_uppercase()));
        assert!(!is_content_hash(&HASH[1..]));
        assert!(!is_content_hash("cafe"));
    }

    #[test]
    fn upload_ids_are_1_to_64_characters() {
        assert!(is_upload_id("u"));
        assert!(is_upload_id(&"x".repeat(64)));
        assert!(!is_upload_id(""));
        assert!(!is_upload_id(&"x".repeat(65)));
    }

    #[test]
    fn a_success_reply_describes_the_file() {
        let reply = json!({"op": "get", "ok": true, "hash": HASH, "size": 3, "mime": "image/png", "name": "a.png"});
        assert_eq!(
            decode_reply(&reply, "get"),
            Ok(ByteFile {
                hash: HASH.to_owned(),
                size: 3,
                mime: "image/png".to_owned(),
                name: "a.png".to_owned(),
            })
        );
    }

    #[test]
    fn an_error_reply_carries_the_server_s_code_and_words() {
        let reply = json!({"ok": false, "code": "media_not_found", "message": "No such file."});
        let err = decode_reply(&reply, "get").expect_err("an error line");
        assert_eq!(err.code(), "media_not_found");
        assert_eq!(err.to_string(), "media_not_found: No such file.");
    }

    #[test]
    fn replies_of_another_shape_are_bad() {
        for (reply, op) in [
            (
                json!({"op": "put", "ok": true, "hash": HASH, "size": 3, "mime": "m", "name": "n"}),
                "get",
            ),
            (
                json!({"op": "get", "hash": HASH, "size": 3, "mime": "m", "name": "n"}),
                "get",
            ),
            (
                json!({"op": "get", "ok": true, "hash": "cafe", "size": 3, "mime": "m", "name": "n"}),
                "get",
            ),
            (
                json!({"op": "get", "ok": true, "hash": HASH, "size": -1, "mime": "m", "name": "n"}),
                "get",
            ),
            (json!({"ok": false, "code": "x"}), "get"),
            // The 2.x shapes are not replies any more.
            (
                json!({"type": "error", "code": "media_not_found", "message": "gone"}),
                "get",
            ),
            (json!({"op": "put_ok", "hash": HASH}), "put"),
            (json!([1, 2]), "get"),
        ] {
            let err = decode_reply(&reply, op).expect_err("not a reply");
            assert_eq!(err.code(), "bad_reply", "{reply}");
        }
    }

    #[test]
    fn every_client_failure_has_a_stable_code_first_in_its_text() {
        for err in [
            ByteError::NotConnected,
            ByteError::BadHash,
            ByteError::BadUploadId,
            ByteError::BadReply("x".to_owned()),
            ByteError::TooLarge("x".to_owned()),
            ByteError::TooMuch,
            ByteError::StreamEnded,
            ByteError::Stalled,
            ByteError::Timeout,
        ] {
            assert!(err.to_string().starts_with(err.code()), "{err}");
        }
    }
}
