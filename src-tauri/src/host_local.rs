//! "Host locally & play": run a protocol 3.0 server on this machine and hand
//! the WebView what it needs to sit down at it as the room admin. The terminal
//! client does the same (`clients/tui/src/hostLocal.ts` in the engine
//! repository); this follows its decisions except where a desktop app differs.
//!
//! - The engine is found the one way this app finds it ([`crate::engine`]): a
//!   `loreweaver` on PATH, or the configured engine checkout run with Bun —
//!   the first that answers `--version` like a 3.x engine.
//! - It runs `serve --local --until-stdin-closes` (loopback only; the WebView
//!   dials it with the `local` network profile) as a child process, from an empty temporary
//!   working directory (Bun loads `.env` from the working directory), with this
//!   app's environment minus every `TRPG_*` variable, plus `TRPG_DATA_DIR` and
//!   the few settings the caller passes (nothing secret goes on the command
//!   line). The data directory is `<home>/data`; the home is the folder the
//!   user picked, or `local-server` under this app's data folder.
//! - Ready is the ONE JSON line the server prints on stdout,
//!   `{ok, version, ticket, notes, first_key?}`; a refusal is one JSON object
//!   on stderr, `{ok: false, code, problems?, detail?}` (`bad_settings`,
//!   `data_dir_in_use`, `startup_failed` with a `detail`). The wait is bounded.
//! - The child's standard input is a pipe this process holds for the child's
//!   whole life, and the server is told to stop when it ends
//!   (`--until-stdin-closes`, the engine's `docs/deploy.md`, "Hosting it from
//!   another program"). If this app crashes or is killed, the operating system
//!   closes the pipe and the server stops instead of outliving it. The flag is
//!   always passed: the engine probe only accepts a 3.x engine, and the 3.0
//!   engine has it.
//! - The admin key: `first_key` the first time a data directory is used; the
//!   app keeps it (owner-only file in its data folder, keyed by data
//!   directory) and uses it on every later start. A data directory that
//!   already holds a server but whose key the app has lost gets a new admin
//!   key from the server's own `key` command before the server starts (the
//!   terminal client does exactly this).
//! - The child is stopped when the user stops hosting, leaves the hosted
//!   table, or quits the app: its standard input is closed (and on Unix it is
//!   sent SIGTERM too), it gets a grace period to close cleanly, then it is
//!   killed. A server
//!   that dies on its own is reported once, with the last lines it wrote to
//!   stderr — bounded, and with every key this app knows replaced.
//!
//! The process side ([`LocalHost`]) knows nothing of Tauri, so the live gate
//! (`tests/host_local_live.rs`) drives exactly this code against the real
//! server; the commands at the bottom are a thin layer over it.

use crate::engine::{self, EngineCandidate};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::{Arc, Mutex, MutexGuard, Weak};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, watch};

/// The event a hosted server that died on its own is reported on.
pub const HOST_LOCAL_EVENT: &str = "loreweaver://host-local";
/// The room the first admin key of a fresh data directory belongs to (the
/// server's `FIRST_ROOM`), and the room a re-minted admin key is made for.
pub const LOCAL_ROOM: &str = "main";
const ADMIN_NAME: &str = "Admin";
/// How long the server gets to open its store and endpoint and print its
/// ready line (`--local` waits for no relay; the terminal client allows 60s).
pub const READY_TIMEOUT: Duration = Duration::from_secs(60);
/// Tells `serve` to stop when its standard input ends.
pub const UNTIL_STDIN_CLOSES: &str = "--until-stdin-closes";
/// After its input closes (and SIGTERM), how long the server gets to close cleanly before SIGKILL.
const STOP_GRACE: Duration = Duration::from_secs(5);
/// After SIGKILL (or Windows' terminate), how long to wait for it to be gone.
const KILL_WAIT: Duration = Duration::from_secs(5);
/// How long the output readers get to finish once the process is gone.
const READER_SETTLE: Duration = Duration::from_secs(2);
const MINT_TIMEOUT: Duration = Duration::from_secs(60);
/// Lines of the server's output kept for a failure report, and the length of each.
const TAIL_LINES: usize = 40;
const TAIL_LINE_CHARS: usize = 400;
/// A line longer than this is cut (the ready line is a few hundred bytes).
const MAX_LINE_BYTES: usize = 64 * 1024;
/// A known secret is replaced by this wherever the server's words are shown.
const REDACTED: &str = "[key]";
/// The kept admin keys, in this app's data folder.
const KEPT_KEYS_FILE: &str = "local-server-keys.json";
/// The default home under this app's data folder.
const DEFAULT_HOME: &str = "local-server";

// ---------------------------------------------------------------------------
// What crosses to the WebView
// ---------------------------------------------------------------------------

/// Where the admin key of a ready server came from.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum KeySource {
    /// The server's `first_key`: this data directory was used for the first time.
    First,
    /// The key this app kept from an earlier start.
    Kept,
    /// The app had lost the key of a data directory already in use, and the
    /// server's `key` command made a new one before the server started.
    Minted,
}

