//! Verified, content-addressed panel-asset cache (protocol v1.8, spec S-UI).
//!
//! Disk layout: `<app_cache_dir>/panel-assets/<sha256-hex>`. Files are
//! immutable once written — the name IS the content hash, so cross-room and
//! cross-pack dedup fall out for free. Bytes never enter the cache without
//! passing sha256 verification, and the `panel://` scheme handler serves
//! panels exclusively from here. Eviction is LRU by file mtime under a byte
//! budget; a lookup hit refreshes the mtime.

use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager, Runtime, State};

use crate::transport_bridge::TransportState;

const CACHE_SUBDIR: &str = "panel-assets";

/// LRU byte budget. Panel bundles are ≤ 2 MB of code plus images; 256 MiB
/// holds hundreds of rooms' worth before anything is evicted.
pub const MAX_CACHE_BYTES: u64 = 256 * 1024 * 1024;

pub fn is_sha256_hex(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(64);
    for byte in digest {
        let _ = write!(out, "{byte:02x}");
    }
    out
}

pub fn cache_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|err| format!("no cache dir: {err}"))?;
    Ok(base.join(CACHE_SUBDIR))
}

/// Best-effort LRU bookkeeping: a used file becomes the newest.
fn touch(path: &Path) {
    if let Ok(file) = fs::File::options().write(true).open(path) {
        let _ = file.set_modified(SystemTime::now());
    }
}

/// The cached file for `hash`, refreshing its LRU stamp — or None on a miss.
/// Never returns unverified content: everything under the cache dir went
/// through [`verify_and_store`].
pub fn lookup(dir: &Path, hash: &str) -> Option<PathBuf> {
    if !is_sha256_hex(hash) {
        return None;
    }
    let path = dir.join(hash);
    if path.is_file() {
        touch(&path);
        Some(path)
    } else {
        None
    }
}

/// Verify `bytes` against `hash` and persist them atomically (tmp + rename).
/// A mismatch writes nothing and is an error — a corrupt or lying server
/// cannot poison the cache.
pub fn verify_and_store(dir: &Path, hash: &str, bytes: &[u8]) -> Result<(), String> {
    if !is_sha256_hex(hash) {
        return Err(format!("not a sha256 hex hash: {hash:?}"));
    }
    let actual = sha256_hex(bytes);
    if actual != hash {
        return Err(format!("hash mismatch: expected {hash}, got {actual}"));
    }
    fs::create_dir_all(dir).map_err(|err| format!("cache dir create failed: {err}"))?;
    let path = dir.join(hash);
    if path.is_file() {
        touch(&path);
        return Ok(());
    }
    let tmp = dir.join(format!(".tmp-{}-{hash}", std::process::id()));
    fs::write(&tmp, bytes).map_err(|err| format!("cache write failed: {err}"))?;
    fs::rename(&tmp, &path).map_err(|err| format!("cache commit failed: {err}"))?;
    prune(dir, MAX_CACHE_BYTES);
    Ok(())
}

/// Evict oldest-mtime entries until the cache fits the byte budget.
fn prune(dir: &Path, budget: u64) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(PathBuf, u64, SystemTime)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        // Only committed cache entries count; in-flight tmp files are skipped.
        if !is_sha256_hex(&name) {
            continue;
        }
        if let Ok(meta) = entry.metadata() {
            let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
            files.push((path, meta.len(), modified));
        }
    }
    let mut total: u64 = files.iter().map(|(_, len, _)| len).sum();
    if total <= budget {
        return;
    }
    files.sort_by_key(|(_, _, modified)| *modified);
    for (path, len, _) in files {
        if total <= budget {
            break;
        }
        if fs::remove_file(&path).is_ok() {
            total = total.saturating_sub(len);
        }
    }
}

/// Which of `hashes` are already cached (order-preserving).
#[tauri::command]
pub async fn asset_cache_status(app: AppHandle, hashes: Vec<String>) -> Result<Vec<bool>, String> {
    let dir = cache_dir(&app)?;
    Ok(hashes
        .iter()
        .map(|hash| is_sha256_hex(hash) && dir.join(hash).is_file())
        .collect())
}

