//! One-click local hosting — the studio face of the TUI's "Host locally &
//! play" button (clients/tui/src/hostLocal.ts). Acquisition tiers, fastest
//! first:
//!   1. the user's engine checkout (AI & engine settings), its venv python
//!      preferred exactly like the pack-build probe;
//!   2. a previously downloaded prebuilt binary — executed only when its
//!      integrity manifest still matches the executable's SHA-256;
//!   3. download the prebuilt server for this OS/arch from GitHub Releases,
//!      verified against the published `.sha256` sidecar before first run.
//!
//! The TUI's further source-tarball + uv tier is not ported yet; when no tier
//! applies the error says exactly that and points at the settings.
//!
//! Server contract (mirrors `app.py --serve` + clients/tui/src/localPaths.ts):
//! home is `$TRPG_LOCAL_SERVER_HOME` → `$TRPG_HOME` → `~/.loreweaver`; keys
//! live in `local-keys.toml`; an empty keys file makes the server mint a
//! keeper key and write the `keeper-key.txt` sidecar next to it; readiness is
//! the base32 iroh ticket appearing on stderr.

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub const HOST_LOCAL_EVENT: &str = "loreweaver://host-local";
const REPO: &str = "https://github.com/1A7432/loreweaver";
const READY_TIMEOUT: Duration = Duration::from_secs(90);
/// Cap on the pre-ready ticket scan window. The iroh ticket is tens of bytes;
/// 90s of stderr chatter must not accumulate without bound.
const TICKET_SCAN_CAP: usize = 64 * 1024;
const SIDECAR_ATTEMPTS: u32 = 20;
const SIDECAR_DELAY: Duration = Duration::from_millis(250);
/// How often the exit monitor `try_wait`s. The Child stays in the slot; the
/// monitor never calls `wait()` and never holds the mutex across this sleep.
const EXIT_POLL: Duration = Duration::from_millis(100);
/// Explicit stop kills, then waits this long for the process to disappear
/// before returning. `kill_on_drop` still covers an uncooperative child.
const STOP_WAIT: Duration = Duration::from_secs(5);
const BINARY_INTEGRITY_MANIFEST: &str = ".loreweaver-integrity.json";
const EXE_NAME: &str = if cfg!(windows) {
    "loreweaver-server.exe"
} else {
    "loreweaver-server"
};

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostLocalEvent {
    Log {
        host_id: String,
        level: String,
        text: String,
    },
    Ready {
        host_id: String,
        ticket: String,
        key: String,
    },
    Exit {
        host_id: String,
        code: Option<i32>,
    },
    Error {
        host_id: String,
        message: String,
    },
}

/// Occupant of the one local-server slot. `host_id` is minted by the WebView
/// (or, as a fallback, here) and travels on every event so the store can
/// drop queued frames from a superseded session — a Rust emit-before-check
/// cannot see the JS queue.
struct Hosted {
    child: Child,
    host_id: String,
}

#[derive(Default)]
struct Inner {
    hosted: Option<Hosted>,
    /// The host id that may still emit Log/Ready/Error. Cleared on stop and
    /// on observed death so a late Ready cannot revive a dead server.
    /// Exit is emitted with the claimed id *after* this is cleared.
    current_host_id: Option<String>,
}

/// The Child lives behind a `std::sync::Mutex` so `try_wait` / take are
/// instantaneous. Callers must never hold this lock across `.await` — stop
/// waits on a taken Child outside the mutex, and the monitor only polls.
#[derive(Default)]
pub struct HostLocalState {
    inner: Mutex<Inner>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostLocalStatus {
    pub running: bool,
    pub home: String,
    /// What the local server runs with as `TRPG_DATA_DIR`. Anything that must
    /// be visible to it — an installed pack above all — has to land here, so
    /// the caller needs the resolved path, not just the home.
    pub data_dir: String,
    /// Host session id of the live child, when one is running. The WebView
    /// adopts this after a reload so a later Exit still belongs to it.
    pub host_id: Option<String>,
}

struct LocalPaths {
    home: PathBuf,
    binary_dir: PathBuf,
    data_dir: PathBuf,
    env_file: PathBuf,
    keys_file: PathBuf,
    keeper_sidecar: PathBuf,
}

fn nonempty(value: std::result::Result<String, std::env::VarError>) -> Option<String> {
    value
        .ok()
        .map(|v| v.trim().to_owned())
        .filter(|v| !v.is_empty())
}

fn user_home() -> PathBuf {
    nonempty(std::env::var("HOME"))
        .or_else(|| nonempty(std::env::var("USERPROFILE")))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn expand_home(path: &str) -> PathBuf {
    if path == "~" {
        return user_home();
    }
    if let Some(rest) = path.strip_prefix("~/").or_else(|| path.strip_prefix("~\\")) {
        return user_home().join(rest);
    }
    PathBuf::from(path)
}

fn resolve_paths(home_override: Option<&str>) -> LocalPaths {
    // Precedence mirrors the TUI: the folder picked in the UI wins, then the
    // TRPG_LOCAL_SERVER_HOME / TRPG_HOME environment, then ~/.loreweaver.
    let override_root = home_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_home);
    let root = override_root
        .or_else(|| {
            nonempty(std::env::var("TRPG_LOCAL_SERVER_HOME")).map(|value| expand_home(&value))
        })
        .or_else(|| nonempty(std::env::var("TRPG_HOME")).map(|value| expand_home(&value)))
        .unwrap_or_else(|| user_home().join(".loreweaver"));
    LocalPaths {
        binary_dir: root.join("server-bin"),
        data_dir: root.join("data"),
        env_file: root.join(".env"),
        keys_file: root.join("local-keys.toml"),
        keeper_sidecar: root.join("keeper-key.txt"),
        home: root,
    }
}

/// The released asset for this OS/arch, or None when no prebuilt exists.
fn asset_name() -> Option<&'static str> {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        Some("loreweaver-server-macos-arm64.tar.gz")
    } else if cfg!(all(target_os = "linux", target_arch = "x86_64")) {
        Some("loreweaver-server-linux-x64.tar.gz")
    } else if cfg!(all(target_os = "linux", target_arch = "aarch64")) {
        Some("loreweaver-server-linux-arm64.tar.gz")
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        Some("loreweaver-server-windows-x64.zip")
    } else {
        None
    }
}