/// A server that is up, and how to sit down at it as the room admin.
#[derive(Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostReady {
    pub host_id: String,
    pub ticket: String,
    /// The room admin's access key. A secret: never logged, never in `Debug`.
    pub key: String,
    pub room: String,
    pub key_source: KeySource,
    /// What the server said at start-up, as its stable codes (`model_not_configured`, …).
    pub notes: Vec<String>,
    pub version: String,
    pub data_dir: String,
    /// The server was already running for this data directory (the WebView
    /// reloaded, say): this is its ready, again.
    pub reused: bool,
}

impl std::fmt::Debug for HostReady {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostReady")
            .field("host_id", &self.host_id)
            .field("ticket", &self.ticket)
            .field("key", &REDACTED)
            .field("room", &self.room)
            .field("key_source", &self.key_source)
            .field("notes", &self.notes)
            .field("version", &self.version)
            .field("data_dir", &self.data_dir)
            .field("reused", &self.reused)
            .finish()
    }
}

/// One problem of a `bad_settings` refusal, as the server names it (a
/// variable and what is wrong with it — never its value).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
pub struct ConfigProblem {
    pub variable: String,
    pub problem: String,
}

/// An engine candidate that could not be used, for the "no engine" answer.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
pub struct EngineProblem {
    pub kind: String,
    pub program: String,
    pub problem: String,
}

/// Why hosting did not start. Serialized as `{code, …fields in camelCase}`;
/// the WebView words each code.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(
    tag = "code",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum HostFailure {
    /// No engine was found, or none answered like a 3.x engine.
    NoEngine { engines: Vec<EngineProblem> },
    /// A server this app started is running for another data directory.
    AlreadyRunning { data_dir: String },
    /// The server refused to start, with its code (`bad_settings` carries its
    /// problems, `startup_failed` its `detail`).
    Refused {
        refusal: String,
        problems: Vec<ConfigProblem>,
        detail: Option<String>,
    },
    /// The server exited before it was ready.
    Exited {
        exit_code: Option<i32>,
        stderr: Vec<String>,
    },
    /// No ready line within [`READY_TIMEOUT`]; the server was stopped.
    Timeout { stderr: Vec<String> },
    /// The user stopped hosting before the server was ready.
    Cancelled,
    /// Making a new admin key for a data directory already in use failed.
    MintFailed {
        refusal: Option<String>,
        stderr: Vec<String>,
    },
    /// The server is up but no admin key is known for it.
    NoKey,
    /// The process could not be started, or a file could not be written.
    Io { detail: String },
}

/// A hosted server that died on its own (not stopped by this app). Sent on
/// [`HOST_LOCAL_EVENT`]; the WebView matches `hostId` against the server it
/// is sitting at.
#[derive(Serialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostExited {
    pub host_id: String,
    pub code: Option<i32>,
    pub stderr: Vec<String>,
}

// ---------------------------------------------------------------------------
// The server's lines
// ---------------------------------------------------------------------------

/// The server's ready line.
#[derive(Clone, PartialEq, Eq)]
pub struct ReadyLine {
    pub ticket: String,
    pub version: String,
    pub notes: Vec<String>,
    /// `(room, key)` — only the first time a data directory is used.
    pub first_key: Option<(String, String)>,
}

/// A refusal to start.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: String,
    pub problems: Vec<ConfigProblem>,
    /// `startup_failed`: what went wrong, in the server's words.
    pub detail: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
pub enum ServerLine {
    Ready(ReadyLine),
    Refusal(Refusal),
}

/// The server's one JSON line — its ready line or its refusal — or None when
/// `line` is anything else (an operator report, a stack trace).
pub fn parse_server_line(line: &str) -> Option<ServerLine> {
    let value: Value = serde_json::from_str(line.trim()).ok()?;
    let record = value.as_object()?;
    match record.get("ok")?.as_bool()? {
        false => {
            let code = record
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_owned();
            let problems = record
                .get("problems")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(|entry| serde_json::from_value(entry.clone()).ok())
                        .collect()
                })
                .unwrap_or_default();
            let detail = record
                .get("detail")
                .and_then(Value::as_str)
                .map(clean_line)
                .filter(|detail| !detail.trim().is_empty());
            Some(ServerLine::Refusal(Refusal {
                code,
                problems,
                detail,
            }))
        }
        true => {
            let ticket = record.get("ticket")?.as_str()?.trim();
            if ticket.is_empty() {
                return None;
            }
            let notes = record
                .get("notes")
                .and_then(Value::as_array)
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let first_key = record.get("first_key").and_then(|first| {
                let key = first.get("key")?.as_str()?.trim();
                if key.is_empty() {
                    return None;
                }
                let room = first
                    .get("room")
                    .and_then(Value::as_str)
                    .unwrap_or(LOCAL_ROOM);
                Some((room.to_owned(), key.to_owned()))
            });
            Some(ServerLine::Ready(ReadyLine {
                ticket: ticket.to_owned(),
                version: record
                    .get("version")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_owned(),
                notes,
                first_key,
            }))
        }
    }
}

