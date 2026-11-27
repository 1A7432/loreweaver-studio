//! The live gate of a room save: a save larger than one control-stream line (8 MiB) goes out of
//! a REAL protocol 3.0 server and back in through the app's own save code
//! (`loreweaver_studio_lib::save`: `fetch_to`, `prepare`, `send` — what the `save_fetch`,
//! `save_prepare` and `save_upload` commands run), over the REAL link. The control frames the
//! WebView's session sends (`command.run save`, `media.offer {purpose: "save"}`) are written
//! here by hand, as the other live gates do.
//!
//! 1. The room's own export, fetched and written by the app's code: a small save.
//! 2. That save grown past 8 MiB (narrative log entries, each within what a client takes of one
//!    text), offered, PUT and imported: the server ends the link; the test dials again.
//! 3. The room exported and fetched: over 8 MiB, written private to this user, and its content
//!    is what went in.
//! 4. The small save put back (so the room is small again), then the big file of 3. — the one
//!    the app wrote — offered, PUT and imported, and the room exported once more: the same
//!    content as before it went out and came back.
//!
//! Ignored by default — it needs a server process — and driven by `scripts/check_live_connect.sh`
//! (the live stage of the round-trip gate), with the same server and key as the link's gate:
//!
//! ```text
//! LOREWEAVER_LIVE_TICKET=endpoint…  LOREWEAVER_LIVE_KEY=…  LOREWEAVER_LIVE_NETWORK=local \
//!   cargo test -p loreweaver-studio --test save_live -- --ignored --nocapture
//! ```
//!
//! It replaces the room it is given: run it only against a throwaway server.

use std::path::{Path, PathBuf};
use std::time::Duration;

use loreweaver_studio_lib::save::{fetch_to, prepare, send, SAVE_MIME};
use loreweaver_transport::codec::MAX_LINE_BYTES;
use loreweaver_transport::link::{
    connect, LinkEvent, LinkHandle, LinkParams, LinkStatus, NetworkProfile,
};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

/// Generous: a big import is read and checked whole before the server answers.
const DEADLINE: Duration = Duration::from_secs(120);
/// Log entries added to grow the save, and the length of each one's text.
const ENTRIES: usize = 60;
const ENTRY_CHARS: usize = 180_000;
/// The server refills one message every two seconds once a member's burst is spent.
const RATE_WAIT: Duration = Duration::from_millis(2_100);
const RATE_RETRIES: usize = 10;

/// A scratch folder for the save files, removed even when the test fails.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

struct Live {
    ticket: String,
    key: String,
    network: NetworkProfile,
}

impl Live {
    fn from_env() -> Self {
        Self {
            ticket: std::env::var("LOREWEAVER_LIVE_TICKET")
                .expect("LOREWEAVER_LIVE_TICKET must name a running server's endpoint ticket")
                .trim()
                .to_owned(),
            key: std::env::var("LOREWEAVER_LIVE_KEY")
                .expect("LOREWEAVER_LIVE_KEY must carry the room admin's key")
                .trim()
                .to_owned(),
            network: match std::env::var("LOREWEAVER_LIVE_NETWORK").as_deref() {
                Ok("n0") => NetworkProfile::N0,
                _ => NetworkProfile::Local,
            },
        }
    }
}

/// One link, welcomed as the room admin.
struct Session {
    handle: LinkHandle,
    rx: UnboundedReceiver<LinkEvent>,
    epoch: u64,
    calls: u32,
}

async fn next(rx: &mut UnboundedReceiver<LinkEvent>, what: &str) -> LinkEvent {
    tokio::time::timeout(DEADLINE, rx.recv())
        .await
        .unwrap_or_else(|_| panic!("no {what} within {DEADLINE:?}"))
        .unwrap_or_else(|| panic!("the link ended before {what}"))
}

impl Session {
    async fn open(live: &Live) -> Self {
        let (handle, mut rx) = connect(LinkParams {
            ticket: live.ticket.clone(),
            network: live.network,
        });
        for expected in [LinkStatus::Connecting, LinkStatus::Up] {
            match next(&mut rx, "a status").await {
                LinkEvent::Status { status, .. } if status == expected => {}
                other => panic!("expected {expected:?}, got {other:?}"),
            }
        }
        handle
            .send_frame(json!({
                "type": "hello",
                "protocol": "3.0",
                "key": live.key,
                "name": "save-gate",
                "locale": "en",
                "client": {"name": "loreweaver-studio", "version": env!("CARGO_PKG_VERSION")},
                "caps": [],
            }))
            .await
            .expect("hello is written");
        let mut session = Self {
            handle,
            rx,
            epoch: 0,
            calls: 0,
        };
        let welcome = session.frame_of("welcome").await;
        assert_eq!(welcome["you"]["role"], "admin", "{welcome}");
        session.epoch = welcome["epoch"].as_u64().expect("an epoch");
        session
    }