fn release_url(asset: &str) -> String {
    let tag = nonempty(std::env::var("TRPG_SERVER_RELEASE_TAG"))
        .or_else(|| nonempty(std::env::var("TRPG_RELEASE_TAG")))
        .unwrap_or_else(|| "latest".to_owned());
    if tag == "latest" {
        format!("{REPO}/releases/latest/download/{asset}")
    } else {
        format!("{REPO}/releases/download/{tag}/{asset}")
    }
}

/// Parse a `<sha256>  <filename>` sidecar line; the filename (when present)
/// must match the asset (an optional leading `*` marks binary mode).
fn parse_sha256_sidecar(text: &str, asset: &str) -> Option<String> {
    let mut parts = text.split_whitespace();
    let digest = parts.next()?.to_lowercase();
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if let Some(filename) = parts.next() {
        if filename.trim_start_matches('*') != asset {
            return None;
        }
    }
    Some(digest)
}

/// First `endpoint[a-z0-9]{20,}` run in `text` — the locale-independent iroh
/// ticket the server prints once its relay handshake completes.
fn extract_ticket(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut from = 0;
    while let Some(at) = text[from..].find("endpoint") {
        let start = from + at;
        let mut end = start + "endpoint".len();
        while end < bytes.len() && (bytes[end].is_ascii_lowercase() || bytes[end].is_ascii_digit())
        {
            end += 1;
        }
        if end - (start + "endpoint".len()) >= 20 {
            return Some(text[start..end].to_owned());
        }
        from = start + "endpoint".len();
    }
    None
}

/// `key=…` from the keeper sidecar the server writes on first --serve.
fn parse_sidecar_key(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let key = line.strip_prefix("key=")?.trim();
        let valid = key.len() >= 16
            && key
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-');
        valid.then(|| key.to_owned())
    })
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    format!("{:x}", hasher.finalize())
}

#[derive(serde::Deserialize, Serialize)]
struct IntegrityManifest {
    version: u32,
    asset: String,
    source_url: String,
    archive_sha256: String,
    executable_sha256: String,
}

fn binary_exe(binary_dir: &Path) -> PathBuf {
    binary_dir.join("loreweaver-server").join(EXE_NAME)
}

/// Never run a cached binary on existence alone: the manifest must parse, be
/// for this asset, and the executable's hash must still match it.
async fn verified_cached_binary(binary_dir: &Path, asset: &str) -> Option<PathBuf> {
    let exe = binary_exe(binary_dir);
    if !exe.is_file() {
        return None;
    }
    let manifest_text = tokio::fs::read_to_string(binary_dir.join(BINARY_INTEGRITY_MANIFEST))
        .await
        .ok()?;
    let manifest: IntegrityManifest = serde_json::from_str(&manifest_text).ok()?;
    if manifest.version != 1 || manifest.asset != asset || !manifest.source_url.starts_with(REPO) {
        return None;
    }
    let bytes = tokio::fs::read(&exe).await.ok()?;
    (sha256_hex(&bytes) == manifest.executable_sha256).then_some(exe)
}

fn emit_log(app: &AppHandle, host_id: &str, level: &str, text: impl Into<String>) {
    let _ = app.emit(
        HOST_LOCAL_EVENT,
        HostLocalEvent::Log {
            host_id: host_id.to_owned(),
            level: level.to_owned(),
            text: text.into(),
        },
    );
}

