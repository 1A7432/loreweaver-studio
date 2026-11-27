//! Local engine CLI integration. The studio never zips or validates packs in
//! TypeScript — the 3.0 engine's command line (`loreweaver pack <dir> --out
//! <file>`, `install <file> --yes`, `packs`) is the single source of truth for
//! validation, module bundling and deterministic builds. This module only finds
//! that command line and runs it, streaming nothing: one bounded run, stdout /
//! stderr and exit code back to the WebView. Every command prints ONE JSON
//! object (`server/src/cli/main.ts` in the engine repository).
//!
//! Where the engine is found:
//! - a `loreweaver` executable on PATH (the compiled single-file server), or
//! - an engine CHECKOUT the author points Studio at: it is run as
//!   `bun <dir>/server/src/cli/main.ts …`, from a temporary working directory —
//!   Bun loads `.env` from the working directory, and a checkout's `.env` (model
//!   keys) must not be read by a pack build.
//!
//! Each candidate is probed with `--version` before it is offered.
//!
//! Capture contract (`run_engine_cli` / `run_engine_command`):
//! - Both pipes are drained from spawn, concurrently. Filling one pipe can
//!   never stall the other (the previous sequential `read_to_end` deadlocked
//!   when stderr filled first and stdout stayed open).
//! - Each pipe keeps a PREFIX of at most `MAX_CAPTURE_BYTES`. Once the cap
//!   is hit the rest is discarded, but the read continues until EOF so the
//!   child cannot block on a full pipe. A single `TRUNCATED_MARKER` is
//!   appended after the prefix.
//! - A pipe read error keeps the prefix, appends a `read error: …` marker,
//!   and does not fail the whole run (the other pipe and the exit code
//!   still surface). The broken pipe is no longer read.
//! - On timeout the child is explicitly killed and `wait`ed (reaped) before
//!   the reader tasks are joined. `kill_on_drop` is only a safety net.

use serde::Serialize;
use std::collections::HashMap;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;

/// Bound runaway CLI output before it reaches the WebView.
const MAX_CAPTURE_BYTES: usize = 256 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(600);
/// `--version` answers at once; a candidate that does not is not offered as working.
const PROBE_TIMEOUT: Duration = Duration::from_secs(30);
/// After the child is reaped, readers should see EOF almost immediately.
/// This is a hang-break, not a second run budget.
const READER_SETTLE: Duration = Duration::from_secs(8);
/// The name every scratch data directory starts with; `remove_scratch_dir`
/// removes nothing else.
const SCRATCH_PREFIX: &str = "lw-studio-verify-";
/// The engine's entry point inside a checkout.
const CHECKOUT_ENTRY: [&str; 4] = ["server", "src", "cli", "main.ts"];

/// Appended once when a pipe produced more than the capture cap. The
/// captured text is the PREFIX (first `MAX_CAPTURE_BYTES` bytes), not a tail.
const TRUNCATED_MARKER: &str = "\n… (truncated)";
const READ_ERROR_PREFIX: &str = "\n… (read error: ";

#[derive(Serialize, Clone)]
pub struct EngineCandidate {
    /// "binary" (a `loreweaver` on PATH) or "checkout" (`bun <dir>/server/src/cli/main.ts`).
    pub kind: String,
    pub program: String,
    /// Argument prefix before the studio's own arguments (the checkout's entry file).
    pub args: Vec<String>,
    pub cwd: Option<String>,
    /// What `--version` printed; None when it did not answer.
    pub version: Option<String>,
    /// Why `--version` failed, when it did.
    pub problem: Option<String>,
}

fn executable_in_path(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    let names: Vec<String> = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            name.to_owned(),
        ]
    } else {
        vec![name.to_owned()]
    };
    for dir in std::env::split_paths(&path_var) {
        for candidate in &names {
            let full = dir.join(candidate);
            if full.is_file() {
                return Some(full);
            }
        }
    }
    None
}

