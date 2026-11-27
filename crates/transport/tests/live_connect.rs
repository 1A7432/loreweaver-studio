//! The live-connect smoke gate: one test that dials a REAL protocol 3.0 server
//! through the real link and walks the start of a session by hand: `hello`,
//! `welcome`, a ping, and a byte-channel GET the server must refuse with its
//! code.
//!
//! Ignored by default — it needs a server process — and driven by
//! `scripts/check_live_connect.sh`, which starts the engine's Bun server from
//! the sibling checkout (`serve --local`, a throwaway data directory) and
//! passes its ticket and first admin key through the environment:
//!
//! ```text
//! LOREWEAVER_LIVE_TICKET=endpoint…  LOREWEAVER_LIVE_KEY=…  \
//!   cargo test -p loreweaver-transport --test live_connect -- --ignored --nocapture
//! ```
//!
//! `LOREWEAVER_LIVE_NETWORK` picks the endpoint profile (`local`, the
//! default, for a `serve --local` server; `n0` for a server dialled over the
//! relays).
//!
//! Why it exists: a hand-written server agrees with whatever the client
//! believes. Only a real server catches an ALPN, framing or byte-channel
//! drift between the two repositories.

use std::time::Duration;

use loreweaver_transport::link::{connect, LinkEvent, LinkParams, LinkStatus, NetworkProfile};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

/// Generous: a cold server may still be warming its first room.
const DEADLINE: Duration = Duration::from_secs(60);
/// A hash nobody holds.
const MISSING: &str = "0000000000000000000000000000000000000000000000000000000000000000";

async fn next(rx: &mut UnboundedReceiver<LinkEvent>, what: &str) -> LinkEvent {
    tokio::time::timeout(DEADLINE, rx.recv())
        .await
        .unwrap_or_else(|_| panic!("no {what} within {DEADLINE:?}"))
        .unwrap_or_else(|| panic!("the link ended before {what}"))
}

/// The next frame of `type`; frames of other types (a replayed event, a
/// `turn` signal) are skipped, a status or an `error` frame fails the gate.
async fn frame_of(rx: &mut UnboundedReceiver<LinkEvent>, kind: &str) -> Value {
    loop {
        match next(rx, kind).await {
            LinkEvent::Frame { frame } => {
                println!("<- {frame}");
                match frame.get("type").and_then(Value::as_str) {
                    Some(t) if t == kind => return frame,
                    Some("error") => panic!("the server refused: {frame}"),
                    _ => continue,
                }
            }
            LinkEvent::Status {
                status,
                code,
                reason,
            } => panic!("waiting for {kind}, the link went {status:?} ({code:?}: {reason:?})"),
        }
    }
}

#[tokio::test]
#[ignore = "needs a live protocol 3.0 server; run via scripts/check_live_connect.sh"]
async fn a_live_server_welcomes_us_pongs_and_refuses_a_missing_file_with_its_code() {
    let ticket = std::env::var("LOREWEAVER_LIVE_TICKET")
        .expect("LOREWEAVER_LIVE_TICKET must name a running server's endpoint ticket");
    let key = std::env::var("LOREWEAVER_LIVE_KEY")
        .expect("LOREWEAVER_LIVE_KEY must carry a key from the server's keystore");
    let network = match std::env::var("LOREWEAVER_LIVE_NETWORK").as_deref() {
        Ok("n0") => NetworkProfile::N0,
        _ => NetworkProfile::Local,
    };

    let (handle, mut rx) = connect(LinkParams {
        ticket: ticket.trim().to_owned(),
        network,
    });
    for expected in [LinkStatus::Connecting, LinkStatus::Up] {
        match next(&mut rx, "a status").await {
            LinkEvent::Status { status, .. } if status == expected => {}
            other => panic!("expected {expected:?}, got {other:?}"),
        }
    }

    // The link wrote nothing: this hello is the first line the server sees.
    let hello = json!({
        "type": "hello",
        "protocol": "3.0",
        "key": key.trim(),
        "name": "live-connect-gate",
        "locale": "en",
        "client": {"name": "loreweaver-studio", "version": env!("CARGO_PKG_VERSION")},
        "caps": [],
    });
    handle.send_frame(hello).await.expect("hello is written");
    let welcome = frame_of(&mut rx, "welcome").await;
    let protocol = welcome["protocol"].as_str().unwrap_or_default();
    assert_eq!(
        protocol.split('.').next(),
        Some("3"),
        "the server must speak protocol major 3: {welcome}"
    );
    assert_eq!(welcome["you"]["name"], "live-connect-gate");
    assert_eq!(
        welcome["you"]["role"], "admin",
        "the first key of a fresh data directory is the room admin's"
    );
    assert!(welcome["room"]["id"].is_string(), "{welcome}");
    assert!(
        welcome["epoch"].is_u64() && welcome["head"].is_u64(),
        "{welcome}"
    );

    handle
        .send_frame(json!({"type": "ping", "t": 42}))
        .await
        .expect("ping is written");
    assert_eq!(
        frame_of(&mut rx, "pong").await,
        json!({"type": "pong", "t": 42})
    );

    let refused = tokio::time::timeout(DEADLINE, handle.fetch(MISSING.to_owned()))
        .await
        .expect("the GET is answered in time")
        .expect_err("nobody holds that hash");
    println!("GET {MISSING}: {refused}");
    assert_eq!(refused.code(), "media_not_found", "{refused}");

    handle.close();
    match next(&mut rx, "closed").await {
        LinkEvent::Status {
            status: LinkStatus::Closed,
            code: None,
            ..
        } => {}
        other => panic!("expected our own close, got {other:?}"),
    }
}
