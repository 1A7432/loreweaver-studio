//! Receiving a session report (protocol 2.4 `report` frame).
//!
//! The server announces a generated HTML report to the ONE connection that
//! asked for it; the bytes ride the ordinary media GET. This module pulls them
//! through the same verified path panel assets use (`fetch_blob` +
//! [`verify_and_store`]), then hands the file out in exactly two ways: copied
//! to a path the person picked in the native save dialog, or copied under a
//! readable name into the app cache and opened with the OS default handler.
//!
//! The protocol forbids a client from rendering report HTML inside its own UI,
//! so the bytes never enter the WebView, and they live in their OWN cache
//! directory — never `panel-assets/`, which the `panel://` scheme serves to
//! tier-2 iframes. The system browser opening a local file is the sandbox the
//! page was written for.
//!
//! The opener plugin is called from here, not from the WebView: the frontend
//! holds no opener permission at all, so the only thing it can ever get opened
//! is a verified report this module wrote.

use std::fs;
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_opener::OpenerExt;

use crate::asset_cache::{is_sha256_hex, lookup, verify_and_store};
use crate::transport_bridge::TransportState;

/// Verified report blobs, content-addressed like the panel-asset cache.
const BLOB_SUBDIR: &str = "reports";
/// Named copies handed to the system browser: `<subdir>/<hash>/<name>.html`.
const OPEN_SUBDIR: &str = "reports-open";
/// The only MIME a `report` frame announces.
const REPORT_MIME: &str = "text/html";
/// Longest name accepted for the browser copy (bytes; every filesystem allows 255).
const MAX_NAME_BYTES: usize = 240;

fn cache_base<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map_err(|err| format!("no cache dir: {err}"))
}

fn checked_hash(hash: &str) -> Result<String, String> {
    let hash = hash.to_ascii_lowercase();
    if is_sha256_hex(&hash) {
        Ok(hash)
    } else {
        Err(format!("not a sha256 hex hash: {hash:?}"))
    }
}

/// Windows device names, which no file may be called whatever its extension.
fn is_reserved_stem(stem: &str) -> bool {
    let head = stem.split('.').next().unwrap_or("").to_ascii_lowercase();
    matches!(head.as_str(), "con" | "prn" | "aux" | "nul")
        || (head.len() == 4
            && (head.starts_with("com") || head.starts_with("lpt"))
            && head.as_bytes()[3].is_ascii_digit())
}

/// Characters a name must not carry: separators, the set Windows forbids, C0/C1
/// controls, and the invisible formatting/bidi controls that make a name read
/// differently from what it is.
fn is_forbidden_char(c: char) -> bool {
    matches!(c, '/' | '\\' | '<' | '>' | ':' | '"' | '|' | '?' | '*')
        || c.is_control()
        || matches!(c, '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2066}'..='\u{2069}' | '\u{FEFF}')
}

/// The browser copy's name must ALREADY be a safe base name — the frontend's
/// `safeReportName` produced it. This only checks, never rewrites: one
/// transform, one home, and a name that fails here is refused, not repaired.
pub fn is_safe_report_name(name: &str) -> bool {
    let Some(stem) = name
        .strip_suffix(".html")
        .or_else(|| name.strip_suffix(".HTML"))
    else {
        return false;
    };
    !stem.is_empty()
        && name.len() <= MAX_NAME_BYTES
        && !stem.starts_with('.')
        && !stem.ends_with('.')
        && !stem.ends_with(' ')
        && stem.trim() == stem
        && !stem.chars().any(is_forbidden_char)
        && !is_reserved_stem(stem)
}

/// The verified blob for `hash`, or an error naming the miss.
fn cached_blob(dir: &Path, hash: &str) -> Result<PathBuf, String> {
    lookup(dir, hash).ok_or_else(|| format!("report not fetched: {hash}"))
}

/// Copy the verified blob to `dest`. `dest` came from the native save dialog,
/// which already asked before replacing an existing file — so this writes what
/// the person confirmed, and refuses only what no dialog can mean (a directory).
pub fn save_blob(dir: &Path, hash: &str, dest: &Path) -> Result<u64, String> {
    let source = cached_blob(dir, hash)?;
    if dest.is_dir() {
        return Err(format!("{} is a directory", dest.display()));
    }
    fs::copy(&source, dest).map_err(|err| format!("saving the report failed: {err}"))
}

/// Place the readable-name copy the browser opens. The directory is named by
/// the hash, so an existing file there already holds these exact bytes and is
/// reused rather than rewritten.
pub fn place_open_copy(
    blobs: &Path,
    open_root: &Path,
    hash: &str,
    name: &str,
) -> Result<PathBuf, String> {
    if !is_safe_report_name(name) {
        return Err(format!("unsafe report file name: {name:?}"));
    }
    let source = cached_blob(blobs, hash)?;
    let dir = open_root.join(hash);
    fs::create_dir_all(&dir).map_err(|err| format!("report dir create failed: {err}"))?;
    let path = dir.join(name);
    if !path.is_file() {
        fs::copy(&source, &path).map_err(|err| format!("report copy failed: {err}"))?;
    }
    Ok(path)
}