/// Ask a candidate its version. The run is sandboxed like every other.
async fn probe_version(candidate: &mut EngineCandidate) {
    let mut args = candidate.args.clone();
    args.push("--version".to_owned());
    match run_engine_command(
        &candidate.program,
        &args,
        candidate.cwd.as_deref(),
        None,
        true,
        PROBE_TIMEOUT,
        4096,
    )
    .await
    {
        Ok(result) if result.code == Some(0) && !result.stdout.trim().is_empty() => {
            candidate.version = Some(result.stdout.trim().to_owned());
        }
        Ok(result) => {
            let detail = if result.stderr.trim().is_empty() {
                result.stdout.trim().to_owned()
            } else {
                result.stderr.trim().to_owned()
            };
            candidate.problem = Some(format!(
                "--version exited with {}: {}",
                result
                    .code
                    .map_or_else(|| "no code".to_owned(), |code| code.to_string()),
                detail.chars().take(400).collect::<String>()
            ));
        }
        Err(err) => candidate.problem = Some(err),
    }
}

/// Probe for a usable engine command line: a `loreweaver` on PATH, and the
/// user-configured engine checkout (run with `bun`). Each is asked `--version`.
#[tauri::command]
pub async fn probe_engine_cli(engine_repo_dir: Option<String>) -> Vec<EngineCandidate> {
    let mut candidates = Vec::new();
    if let Some(binary) = executable_in_path("loreweaver") {
        candidates.push(EngineCandidate {
            kind: "binary".to_owned(),
            program: binary.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
            version: None,
            problem: None,
        });
    }
    if let Some(repo) = engine_repo_dir {
        let entry = CHECKOUT_ENTRY
            .iter()
            .fold(Path::new(&repo).to_path_buf(), |path, part| path.join(part));
        if entry.is_file() {
            let bun = executable_in_path("bun");
            candidates.push(EngineCandidate {
                kind: "checkout".to_owned(),
                program: bun.map_or_else(
                    || "bun".to_owned(),
                    |path| path.to_string_lossy().into_owned(),
                ),
                args: vec![entry.to_string_lossy().into_owned()],
                // Never the checkout itself: Bun would load its `.env`.
                cwd: Some(std::env::temp_dir().to_string_lossy().into_owned()),
                version: None,
                problem: None,
            });
        }
    }
    for candidate in &mut candidates {
        probe_version(candidate).await;
    }
    candidates
}

/// A fresh, empty data directory for verifying a pack with the real installer
/// (`TRPG_DATA_DIR`), under the system temporary directory.
#[tauri::command]
pub fn make_scratch_dir() -> Result<String, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or_default();
    let dir = std::env::temp_dir().join(format!("{SCRATCH_PREFIX}{}-{stamp}", std::process::id()));
    std::fs::create_dir_all(&dir)
        .map_err(|err| format!("creating {} failed: {err}", dir.display()))?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Whether `path` is a scratch directory this module made: directly under the
/// system temporary directory, named with `SCRATCH_PREFIX`.
fn is_scratch_dir(path: &Path) -> bool {
    let named = path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.starts_with(SCRATCH_PREFIX));
    let temp = std::env::temp_dir();
    let parent_is_temp = match (path.parent(), temp.canonicalize()) {
        (Some(parent), Ok(temp)) => parent.canonicalize().is_ok_and(|parent| parent == temp),
        _ => false,
    };
    named && parent_is_temp
}

/// Remove a scratch directory `make_scratch_dir` made, and nothing else.
#[tauri::command]
pub fn remove_scratch_dir(path: String) -> Result<(), String> {
    let dir = Path::new(&path);
    if !is_scratch_dir(dir) {
        return Err(format!("{path} is not a scratch directory this app made"));
    }
    match std::fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("removing {path} failed: {err}")),
    }
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

/// In-flight per-pipe capture. `bytes.len()` never exceeds `cap`.
struct PipeCapture {
    bytes: Vec<u8>,
    cap: usize,
    truncated: bool,
    read_error: Option<String>,
}

impl PipeCapture {
    fn new(cap: usize) -> Self {
        Self {
            bytes: Vec::new(),
            cap,
            truncated: false,
            read_error: None,
        }
    }

    fn failed(message: impl Into<String>) -> Self {
        Self {
            bytes: Vec::new(),
            cap: 0,
            truncated: false,
            read_error: Some(message.into()),
        }
    }

