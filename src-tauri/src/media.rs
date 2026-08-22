//! Uploading a picture or an audio file to the room.
//!
//! The upload flow is `docs/protocol.md`'s, split at the one seam that matters:
//! the CONTROL half (`media_offer` out, `media_accept` back) is frames, so the
//! WebView owns it; the BYTE half is a PUT on the media channel, so it happens
//! here and the file's bytes never enter the WebView. That is the same rule
//! `asset_cache.rs` keeps for downloads, and for the same reason — the protocol
//! allows 128 MiB of audio per file.
//!
//! Two commands, matching the two steps:
//!   1. `media_prepare(path)` stats the file, refuses a non-regular or over-cap
//!      path *before* `read`, hashes the bytes, and reports the
//!      `{name, mime, size, sha256}` the offer frame needs.
//!   2. `media_upload(path, upload_id)` repeats that pre-check, re-reads, and
//!      PUTs, refusing if the file grew past the cap between `metadata` and
//!      `read` (TOCTOU) or no longer hashes to what was offered.
//!
//! The cap is [`loreweaver_transport::MAX_BLOB_BYTES`] — the same client
//! defensive ceiling the GET path uses — so a 65–128 MiB audio file the
//! protocol already allows is not blocked here.
//!
//! MIME comes from the file EXTENSION against the engine's own allowlists
//! (`infra/media_store.py`: `ALLOWED_IMAGE_MIMES` / `ALLOWED_AUDIO_MIMES`),
//! never from sniffing: the server validates the offered MIME against those
//! same sets, so guessing differently would only produce a confusing rejection.

use serde::Serialize;
use std::path::Path;
use tauri::State;

use crate::asset_cache::sha256_hex;
use crate::transport_bridge::TransportState;
use loreweaver_transport::MAX_BLOB_BYTES;

/// Extension → MIME, mirroring `infra/media_store.py`'s two allowlists. A
/// suffix that is not here is not uploadable, and the error says so rather than
/// letting the server answer `media_bad_mime` about a file we could have
/// refused locally.
fn mime_for(name: &str) -> Option<&'static str> {
    let ext = Path::new(name)
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)?;
    Some(match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "ogg" | "oga" => "audio/ogg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "m4a" | "mp4" => "audio/mp4",
        "aac" => "audio/aac",
        _ => return None,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaOffer {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
}

fn file_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("upload")
        .to_owned()
}

fn over_cap_err(name: &str, len: u64, cap: u64, grew: bool) -> String {
    if grew {
        format!("{name}: file grew to {len} bytes, past the {cap}-byte client cap")
    } else {
        format!("{name}: {len} bytes exceeds the {cap}-byte client cap")
    }
}

/// Stat, refuse a non-regular or over-cap path, then read. After the read,
/// refuse again if the file grew past `cap` between `metadata` and `read`.
async fn read_capped_file_with(path: &str, cap: u64) -> Result<Vec<u8>, String> {
    let name = file_name(path);
    let meta = tokio::fs::metadata(path)
        .await
        .map_err(|err| format!("reading {name} failed: {err}"))?;
    if !meta.is_file() {
        return Err(format!("{name}: not a regular file"));
    }
    if meta.len() > cap {
        return Err(over_cap_err(&name, meta.len(), cap, false));
    }
    let bytes = tokio::fs::read(path)
        .await
        .map_err(|err| format!("reading {name} failed: {err}"))?;
    let len = bytes.len() as u64;
    if len > cap {
        return Err(over_cap_err(&name, len, cap, true));
    }
    Ok(bytes)
}

async fn read_capped_file(path: &str) -> Result<Vec<u8>, String> {
    read_capped_file_with(path, MAX_BLOB_BYTES).await
}

/// Read a file and report exactly what `media_offer` needs to say about it.
#[tauri::command]
pub async fn media_prepare(path: String) -> Result<MediaOffer, String> {
    let name = file_name(&path);
    let mime = mime_for(&name)
        .ok_or_else(|| format!("{name}: not an image or audio format this server accepts"))?;
    let bytes = read_capped_file(&path).await?;
    Ok(MediaOffer {
        sha256: sha256_hex(&bytes),
        size: bytes.len() as u64,
        mime: mime.to_owned(),
        name,
    })
}

