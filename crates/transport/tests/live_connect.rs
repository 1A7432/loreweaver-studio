//! The live-connect smoke gate: one test that dials a REAL `--serve` engine
//! through the real transport crate and asserts the handshake completes.
//!
//! Ignored by default — it needs an engine process — and driven by
//! `scripts/check_live_connect.sh`, which spawns the engine from the sibling
//! checkout and passes its ticket and keeper key through the environment:
//!
//! ```text
//! LOREWEAVER_LIVE_TICKET=endpoint…  LOREWEAVER_LIVE_KEY=…  \
//!   cargo test -p loreweaver-transport --test live_connect -- --ignored --nocapture
//! ```
//!
//! Why it exists: the transport used to refuse every welcome that did not
//! announce protocol major 1, and no test in either repo ever connected to a
//! real engine, so the refusal went unnoticed across a whole major bump. Unit
//! tests with a hand-written server cannot catch that class of bug — only a
//! real engine announcing its real version can.

use std::time::Duration;

use loreweaver_transport::client::{
    connect, ConnStatus, ConnectParams, NetworkProfile, TransportEvent,
};

/// Generous: a cold engine binds an endpoint and reaches a relay first.
const DEADLINE: Duration = Duration::from_secs(60);

#[tokio::test]
#[ignore = "needs a live `python -m app --serve` engine; run via scripts/check_live_connect.sh"]
async fn live_engine_welcome_reaches_the_event_channel() {
    let ticket = std::env::var("LOREWEAVER_LIVE_TICKET")
        .expect("LOREWEAVER_LIVE_TICKET must name a running engine's endpoint ticket");
    let key = std::env::var("LOREWEAVER_LIVE_KEY")
        .expect("LOREWEAVER_LIVE_KEY must carry a key from the engine's keystore");

    let (handle, mut rx) = connect(ConnectParams {
        ticket: ticket.trim().to_owned(),
        key: key.trim().to_owned(),
        name: Some("live-connect-gate".to_owned()),
        client_name: "loreweaver-studio".to_owned(),
        client_version: env!("CARGO_PKG_VERSION").to_owned(),
        // The engine serves on `preset_n0`; the gate dials the way the app does
        // rather than through the hermetic loopback profile, so a regression in
        // the production dial path fails here too.
        network: NetworkProfile::N0,
    });

    let deadline = tokio::time::Instant::now() + DEADLINE;
    let mut welcome = None;
    let mut online = false;
    while welcome.is_none() || !online {
        let event = tokio::time::timeout_at(deadline, rx.recv())
            .await
            .expect("the engine answered before the deadline")
            .expect("the transport actor stayed alive");
        match event {
            TransportEvent::Frame { frame } => {
                let kind = frame.get("type").and_then(|v| v.as_str()).unwrap_or("");
                assert_ne!(
                    kind, "error",
                    "the engine refused the join: {frame} — is the key from its keystore?"
                );
                if kind == "welcome" {
                    welcome = Some(frame);
                }
            }
            TransportEvent::Status { status, error, .. } => {
                assert_ne!(
                    status,
                    ConnStatus::Offline,
                    "the transport gave up before the handshake completed: {error:?}"
                );
                if status == ConnStatus::Online {
                    online = true;
                }
            }
        }
    }

    let welcome = welcome.expect("loop only exits with a welcome");
    let protocol = welcome
        .get("protocol")
        .and_then(|v| v.as_str())
        .expect("welcome carries a protocol banner");
    println!("live welcome: {welcome}");

    // The point of the gate. The frontend (`store/connection.ts`) accepts any
    // welcome whose MAJOR matches the installed `@loreweaver/protocol`; if the
    // transport ever again refuses one the frontend would accept, the loop
    // above sees Offline and fails. Pinning 2.x on top keeps the gate honest
    // about which engine line it was actually run against.
    assert_eq!(
        protocol.split('.').next(),
        Some("2"),
        "engine announced protocol {protocol:?}; the studio targets the 2.x line"
    );
    assert!(
        welcome.get("room").is_some(),
        "welcome is missing its room: {welcome}"
    );
    assert!(
        welcome.get("you").is_some(),
        "welcome is missing the identity block: {welcome}"
    );

    handle.close();
}