fn resolve_host_id(host_id: Option<String>) -> String {
    let trimmed = host_id.unwrap_or_default();
    let trimmed = trimmed.trim();
    if !trimmed.is_empty() {
        return trimmed.to_owned();
    }
    format!(
        "host-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    )
}

/// Download + verify + unpack the prebuilt server; returns the executable.
async fn download_binary(
    app: &AppHandle,
    paths: &LocalPaths,
    asset: &str,
    host_id: &str,
) -> Result<PathBuf, String> {
    let url = release_url(asset);
    emit_log(app, host_id, "step", format!("Downloading {asset}…"));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|err| err.to_string())?;
    let archive_bytes = client
        .get(&url)
        .send()
        .await
        .map_err(|err| format!("download failed: {err}"))?
        .error_for_status()
        .map_err(|err| format!("download failed: {err}"))?
        .bytes()
        .await
        .map_err(|err| format!("download failed: {err}"))?;

    let sidecar_text = client
        .get(format!("{url}.sha256"))
        .send()
        .await
        .map_err(|err| format!("SHA-256 metadata fetch failed: {err}"))?
        .error_for_status()
        .map_err(|err| format!("SHA-256 metadata fetch failed: {err}"))?
        .text()
        .await
        .map_err(|err| format!("SHA-256 metadata fetch failed: {err}"))?;
    let expected = parse_sha256_sidecar(&sidecar_text, asset)
        .ok_or_else(|| "invalid SHA-256 metadata for the server download".to_owned())?;
    let actual = sha256_hex(&archive_bytes);
    if actual != expected {
        return Err(format!(
            "server download SHA-256 mismatch for {asset} — refusing to run it"
        ));
    }
    emit_log(
        app,
        host_id,
        "ok",
        "Download verified against its published SHA-256",
    );

    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let archive = paths.home.join(format!("{asset}.{stamp}.tmp"));
    let staging = paths.home.join(format!("server-bin.staging-{stamp}"));
    tokio::fs::create_dir_all(&staging)
        .await
        .map_err(|err| err.to_string())?;
    tokio::fs::write(&archive, &archive_bytes)
        .await
        .map_err(|err| err.to_string())?;

    let result: Result<PathBuf, String> = async {
        // System tar (bsdtar on Windows handles the .zip asset too, same as the TUI).
        let status = Command::new("tar")
            .arg("-xf")
            .arg(&archive)
            .arg("-C")
            .arg(&staging)
            .status()
            .await
            .map_err(|err| format!("running tar failed: {err}"))?;
        if !status.success() {
            return Err("extracting the verified server archive failed".to_owned());
        }
        let staged_exe = binary_exe(&staging);
        if !staged_exe.is_file() {
            return Err("verified server archive has an unexpected layout".to_owned());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&staged_exe, std::fs::Permissions::from_mode(0o755));
        }
        let exe_bytes = tokio::fs::read(&staged_exe)
            .await
            .map_err(|err| err.to_string())?;
        let manifest = IntegrityManifest {
            version: 1,
            asset: asset.to_owned(),
            source_url: url.clone(),
            archive_sha256: actual.clone(),
            executable_sha256: sha256_hex(&exe_bytes),
        };
        let manifest_json =
            serde_json::to_string_pretty(&manifest).map_err(|err| err.to_string())?;
        tokio::fs::write(staging.join(BINARY_INTEGRITY_MANIFEST), manifest_json)
            .await
            .map_err(|err| err.to_string())?;
        // Commit atomically: move any previous cache aside, then rename staging in.
        let backup = paths.home.join(format!("server-bin.backup-{stamp}"));
        let had_previous = paths.binary_dir.exists();
        if had_previous {
            tokio::fs::rename(&paths.binary_dir, &backup)
                .await
                .map_err(|err| err.to_string())?;
        }
        if let Err(err) = tokio::fs::rename(&staging, &paths.binary_dir).await {
            if had_previous {
                let _ = tokio::fs::rename(&backup, &paths.binary_dir).await;
            }
            return Err(err.to_string());
        }
        if had_previous {
            let _ = tokio::fs::remove_dir_all(&backup).await;
        }
        Ok(binary_exe(&paths.binary_dir))
    }
    .await;

    let _ = tokio::fs::remove_file(&archive).await;
    let _ = tokio::fs::remove_dir_all(&staging).await;
    result
}

enum Launch {
    Python { program: PathBuf, repo: PathBuf },
    Binary { exe: PathBuf },
}

/// The acquisition chain: checkout (venv python first) → verified cached
/// binary → fresh download. No tier left = a pointed error, not a hang.
async fn resolve_launch(
    app: &AppHandle,
    paths: &LocalPaths,
    engine_repo_dir: Option<String>,
    host_id: &str,
) -> Result<Launch, String> {
    if let Some(repo) = engine_repo_dir.map(|value| expand_home(value.trim())) {
        if repo.join("app.py").is_file() {
            let venv_pythons = [
                repo.join(".venv").join("bin").join("python"),
                repo.join(".venv").join("Scripts").join("python.exe"),
                repo.join("venv").join("bin").join("python"),
                repo.join("venv").join("Scripts").join("python.exe"),
            ];
            if let Some(python) = venv_pythons.into_iter().find(|p| p.is_file()) {
                emit_log(
                    app,
                    host_id,
                    "ok",
                    format!("Using the engine checkout at {}", repo.display()),
                );
                return Ok(Launch::Python {
                    program: python,
                    repo,
                });
            }
            for name in ["python3", "python"] {
                if which_in_path(name).is_some() {
                    emit_log(
                        app,
                        host_id,
                        "ok",
                        format!(
                            "Using the engine checkout at {} (system {name})",
                            repo.display()
                        ),
                    );
                    return Ok(Launch::Python {
                        program: PathBuf::from(name),
                        repo,
                    });
                }
            }
        }
    }

    let Some(asset) = asset_name() else {
        return Err(
            "no prebuilt server exists for this platform and no engine checkout is configured — \
             set the engine repo in AI & engine settings"
                .to_owned(),
        );
    };
    if let Some(exe) = verified_cached_binary(&paths.binary_dir, asset).await {
        emit_log(
            app,
            host_id,
            "ok",
            "Using the verified prebuilt server downloaded earlier",
        );
        return Ok(Launch::Binary { exe });
    }
    if binary_exe(&paths.binary_dir).is_file() {
        emit_log(
            app,
            host_id,
            "err",
            "Ignoring an unverified or changed prebuilt server cache",
        );
    }
    let exe = download_binary(app, paths, asset, host_id).await?;
    Ok(Launch::Binary { exe })
}

fn which_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let full = dir.join(name);
        if full.is_file() {
            return Some(full);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{name}.exe"));
            if exe.is_file() {
                return Some(exe);
            }
        }
    }
    None
}

/// Rolling window the ticket scanner walks. Each `push_line` also scans the
/// line alone so a ticket on one banner line cannot be lost to a cap trim.
struct TicketScan {
    buf: String,
    cap: usize,
}