    /// The next frame of `kind`; others (the replayed log, signals) are skipped.
    async fn frame_of(&mut self, kind: &str) -> Value {
        loop {
            match next(&mut self.rx, kind).await {
                LinkEvent::Frame { frame } => match frame.get("type").and_then(Value::as_str) {
                    Some(t) if t == kind => return frame,
                    Some("error") => panic!("the server refused: {frame}"),
                    _ => continue,
                },
                LinkEvent::Status {
                    status,
                    code,
                    reason,
                } => panic!("waiting for {kind}, the link went {status:?} ({code:?}: {reason:?})"),
            }
        }
    }

    /// `call method params`, and its result. The server lets a member send a burst of five,
    /// then one every two seconds (`rate_limited`): a refused call is sent again after a wait,
    /// as a person would press again.
    async fn call(&mut self, method: &str, params: Value) -> Value {
        for _ in 0..RATE_RETRIES {
            self.calls += 1;
            let rid = format!("save-gate-{}", self.calls);
            self.handle
                .send_frame(json!({"type": "call", "rid": rid, "method": method, "params": params}))
                .await
                .expect("the call is written");
            let result = loop {
                let frame = self.frame_of("result").await;
                if frame["rid"] == rid.as_str() {
                    break frame;
                }
            };
            if result["error"]["code"] != "rate_limited" {
                return result;
            }
            tokio::time::sleep(RATE_WAIT).await;
        }
        panic!("{method} was still rate limited after {RATE_RETRIES} tries");
    }

    /// The link ends: the server closes every member's connection after an import.
    async fn ended(mut self) {
        loop {
            match next(&mut self.rx, "the end of the link").await {
                LinkEvent::Frame { .. } => continue,
                LinkEvent::Status {
                    status: LinkStatus::Closed,
                    ..
                } => return,
                LinkEvent::Status { .. } => continue,
            }
        }
    }
}

/// `save {op: "export"}`, then the file it names fetched and written at `dest` by the app's code.
async fn export_to(session: &mut Session, dest: &Path) -> u64 {
    let result = session
        .call(
            "command.run",
            json!({"id": "save", "args": {"op": "export"}}),
        )
        .await;
    assert_eq!(result["ok"], true, "the export was refused: {result}");
    let media = &result["data"]["media"];
    assert_eq!(media["mime"], SAVE_MIME, "{result}");
    let hash = media["hash"].as_str().expect("a hash").to_owned();
    let size = media["size"].as_u64().expect("a size");
    // The answer is a reference, not the room.
    assert!(
        result.to_string().len() < 2048,
        "the answer carries more than a reference"
    );
    let written = tokio::time::timeout(DEADLINE, fetch_to(&session.handle, &hash, size, dest))
        .await
        .expect("the fetch is done in time")
        .unwrap_or_else(|failure| panic!("the app's fetch failed: {failure:?}"));
    assert_eq!(written, size);
    assert_eq!(std::fs::metadata(dest).expect("written").len(), size);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(dest).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "a save is private to this user, not {mode:o}");
    }
    println!("export: {size} bytes written by the app's code");
    size
}

