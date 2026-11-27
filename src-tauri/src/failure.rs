//! What the byte-channel and file commands answer the WebView when they fail.
//!
//! A stable `code` the UI words in the person's language, and — when the SERVER refused (an
//! error line on the byte channel, `docs/protocol.md` §11.5) — the server's own `message`,
//! already in this member's language, which the UI shows as written. Every other failure is
//! this client's verdict: `server` is false and `message` is English detail for logs only.

use loreweaver_transport::bytes::ByteError;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Failure {
    pub code: String,
    pub message: String,
    pub server: bool,
}

impl Failure {
    /// A failure on this side of the link, under one of this client's codes.
    pub fn local(code: &str, detail: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: detail.into(),
            server: false,
        }
    }
}

impl From<ByteError> for Failure {
    fn from(error: ByteError) -> Self {
        match error {
            ByteError::Server { code, message } => Self {
                code,
                message,
                server: true,
            },
            other => Self::local(other.code(), other.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_refusal_keeps_its_own_words() {
        let failure = Failure::from(ByteError::Server {
            code: "media_disabled".to_owned(),
            message: "Uploads are off in this room.".to_owned(),
        });
        assert_eq!(
            failure,
            Failure {
                code: "media_disabled".to_owned(),
                message: "Uploads are off in this room.".to_owned(),
                server: true,
            }
        );
    }

    #[test]
    fn a_client_verdict_is_not_the_servers() {
        let failure = Failure::from(ByteError::Stalled);
        assert_eq!(failure.code, "stalled");
        assert!(!failure.server);
    }

    #[test]
    fn it_serializes_as_the_webview_reads_it() {
        let json = serde_json::to_value(Failure::local("bad_type", "x")).unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "code": "bad_type", "message": "x", "server": false })
        );
    }
}
