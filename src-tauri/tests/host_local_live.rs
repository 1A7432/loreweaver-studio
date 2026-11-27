//! The live gate of "Host locally & play", without a GUI: the app's own
//! host-local code ([`LocalHost`], the shared engine probe) starts the REAL
//! protocol 3.0 server from the engine checkout, the REAL link dials it with
//! the key it was given and is welcomed as the room admin, and stopping the
//! host leaves no process behind. It runs three times over one data directory:
//! the first run (the server's `first_key`), a second run (the key the app
//! kept), and a run after the app lost its key (a new one from the server's
//! `key` command). Then two app instances over that one directory: the second
//! is refused with `data_dir_in_use`, and the first is dropped without being
//! stopped — what a crash does — and its server must stop by itself, because
//! the input pipe it was started with (`--until-stdin-closes`) has ended.
//!
//! The product hosts over the public relays (`serve --until-stdin-closes`), which
//! needs a network; this gate must run offline, so it hosts with the test-only
//! loopback option ([`NetworkProfile::Local`]: `serve --local
//! --until-stdin-closes`) and dials with the profile the host reports.
//!
//! Ignored by default — it needs Bun and an engine checkout — and driven by
//! `scripts/check_roundtrip.sh` (stage g):
//!
//! ```text
//! LOREWEAVER_HOST_ENGINE_REPO=../trpg_kp [LOREWEAVER_HOST_MARK=…] \
//!   cargo test -p loreweaver-studio --test host_local_live -- --ignored --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use loreweaver_studio_lib::engine::{is_engine_version, probe_candidates};
use loreweaver_studio_lib::host_local::{
    forget_key, resolve_paths, EngineCommand, HostConfig, HostFailure, HostPaths, HostReady,
    KeySource, LocalHost, READY_TIMEOUT,
};
use loreweaver_transport::link::{connect, LinkEvent, LinkParams, LinkStatus, NetworkProfile};
use serde_json::{json, Value};
use tokio::sync::mpsc::UnboundedReceiver;

const DEADLINE: Duration = Duration::from_secs(60);

/// A scratch folder for the app's data, removed even when the test fails.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Stops the host when the test ends, however it ends.
struct Hosting(Arc<LocalHost>);

impl Drop for Hosting {
    fn drop(&mut self) {
        let host = Arc::clone(&self.0);
        let _ = std::thread::spawn(move || {
            tokio::runtime::Runtime::new()
                .expect("a runtime")
                .block_on(host.stop())
        })
        .join();
    }
}

async fn next(rx: &mut UnboundedReceiver<LinkEvent>, what: &str) -> LinkEvent {
    tokio::time::timeout(DEADLINE, rx.recv())
        .await
        .unwrap_or_else(|_| panic!("no {what} within {DEADLINE:?}"))
        .unwrap_or_else(|| panic!("the link ended before {what}"))
}

/// Dial the hosted server through the real link, with the profile the host
/// reported and the key it gave, and return the `welcome`.
async fn sit_down(ready: &HostReady) -> Value {
    let (handle, mut rx) = connect(LinkParams {
        ticket: ready.ticket.clone(),
        network: ready.network,
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
            "key": ready.key,
            "name": "host-local-gate",
            "locale": "en",
            "client": {"name": "loreweaver-studio", "version": env!("CARGO_PKG_VERSION")},
            "caps": [],
        }))
        .await
        .expect("hello is written");
    let welcome = loop {
        match next(&mut rx, "welcome").await {
            LinkEvent::Frame { frame } => match frame.get("type").and_then(Value::as_str) {
                Some("welcome") => break frame,
                Some("error") => panic!("the server refused the key it was given: {frame}"),
                _ => continue,
            },
            LinkEvent::Status { status, code, .. } => {
                panic!("waiting for welcome, the link went {status:?} ({code:?})")
            }
        }
    };
    handle.close();
    welcome
}

#[cfg(unix)]
fn alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn alive(_pid: u32) -> bool {
    false
}

/// The settings every hosted run gets: the server's language, and the gate
/// script's mark (`LOREWEAVER_HOST_MARK`), which lets it find and stop a server
/// this test could not stop itself because it was killed — at any moment, the
/// start included.
fn env() -> Vec<(String, String)> {
    let mut env = vec![("TRPG_LOCALE".to_owned(), "en".to_owned())];
    if let Ok(mark) = std::env::var("LOREWEAVER_HOST_MARK") {
        env.push(("LOREWEAVER_HOST_MARK".to_owned(), mark));
    }
    env
}

async fn engine(repo: &Path) -> EngineCommand {
    let candidates = probe_candidates(Some(repo.to_string_lossy().into_owned())).await;
    let checkout = candidates
        .iter()
        .find(|candidate| candidate.kind == "checkout")
        .unwrap_or_else(|| panic!("no checkout candidate at {}", repo.display()));
    assert!(
        checkout.version.as_deref().is_some_and(is_engine_version),
        "the checkout does not answer like a 3.x engine: {:?}",
        checkout.problem
    );
    checkout.into()
}

