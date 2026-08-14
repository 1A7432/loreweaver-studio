//! The minimal frame vocabulary the transport layer itself must understand.
//!
//! Everything else passes through opaque to the frontend, which owns the full
//! typed protocol surface via `@loreweaver/protocol`.

use serde_json::{json, Value};

/// ALPN both ends negotiate. It names the FRAMING, not the JSON protocol
/// version, and is frozen independently of it — mirror of the engine's
/// `net/iroh_server.py` (`ALPN = b"loreweaver/tui/1"`, "bump if the framing
/// (not the JSON protocol) changes"). Do not follow the wire version here.
pub const ALPN: &[u8] = b"loreweaver/tui/1";

pub fn frame_type(frame: &Value) -> Option<&str> {
    frame.get("type")?.as_str()
}

/// Build the mandatory first frame. The server authenticates on `key` alone;
/// `name` is advisory (the keystore name wins server-side).
pub fn join_frame(key: &str, name: Option<&str>, client_name: &str, client_version: &str) -> Value {
    let mut frame = json!({
        "type": "join",
        "key": key,
        "client": { "name": client_name, "version": client_version },
    });
    if let Some(name) = name {
        frame["name"] = json!(name);
    }
    frame
}

/// Error codes that terminate the session server-side. They only ever happen
/// during or before the join handshake; an automatic redial would just repeat
/// the failure, so the client must stop and surface them.
pub fn is_fatal_error_code(code: &str) -> bool {
    matches!(code, "bad_key" | "join_timeout" | "too_many_connections")
}

/// The server-initiated keepalive: a `ping {t}` is answered with `pong {t}`
/// inside the transport, without bothering the frontend.
pub fn ping_reply(frame: &Value) -> Option<Value> {
    if frame_type(frame)? != "ping" {
        return None;
    }
    Some(json!({ "type": "pong", "t": frame.get("t")?.clone() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn join_frame_carries_key_and_client_info() {
        let frame = join_frame("secret", Some("Nyx"), "studio", "0.1.0");
        assert_eq!(frame["type"], "join");
        assert_eq!(frame["key"], "secret");
        assert_eq!(frame["name"], "Nyx");
        assert_eq!(frame["client"]["name"], "studio");
        assert_eq!(frame["client"]["version"], "0.1.0");
    }

    #[test]
    fn join_frame_omits_absent_name() {
        let frame = join_frame("secret", None, "studio", "0.1.0");
        assert!(frame.get("name").is_none());
    }

    #[test]
    fn classifies_fatal_error_codes() {
        for fatal in ["bad_key", "join_timeout", "too_many_connections"] {
            assert!(is_fatal_error_code(fatal));
        }
        for recoverable in [
            "bad_frame",
            "rate_limited",
            "input_too_long",
            "server_error",
        ] {
            assert!(!is_fatal_error_code(recoverable));
        }
    }

    #[test]
    fn ping_gets_a_matching_pong() {
        let pong = ping_reply(&json!({"type": "ping", "t": 42})).unwrap();
        assert_eq!(pong, json!({"type": "pong", "t": 42}));
        assert!(ping_reply(&json!({"type": "narrative"})).is_none());
        assert!(ping_reply(&json!({"type": "ping"})).is_none());
    }
}