impl TicketScan {
    fn new(cap: usize) -> Self {
        Self {
            buf: String::new(),
            cap: cap.max(1),
        }
    }

    fn push_line(&mut self, line: &str) -> Option<String> {
        if let Some(ticket) = extract_ticket(line) {
            return Some(ticket);
        }
        self.buf.push_str(line);
        self.buf.push('\n');
        if self.buf.len() > self.cap {
            let overflow = self.buf.len() - self.cap;
            let mut start = overflow.min(self.buf.len());
            while start < self.buf.len() && !self.buf.is_char_boundary(start) {
                start += 1;
            }
            self.buf.drain(..start);
        }
        extract_ticket(&self.buf)
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.buf.len()
    }
}

/// Line-oriented drain of one pipe. Returns only on EOF (the process closed
/// the fd). A readiness timeout must never wrap this future — dropping it
/// would drop the reader and stall the child on a full pipe.
async fn drain_lines<R, F>(reader: R, mut on_line: F)
where
    R: AsyncBufRead + Unpin,
    F: FnMut(String),
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        on_line(line);
    }
}

/// Poll the keeper sidecar without touching the stderr reader.
async fn await_sidecar_key(path: &Path, attempts: u32, delay: Duration) -> Option<String> {
    for _ in 0..attempts {
        if let Ok(text) = tokio::fs::read_to_string(path).await {
            if let Some(key) = parse_sidecar_key(&text) {
                return Some(key);
            }
        }
        tokio::time::sleep(delay).await;
    }
    None
}

/// Sleep `timeout`, then report whether readiness is still outstanding.
/// Never cancels a drain — the caller emits an Error and leaves the readers.
async fn wait_readiness_timeout(timeout: Duration, already_reported: &AtomicBool) -> bool {
    tokio::time::sleep(timeout).await;
    !already_reported.load(Ordering::SeqCst)
}

fn lock_inner(state: &HostLocalState) -> Result<MutexGuard<'_, Inner>, String> {
    state
        .inner
        .lock()
        .map_err(|_| "host state poisoned".to_owned())
}

fn host_id_is_current(inner: &Inner, host_id: &str) -> bool {
    inner.current_host_id.as_deref() == Some(host_id)
}

fn host_id_is_current_in(state: &HostLocalState, host_id: &str) -> bool {
    lock_inner(state)
        .map(|inner| host_id_is_current(&inner, host_id))
        .unwrap_or(false)
}

fn is_live(inner: &mut Inner) -> bool {
    match inner.hosted.as_mut() {
        Some(hosted) => matches!(hosted.child.try_wait(), Ok(None)),
        None => false,
    }
}

/// Outcome of one monitor poll. `Stale` means this watcher must go quiet —
/// another start/stop already owns the slot.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ObserveExit {
    Stale,
    Running,
    Exited(Option<i32>),
}

fn exit_code(status: ExitStatus) -> Option<i32> {
    status.code()
}

fn clear_current_if(inner: &mut Inner, host_id: &str) {
    if inner.current_host_id.as_deref() == Some(host_id) {
        inner.current_host_id = None;
    }
}

/// Claim a spontaneous exit for `expected` at most once. Takes the Child
/// and clears `current_host_id` so a late Ready for this id cannot follow.
/// The caller still emits Exit tagged with `expected` — the WebView filter,
/// not this flag, is what accepts that Exit.
fn try_observe_exit(inner: &mut Inner, expected: &str) -> ObserveExit {
    match inner.hosted.as_mut() {
        Some(hosted) if hosted.host_id == expected => match hosted.child.try_wait() {
            Ok(None) => ObserveExit::Running,
            Ok(Some(status)) => {
                inner.hosted = None;
                clear_current_if(inner, expected);
                ObserveExit::Exited(exit_code(status))
            }
            Err(_) => {
                inner.hosted = None;
                clear_current_if(inner, expected);
                ObserveExit::Exited(None)
            }
        },
        _ => ObserveExit::Stale,
    }
}

/// Take the Child for an explicit stop and invalidate every watcher. The
/// caller kills + waits *outside* the mutex, then emits Exit with this id.
fn take_for_stop(inner: &mut Inner) -> Option<(Child, String)> {
    let hosted = inner.hosted.take()?;
    clear_current_if(inner, &hosted.host_id);
    Some((hosted.child, hosted.host_id))
}

/// Poll `observe` until the child exits or this host id is superseded.
/// Returns `Some(code)` exactly when *this* watcher claimed the death.
async fn monitor_child_exit<F>(mut observe: F, poll: Duration) -> Option<Option<i32>>
where
    F: FnMut() -> ObserveExit,
{
    loop {
        match observe() {
            ObserveExit::Stale => return None,
            ObserveExit::Exited(code) => return Some(code),
            ObserveExit::Running => tokio::time::sleep(poll).await,
        }
    }
}

fn emit_if_current(app: &AppHandle, host_id: &str, event: HostLocalEvent) {
    if !host_id_is_current_in(&app.state::<HostLocalState>(), host_id) {
        return;
    }
    let _ = app.emit(HOST_LOCAL_EVENT, event);
}

fn claim_ready(flag: &AtomicBool) -> bool {
    flag.compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_ok()
}