    /// Keep the prefix; ignore further bytes once the cap is hit.
    fn ingest(&mut self, chunk: &[u8]) {
        if self.truncated || chunk.is_empty() {
            return;
        }
        let room = self.cap.saturating_sub(self.bytes.len());
        if chunk.len() <= room {
            self.bytes.extend_from_slice(chunk);
            return;
        }
        self.bytes.extend_from_slice(&chunk[..room]);
        self.truncated = true;
    }

    fn into_text(self) -> String {
        let mut text = String::from_utf8_lossy(&self.bytes).into_owned();
        if self.truncated {
            text.push_str(TRUNCATED_MARKER);
        }
        if let Some(err) = self.read_error {
            text.push_str(READ_ERROR_PREFIX);
            text.push_str(&err);
            text.push(')');
        }
        text
    }
}

/// Drain `pipe` to EOF (or the first hard read error). Bytes past `cap` are
/// discarded; the read itself never stops early.
async fn drain_pipe<R: AsyncRead + Unpin>(mut pipe: R, cap: usize) -> PipeCapture {
    let mut capture = PipeCapture::new(cap);
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => capture.ingest(&chunk[..n]),
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            Err(err) => {
                capture.read_error = Some(err.to_string());
                break;
            }
        }
    }
    capture
}

async fn settle_reader(mut task: tokio::task::JoinHandle<PipeCapture>) -> PipeCapture {
    match tokio::time::timeout(READER_SETTLE, &mut task).await {
        Ok(Ok(capture)) => capture,
        Ok(Err(_)) => PipeCapture::failed("reader task panicked"),
        Err(_) => {
            task.abort();
            match task.await {
                Ok(capture) => capture,
                Err(join_err) if join_err.is_cancelled() => {
                    PipeCapture::failed("reader aborted after settle timeout")
                }
                Err(_) => PipeCapture::failed("reader task panicked"),
            }
        }
    }
}

fn timeout_line(program: &str, timeout: Duration) -> String {
    format!("{program} timed out after {}s", timeout.as_secs())
}

fn timeout_stderr(program: &str, timeout: Duration, captured: &str) -> String {
    let line = timeout_line(program, timeout);
    if captured.is_empty() {
        line
    } else {
        format!("{captured}\n{line}")
    }
}