/// Offer the save at `path` (`purpose: "save"`), PUT it with the app's code when the server asks
/// for the bytes, import it, and wait for the server to end the link. Answers a new session on
/// the restored room.
async fn restore(live: &Live, mut session: Session, path: &Path) -> Session {
    let file = prepare(path)
        .await
        .unwrap_or_else(|failure| panic!("the app's prepare failed: {failure:?}"));
    let offered = session
        .call(
            "media.offer",
            json!({
                "name": file.name,
                "mime": file.mime,
                "size": file.size,
                "sha256": file.sha256,
                "purpose": "save",
            }),
        )
        .await;
    assert_eq!(offered["ok"], true, "the offer was refused: {offered}");
    let hash = if let Some(upload_id) = offered["data"]["upload_id"].as_str() {
        let receipt = tokio::time::timeout(
            DEADLINE,
            send(&session.handle, path, upload_id.to_owned(), &file.sha256),
        )
        .await
        .expect("the upload is done in time")
        .unwrap_or_else(|failure| panic!("the app's upload failed: {failure:?}"));
        assert_eq!(receipt.mime, SAVE_MIME);
        println!("upload: {} bytes sent by the app's code", receipt.size);
        receipt.hash
    } else {
        let existing = &offered["data"]["existing"];
        assert_eq!(existing["hash"], file.sha256.as_str(), "{offered}");
        file.sha256.clone()
    };
    assert_eq!(hash, file.sha256);
    let before = session.epoch;
    let imported = session
        .call(
            "command.run",
            json!({"id": "save", "args": {"op": "import", "file": hash}}),
        )
        .await;
    assert_eq!(imported["ok"], true, "the import was refused: {imported}");
    session.ended().await;
    let session = Session::open(live).await;
    assert_ne!(
        session.epoch, before,
        "the room was replaced: another epoch"
    );
    session
}

/// A bundle's content: what an import loads and an export gives back.
fn content(path: &Path) -> Value {
    let bundle: Value =
        serde_json::from_slice(&std::fs::read(path).expect("a save file")).expect("JSON");
    json!({
        "turn": bundle["turn"],
        "documents": bundle["documents"],
        "state": bundle["state"],
        "modules": bundle["modules"],
        "events": bundle["events"],
    })
}

/// The room's own save grown past one control-stream line with narrative log entries.
fn grow(small: &Path, big: &Path) {
    let mut bundle: Value =
        serde_json::from_slice(&std::fs::read(small).expect("the small save")).expect("JSON");
    let turn = bundle["turn"].as_u64().unwrap_or(0).max(1);
    bundle["turn"] = json!(turn);
    let events = bundle["events"].as_array_mut().expect("an event list");
    for index in 0..ENTRIES {
        let text = format!(
            "{index}:{}{}",
            "灯".repeat(10),
            char::from(b'0' + (index % 10) as u8)
                .to_string()
                .repeat(ENTRY_CHARS)
        );
        events.push(json!({
            "id": format!("save-gate-{index}"),
            "ts": 1_764_240_000_000u64 + index as u64,
            "kind": "narrative",
            "turn": turn,
            "data": {"speaker": "kp", "text": text, "format": "plain"},
        }));
    }
    std::fs::write(big, serde_json::to_vec(&bundle).expect("JSON")).expect("the big save");
}

#[tokio::test]
#[ignore = "needs a live protocol 3.0 server; run via scripts/check_live_connect.sh"]
async fn a_save_over_a_line_goes_out_and_back_in_through_the_apps_code_whole() {
    let live = Live::from_env();
    let scratch =
        Scratch(std::env::temp_dir().join(format!("lw-save-live-{}", std::process::id())));
    let _ = std::fs::remove_dir_all(&scratch.0);
    std::fs::create_dir_all(&scratch.0).expect("a scratch folder");
    let at = |name: &str| scratch.0.join(name);
    let line = MAX_LINE_BYTES as u64;

    // 1. The room as it is, out.
    let mut session = Session::open(&live).await;
    let small = export_to(&mut session, &at("small.json")).await;
    assert!(small < line);

    // 2. Grown past a line, in.
    grow(&at("small.json"), &at("grown.json"));
    let grown = std::fs::metadata(at("grown.json")).unwrap().len();
    assert!(grown > line, "the grown save is {grown} bytes");
    let mut session = restore(&live, session, &at("grown.json")).await;

    // 3. Out again: over a line, and what went in.
    let out = export_to(&mut session, &at("out.json")).await;
    assert!(out > line, "the export is {out} bytes");
    assert!(
        content(&at("out.json")) == content(&at("grown.json")),
        "the exported room is not the room that was imported"
    );

    // 4. The small room back, then the big file the app wrote, in; and out once more.
    let session = restore(&live, session, &at("small.json")).await;
    let mut session = restore(&live, session, &at("out.json")).await;
    let again = export_to(&mut session, &at("again.json")).await;
    assert!(again > line);
    assert!(
        content(&at("again.json")) == content(&at("out.json")),
        "the room is not the same after going out and back in"
    );
    println!(
        "a {out}-byte save went out and back in through the app's code, the room the same before and after"
    );
    session.handle.close();
}