/// Announce Ready (or a sidecar Error) without holding the stderr reader.
async fn announce_ready(
    app: AppHandle,
    sidecar: PathBuf,
    ticket: String,
    host_id: String,
    reported: Arc<AtomicBool>,
) {
    if let Some(key) = await_sidecar_key(&sidecar, SIDECAR_ATTEMPTS, SIDECAR_DELAY).await {
        if host_id_is_current_in(&app.state::<HostLocalState>(), &host_id) && claim_ready(&reported)
        {
            emit_if_current(
                &app,
                &host_id,
                HostLocalEvent::Ready {
                    host_id: host_id.clone(),
                    ticket,
                    key,
                },
            );
        }
        return;
    }
    if host_id_is_current_in(&app.state::<HostLocalState>(), &host_id) && claim_ready(&reported) {
        emit_if_current(
            &app,
            &host_id,
            HostLocalEvent::Error {
                host_id: host_id.clone(),
                message: "server is up but its keeper-key.txt sidecar never appeared".to_owned(),
            },
        );
    }
}

/// Drain stdout + stderr until EOF. The same stderr reader scans for the
/// ticket, fires Ready via a sidecar waiter, then keeps draining. A ready
/// timeout only emits an Error — it does not drop either reader.
async fn watch_output(
    app: AppHandle,
    sidecar: PathBuf,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
    host_id: String,
    ready_timeout: Duration,
) {
    let reported = Arc::new(AtomicBool::new(false));

    let out_app = app.clone();
    let out_host = host_id.clone();
    let stdout_task = tauri::async_runtime::spawn(async move {
        if let Some(stdout) = stdout {
            let state_app = out_app.clone();
            drain_lines(BufReader::new(stdout), move |line| {
                if host_id_is_current_in(&state_app.state::<HostLocalState>(), &out_host) {
                    emit_log(&state_app, &out_host, "out", line);
                }
            })
            .await;
        }
    });

    let err_app = app.clone();
    let err_reported = reported.clone();
    let err_host = host_id.clone();
    let stderr_task = tauri::async_runtime::spawn(async move {
        let Some(stderr) = stderr else {
            return;
        };
        let mut scan = TicketScan::new(TICKET_SCAN_CAP);
        let mut looking = true;
        let drain_app = err_app.clone();
        let drain_reported = err_reported.clone();
        let drain_host = err_host.clone();
        drain_lines(BufReader::new(stderr), move |line| {
            if host_id_is_current_in(&drain_app.state::<HostLocalState>(), &drain_host) {
                emit_log(&drain_app, &drain_host, "out", line.clone());
            }
            if looking {
                if let Some(ticket) = scan.push_line(&line) {
                    looking = false;
                    tauri::async_runtime::spawn(announce_ready(
                        drain_app.clone(),
                        sidecar.clone(),
                        ticket,
                        drain_host.clone(),
                        drain_reported.clone(),
                    ));
                }
            }
        })
        .await;
        if looking
            && host_id_is_current_in(&err_app.state::<HostLocalState>(), &err_host)
            && claim_ready(&err_reported)
        {
            emit_if_current(
                &err_app,
                &err_host,
                HostLocalEvent::Error {
                    host_id: err_host.clone(),
                    message: "the server exited before it was ready".to_owned(),
                },
            );
        }
    });

    let timeout_app = app.clone();
    let timeout_reported = reported.clone();
    let timeout_host = host_id.clone();
    let timeout_task = tauri::async_runtime::spawn(async move {
        if wait_readiness_timeout(ready_timeout, &timeout_reported).await
            && host_id_is_current_in(&timeout_app.state::<HostLocalState>(), &timeout_host)
            && claim_ready(&timeout_reported)
        {
            emit_if_current(
                &timeout_app,
                &timeout_host,
                HostLocalEvent::Error {
                    host_id: timeout_host.clone(),
                    message: "the server did not become ready in time (no iroh ticket after 90s)"
                        .to_owned(),
                },
            );
        }
    });

    let _ = stdout_task.await;
    let _ = stderr_task.await;
    timeout_task.abort();
}

async fn watch_exit(app: AppHandle, host_id: String) {
    let watch_app = app.clone();
    let watch_id = host_id.clone();
    let observed = monitor_child_exit(
        move || {
            let state = watch_app.state::<HostLocalState>();
            let observed = match lock_inner(&state) {
                Ok(mut inner) => try_observe_exit(&mut inner, &watch_id),
                Err(_) => ObserveExit::Stale,
            };
            observed
        },
        EXIT_POLL,
    )
    .await;
    // Emit Exit even though current_host_id is already cleared — the
    // WebView accepts it by matching the id it still holds (or the
    // stopping id). A later start has a different id and will drop this.
    if let Some(code) = observed {
        let _ = app.emit(HOST_LOCAL_EVENT, HostLocalEvent::Exit { host_id, code });
    }
}

