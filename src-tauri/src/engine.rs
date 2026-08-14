//! Local engine CLI integration. The studio never zips or validates packs in
//! TypeScript — the engine (`loreweaver-server --pack` / `python -m app
//! --pack`) is the single source of truth for validation and deterministic
//! builds. This module only finds that CLI and runs it, streaming nothing:
//! one buffered run, stdout/stderr and exit code back to the WebView.

use serde::Serialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// Bound runaway CLI output before it reaches the WebView.
const MAX_CAPTURE_BYTES: usize = 256 * 1024;
const RUN_TIMEOUT: Duration = Duration::from_secs(600);

#[derive(Serialize, Clone)]
pub struct EngineCandidate {
    /// "bundled-binary" (PATH `loreweaver-server`) or "python-module".
    pub kind: String,
    pub program: String,
    /// Argument prefix before the studio's own flags (e.g. ["-m", "app"]).
    pub args: Vec<String>,
    pub cwd: Option<String>,
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

/// Probe for a usable engine CLI. `engine_repo_dir` is the user-configured
/// checkout of the main repo (enables the `python -m app` route).
#[tauri::command]
pub async fn probe_engine_cli(engine_repo_dir: Option<String>) -> Vec<EngineCandidate> {
    let mut candidates = Vec::new();
    if let Some(binary) = executable_in_path("loreweaver-server") {
        candidates.push(EngineCandidate {
            kind: "bundled-binary".to_owned(),
            program: binary.to_string_lossy().into_owned(),
            args: Vec::new(),
            cwd: None,
        });
    }
    if let Some(repo) = engine_repo_dir {
        let repo_path = Path::new(&repo);
        if repo_path.join("app.py").is_file() {
            // The repo's own virtualenv carries the engine's dependencies; a
            // bare system python almost never does (found live: `python3 -m
            // app --pack` died with a dependency traceback while the checkout
            // had a perfectly good .venv). Prefer the venv interpreter.
            let venv_pythons = [
                repo_path.join(".venv").join("bin").join("python"),
                repo_path.join(".venv").join("Scripts").join("python.exe"),
                repo_path.join("venv").join("bin").join("python"),
                repo_path.join("venv").join("Scripts").join("python.exe"),
            ];
            let venv = venv_pythons.iter().find(|python| python.is_file());
            if let Some(python) = venv {
                candidates.push(EngineCandidate {
                    kind: "python-module".to_owned(),
                    program: python.to_string_lossy().into_owned(),
                    args: vec!["-m".to_owned(), "app".to_owned()],
                    cwd: Some(repo.clone()),
                });
            } else {
                for python in ["python3", "python"] {
                    if executable_in_path(python).is_some() {
                        candidates.push(EngineCandidate {
                            kind: "python-module".to_owned(),
                            program: python.to_owned(),
                            args: vec!["-m".to_owned(), "app".to_owned()],
                            cwd: Some(repo),
                        });
                        break;
                    }
                }
            }
        }
    }
    candidates
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

fn truncate_capture(mut text: String) -> String {
    if text.len() > MAX_CAPTURE_BYTES {
        let mut cut = MAX_CAPTURE_BYTES;
        while !text.is_char_boundary(cut) {
            cut -= 1;
        }
        text.truncate(cut);
        text.push_str("\n… (truncated)");
    }
    text
}

/// Run the engine CLI once with `args`, capturing output. The program/cwd come
/// from `probe_engine_cli` or the user's explicit settings — this is a local
/// developer tool acting on the user's own click, not an exposed surface.
///
/// `env` overlays the studio's own environment for this one run. The caller
/// that needs it is "test this pack now": `--install` lands the pack under
/// `settings.data_dir`, which the engine reads from `TRPG_DATA_DIR`, and the
/// one-click local server runs with its own data dir — without the overlay the
/// pack would install where nothing is going to look for it.
#[tauri::command]
pub async fn run_engine_cli(
    program: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, String>>,
) -> Result<RunResult, String> {
    let mut command = Command::new(&program);
    command
        .args(&args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = &cwd {
        command.current_dir(dir);
    }
    for (key, value) in env.unwrap_or_default() {
        command.env(key, value);
    }
    let mut child = command
        .spawn()
        .map_err(|err| format!("spawning {program} failed: {err}"))?;

    let mut stdout_pipe = child.stdout.take();
    let mut stderr_pipe = child.stderr.take();
    let reader = async {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        if let Some(pipe) = stdout_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut stdout).await;
        }
        if let Some(pipe) = stderr_pipe.as_mut() {
            let _ = pipe.read_to_end(&mut stderr).await;
        }
        (stdout, stderr)
    };

    let run = async {
        let (outputs, status) = tokio::join!(reader, child.wait());
        (outputs, status)
    };

    match tokio::time::timeout(RUN_TIMEOUT, run).await {
        Ok(((stdout, stderr), status)) => {
            let status = status.map_err(|err| format!("waiting on {program} failed: {err}"))?;
            Ok(RunResult {
                code: status.code(),
                stdout: truncate_capture(String::from_utf8_lossy(&stdout).into_owned()),
                stderr: truncate_capture(String::from_utf8_lossy(&stderr).into_owned()),
                timed_out: false,
            })
        }
        Err(_) => Ok(RunResult {
            code: None,
            stdout: String::new(),
            stderr: format!("{program} timed out after {}s", RUN_TIMEOUT.as_secs()),
            timed_out: true,
        }),
    }
}