/// Pull one announced report over the live connection's media channel into the
/// verified report cache. Returns its byte size. A bad hash, a non-HTML reply
/// or bytes that do not hash to the announcement write nothing.
#[tauri::command]
pub async fn report_fetch(
    app: AppHandle,
    state: State<'_, TransportState>,
    hash: String,
) -> Result<u64, String> {
    let hash = checked_hash(&hash)?;
    let dir = cache_base(&app)?.join(BLOB_SUBDIR);
    if let Some(path) = lookup(&dir, &hash) {
        return fs::metadata(&path)
            .map(|meta| meta.len())
            .map_err(|err| format!("cache stat failed: {err}"));
    }
    let handle = state.handle().await.ok_or("not connected")?;
    let blob = handle.fetch_blob(hash.clone()).await?;
    if blob.mime != REPORT_MIME {
        return Err(format!("not a report: the server sent {:?}", blob.mime));
    }
    verify_and_store(&dir, &hash, &blob.bytes)?;
    Ok(blob.bytes.len() as u64)
}

/// Save a fetched report to the path the save dialog returned.
#[tauri::command]
pub async fn report_save(app: AppHandle, hash: String, path: String) -> Result<u64, String> {
    let hash = checked_hash(&hash)?;
    save_blob(
        &cache_base(&app)?.join(BLOB_SUBDIR),
        &hash,
        Path::new(&path),
    )
}

/// Open a fetched report in the system's default handler for `.html` — the
/// browser. Answers the path that was opened.
#[tauri::command]
pub async fn report_open(app: AppHandle, hash: String, name: String) -> Result<String, String> {
    let hash = checked_hash(&hash)?;
    let base = cache_base(&app)?;
    let path = place_open_copy(
        &base.join(BLOB_SUBDIR),
        &base.join(OPEN_SUBDIR),
        &hash,
        &name,
    )?;
    let shown = path.to_string_lossy().into_owned();
    app.opener()
        .open_path(shown.clone(), None::<&str>)
        .map_err(|err| format!("opening the report failed: {err}"))?;
    Ok(shown)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset_cache::sha256_hex;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lw-report-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn accepts_the_names_the_frontend_produces() {
        for name in [
            "loreweaver-report-tide-20261016-120000.html",
            "loreweaver-report-tide-20261016-120000-reveal.html",
            "汐浦送灯 团报.html",
            "a.b.html",
        ] {
            assert!(is_safe_report_name(name), "{name}");
        }
    }

    #[test]
    fn refuses_anything_that_is_not_a_plain_html_base_name() {
        for name in [
            "",
            ".html",
            "../escape.html",
            "dir/name.html",
            "dir\\name.html",
            ".hidden.html",
            "trailing..html",
            "trailing .html",
            " lead.html",
            "no-extension",
            "page.htm",
            "con.html",
            "COM1.html",
            "lpt9.report.html",
            "bell\u{7}.html",
            "rtl\u{202E}lmth.exe.html",
            "a<b>.html",
            "what?.html",
        ] {
            assert!(!is_safe_report_name(name), "{name:?}");
        }
        assert!(!is_safe_report_name(&format!(
            "{}.html",
            "x".repeat(MAX_NAME_BYTES)
        )));
    }

    #[test]
    fn reserved_check_spares_ordinary_words() {
        assert!(!is_reserved_stem("console"));
        assert!(!is_reserved_stem("comx"));
        assert!(is_reserved_stem("nul"));
        assert!(is_reserved_stem("Com7.tar"));
    }

    #[test]
    fn a_mismatched_report_never_reaches_the_cache() {
        let dir = temp_dir("mismatch");
        let announced = sha256_hex(b"<html>the real report</html>");
        let err = verify_and_store(&dir, &announced, b"<html>something else</html>").unwrap_err();
        assert!(err.contains("hash mismatch"), "{err}");
        assert!(
            cached_blob(&dir, &announced).is_err(),
            "nothing to save or open"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_copies_the_verified_bytes_and_refuses_a_directory() {
        let dir = temp_dir("save");
        let bytes = b"<html>report</html>";
        let hash = sha256_hex(bytes);
        verify_and_store(&dir, &hash, bytes).unwrap();
        let out = temp_dir("save-out");
        fs::create_dir_all(&out).unwrap();
        let dest = out.join("report.html");
        assert_eq!(save_blob(&dir, &hash, &dest).unwrap(), bytes.len() as u64);
        assert_eq!(fs::read(&dest).unwrap(), bytes);
        assert!(save_blob(&dir, &hash, &out)
            .unwrap_err()
            .contains("directory"));
        assert!(save_blob(&dir, &sha256_hex(b"absent"), &dest).is_err());
        let _ = fs::remove_dir_all(&dir);
        let _ = fs::remove_dir_all(&out);
    }

    #[test]
    fn open_copy_lands_under_the_hash_with_the_given_name() {
        let blobs = temp_dir("open-blobs");
        let root = temp_dir("open-root");
        let bytes = b"<html>report</html>";
        let hash = sha256_hex(bytes);
        verify_and_store(&blobs, &hash, bytes).unwrap();
        let path = place_open_copy(&blobs, &root, &hash, "tide.html").unwrap();
        assert_eq!(path, root.join(&hash).join("tide.html"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        // Idempotent: a second open reuses the same file.
        assert_eq!(
            place_open_copy(&blobs, &root, &hash, "tide.html").unwrap(),
            path
        );
        let err = place_open_copy(&blobs, &root, &hash, "../tide.html").unwrap_err();
        assert!(err.contains("unsafe"), "{err}");
        let _ = fs::remove_dir_all(&blobs);
        let _ = fs::remove_dir_all(&root);
    }
}