/// One line for a report: terminal colour codes and other control
/// characters out, cut to [`TAIL_LINE_CHARS`] characters.
fn clean_line(raw: &str) -> String {
    let mut out = String::new();
    let mut chars = raw.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // CSI: ESC [ params final-byte; any other escape: drop ESC and the next char.
            if chars.peek() == Some(&'[') {
                chars.next();
                for next in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&next) {
                        break;
                    }
                }
            } else {
                chars.next();
            }
            continue;
        }
        if c.is_control() && c != '\t' {
            continue;
        }
        out.push(c);
    }
    if out.chars().count() > TAIL_LINE_CHARS {
        out = out.chars().take(TAIL_LINE_CHARS).collect();
        out.push('…');
    }
    out
}

/// `line` with every known secret replaced.
fn redact(line: &str, secrets: &[String]) -> String {
    secrets
        .iter()
        .filter(|secret| secret.len() >= 8)
        .fold(line.to_owned(), |text, secret| {
            text.replace(secret.as_str(), REDACTED)
        })
}

/// Read one line of at most `cap` bytes into `buf` (the rest of a longer line
/// is read and dropped, so the pipe never stalls and memory stays bounded).
/// None at end of stream.
async fn read_line_capped<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    cap: usize,
    buf: &mut Vec<u8>,
) -> std::io::Result<Option<()>> {
    buf.clear();
    let mut any = false;
    loop {
        let available = reader.fill_buf().await?;
        if available.is_empty() {
            return Ok(any.then_some(()));
        }
        any = true;
        let (chunk, used, done) = match available.iter().position(|&b| b == b'\n') {
            Some(at) => (&available[..at], at + 1, true),
            None => (available, available.len(), false),
        };
        let room = cap.saturating_sub(buf.len());
        buf.extend_from_slice(&chunk[..chunk.len().min(room)]);
        reader.consume(used);
        if done {
            return Ok(Some(()));
        }
    }
}

/// What the readers collected: the last lines (for a failure report), the
/// refusal if the server printed one, and the secrets to keep out of both.
#[derive(Default)]
struct Output {
    tail: VecDeque<String>,
    refusal: Option<Refusal>,
    secrets: Vec<String>,
}

impl Output {
    fn push(&mut self, line: &str) {
        let line = clean_line(line);
        if line.trim().is_empty() {
            return;
        }
        if self.tail.len() == TAIL_LINES {
            self.tail.pop_front();
        }
        self.tail.push_back(line);
    }

