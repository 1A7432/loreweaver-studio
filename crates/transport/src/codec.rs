//! Incremental newline-delimited JSON framing.
//!
//! The control stream is one long-lived QUIC bidirectional stream carrying one
//! compact `{...}\n` JSON object per line. The server caps lines at 1 MiB; we
//! enforce the same bound so a misbehaving peer cannot grow the buffer forever.

use serde_json::Value;

/// Maximum accepted line length, matching the server's cap.
pub const MAX_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    #[error("frame line exceeds {MAX_LINE_BYTES} bytes")]
    LineTooLong,
}

/// Feed raw stream chunks in, get parsed JSON object frames out.
///
/// Non-JSON and non-object lines are dropped silently: the transport is
/// untrusted and a garbled line must never wedge the connection. An oversized
/// line is a protocol violation and surfaces as an error so the caller can
/// tear the connection down.
#[derive(Debug, Default)]
pub struct LineDecoder {
    buf: Vec<u8>,
}

impl LineDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, DecodeError> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        while let Some(pos) = self.buf.iter().position(|&b| b == b'\n') {
            if pos > MAX_LINE_BYTES {
                self.buf.clear();
                return Err(DecodeError::LineTooLong);
            }
            let line: Vec<u8> = self.buf.drain(..=pos).collect();
            let line = &line[..line.len() - 1];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if line.is_empty() {
                continue;
            }
            if let Ok(value) = serde_json::from_slice::<Value>(line) {
                if value.is_object() {
                    frames.push(value);
                }
            }
        }
        if self.buf.len() > MAX_LINE_BYTES {
            self.buf.clear();
            return Err(DecodeError::LineTooLong);
        }
        Ok(frames)
    }
}

/// Encode one frame as a compact JSON line.
pub fn encode_line(frame: &Value) -> Vec<u8> {
    let mut out = serde_json::to_vec(frame).expect("a JSON value always serializes");
    out.push(b'\n');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn splits_multiple_frames_in_one_chunk() {
        let mut dec = LineDecoder::new();
        let frames = dec.push(b"{\"type\":\"a\"}\n{\"type\":\"b\"}\n").unwrap();
        assert_eq!(frames, vec![json!({"type": "a"}), json!({"type": "b"})]);
    }

    #[test]
    fn reassembles_frames_split_across_chunks() {
        let mut dec = LineDecoder::new();
        assert!(dec.push(b"{\"type\":\"wel").unwrap().is_empty());
        assert!(dec.push(b"come\",\"room\"").unwrap().is_empty());
        let frames = dec.push(b":\"r1\"}\n").unwrap();
        assert_eq!(frames, vec![json!({"type": "welcome", "room": "r1"})]);
    }

    #[test]
    fn tolerates_crlf_and_blank_lines() {
        let mut dec = LineDecoder::new();
        let frames = dec
            .push(b"{\"type\":\"a\"}\r\n\n\r\n{\"type\":\"b\"}\n")
            .unwrap();
        assert_eq!(frames.len(), 2);
    }

    #[test]
    fn drops_garbage_and_non_object_lines() {
        let mut dec = LineDecoder::new();
        let frames = dec
            .push(b"not json\n[1,2]\n42\n{\"type\":\"ok\"}\n")
            .unwrap();
        assert_eq!(frames, vec![json!({"type": "ok"})]);
    }

    #[test]
    fn rejects_oversized_terminated_line() {
        let mut dec = LineDecoder::new();
        let mut big = vec![b'x'; MAX_LINE_BYTES + 1];
        big.push(b'\n');
        assert_eq!(dec.push(&big), Err(DecodeError::LineTooLong));
        // The decoder stays usable after the reset.
        assert_eq!(dec.push(b"{\"type\":\"ok\"}\n").unwrap().len(), 1);
    }

    #[test]
    fn rejects_oversized_unterminated_line() {
        let mut dec = LineDecoder::new();
        let big = vec![b'x'; MAX_LINE_BYTES + 1];
        assert_eq!(dec.push(&big), Err(DecodeError::LineTooLong));
    }

    #[test]
    fn encode_appends_newline() {
        let bytes = encode_line(&json!({"type": "input", "text": "hi"}));
        assert!(bytes.ends_with(b"\n"));
        assert_eq!(
            serde_json::from_slice::<Value>(&bytes[..bytes.len() - 1]).unwrap(),
            json!({"type": "input", "text": "hi"}),
        );
    }
}