/// The one option only a test sets: host loopback-only, so no network is needed.
const OFFLINE: NetworkProfile = NetworkProfile::Local;

/// One run: start, sit down as the admin, stop, and check the process is gone.
async fn run(host: &Arc<LocalHost>, paths: &HostPaths, engine: &EngineCommand) -> HostReady {
    let engine = engine.clone();
    let ready = host
        .start(
            HostConfig {
                paths: paths.clone(),
                env: env(),
                ready_timeout: READY_TIMEOUT,
                network: OFFLINE,
            },
            async move { Ok(engine) },
            |exited| panic!("the server died while hosting: {exited:?}"),
        )
        .await
        .unwrap_or_else(|failure| panic!("hosting failed: {failure:?}"));
    println!(
        "ready: key from {:?}, notes {:?}, ticket {}…",
        ready.key_source,
        ready.notes,
        &ready.ticket[..24.min(ready.ticket.len())]
    );
    assert_eq!(ready.network, OFFLINE, "the host says how to dial it");
    let pid = host.pid().expect("a running server has a pid");
    assert!(alive(pid));

    let welcome = sit_down(&ready).await;
    assert_eq!(welcome["you"]["role"], "admin", "{welcome}");
    assert_eq!(welcome["room"]["id"], ready.room.as_str(), "{welcome}");
    assert_eq!(
        welcome["protocol"]
            .as_str()
            .unwrap_or_default()
            .split('.')
            .next(),
        Some("3")
    );

    assert!(host.stop().await, "there was a server to stop");
    assert!(!alive(pid), "the server {pid} is still running after stop");
    assert!(host.running().is_none());
    ready
}

#[tokio::test]
#[ignore = "needs Bun and a protocol 3.0 engine checkout; run via scripts/check_roundtrip.sh"]
async fn the_app_hosts_the_real_server_sits_down_as_admin_and_stops_it() {
    let repo = PathBuf::from(
        std::env::var("LOREWEAVER_HOST_ENGINE_REPO")
            .expect("LOREWEAVER_HOST_ENGINE_REPO must name the engine checkout"),
    );
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let scratch =
        Scratch(std::env::temp_dir().join(format!("lw-host-live-{}-{stamp}", std::process::id())));
    let paths = resolve_paths(&scratch.0.join("app-data"), None);
    let engine = engine(&repo).await;
    let host = Arc::new(LocalHost::default());
    let _hosting = Hosting(Arc::clone(&host));

    let first = run(&host, &paths, &engine).await;
    assert_eq!(first.key_source, KeySource::First);
    assert!(
        first
            .notes
            .iter()
            .any(|note| note == "model_not_configured"),
        "no model reaches the hosted server unless it is set: {:?}",
        first.notes
    );

    let second = run(&host, &paths, &engine).await;
    assert_eq!(second.key_source, KeySource::Kept);
    assert_eq!(second.key, first.key);

    assert!(forget_key(&paths.keys_file, &paths.data_dir).expect("forget"));
    let third = run(&host, &paths, &engine).await;
    assert_eq!(third.key_source, KeySource::Minted);
    assert_ne!(third.key, first.key);

    // Two app instances, one data directory. The first hosts it; the second is
    // refused by the server itself, in its own code.
    let crashing = Arc::new(LocalHost::default());
    let start = |host: Arc<LocalHost>| {
        let engine = engine.clone();
        let paths = paths.clone();
        async move {
            host.start(
                HostConfig {
                    paths,
                    env: env(),
                    ready_timeout: READY_TIMEOUT,
                    network: OFFLINE,
                },
                async move { Ok(engine) },
                |_| {},
            )
            .await
        }
    };
    start(Arc::clone(&crashing))
        .await
        .unwrap_or_else(|failure| panic!("hosting failed: {failure:?}"));
    let pid = crashing.pid().expect("a running server has a pid");
    let other = Arc::new(LocalHost::default());
    let refused = start(Arc::clone(&other)).await.unwrap_err();
    assert!(
        matches!(&refused, HostFailure::Refused { refusal, .. } if refusal == "data_dir_in_use"),
        "{refused:?}"
    );
    assert!(
        alive(pid),
        "the refused start must not touch the running server"
    );

    // The first instance goes away without stopping anything, as a crashed app
    // does: its end of the server's input closes, and the server stops.
    drop(crashing);
    let mut waited = Duration::ZERO;
    while alive(pid) && waited < DEADLINE {
        tokio::time::sleep(Duration::from_millis(100)).await;
        waited += Duration::from_millis(100);
    }
    assert!(
        !alive(pid),
        "the server {pid} outlived the app that hosted it"
    );
    println!("an abandoned server stopped by itself after {waited:?}");
}