    fn report(&self) -> Vec<String> {
        self.tail
            .iter()
            .map(|line| redact(line, &self.secrets))
            .collect()
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Drain stdout to its end: the ready line goes to `ready` (once), anything
/// that is not JSON to the tail. A JSON line never enters the tail — the
/// ready line carries the first admin key.
async fn read_stdout<R: AsyncBufRead + Unpin>(
    mut reader: R,
    output: Arc<Mutex<Output>>,
    ready: oneshot::Sender<ReadyLine>,
) {
    let mut ready = Some(ready);
    let mut buf = Vec::new();
    while let Ok(Some(())) = read_line_capped(&mut reader, MAX_LINE_BYTES, &mut buf).await {
        let line = String::from_utf8_lossy(&buf);
        match parse_server_line(&line) {
            Some(ServerLine::Ready(parsed)) => {
                if let Some((_, key)) = &parsed.first_key {
                    lock(&output).secrets.push(key.clone());
                }
                if let Some(sender) = ready.take() {
                    let _ = sender.send(parsed);
                }
            }
            Some(ServerLine::Refusal(refusal)) => lock(&output).refusal = Some(refusal),
            None if line.trim_start().starts_with('{') => {}
            None => lock(&output).push(&line),
        }
    }
}

/// Drain stderr to its end: a refusal is kept, every other line goes to the tail.
async fn read_stderr<R: AsyncBufRead + Unpin>(mut reader: R, output: Arc<Mutex<Output>>) {
    let mut buf = Vec::new();
    while let Ok(Some(())) = read_line_capped(&mut reader, MAX_LINE_BYTES, &mut buf).await {
        let line = String::from_utf8_lossy(&buf);
        match parse_server_line(&line) {
            Some(ServerLine::Refusal(refusal)) => lock(&output).refusal = Some(refusal),
            Some(ServerLine::Ready(_)) => {}
            None => lock(&output).push(&line),
        }
    }
}

// ---------------------------------------------------------------------------
// Paths and the kept keys
// ---------------------------------------------------------------------------

/// Where a hosted server lives.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HostPaths {
    pub home: PathBuf,
    /// `TRPG_DATA_DIR`: the server's database, keys, transport identity, packs.
    pub data_dir: PathBuf,
    /// The kept admin keys (one file for every data directory this app hosted).
    pub keys_file: PathBuf,
}

fn expand_home(path: &str) -> PathBuf {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"));
    match (path, home) {
        ("~", Some(home)) => PathBuf::from(home),
        (path, Some(home)) if path.starts_with("~/") || path.starts_with("~\\") => {
            PathBuf::from(home).join(&path[2..])
        }
        (path, _) => PathBuf::from(path),
    }
}

/// The home is the folder the user picked, or `local-server` under this
/// app's data folder; the data directory is `<home>/data`.
pub fn resolve_paths(app_data_dir: &Path, home_override: Option<&str>) -> HostPaths {
    let home = home_override
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(expand_home)
        .unwrap_or_else(|| app_data_dir.join(DEFAULT_HOME));
    HostPaths {
        data_dir: home.join("data"),
        keys_file: app_data_dir.join(KEPT_KEYS_FILE),
        home,
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct KeptKey {
    data_dir: String,
    room: String,
    key: String,
}

#[derive(Serialize, Deserialize, Default)]
struct KeptKeys {
    keys: Vec<KeptKey>,
}

/// The data directory as the kept keys name it: canonical when it exists.
fn key_name(data_dir: &Path) -> String {
    data_dir
        .canonicalize()
        .unwrap_or_else(|_| data_dir.to_path_buf())
        .to_string_lossy()
        .into_owned()
}

fn read_kept(file: &Path) -> KeptKeys {
    std::fs::read(file)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Write the kept keys: owner-only, replaced in one rename.
fn write_kept(file: &Path, kept: &KeptKeys) -> std::io::Result<()> {
    if let Some(dir) = file.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(kept).map_err(std::io::Error::other)?;
    let temp = file.with_extension(format!("tmp-{}", unique()));
    {
        use std::io::Write;
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut handle = options.open(&temp)?;
        handle.write_all(&bytes)?;
        handle.sync_all()?;
    }
    std::fs::rename(&temp, file)
}

/// The admin key kept for `data_dir`, as `(room, key)`.
pub fn kept_key(file: &Path, data_dir: &Path) -> Option<(String, String)> {
    let name = key_name(data_dir);
    read_kept(file)
        .keys
        .into_iter()
        .find(|entry| entry.data_dir == name && !entry.key.is_empty())
        .map(|entry| (entry.room, entry.key))
}

pub fn keep_key(file: &Path, data_dir: &Path, room: &str, key: &str) -> std::io::Result<()> {
    let name = key_name(data_dir);
    let mut kept = read_kept(file);
    kept.keys.retain(|entry| entry.data_dir != name);
    kept.keys.push(KeptKey {
        data_dir: name,
        room: room.to_owned(),
        key: key.to_owned(),
    });
    write_kept(file, &kept)
}

/// Forget the admin key kept for `data_dir`; true when there was one.
pub fn forget_key(file: &Path, data_dir: &Path) -> std::io::Result<bool> {
    let name = key_name(data_dir);
    let mut kept = read_kept(file);
    let before = kept.keys.len();
    kept.keys.retain(|entry| entry.data_dir != name);
    if kept.keys.len() == before {
        return Ok(false);
    }
    write_kept(file, &kept).map(|()| true)
}

// ---------------------------------------------------------------------------
// The child process
// ---------------------------------------------------------------------------

/// How to run the engine: the program and its leading arguments (a
/// checkout's entry file); the subcommand goes after.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineCommand {
    pub program: String,
    pub args: Vec<String>,
}

impl From<&EngineCandidate> for EngineCommand {
    fn from(candidate: &EngineCandidate) -> Self {
        Self {
            program: candidate.program.clone(),
            args: candidate.args.clone(),
        }
    }
}

/// The engine to host with, or why there is none.
pub async fn find_engine(engine_repo_dir: Option<String>) -> Result<EngineCommand, HostFailure> {
    let candidates = engine::probe_candidates(engine_repo_dir).await;
    if let Some(found) = engine::pick_engine(&candidates) {
        return Ok(found.into());
    }
    Err(HostFailure::NoEngine {
        engines: candidates
            .iter()
            .map(|candidate| EngineProblem {
                kind: candidate.kind.clone(),
                program: candidate.program.clone(),
                problem: candidate.problem.clone().unwrap_or_else(|| {
                    format!(
                        "--version printed {:?}, not a 3.x version",
                        clean_line(candidate.version.as_deref().unwrap_or_default())
                    )
                }),
            })
            .collect(),
    })
}

/// The `serve --local --until-stdin-closes` command: the engine's program and
/// arguments, run from `cwd`, with this app's environment minus every `TRPG_*`
/// variable, plus `TRPG_DATA_DIR` and `env`, and its standard input a pipe
/// (the caller holds it for the child's life). Values go in the environment
/// only — the command line is `<program> [<entry>] serve --local
/// --until-stdin-closes`, nothing else.
pub fn serve_command(
    engine: &EngineCommand,
    cwd: &Path,
    data_dir: &Path,
    env: &[(String, String)],
) -> Command {
    let mut command = Command::new(&engine.program);
    command
        .args(&engine.args)
        .args(["serve", "--local", UNTIL_STDIN_CLOSES])
        .current_dir(cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    engine::no_console_window(&mut command);
    engine::scrub_trpg(&mut command);
    command.env("TRPG_DATA_DIR", data_dir);
    for (name, value) in env {
        command.env(name, value);
    }
    command
}

/// Stop a child whose standard input the caller has already closed (which
/// alone stops the server): SIGTERM as well on Unix, a grace period for the
/// server to close its store and endpoint, then a hard kill. Returns once it
/// is gone (or the waits ran out).
async fn terminate(child: &mut Child) -> Option<ExitStatus> {
    #[cfg(unix)]
    if let Some(pid) = child.id().and_then(|pid| libc::pid_t::try_from(pid).ok()) {
        // SAFETY: kill(2) with a pid this process spawned and has not reaped
        // (tokio reaps only through `wait`, which nothing else calls).
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    if let Ok(status) = tokio::time::timeout(STOP_GRACE, child.wait()).await {
        return status.ok();
    }
    let _ = child.start_kill();
    tokio::time::timeout(KILL_WAIT, child.wait())
        .await
        .ok()
        .and_then(Result::ok)
}

/// An empty working directory of its own for one server: Bun loads `.env`
/// (and `bunfig.toml`) from the working directory.
fn make_run_dir() -> std::io::Result<PathBuf> {
    loop {
        let dir = std::env::temp_dir().join(format!("lw-studio-host-{}", unique()));
        // `create_dir`, not `create_dir_all`: a directory that already exists is
        // someone else's, and is removed by them when their server ends.
        match std::fs::create_dir(&dir) {
            Ok(()) => return Ok(dir),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err),
        }
    }
}

/// `<pid>-<clock>-<count>`: unique in this process even where the clock ticks
/// in microseconds (macOS) and two starts land in the same tick.
fn unique() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static COUNT: AtomicU64 = AtomicU64::new(0);
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    format!(
        "{}-{stamp:x}-{}",
        std::process::id(),
        COUNT.fetch_add(1, Ordering::Relaxed)
    )
}

/// The exit code the supervisor saw, once the process is gone.
async fn exit_code(exit: &mut watch::Receiver<Option<Option<i32>>>) -> Option<i32> {
    exit.wait_for(Option::is_some)
        .await
        .ok()
        .and_then(|code| *code)
        .flatten()
}

/// Resolves once a stop was asked for (at once if it already was). Holds no
/// borrow of the channel afterwards.
///
/// The sender lives in the slot, so it is dropped when the slot is released —
/// by the supervisor, after the process ended. That is not a stop: a closed
/// channel never resolves here, or a start could read its own server's exit
/// as a cancel.
async fn stopped(stop: &mut watch::Receiver<bool>) {
    if stop.wait_for(|stop| *stop).await.is_err() {
        std::future::pending::<()>().await;
    }
}

fn mint_host_id() -> String {
    format!("host-{}", unique())
}

/// A new admin key from the server's own `key` command (the server must not
/// be running for this data directory).
async fn mint_admin_key(
    engine: &EngineCommand,
    cwd: &Path,
    data_dir: &Path,
    env: &[(String, String)],
) -> Result<String, HostFailure> {
    let mut args = engine.args.clone();
    args.extend(
        ["key", LOCAL_ROOM, "admin", ADMIN_NAME]
            .iter()
            .map(|part| (*part).to_owned()),
    );
    let mut overlay: std::collections::HashMap<String, String> = env.iter().cloned().collect();
    overlay.insert(
        "TRPG_DATA_DIR".to_owned(),
        data_dir.to_string_lossy().into_owned(),
    );
    let result = engine::run_engine_command(
        &engine.program,
        &args,
        Some(&cwd.to_string_lossy()),
        Some(overlay),
        true,
        MINT_TIMEOUT,
        64 * 1024,
    )
    .await
    .map_err(|detail| HostFailure::Io { detail })?;
    let parsed: Option<Value> = serde_json::from_str(result.stdout.trim())
        .ok()
        .or_else(|| serde_json::from_str(result.stderr.trim()).ok());
    if let Some(key) = parsed
        .as_ref()
        .filter(|value| value.get("ok").and_then(Value::as_bool) == Some(true))
        .and_then(|value| value.get("key"))
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
    {
        return Ok(key.to_owned());
    }
    let refusal = parsed
        .as_ref()
        .and_then(|value| value.get("code"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    Err(HostFailure::MintFailed {
        refusal,
        stderr: result
            .stderr
            .lines()
            .filter(|line| !line.trim_start().starts_with('{'))
            .map(clean_line)
            .filter(|line| !line.trim().is_empty())
            .rev()
            .take(TAIL_LINES)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect(),
    })
}

// ---------------------------------------------------------------------------
// The one slot
// ---------------------------------------------------------------------------

/// What a start needs.
pub struct HostConfig {
    pub paths: HostPaths,
    /// Settings for the server beyond `TRPG_DATA_DIR` (its default language).
    pub env: Vec<(String, String)>,
    pub ready_timeout: Duration,
}

struct Hosted {
    id: String,
    data_dir: PathBuf,
    stop: watch::Sender<bool>,
    /// Becomes true once the slot is released (the process is gone, or was
    /// never started).
    done: watch::Receiver<bool>,
    ready: Option<HostReady>,
    stopping: bool,
    pid: Option<u32>,
    /// The write end of the child's standard input. Held here for the child's
    /// whole life: it closes when the slot is released, when hosting stops,
    /// or when this `LocalHost` itself goes away — and with this app, by the
    /// operating system — and the server stops when it closes.
    stdin: Option<ChildStdin>,
}

/// The one local server this app may run.
#[derive(Default)]
pub struct LocalHost {
    slot: Mutex<Option<Hosted>>,
}

/// Release the slot if `id` still holds it. Returns whether it was a ready,
/// not-stopping server — one whose death nobody asked for.
fn release(slot: &Mutex<Option<Hosted>>, id: &str) -> bool {
    let mut slot = lock(slot);
    match slot.as_ref() {
        Some(hosted) if hosted.id == id => {
            let unasked = hosted.ready.is_some() && !hosted.stopping;
            *slot = None;
            unasked
        }
        _ => false,
    }
}

impl LocalHost {
    /// The running server's process id, if one is running (for the live gate).
    pub fn pid(&self) -> Option<u32> {
        lock(&self.slot).as_ref().and_then(|hosted| hosted.pid)
    }

    /// Whether a server is running (or starting), and for which data directory.
    pub fn running(&self) -> Option<PathBuf> {
        lock(&self.slot)
            .as_ref()
            .map(|hosted| hosted.data_dir.clone())
    }

    /// Start a server and wait for it to be ready. `engine` finds the engine
    /// (awaited inside the slot, so a stop meanwhile cancels the start);
    /// `on_exit` is told if the server later dies on its own. Starting again
    /// for the data directory of the server already running returns its
    /// ready (`reused`).
    pub async fn start<E, X>(
        self: &Arc<Self>,
        config: HostConfig,
        engine: E,
        on_exit: X,
    ) -> Result<HostReady, HostFailure>
    where
        E: std::future::Future<Output = Result<EngineCommand, HostFailure>>,
        X: FnOnce(HostExited) + Send + 'static,
    {
        let data_dir = config.paths.data_dir.clone();
        let id = mint_host_id();
        let (stop_tx, mut stop_rx) = watch::channel(false);
        let (done_tx, done_rx) = watch::channel(false);
        {
            let mut slot = lock(&self.slot);
            if let Some(hosted) = slot.as_ref() {
                return match &hosted.ready {
                    Some(ready) if hosted.data_dir == data_dir && !hosted.stopping => {
                        Ok(HostReady {
                            reused: true,
                            ..ready.clone()
                        })
                    }
                    _ => Err(HostFailure::AlreadyRunning {
                        data_dir: hosted.data_dir.to_string_lossy().into_owned(),
                    }),
                };
            }
            *slot = Some(Hosted {
                id: id.clone(),
                data_dir: data_dir.clone(),
                stop: stop_tx,
                done: done_rx,
                ready: None,
                stopping: false,
                pid: None,
                stdin: None,
            });
        }
        let run_dir = match make_run_dir() {
            Ok(dir) => dir,
            Err(err) => {
                release(&self.slot, &id);
                let _ = done_tx.send(true);
                return Err(HostFailure::Io {
                    detail: format!("creating a working directory failed: {err}"),
                });
            }
        };
        // Until a child is spawned, this function releases the slot (and the
        // working directory) itself; after, the supervisor does.
        let unspawned = |failure: HostFailure| {
            let _ = std::fs::remove_dir_all(&run_dir);
            release(&self.slot, &id);
            let _ = done_tx.send(true);
            Err(failure)
        };

        let engine = tokio::select! {
            found = engine => found,
            _ = stopped(&mut stop_rx) => return unspawned(HostFailure::Cancelled),
        };
        let engine = match engine {
            Ok(engine) => engine,
            Err(failure) => return unspawned(failure),
        };
        if let Err(err) = std::fs::create_dir_all(&data_dir) {
            return unspawned(HostFailure::Io {
                detail: format!("creating {} failed: {err}", data_dir.display()),
            });
        }

        // The admin key: kept from before, or minted now for a data directory
        // already in use whose key was lost. A fresh one prints `first_key`.
        let keys_file = config.paths.keys_file.clone();
        let fresh = !data_dir.join("keys.json").exists();
        let mut known =
            kept_key(&keys_file, &data_dir).map(|(room, key)| (room, key, KeySource::Kept));
        if !fresh && known.is_none() {
            let minted = tokio::select! {
                minted = mint_admin_key(&engine, &run_dir, &data_dir, &config.env) => minted,
                _ = stopped(&mut stop_rx) => Err(HostFailure::Cancelled),
            };
            match minted {
                Ok(key) => {
                    if let Err(err) = keep_key(&keys_file, &data_dir, LOCAL_ROOM, &key) {
                        return unspawned(HostFailure::Io {
                            detail: format!("keeping the admin key failed: {err}"),
                        });
                    }
                    known = Some((LOCAL_ROOM.to_owned(), key, KeySource::Minted));
                }
                Err(failure) => return unspawned(failure),
            }
        }
        if *stop_rx.borrow() {
            return unspawned(HostFailure::Cancelled);
        }

        let mut child = match serve_command(&engine, &run_dir, &data_dir, &config.env).spawn() {
            Ok(child) => child,
            Err(err) => {
                return unspawned(HostFailure::Io {
                    detail: format!("starting {} failed: {err}", engine.program),
                })
            }
        };
        let stdin = child.stdin.take();
        if let Some(hosted) = lock(&self.slot).as_mut().filter(|hosted| hosted.id == id) {
            hosted.pid = child.id();
            hosted.stdin = stdin;
        }

        let output = Arc::new(Mutex::new(Output::default()));
        if let Some((_, key, _)) = &known {
            lock(&output).secrets.push(key.clone());
        }
        let (ready_tx, ready_rx) = oneshot::channel();
        let readers = [
            child.stdout.take().map(|pipe| {
                tokio::spawn(read_stdout(BufReader::new(pipe), output.clone(), ready_tx))
            }),
            child
                .stderr
                .take()
                .map(|pipe| tokio::spawn(read_stderr(BufReader::new(pipe), output.clone()))),
        ];

        // The supervisor owns the child from here: it waits for its death (or
        // a stop), then releases the slot; a death nobody asked for is told.
        // It holds the host weakly, so the host's own end (and with it the
        // child's input pipe) is not kept alive by the task watching it.
        let (exit_tx, mut exit_rx) = watch::channel::<Option<Option<i32>>>(None);
        {
            let host: Weak<LocalHost> = Arc::downgrade(self);
            let id = id.clone();
            let output = output.clone();
            let mut stop_rx = stop_rx.clone();
            tokio::spawn(async move {
                let status = tokio::select! {
                    status = child.wait() => status.ok(),
                    _ = stopped(&mut stop_rx) => terminate(&mut child).await,
                };
                for reader in readers.into_iter().flatten() {
                    let _ = tokio::time::timeout(READER_SETTLE, reader).await;
                }
                let code = status.and_then(|status| status.code());
                let _ = exit_tx.send(Some(code));
                let unasked = host.upgrade().is_some_and(|host| release(&host.slot, &id));
                let _ = std::fs::remove_dir_all(&run_dir);
                let _ = done_tx.send(true);
                if unasked {
                    let stderr = lock(&output).report();
                    on_exit(HostExited {
                        host_id: id,
                        code,
                        stderr,
                    });
                }
            });
        }

        enum Outcome {
            Ready(ReadyLine),
            Exited(Option<i32>),
            Cancelled,
            Timeout,
        }
        let outcome = tokio::select! {
            ready = ready_rx => match ready {
                Ok(ready) => Outcome::Ready(ready),
                // stdout closed without a ready line: the process is ending.
                Err(_) => Outcome::Exited(exit_code(&mut exit_rx).await),
            },
            code = exit_code(&mut exit_rx) => Outcome::Exited(code),
            _ = stopped(&mut stop_rx) => Outcome::Cancelled,
            () = tokio::time::sleep(config.ready_timeout) => Outcome::Timeout,
        };

        let failure = match outcome {
            Outcome::Ready(ready) => {
                let key = match (&ready.first_key, known) {
                    (Some((room, key)), _) => {
                        // A fresh data directory: this key is the one to keep. A key
                        // kept for an earlier directory of the same name is replaced.
                        if let Err(err) = keep_key(&keys_file, &data_dir, room, key) {
                            Err(HostFailure::Io {
                                detail: format!("keeping the admin key failed: {err}"),
                            })
                        } else {
                            Ok((room.clone(), key.clone(), KeySource::First))
                        }
                    }
                    (None, Some(known)) => Ok(known),
                    (None, None) => Err(HostFailure::NoKey),
                };
                match key {
                    Ok((room, key, key_source)) => {
                        let ready = HostReady {
                            host_id: id.clone(),
                            ticket: ready.ticket,
                            key,
                            room,
                            key_source,
                            notes: ready.notes,
                            version: ready.version,
                            data_dir: data_dir.to_string_lossy().into_owned(),
                            reused: false,
                        };
                        let mut slot = lock(&self.slot);
                        match slot.as_mut() {
                            Some(hosted) if hosted.id == id && !hosted.stopping => {
                                hosted.ready = Some(ready.clone());
                                return Ok(ready);
                            }
                            // A stop landed meanwhile; the supervisor is ending it.
                            _ => HostFailure::Cancelled,
                        }
                    }
                    Err(failure) => failure,
                }
            }
            Outcome::Exited(code) => {
                let output = lock(&output);
                match &output.refusal {
                    Some(refusal) => HostFailure::Refused {
                        refusal: refusal.code.clone(),
                        problems: refusal.problems.clone(),
                        detail: refusal.detail.clone(),
                    },
                    None => HostFailure::Exited {
                        exit_code: code,
                        stderr: output.report(),
                    },
                }
            }
            Outcome::Cancelled => HostFailure::Cancelled,
            Outcome::Timeout => HostFailure::Timeout {
                stderr: lock(&output).report(),
            },
        };
        // Not ready, and not going to be: make sure the process is gone.
        self.stop_id(&id).await;
        Err(failure)
    }

    /// Stop the server (or the start in progress) and wait until it is gone.
    /// False when nothing was running.
    pub async fn stop(&self) -> bool {
        let id = match lock(&self.slot).as_ref() {
            Some(hosted) => hosted.id.clone(),
            None => return false,
        };
        self.stop_id(&id).await;
        true
    }

    async fn stop_id(&self, id: &str) {
        let done = {
            let mut slot = lock(&self.slot);
            match slot.as_mut() {
                Some(hosted) if hosted.id == id => {
                    hosted.stopping = true;
                    // Closing its input is the stop the server listens for.
                    drop(hosted.stdin.take());
                    let _ = hosted.stop.send(true);
                    hosted.done.clone()
                }
                _ => return,
            }
        };
        let mut done = done;
        let _ = tokio::time::timeout(
            STOP_GRACE + KILL_WAIT + READER_SETTLE + Duration::from_secs(1),
            done.wait_for(|done| *done),
        )
        .await;
    }
}

// ---------------------------------------------------------------------------
// Tauri commands
// ---------------------------------------------------------------------------

/// The app's one [`LocalHost`].
#[derive(Default)]
pub struct HostLocalState(pub Arc<LocalHost>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostLocalStatus {
    /// The home a start would use now (the picked folder, or the default).
    pub home: String,
    pub data_dir: String,
    /// A server this app started is running (or starting).
    pub running: bool,
}

fn app_paths(
    app: &tauri::AppHandle,
    home_override: Option<&str>,
) -> Result<HostPaths, HostFailure> {
    use tauri::Manager;
    let app_data = app.path().app_data_dir().map_err(|err| HostFailure::Io {
        detail: format!("this app's data folder is unknown: {err}"),
    })?;
    Ok(resolve_paths(&app_data, home_override))
}

/// The server's default language: the app's, when it is one the server speaks.
fn locale_env(locale: Option<&str>) -> Vec<(String, String)> {
    match locale.map(str::trim) {
        Some(locale @ ("en" | "zh")) => vec![("TRPG_LOCALE".to_owned(), locale.to_owned())],
        _ => Vec::new(),
    }
}

#[tauri::command]
pub async fn host_local_start(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostLocalState>,
    engine_repo_dir: Option<String>,
    home_override: Option<String>,
    locale: Option<String>,
) -> Result<HostReady, HostFailure> {
    use tauri::Emitter;
    let paths = app_paths(&app, home_override.as_deref())?;
    let config = HostConfig {
        paths,
        env: locale_env(locale.as_deref()),
        ready_timeout: READY_TIMEOUT,
    };
    let host = Arc::clone(&state.0);
    host.start(config, find_engine(engine_repo_dir), move |exited| {
        let _ = app.emit(HOST_LOCAL_EVENT, exited);
    })
    .await
}

// An async command that borrows state must return a `Result`; stopping cannot fail, and the
// error type is a `String` only because a unit error is a lint in newer toolchains.
#[tauri::command]
pub async fn host_local_stop(state: tauri::State<'_, HostLocalState>) -> Result<bool, String> {
    Ok(state.0.stop().await)
}

#[tauri::command]
pub fn host_local_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, HostLocalState>,
    home_override: Option<String>,
) -> Result<HostLocalStatus, HostFailure> {
    let paths = app_paths(&app, home_override.as_deref())?;
    Ok(HostLocalStatus {
        home: paths.home.to_string_lossy().into_owned(),
        data_dir: paths.data_dir.to_string_lossy().into_owned(),
        running: state.0.running().is_some(),
    })
}

/// Forget the admin key kept for a home's data directory (the server turned
/// it down): the next start makes a new one.
#[tauri::command]
pub fn host_local_forget_key(
    app: tauri::AppHandle,
    home_override: Option<String>,
) -> Result<bool, HostFailure> {
    let paths = app_paths(&app, home_override.as_deref())?;
    forget_key(&paths.keys_file, &paths.data_dir).map_err(|err| HostFailure::Io {
        detail: format!("forgetting the admin key failed: {err}"),
    })
}

/// The app is quitting: stop the server it started, and wait for it.
pub fn shutdown(app: &tauri::AppHandle) {
    use tauri::Manager;
    let host = Arc::clone(&app.state::<HostLocalState>().0);
    tauri::async_runtime::block_on(async move {
        host.stop().await;
    });
}

#[cfg(test)]
mod tests;