#[tauri::command]
pub async fn host_local_start(
    app: AppHandle,
    state: State<'_, HostLocalState>,
    engine_repo_dir: Option<String>,
    home_override: Option<String>,
    dev_source_root: Option<String>,
    host_id: Option<String>,
) -> Result<(), String> {
    let host_id = resolve_host_id(host_id);
    {
        let mut inner = lock_inner(&state)?;
        if is_live(&mut inner) {
            return Err("a local server is already running".to_owned());
        }
        // A dead occupant is still visible to the old monitor. Drop it and
        // clear the current id *before* the acquire path so a late Ready
        // from that child cannot land after we have moved on.
        if let Some(dead) = inner.hosted.take() {
            clear_current_if(&mut inner, &dead.host_id);
        }
    }

    let paths = resolve_paths(home_override.as_deref());
    tokio::fs::create_dir_all(&paths.home)
        .await
        .map_err(|err| format!("creating {} failed: {err}", paths.home.display()))?;
    tokio::fs::create_dir_all(&paths.data_dir)
        .await
        .map_err(|err| err.to_string())?;
    emit_log(
        &app,
        &host_id,
        "step",
        format!("Local server home: {}", paths.home.display()),
    );

    let launch = resolve_launch(&app, &paths, engine_repo_dir, &host_id).await?;

    let mut command = match &launch {
        Launch::Python { program, repo } => {
            let mut cmd = Command::new(program);
            cmd.args(["-m", "app"]).current_dir(repo);
            cmd
        }
        Launch::Binary { exe } => {
            let mut cmd = Command::new(exe);
            if let Some(dir) = exe.parent() {
                cmd.current_dir(dir);
            }
            cmd
        }
    };
    command
        .arg("--serve")
        .arg("--keys")
        .arg(&paths.keys_file)
        .env("TRPG_LOCAL_SERVER_HOME", &paths.home)
        .env("TRPG_DATA_DIR", &paths.data_dir)
        .env("TRPG_ENV_FILE", &paths.env_file)
        .env("TRPG_TUI_KEYS", &paths.keys_file)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Author dev rooms (`gateway/dev_room.py`): `.dev mount` resolves ONLY
    // under this root and the whole surface is off while it is unset, so the
    // studio sets it exactly when the author asked to mount a source tree.
    // Settings are read at startup, which is why turning this on restarts the
    // server rather than reconfiguring a running one.
    if let Some(root) = dev_source_root
        .as_deref()
        .map(str::trim)
        .filter(|r| !r.is_empty())
    {
        command.env("TRPG_DEV__SOURCE_ROOT", root);
        emit_log(
            &app,
            &host_id,
            "step",
            format!("Dev-room source root: {root}"),
        );
    }

    emit_log(
        &app,
        &host_id,
        "step",
        "Starting the local p2p server — waiting for a relay, ~10s…",
    );
    let mut child = command
        .spawn()
        .map_err(|err| format!("starting the server failed: {err}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let seated = {
        let mut inner = lock_inner(&state)?;
        if is_live(&mut inner) {
            Err(child)
        } else {
            inner.current_host_id = Some(host_id.clone());
            inner.hosted = Some(Hosted {
                child,
                host_id: host_id.clone(),
            });
            Ok(())
        }
    };
    if let Err(mut leftover) = seated {
        let _ = leftover.start_kill();
        let _ = tokio::time::timeout(STOP_WAIT, leftover.wait()).await;
        return Err("a local server is already running".to_owned());
    }
    tauri::async_runtime::spawn(watch_output(
        app.clone(),
        paths.keeper_sidecar.clone(),
        stdout,
        stderr,
        host_id.clone(),
        READY_TIMEOUT,
    ));
    tauri::async_runtime::spawn(watch_exit(app, host_id));
    Ok(())
}

#[tauri::command]
pub async fn host_local_stop(
    app: AppHandle,
    state: State<'_, HostLocalState>,
) -> Result<bool, String> {
    let Some((mut child, host_id)) = ({
        let mut inner = lock_inner(&state)?;
        take_for_stop(&mut inner)
    }) else {
        return Ok(false);
    };
    let _ = child.start_kill();
    // Confirm the process is gone (or give up after STOP_WAIT). The monitor
    // cannot `wait()` this Child — we took it — so the two cannot deadlock.
    let code = match tokio::time::timeout(STOP_WAIT, child.wait()).await {
        Ok(Ok(status)) => exit_code(status),
        _ => None,
    };
    let _ = app.emit(HOST_LOCAL_EVENT, HostLocalEvent::Exit { host_id, code });
    Ok(true)
}

#[tauri::command]
pub async fn host_local_status(
    state: State<'_, HostLocalState>,
    home_override: Option<String>,
) -> Result<HostLocalStatus, String> {
    let (running, host_id) = {
        let mut inner = lock_inner(&state)?;
        if is_live(&mut inner) {
            (
                true,
                inner.hosted.as_ref().map(|hosted| hosted.host_id.clone()),
            )
        } else {
            (false, None)
        }
    };
    let paths = resolve_paths(home_override.as_deref());
    Ok(HostLocalStatus {
        running,
        home: paths.home.to_string_lossy().into_owned(),
        data_dir: paths.data_dir.to_string_lossy().into_owned(),
        host_id,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        await_sidecar_key, drain_lines, extract_ticket, host_id_is_current, is_live,
        monitor_child_exit, parse_sha256_sidecar, parse_sidecar_key, resolve_host_id,
        resolve_paths, take_for_stop, try_observe_exit, wait_readiness_timeout, Hosted, Inner,
        ObserveExit, TicketScan, TICKET_SCAN_CAP,
    };
    use std::process::Stdio;
    use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::io::BufReader;
    use tokio::process::Command;

    const SAMPLE_TICKET: &str = "endpointac5qv3krex5jrly5kpdrkxhy67gxq3ases";

    #[test]
    fn home_override_outranks_the_env_chain() {
        let paths = resolve_paths(Some("/tmp/custom-lw-home"));
        assert!(paths.home.ends_with("custom-lw-home"));
        assert!(paths.keys_file.ends_with("custom-lw-home/local-keys.toml"));
        // Blank override falls through to the default chain.
        let fallback = resolve_paths(Some("   "));
        assert!(!fallback.home.as_os_str().is_empty());
    }

    #[test]
    fn ticket_scanner_finds_the_base32_run() {
        let banner =
            "★ Iroh p2p ready\n  Ticket：endpointac5qv3krex5jrly5kpdrkxhy67gxq3ases\n  saved";
        assert_eq!(
            extract_ticket(banner).as_deref(),
            Some("endpointac5qv3krex5jrly5kpdrkxhy67gxq3ases")
        );
        assert_eq!(extract_ticket("endpoint short"), None);
        assert_eq!(extract_ticket("no ticket here"), None);
    }

    #[test]
    fn sidecar_key_parses_the_bootstrap_format() {
        let sidecar = "room=table\nrole=keeper\nkey=UHEYQm7dvCvNujUglSaj8Px-\n";
        assert_eq!(
            parse_sidecar_key(sidecar).as_deref(),
            Some("UHEYQm7dvCvNujUglSaj8Px-")
        );
        assert_eq!(parse_sidecar_key("key=short"), None);
        assert_eq!(parse_sidecar_key("nothing"), None);
    }

    #[test]
    fn sha256_sidecar_accepts_plain_and_filename_forms() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_sha256_sidecar(&digest, "x.tar.gz").as_deref(),
            Some(digest.as_str())
        );
        let with_name = format!("{digest}  *x.tar.gz");
        assert_eq!(
            parse_sha256_sidecar(&with_name, "x.tar.gz").as_deref(),
            Some(digest.as_str())
        );
        let wrong_name = format!("{digest}  other.tar.gz");
        assert_eq!(parse_sha256_sidecar(&wrong_name, "x.tar.gz"), None);
        assert_eq!(parse_sha256_sidecar("zz", "x.tar.gz"), None);
    }

    #[test]
    fn ticket_scan_caps_the_window_and_still_finds_a_late_ticket() {
        let mut scan = TicketScan::new(64);
        for i in 0..200 {
            assert_eq!(scan.push_line(&format!("noise {i} with no ticket")), None);
        }
        assert!(scan.len() <= 64);
        assert_eq!(
            scan.push_line(&format!("Ticket：{SAMPLE_TICKET}"))
                .as_deref(),
            Some(SAMPLE_TICKET)
        );
    }

    #[test]
    fn ticket_scan_reads_a_ticket_on_the_line_even_when_the_window_is_full() {
        let mut scan = TicketScan::new(8);
        scan.push_line("xxxxxxxx");
        assert_eq!(
            scan.push_line(&format!("  {SAMPLE_TICKET}")).as_deref(),
            Some(SAMPLE_TICKET)
        );
    }

    #[tokio::test]
    async fn drain_lines_reads_every_line_until_eof() {
        let cursor = std::io::Cursor::new("one\ntwo\nthree\n");
        let mut got = Vec::new();
        drain_lines(BufReader::new(cursor), |line| got.push(line)).await;
        assert_eq!(got, ["one", "two", "three"]);
    }

    #[tokio::test]
    async fn readiness_timeout_reports_only_when_still_outstanding() {
        let pending = AtomicBool::new(false);
        assert!(wait_readiness_timeout(Duration::from_millis(5), &pending).await);
        let done = AtomicBool::new(true);
        assert!(!wait_readiness_timeout(Duration::from_millis(5), &done).await);
    }

    #[tokio::test]
    async fn sidecar_waiter_sees_a_key_written_after_the_first_miss() {
        let dir = std::env::temp_dir().join(format!(
            "lw-sidecar-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::create_dir_all(&dir).await.unwrap();
        let path = dir.join("keeper-key.txt");
        let writer = path.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(30)).await;
            tokio::fs::write(writer, "room=table\nkey=UHEYQm7dvCvNujUglSaj8Px-\n")
                .await
                .unwrap();
        });
        let key = await_sidecar_key(&path, 20, Duration::from_millis(10)).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        assert_eq!(key.as_deref(), Some("UHEYQm7dvCvNujUglSaj8Px-"));
    }

    #[tokio::test]
    async fn monitor_claims_an_exit_exactly_once() {
        let step = AtomicU8::new(0);
        let first = monitor_child_exit(
            || match step.fetch_add(1, Ordering::SeqCst) {
                0 => ObserveExit::Running,
                _ => ObserveExit::Exited(Some(7)),
            },
            Duration::from_millis(1),
        )
        .await;
        assert_eq!(first, Some(Some(7)));
        let stale = monitor_child_exit(|| ObserveExit::Stale, Duration::from_millis(1)).await;
        assert_eq!(stale, None);
    }

    fn spawn_sh(script: &str) -> tokio::process::Child {
        Command::new("sh")
            .args(["-c", script])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sh")
    }

    #[tokio::test]
    async fn short_command_stdout_and_stderr_drain_until_exit() {
        let mut child = spawn_sh(&format!(
            "echo out-a; echo pre >&2; echo Ticket：{SAMPLE_TICKET} >&2; echo out-b; echo post >&2; exit 3"
        ));
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let out = Arc::new(Mutex::new(Vec::new()));
        let err = Arc::new(Mutex::new(Vec::new()));
        let mut scan = TicketScan::new(TICKET_SCAN_CAP);
        let ticket = Arc::new(Mutex::new(None));
        let out_c = out.clone();
        let err_c = err.clone();
        let ticket_c = ticket.clone();
        let drain_out = drain_lines(BufReader::new(stdout), move |line| {
            out_c.lock().unwrap().push(line);
        });
        let drain_err = drain_lines(BufReader::new(stderr), move |line| {
            if ticket_c.lock().unwrap().is_none() {
                *ticket_c.lock().unwrap() = scan.push_line(&line);
            }
            err_c.lock().unwrap().push(line);
        });
        let reported = AtomicBool::new(false);
        let ((), (), timed_out) = tokio::join!(
            drain_out,
            drain_err,
            wait_readiness_timeout(Duration::from_millis(5), &reported),
        );
        // Timeout is a readiness signal only — both pipes still drained to EOF.
        let _ = timed_out;
        let status = child.wait().await.unwrap();
        assert_eq!(status.code(), Some(3));
        assert_eq!(*out.lock().unwrap(), ["out-a", "out-b"]);
        assert_eq!(
            *err.lock().unwrap(),
            vec![
                "pre".to_string(),
                format!("Ticket：{SAMPLE_TICKET}"),
                "post".to_string()
            ]
        );
        assert_eq!(ticket.lock().unwrap().as_deref(), Some(SAMPLE_TICKET));
    }

    #[tokio::test]
    async fn readiness_timeout_leaves_the_stderr_reader_in_place() {
        let mut child = spawn_sh(&format!(
            "echo pre >&2; sleep 0.15; echo Ticket：{SAMPLE_TICKET} >&2; echo post >&2"
        ));
        let stderr = child.stderr.take().unwrap();
        let lines = Arc::new(Mutex::new(Vec::new()));
        let lines_c = lines.clone();
        let mut scan = TicketScan::new(TICKET_SCAN_CAP);
        let ticket = Arc::new(Mutex::new(None));
        let ticket_c = ticket.clone();
        let drain = tokio::spawn(async move {
            drain_lines(BufReader::new(stderr), move |line| {
                if ticket_c.lock().unwrap().is_none() {
                    *ticket_c.lock().unwrap() = scan.push_line(&line);
                }
                lines_c.lock().unwrap().push(line);
            })
            .await;
        });
        let reported = AtomicBool::new(false);
        assert!(wait_readiness_timeout(Duration::from_millis(40), &reported).await);
        // The timeout fired while the process was still writing; drain continues.
        drain.await.unwrap();
        let collected = lines.lock().unwrap().clone();
        assert!(collected.iter().any(|line| line == "pre"));
        assert!(collected.iter().any(|line| line == "post"));
        assert_eq!(ticket.lock().unwrap().as_deref(), Some(SAMPLE_TICKET));
        let _ = child.wait().await;
    }

    #[test]
    fn resolve_host_id_keeps_a_nonempty_mint_and_fills_a_blank() {
        assert_eq!(resolve_host_id(Some("  minted-1  ".into())), "minted-1");
        let fallback = resolve_host_id(Some("   ".into()));
        assert!(fallback.starts_with("host-"));
        assert_ne!(fallback, "minted-1");
    }

    #[tokio::test]
    async fn observe_exit_of_a_short_command_is_once_per_host_id() {
        let child = spawn_sh("exit 9");
        let mut inner = Inner {
            hosted: Some(Hosted {
                child,
                host_id: "sess-1".into(),
            }),
            current_host_id: Some("sess-1".into()),
        };
        let mut saw = ObserveExit::Running;
        for _ in 0..50 {
            saw = try_observe_exit(&mut inner, "sess-1");
            if saw != ObserveExit::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(saw, ObserveExit::Exited(Some(9)));
        assert!(!host_id_is_current(&inner, "sess-1"));
        assert_eq!(try_observe_exit(&mut inner, "sess-1"), ObserveExit::Stale);
        assert_eq!(try_observe_exit(&mut inner, "sess-2"), ObserveExit::Stale);
        assert!(!is_live(&mut inner));
    }

    #[tokio::test]
    async fn observed_exit_clears_current_id_so_ready_cannot_follow() {
        // The bug: try_observe_exit took hosted but left generation current,
        // so announce_ready still emitted Ready after Exit.
        let child = spawn_sh("exit 0");
        let mut inner = Inner {
            hosted: Some(Hosted {
                child,
                host_id: "dead".into(),
            }),
            current_host_id: Some("dead".into()),
        };
        let mut saw = ObserveExit::Running;
        for _ in 0..50 {
            saw = try_observe_exit(&mut inner, "dead");
            if saw != ObserveExit::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(saw, ObserveExit::Exited(Some(0)));
        assert!(
            !host_id_is_current(&inner, "dead"),
            "late Ready must not see this id as current"
        );
    }

    #[tokio::test]
    async fn stop_takes_the_child_and_the_monitor_does_not_claim_exit() {
        let child = spawn_sh("sleep 30");
        let mut inner = Inner {
            hosted: Some(Hosted {
                child,
                host_id: "sess-4".into(),
            }),
            current_host_id: Some("sess-4".into()),
        };
        assert!(is_live(&mut inner));
        let (mut taken, stopped_id) = take_for_stop(&mut inner).expect("child");
        assert_eq!(stopped_id, "sess-4");
        assert!(!host_id_is_current(&inner, "sess-4"));
        assert_eq!(try_observe_exit(&mut inner, "sess-4"), ObserveExit::Stale);
        assert!(!is_live(&mut inner));
        let _ = taken.start_kill();
        let status = tokio::time::timeout(Duration::from_secs(2), taken.wait())
            .await
            .expect("stop wait")
            .expect("wait");
        // SIGKILL has no numeric code on Unix; the point is the wait finished.
        let _ = status.code();
    }

    #[tokio::test]
    async fn stale_host_id_never_claims_a_live_child() {
        let child = spawn_sh("sleep 30");
        let mut inner = Inner {
            hosted: Some(Hosted {
                child,
                host_id: "live".into(),
            }),
            current_host_id: Some("live".into()),
        };
        assert_eq!(try_observe_exit(&mut inner, "dead"), ObserveExit::Stale);
        assert!(host_id_is_current(&inner, "live"));
        assert!(is_live(&mut inner));
        if let Some((mut child, _)) = take_for_stop(&mut inner) {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }
}
