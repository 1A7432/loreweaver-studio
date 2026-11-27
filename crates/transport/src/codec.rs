//! Incremental newline-delimited JSON framing (protocol 3.0 §2.2).
//!
//! The control stream is one long-lived QUIC bidirectional stream carrying one
//! compact `{...}\n` JSON object per line, in both directions. A line is
//! bounded so a misbehaving peer cannot grow the buffer forever; over the
//! bound is a torn connection, never a truncated frame.

use serde_json::Value;

/// Maximum accepted line length: what the reference terminal client accepts
/// (`clients/tui/src/irohLink.ts` `MAX_LINE_BYTES`). A 3.0 view value alone
/// may be 512 KiB and a narrative text 200,000 characters (up to four bytes
/// each), so the 2.x 1 MiB bound is too tight.
pub const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, PartialEq, Eq, thiserror::Error)]
pub enum DecodeError {
    #[error("frame line exceeds {MAX_LINE_BYTES} bytes")]
    LineTooLong,
}

/// Feed raw stream chunks in, get parsed JSON object frames out.
///
/// Non-JSON and non-object lines are dropped silently: the transport is
/// untrusted and a garbled line must never wedge the connection (what a frame
/// MEANS is the protocol session's business, in the WebView). An oversized
/// line is a protocol violation and surfaces as an error so the caller can
/// tear the connection down.
#[derive(Debug, Default)]
pub struct LineDecoder {
    buf: Vec<u8>,
    /// How much of `buf` is already known to hold no newline: a long line
    /// arriving in many chunks is scanned once, not once per chunk.
    scanned: usize,
}

impl LineDecoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<Value>, DecodeError> {
        self.buf.extend_from_slice(chunk);
        let mut frames = Vec::new();
        let mut start = 0;
        while let Some(found) = self.buf[self.scanned..].iter().position(|&b| b == b'\n') {
            let end = self.scanned + found;
            if end - start > MAX_LINE_BYTES {
                self.reset();
                return Err(DecodeError::LineTooLong);
            }
            let line = &self.buf[start..end];
            let line = line.strip_suffix(b"\r").unwrap_or(line);
            if !line.is_empty() {
                if let Ok(value) = serde_json::from_slice::<Value>(line) {
                    if value.is_object() {
                        frames.push(value);
                    }
                }
            }
            start = end + 1;
            self.scanned = start;
        }
        self.buf.drain(..start);
        self.scanned = self.buf.len();
        if self.buf.len() > MAX_LINE_BYTES {
            self.reset();
            return Err(DecodeError::LineTooLong);
        }
        Ok(frames)
    }

    fn reset(&mut self) {
        self.buf.clear();
        self.scanned = 0;
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
    fn a_line_of_exactly_the_cap_is_accepted_in_many_chunks() {
        let mut dec = LineDecoder::new();
        let prefix = b"{\"t\":\"";
        let suffix = b"\"}";
        let filler = MAX_LINE_BYTES - prefix.len() - suffix.len();
        let mut line = prefix.to_vec();
        line.extend(std::iter::repeat_n(b'x', filler));
        line.extend_from_slice(suffix);
        assert_eq!(line.len(), MAX_LINE_BYTES);
        line.push(b'\n');
        let mut frames = Vec::new();
        for chunk in line.chunks(64 * 1024) {
            frames.extend(dec.push(chunk).expect("within the cap"));
        }
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0]["t"].as_str().map(str::len), Some(filler));
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
