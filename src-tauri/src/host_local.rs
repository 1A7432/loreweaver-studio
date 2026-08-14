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
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

pub const HOST_LOCAL_EVENT: &str = "loreweaver://host-local";
const REPO: &str = "https://github.com/1A7432/loreweaver";
const READY_TIMEOUT: Duration = Duration::from_secs(90);
const BINARY_INTEGRITY_MANIFEST: &str = ".loreweaver-integrity.json";
const EXE_NAME: &str = if cfg!(windows) {
    "loreweaver-server.exe"
} else {
    "loreweaver-server"
};

#[derive(Serialize, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum HostLocalEvent {
    Log { level: String, text: String },
    Ready { ticket: String, key: String },
    Exit { code: Option<i32> },
    Error { message: String },
}

#[derive(Default)]
pub struct HostLocalState(pub Mutex<Option<Child>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostLocalStatus {
    pub running: bool,
    pub home: String,
    /// What the local server runs with as `TRPG_DATA_DIR`. Anything that must
    /// be visible to it — an installed pack above all — has to land here, so
    /// the caller needs the resolved path, not just the home.
    pub data_dir: String,
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

fn emit_log(app: &AppHandle, level: &str, text: impl Into<String>) {
    let _ = app.emit(
        HOST_LOCAL_EVENT,
        HostLocalEvent::Log {
            level: level.to_owned(),
            text: text.into(),
        },
    );
}

/// Download + verify + unpack the prebuilt server; returns the executable.
async fn download_binary(
    app: &AppHandle,
    paths: &LocalPaths,
    asset: &str,
) -> Result<PathBuf, String> {
    let url = release_url(asset);
    emit_log(app, "step", format!("Downloading {asset}…"));
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
    emit_log(app, "ok", "Download verified against its published SHA-256");

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
            "ok",
            "Using the verified prebuilt server downloaded earlier",
        );
        return Ok(Launch::Binary { exe });
    }
    if binary_exe(&paths.binary_dir).is_file() {
        emit_log(
            app,
            "err",
            "Ignoring an unverified or changed prebuilt server cache",
        );
    }
    let exe = download_binary(app, paths, asset).await?;
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

/// Stream one pipe line-by-line into log events; feed stderr through the
/// ticket scanner and fire Ready exactly once (ticket + sidecar key).
async fn watch_output(
    app: AppHandle,
    paths_sidecar: PathBuf,
    stdout: Option<tokio::process::ChildStdout>,
    stderr: Option<tokio::process::ChildStderr>,
) {
    let out_app = app.clone();
    let stdout_task = tauri::async_runtime::spawn(async move {
        if let Some(stdout) = stdout {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_log(&out_app, "out", line);
            }
        }
    });

    let ready = async {
        let mut seen = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                emit_log(&app, "out", line.clone());
                seen.push_str(&line);
                seen.push('\n');
                if let Some(ticket) = extract_ticket(&seen) {
                    // The sidecar is written before the ticket banner, but poll
                    // briefly anyway in case of filesystem lag.
                    for _ in 0..20 {
                        if let Ok(text) = tokio::fs::read_to_string(&paths_sidecar).await {
                            if let Some(key) = parse_sidecar_key(&text) {
                                let _ = app
                                    .emit(HOST_LOCAL_EVENT, HostLocalEvent::Ready { ticket, key });
                                return true;
                            }
                        }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    let _ = app.emit(
                        HOST_LOCAL_EVENT,
                        HostLocalEvent::Error {
                            message: "server is up but its keeper-key.txt sidecar never appeared"
                                .to_owned(),
                        },
                    );
                    return false;
                }
            }
        }
        false
    };

    match tokio::time::timeout(READY_TIMEOUT, ready).await {
        Ok(true) => {
            // Keep draining stderr in the background so the pipe never fills.
        }
        Ok(false) => {
            let _ = app.emit(
                HOST_LOCAL_EVENT,
                HostLocalEvent::Error {
                    message: "the server exited before it was ready".to_owned(),
                },
            );
        }
        Err(_) => {
            let _ = app.emit(
                HOST_LOCAL_EVENT,
                HostLocalEvent::Error {
                    message: "the server did not become ready in time (no iroh ticket after 90s)"
                        .to_owned(),
                },
            );
        }
    }
    let _ = stdout_task.await;
}

#[tauri::command]
pub async fn host_local_start(
    app: AppHandle,
    state: State<'_, HostLocalState>,
    engine_repo_dir: Option<String>,
    home_override: Option<String>,
) -> Result<(), String> {
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "host state poisoned".to_owned())?;
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return Err("a local server is already running".to_owned()),
                _ => *guard = None,
            }
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
        "step",
        format!("Local server home: {}", paths.home.display()),
    );

    let launch = resolve_launch(&app, &paths, engine_repo_dir).await?;

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

    emit_log(
        &app,
        "step",
        "Starting the local p2p server — waiting for a relay, ~10s…",
    );
    let mut child = command
        .spawn()
        .map_err(|err| format!("starting the server failed: {err}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "host state poisoned".to_owned())?;
        *guard = Some(child);
    }
    tauri::async_runtime::spawn(watch_output(
        app.clone(),
        paths.keeper_sidecar.clone(),
        stdout,
        stderr,
    ));
    Ok(())
}

#[tauri::command]
pub async fn host_local_stop(
    app: AppHandle,
    state: State<'_, HostLocalState>,
) -> Result<bool, String> {
    let stopped = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "host state poisoned".to_owned())?;
        match guard.take() {
            Some(mut child) => {
                let _ = child.start_kill();
                true
            }
            None => false,
        }
    };
    if stopped {
        let _ = app.emit(HOST_LOCAL_EVENT, HostLocalEvent::Exit { code: None });
    }
    Ok(stopped)
}

#[tauri::command]
pub async fn host_local_status(
    state: State<'_, HostLocalState>,
    home_override: Option<String>,
) -> Result<HostLocalStatus, String> {
    let running = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "host state poisoned".to_owned())?;
        match guard.as_mut() {
            Some(child) => matches!(child.try_wait(), Ok(None)),
            None => false,
        }
    };
    let paths = resolve_paths(home_override.as_deref());
    Ok(HostLocalStatus {
        running,
        home: paths.home.to_string_lossy().into_owned(),
        data_dir: paths.data_dir.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::{extract_ticket, parse_sha256_sidecar, parse_sidecar_key, resolve_paths};

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
}
