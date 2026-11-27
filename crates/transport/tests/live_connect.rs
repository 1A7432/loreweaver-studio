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
//! With `LOREWEAVER_LIVE_PACK` (a built `.lwpack` on the server's machine),
//! `LOREWEAVER_LIVE_PAGE_PANEL` (a page panel of it, `<pack>/<panel>`),
//! `LOREWEAVER_LIVE_PAGE` (the HTML file the studio wrote for that page) and
//! `LOREWEAVER_LIVE_PAGE_SHA256` (that file's digest), the session goes on:
//! the room admin installs the pack (`pack install`, which enables it here),
//! subscribes `panels`, and fetches the page over the byte channel by the hash
//! the `panels` view gives — which must be the studio file's digest, and the
//! bytes exactly the studio's file.
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

    if let Ok(pack) = std::env::var("LOREWEAVER_LIVE_PACK") {
        fetch_the_page(&handle, &mut rx, &pack).await;
    }

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

/// The `result` answering `rid`; every other frame is skipped.
async fn result_of(rx: &mut UnboundedReceiver<LinkEvent>, rid: &str) -> Value {
    loop {
        let frame = frame_of(rx, "result").await;
        if frame["rid"] == rid {
            return frame;
        }
    }
}

/// The page stage: install the pack, read the page's entry from `panels`, GET
/// the page by that hash, and compare with what the studio wrote.
async fn fetch_the_page(
    handle: &loreweaver_transport::link::LinkHandle,
    rx: &mut UnboundedReceiver<LinkEvent>,
    pack: &str,
) {
    let panel_id = std::env::var("LOREWEAVER_LIVE_PAGE_PANEL")
        .expect("LOREWEAVER_LIVE_PAGE_PANEL names the page panel");
    let written = std::fs::read(
        std::env::var("LOREWEAVER_LIVE_PAGE")
            .expect("LOREWEAVER_LIVE_PAGE names the studio's file"),
    )
    .expect("the studio's page file is readable");
    let digest = std::env::var("LOREWEAVER_LIVE_PAGE_SHA256")
        .expect("LOREWEAVER_LIVE_PAGE_SHA256 is the file's digest")
        .trim()
        .to_ascii_lowercase();

    handle
        .send_frame(json!({
            "type": "call",
            "rid": "page-install",
            "method": "command.run",
            "params": {"id": "pack", "args": {"op": "install", "ref": pack}},
        }))
        .await
        .expect("pack install is written");
    let installed = result_of(rx, "page-install").await;
    assert_eq!(
        installed["ok"], true,
        "the admin's pack install was refused: {installed}"
    );
    assert_eq!(installed["data"]["enabled"], true, "{installed}");

    handle
        .send_frame(json!({
            "type": "call",
            "rid": "page-panels",
            "method": "view.subscribe",
            "params": {"names": ["panels"]},
        }))
        .await
        .expect("the subscription is written");
    // The view frame and the subscription's result come in either order.
    let entry = loop {
        let frame = match next(rx, "the panels view").await {
            LinkEvent::Frame { frame } => frame,
            LinkEvent::Status { status, code, .. } => {
                panic!("waiting for panels, the link went {status:?} ({code:?})")
            }
        };
        if frame["type"] == "result" && frame["rid"] == "page-panels" {
            assert_eq!(frame["ok"], true, "{frame}");
            assert_eq!(frame["data"]["problems"], json!([]), "{frame}");
            continue;
        }
        if frame["type"] != "view" || frame["name"] != "panels" {
            continue;
        }
        println!("<- panels {}", frame["data"]);
        if let Some(entry) = frame["data"]["panels"]
            .as_array()
            .and_then(|panels| panels.iter().find(|p| p["id"] == panel_id.as_str()))
        {
            break entry.clone();
        }
    };
    assert_eq!(entry["kind"], "page", "{entry}");
    assert_eq!(entry["page"]["mime"], "text/html", "{entry}");
    let hash = entry["page"]["hash"]
        .as_str()
        .expect("a page hash")
        .to_owned();
    assert_eq!(
        hash, digest,
        "the panels view must name the page the studio wrote"
    );
    assert_eq!(entry["page"]["size"], written.len(), "{entry}");

    let fetched = tokio::time::timeout(DEADLINE, handle.fetch(hash.clone()))
        .await
        .expect("the GET is answered in time")
        .expect("a member of the room may fetch its page");
    assert_eq!(fetched.file.hash, hash);
    assert_eq!(fetched.file.mime, "text/html", "{:?}", fetched.file);
    assert!(
        fetched.bytes == written,
        "the fetched page is not the studio's file ({} bytes vs {})",
        fetched.bytes.len(),
        written.len()
    );
    println!(
        "GET {hash}: the page, {} bytes, as the studio wrote it",
        fetched.bytes.len()
    );
}