/// PUT the file the server just accepted. `expected_sha256` is what the offer
/// claimed; a file edited between the offer and the upload is refused here
/// rather than server-side, because only this side knows why. The size
/// pre-check runs again so a file that grew past the cap after the offer
/// is not pulled entirely into memory.
#[tauri::command]
pub async fn media_upload(
    state: State<'_, TransportState>,
    path: String,
    upload_id: String,
    expected_sha256: String,
) -> Result<String, String> {
    let bytes = read_capped_file(&path).await?;
    let actual = sha256_hex(&bytes);
    if actual != expected_sha256.to_ascii_lowercase() {
        return Err("the file changed after it was offered — pick it again".to_owned());
    }
    let handle = state.handle().await.ok_or("not connected")?;
    handle.put_blob(upload_id, bytes).await
}

#[cfg(test)]
mod tests {
    use super::{file_name, mime_for, over_cap_err, read_capped_file_with, MAX_BLOB_BYTES};
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_path(tag: &str) -> std::path::PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        std::env::temp_dir().join(format!(
            "lw-media-{}-{}-{}",
            tag,
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
        ))
    }

    #[test]
    fn client_cap_is_the_transport_constant() {
        assert_eq!(MAX_BLOB_BYTES, loreweaver_transport::MAX_BLOB_BYTES);
        assert_eq!(MAX_BLOB_BYTES, 128 * 1024 * 1024);
    }

    #[test]
    fn over_cap_messages_name_the_file_and_the_cap() {
        let pre = over_cap_err("tide.mp3", 129, 128, false);
        assert!(pre.contains("tide.mp3"), "{pre}");
        assert!(
            pre.contains("129 bytes exceeds the 128-byte client cap"),
            "{pre}"
        );
        let grew = over_cap_err("tide.mp3", 200, 128, true);
        assert!(
            grew.contains("grew to 200 bytes, past the 128-byte client cap"),
            "{grew}"
        );
    }

    #[tokio::test]
    async fn read_capped_file_accepts_a_regular_file_at_the_cap() {
        let path = temp_path("ok.mp3");
        std::fs::write(&path, [0u8; 8]).unwrap();
        let bytes = read_capped_file_with(path.to_str().unwrap(), 8)
            .await
            .expect("exactly the cap is allowed");
        assert_eq!(bytes.len(), 8);
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn read_capped_file_refuses_over_cap_before_the_body_is_the_point() {
        let path = temp_path("big.mp3");
        std::fs::write(&path, [0u8; 9]).unwrap();
        let err = read_capped_file_with(path.to_str().unwrap(), 8)
            .await
            .expect_err("over the test cap");
        assert!(err.contains("exceeds the 8-byte client cap"), "{err}");
        assert!(
            err.contains(file_name(path.to_str().unwrap()).as_str()),
            "{err}"
        );
        let _ = std::fs::remove_file(&path);
    }

    #[tokio::test]
    async fn read_capped_file_refuses_a_directory() {
        let path = temp_path("dir");
        std::fs::create_dir_all(&path).unwrap();
        let err = read_capped_file_with(path.to_str().unwrap(), 128)
            .await
            .expect_err("a directory is not a regular file");
        assert!(err.contains("not a regular file"), "{err}");
        let _ = std::fs::remove_dir_all(&path);
    }

    #[test]
    fn maps_every_format_the_engine_allows() {
        // `infra/media_store.py::ALLOWED_IMAGE_MIMES` / `ALLOWED_AUDIO_MIMES`.
        for (name, mime) in [
            ("a.png", "image/png"),
            ("a.JPG", "image/jpeg"),
            ("a.jpeg", "image/jpeg"),
            ("a.webp", "image/webp"),
            ("a.gif", "image/gif"),
            ("a.svg", "image/svg+xml"),
            ("a.mp3", "audio/mpeg"),
            ("a.ogg", "audio/ogg"),
            ("a.wav", "audio/wav"),
            ("a.flac", "audio/flac"),
            ("a.m4a", "audio/mp4"),
            ("a.aac", "audio/aac"),
        ] {
            assert_eq!(mime_for(name), Some(mime), "{name}");
        }
    }

    #[test]
    fn refuses_anything_outside_those_two_sets() {
        for name in ["notes.txt", "archive.zip", "clip.mkv", "noextension"] {
            assert_eq!(mime_for(name), None, "{name}");
        }
    }
}