/// Run the engine CLI once with `args`, capturing output. The program/cwd come
/// from `probe_engine_cli` or the user's explicit settings — this is a local
/// developer tool acting on the user's own click, not an exposed surface.
///
/// Every `TRPG_*` variable of the studio's own environment is removed first:
/// anything an operator left exported would configure this run (another data
/// directory, a model key). `env` then overlays the run's own settings — the
/// pack verification uses it to point `TRPG_DATA_DIR` at a scratch directory.
#[tauri::command]
pub async fn run_engine_cli(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<RunResult, String> {
    run_engine_command(
        &program,
        &args,
        cwd.as_deref(),
        env,
        true,
        RUN_TIMEOUT,
        MAX_CAPTURE_BYTES,
    )
    .await
}

/// Testable core of `run_engine_cli`. `timeout` and `capture_cap` are
/// parameters so tests can prove deadlock, bounds, and kill/reap without
/// waiting out the production 600s / 256 KiB constants.
pub(crate) async fn run_engine_command(
    program: &str,
    args: &[String],
    cwd: Option<&str>,
    env: Option<HashMap<String, String>>,
    scrub_trpg: bool,
    timeout: Duration,
    capture_cap: usize,
) -> Result<RunResult, String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        command.current_dir(dir);
    }
    if scrub_trpg {
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("TRPG_") {
                command.env_remove(key);
            }
        }
    }
    for (key, value) in env.unwrap_or_default() {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("spawning {program} failed: {err}"))?;

    let stdout_pipe = child.stdout.take();
    let stderr_pipe = child.stderr.take();
    let stdout_task = tokio::spawn(async move {
        match stdout_pipe {
            Some(pipe) => drain_pipe(pipe, capture_cap).await,
            None => PipeCapture::failed("stdout pipe was not captured"),
        }
    });
    let stderr_task = tokio::spawn(async move {
        match stderr_pipe {
            Some(pipe) => drain_pipe(pipe, capture_cap).await,
            None => PipeCapture::failed("stderr pipe was not captured"),
        }
    });

    let wait_result = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(result) => result,
        Err(_) => {
            // Kill + reap first so the pipes close; then join the readers so
            // they cannot outlive this function as background tasks / so the
            // child cannot remain a zombie. Do not rely on Drop for either.
            // `kill().await` skips wait when start_kill fails (child already
            // gone); always wait so a just-exited child is still reaped.
            let _ = child.start_kill();
            let _ = child.wait().await;
            let stdout = settle_reader(stdout_task).await;
            let stderr = settle_reader(stderr_task).await;
            return Ok(RunResult {
                code: None,
                stdout: stdout.into_text(),
                stderr: timeout_stderr(program, timeout, &stderr.into_text()),
                timed_out: true,
            });
        }
    };

    let stdout = settle_reader(stdout_task).await;
    let stderr = settle_reader(stderr_task).await;
    let status = wait_result.map_err(|err| format!("waiting on {program} failed: {err}"))?;
    Ok(RunResult {
        code: status.code(),
        stdout: stdout.into_text(),
        stderr: stderr.into_text(),
        timed_out: false,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        drain_pipe, is_scratch_dir, make_scratch_dir, remove_scratch_dir, run_engine_command,
        timeout_line, PipeCapture, READ_ERROR_PREFIX, TRUNCATED_MARKER,
    };
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::pin::Pin;
    use std::task::{Context, Poll};
    use std::time::Duration;
    use tokio::io::{AsyncRead, ReadBuf};

    /// Larger than a typical OS pipe buffer (64 KiB on Linux/macOS, 4 KiB
    /// default on Windows) so a sequential reader deadlocks for real.
    const PIPE_OVERFILL: usize = 256 * 1024;

    struct FailAfter {
        remaining: usize,
    }

    impl AsyncRead for FailAfter {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.remaining == 0 {
                return Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "injected",
                )));
            }
            let n = self.remaining.min(buf.remaining()).min(32);
            buf.put_slice(&[b'a'; 32][..n]);
            self.remaining -= n;
            Poll::Ready(Ok(()))
        }
    }

    fn short_echo() -> (&'static str, Vec<String>) {
        if cfg!(windows) {
            (
                "cmd",
                vec![
                    "/C".to_owned(),
                    "echo hello-out& echo hello-err 1>&2".to_owned(),
                ],
            )
        } else {
            (
                "sh",
                vec![
                    "-c".to_owned(),
                    "printf 'hello-out\\n'; printf 'hello-err\\n' >&2".to_owned(),
                ],
            )
        }
    }

    #[test]
    fn a_scratch_dir_is_made_empty_and_removed_again() {
        let dir = make_scratch_dir().expect("scratch dir");
        let path = std::path::Path::new(&dir);
        assert!(path.is_dir());
        assert!(is_scratch_dir(path));
        std::fs::write(path.join("index.json"), "[]").expect("write into it");
        remove_scratch_dir(dir.clone()).expect("remove");
        assert!(!path.exists());
        // Removing it twice is fine; it is gone either way.
        remove_scratch_dir(dir).expect("remove again");
    }

    #[test]
    fn only_a_scratch_dir_may_be_removed() {
        let temp = std::env::temp_dir();
        // The right name somewhere else, and another name in the right place.
        let elsewhere = temp.join("not-temp").join("lw-studio-verify-1");
        assert!(!is_scratch_dir(&elsewhere));
        assert!(
            remove_scratch_dir(temp.join("someone-elses").to_string_lossy().into_owned()).is_err()
        );
        assert!(remove_scratch_dir(temp.to_string_lossy().into_owned()).is_err());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_overlay_still_reaches_a_scrubbed_child() {
        let args = vec!["-c".to_owned(), "printf '%s' \"$TRPG_DATA_DIR\"".to_owned()];
        let mut env = HashMap::new();
        env.insert("TRPG_DATA_DIR".to_owned(), "/scratch".to_owned());
        let result = run_engine_command(
            "sh",
            &args,
            None,
            Some(env),
            true,
            Duration::from_secs(10),
            4096,
        )
        .await
        .expect("spawn/wait failed");
        assert_eq!(result.stdout, "/scratch");
    }

    #[test]
    fn prefix_ingest_stops_growing_at_the_cap() {
        let mut capture = PipeCapture::new(8);
        capture.ingest(b"abcdefghijklmnop");
        assert_eq!(capture.bytes, b"abcdefgh");
        assert!(capture.truncated);
        capture.ingest(b"MORE");
        assert_eq!(capture.bytes, b"abcdefgh");
        let text = capture.into_text();
        assert!(text.starts_with("abcdefgh"));
        assert!(text.contains(TRUNCATED_MARKER));
        assert_eq!(text.matches(TRUNCATED_MARKER).count(), 1);
    }

    #[test]
    fn short_prefix_is_kept_without_a_marker() {
        let mut capture = PipeCapture::new(32);
        capture.ingest(b"ok");
        let text = capture.into_text();
        assert_eq!(text, "ok");
        assert!(!text.contains(TRUNCATED_MARKER));
    }

    #[test]
    fn exact_cap_without_overflow_is_not_truncated() {
        let mut capture = PipeCapture::new(4);
        capture.ingest(b"abcd");
        assert!(!capture.truncated);
        assert_eq!(capture.into_text(), "abcd");
    }

    #[tokio::test]
    async fn drain_keeps_reading_after_the_cap() {
        let data = vec![b'x'; 1000];
        let mut cursor = Cursor::new(data);
        let capture = drain_pipe(&mut cursor, 16).await;
        assert_eq!(capture.bytes.len(), 16);
        assert!(capture.truncated);
        assert_eq!(cursor.position(), 1000);
        let text = capture.into_text();
        assert!(text.contains(TRUNCATED_MARKER));
    }

    #[tokio::test]
    async fn drain_records_a_read_error_and_keeps_the_prefix() {
        let capture = drain_pipe(FailAfter { remaining: 6 }, 64).await;
        assert_eq!(capture.bytes, b"aaaaaa");
        assert!(!capture.truncated);
        let text = capture.into_text();
        assert!(text.starts_with("aaaaaa"));
        assert!(text.contains(READ_ERROR_PREFIX));
        assert!(text.contains("injected"));
    }

    #[tokio::test]
    async fn short_command_keeps_both_pipes() {
        let (program, args) = short_echo();
        let result = tokio::time::timeout(
            Duration::from_secs(10),
            run_engine_command(
                program,
                &args,
                None,
                None,
                false,
                Duration::from_secs(10),
                4096,
            ),
        )
        .await
        .expect("short command hung")
        .expect("spawn/wait failed");
        assert_eq!(result.code, Some(0));
        assert!(!result.timed_out);
        assert!(
            result.stdout.contains("hello-out"),
            "stdout={}",
            result.stdout
        );
        assert!(
            result.stderr.contains("hello-err"),
            "stderr={}",
            result.stderr
        );
        assert!(!result.stdout.contains(TRUNCATED_MARKER));
        assert!(!result.stderr.contains(TRUNCATED_MARKER));
    }

    #[tokio::test]
    async fn env_overlay_reaches_the_child() {
        let (program, args) = if cfg!(windows) {
            (
                "cmd",
                vec!["/C".to_owned(), "echo %LW_ENGINE_TEST%".to_owned()],
            )
        } else {
            (
                "sh",
                vec![
                    "-c".to_owned(),
                    "printf '%s\\n' \"$LW_ENGINE_TEST\"".to_owned(),
                ],
            )
        };
        let mut env = HashMap::new();
        env.insert("LW_ENGINE_TEST".to_owned(), "overlay-ok".to_owned());
        let result = run_engine_command(
            program,
            &args,
            None,
            Some(env),
            false,
            Duration::from_secs(10),
            4096,
        )
        .await
        .expect("spawn/wait failed");
        assert_eq!(result.code, Some(0));
        assert!(
            result.stdout.contains("overlay-ok"),
            "stdout={}",
            result.stdout
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stderr_overfill_does_not_deadlock_stdout() {
        // The original bug: parent read stdout to completion first, so a
        // child that filled stderr (and left stdout open) blocked until the
        // 600s timeout. Parallel drain must return well under that.
        // `>&2` first so the zeros hit the child's stderr pipe; then silence
        // dd's own status line. The other order (`2>/dev/null >&2`) dumps
        // the payload into /dev/null.
        let script = format!(
            "dd if=/dev/zero bs={PIPE_OVERFILL} count=1 >&2 2>/dev/null; printf 'stdout-after-full-stderr'"
        );
        let args = vec!["-c".to_owned(), script];
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            run_engine_command("sh", &args, None, None, false, Duration::from_secs(12), 64),
        )
        .await
        .expect("stderr-first overfill deadlocked")
        .expect("spawn/wait failed");
        assert_eq!(result.code, Some(0));
        assert!(!result.timed_out);
        assert!(
            result.stdout.contains("stdout-after-full-stderr"),
            "stdout={}",
            result.stdout
        );
        assert!(
            result.stderr.contains(TRUNCATED_MARKER),
            "stderr should keep a prefix and mark the rest: {}",
            result.stderr
        );
        assert!(result.stderr.len() < 256, "stderr capture stayed bounded");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn stdout_overfill_does_not_deadlock_stderr() {
        let script = format!(
            "dd if=/dev/zero bs={PIPE_OVERFILL} count=1 2>/dev/null; printf 'stderr-after-full-stdout' >&2"
        );
        let args = vec!["-c".to_owned(), script];
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            run_engine_command("sh", &args, None, None, false, Duration::from_secs(12), 64),
        )
        .await
        .expect("stdout-first overfill deadlocked")
        .expect("spawn/wait failed");
        assert_eq!(result.code, Some(0));
        assert!(
            result.stderr.contains("stderr-after-full-stdout"),
            "stderr={}",
            result.stderr
        );
        assert!(result.stdout.contains(TRUNCATED_MARKER));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn huge_pipe_is_capped_and_marked() {
        let args = vec![
            "-c".to_owned(),
            format!("dd if=/dev/zero bs={PIPE_OVERFILL} count=4 2>/dev/null; printf 'x' >&2"),
        ];
        let result = tokio::time::timeout(
            Duration::from_secs(15),
            run_engine_command("sh", &args, None, None, false, Duration::from_secs(12), 32),
        )
        .await
        .expect("huge stdout hung")
        .expect("spawn/wait failed");
        assert_eq!(result.code, Some(0));
        assert!(result.stdout.contains(TRUNCATED_MARKER));
        assert_eq!(result.stdout.matches(TRUNCATED_MARKER).count(), 1);
        // PREFIX + one marker — nowhere near the 1 MiB the child wrote.
        assert!(result.stdout.len() < 128);
        assert!(result.stderr.contains('x'));
        assert!(!result.stderr.contains(TRUNCATED_MARKER));
    }

    #[cfg(unix)]
    fn process_is_alive(pid: u32) -> bool {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timeout_kills_and_reaps_the_child() {
        // Print the shell pid, then exec sleep so the pid stays the sleeper.
        // kill -0 succeeding after return would mean a live process or a
        // zombie we failed to reap.
        let args = vec![
            "-c".to_owned(),
            "printf '%s\\n' \"$$\"; exec sleep 60".to_owned(),
        ];
        let result = tokio::time::timeout(
            Duration::from_secs(8),
            run_engine_command(
                "sh",
                &args,
                None,
                None,
                false,
                Duration::from_millis(250),
                4096,
            ),
        )
        .await
        .expect("timeout path hung (readers or wait did not settle)")
        .expect("spawn/wait failed");
        assert!(result.timed_out);
        assert_eq!(result.code, None);
        assert!(
            result
                .stderr
                .contains(&timeout_line("sh", Duration::from_millis(250))),
            "stderr={}",
            result.stderr
        );
        let pid: u32 = result
            .stdout
            .lines()
            .next()
            .and_then(|line| line.trim().parse().ok())
            .unwrap_or_else(|| panic!("expected a pid on stdout, got {:?}", result.stdout));
        assert!(
            !process_is_alive(pid),
            "child {pid} still alive or left as a zombie"
        );
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn timeout_returns_without_hanging() {
        let args = vec!["-n".to_owned(), "30".to_owned(), "127.0.0.1".to_owned()];
        let result = tokio::time::timeout(
            Duration::from_secs(8),
            run_engine_command(
                "ping",
                &args,
                None,
                None,
                false,
                Duration::from_millis(300),
                4096,
            ),
        )
        .await
        .expect("timeout path hung")
        .expect("spawn/wait failed");
        assert!(result.timed_out);
        assert_eq!(result.code, None);
        assert!(result.stderr.contains("timed out"));
    }
}