/// Ensure one content-addressed blob is in the verified cache, pulling it over
/// the live transport's media byte channel on a miss. Returns the byte size.
/// The WebView never receives the bytes — the `panel://` handler serves them.
#[tauri::command]
pub async fn asset_fetch(
    app: AppHandle,
    state: State<'_, TransportState>,
    hash: String,
) -> Result<u64, String> {
    let hash = hash.to_ascii_lowercase();
    if !is_sha256_hex(&hash) {
        return Err(format!("not a sha256 hex hash: {hash:?}"));
    }
    let dir = cache_dir(&app)?;
    if let Some(path) = lookup(&dir, &hash) {
        return fs::metadata(&path)
            .map(|meta| meta.len())
            .map_err(|err| format!("cache stat failed: {err}"));
    }
    let handle = state.handle().await.ok_or("not connected")?;
    let blob = handle.fetch_blob(hash.clone()).await?;
    verify_and_store(&dir, &hash, &blob.bytes)?;
    Ok(blob.bytes.len() as u64)
}

/// Read one verified cache entry back as base64. Tier-1 `image`/`map_pin`
/// blocks are INERT pictures — unlike tier-2 code they may enter the WebView,
/// which wraps them in a `data:` URL its CSP already allows. Only content
/// that passed sha256 verification is ever returned, and only by its hash.
pub fn read_cached_base64(dir: &Path, hash: &str) -> Result<String, String> {
    let path = lookup(dir, hash).ok_or_else(|| format!("asset not cached: {hash:?}"))?;
    let bytes = fs::read(&path).map_err(|err| format!("cache read failed: {err}"))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(bytes))
}

/// The WebView's read half of [`asset_fetch`]: pull-then-read turns a wire
/// `{hash,mime,size}` block into a displayable picture.
#[tauri::command]
pub async fn asset_read_base64(app: AppHandle, hash: String) -> Result<String, String> {
    let hash = hash.to_ascii_lowercase();
    if !is_sha256_hex(&hash) {
        return Err(format!("not a sha256 hex hash: {hash:?}"));
    }
    read_cached_base64(&cache_dir(&app)?, &hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::Duration;

    fn temp_dir(tag: &str) -> PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lw-asset-cache-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn sha256_hex_matches_known_vector() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        );
    }

    #[test]
    fn store_rejects_mismatched_bytes_and_writes_nothing() {
        let dir = temp_dir("reject");
        let wrong = sha256_hex(b"other bytes");
        let err = verify_and_store(&dir, &wrong, b"panel bytes").unwrap_err();
        assert!(err.contains("hash mismatch"), "unexpected error: {err}");
        assert!(
            lookup(&dir, &wrong).is_none(),
            "mismatch must not be cached"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn store_rejects_non_hash_names() {
        let dir = temp_dir("badname");
        let err = verify_and_store(&dir, "../escape", b"x").unwrap_err();
        assert!(err.contains("not a sha256"), "unexpected error: {err}");
        assert!(!dir.exists(), "nothing may be written for a bad name");
    }

    #[test]
    fn store_then_lookup_roundtrip() {
        let dir = temp_dir("roundtrip");
        let bytes = b"verified panel asset";
        let hash = sha256_hex(bytes);
        verify_and_store(&dir, &hash, bytes).expect("store verified bytes");
        let path = lookup(&dir, &hash).expect("cache hit");
        assert_eq!(fs::read(&path).expect("read cached"), bytes);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_cached_base64_roundtrips_verified_bytes() {
        let dir = temp_dir("readb64");
        let bytes = b"\x89PNG fake image bytes";
        let hash = sha256_hex(bytes);
        verify_and_store(&dir, &hash, bytes).expect("store verified bytes");
        let encoded = read_cached_base64(&dir, &hash).expect("read back");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .expect("valid base64");
        assert_eq!(decoded, bytes);
        assert!(
            read_cached_base64(&dir, &sha256_hex(b"absent")).is_err(),
            "a miss is an error, never unverified content"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_evicts_oldest_first() {
        let dir = temp_dir("prune");
        fs::create_dir_all(&dir).unwrap();
        let old = sha256_hex(b"old");
        let mid = sha256_hex(b"mid");
        let new = sha256_hex(b"new");
        let base = SystemTime::now() - Duration::from_secs(600);
        for (hash, bytes, age) in [
            (&old, b"old" as &[u8], 0u64),
            (&mid, b"mid", 60),
            (&new, b"new", 120),
        ] {
            let path = dir.join(hash);
            fs::write(&path, bytes).unwrap();
            let file = fs::File::options().write(true).open(&path).unwrap();
            file.set_modified(base + Duration::from_secs(age)).unwrap();
        }
        // Budget of 6 bytes keeps only the two newest 3-byte entries.
        prune(&dir, 6);
        assert!(!dir.join(&old).exists(), "oldest entry must be evicted");
        assert!(dir.join(&mid).exists());
        assert!(dir.join(&new).exists());
        let _ = fs::remove_dir_all(&dir);
    }
}
