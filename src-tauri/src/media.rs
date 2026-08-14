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
//!   1. `media_prepare(path)` reads the file, hashes it, and reports the
//!      `{name, mime, size, sha256}` the offer frame needs.
//!   2. `media_upload(path, upload_id)` re-reads it and PUTs it, refusing if
//!      the bytes no longer hash to what was offered — the server would reject
//!      the mismatch anyway, and saying so here names the actual cause.
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

/// Read a file and report exactly what `media_offer` needs to say about it.
#[tauri::command]
pub async fn media_prepare(path: String) -> Result<MediaOffer, String> {
    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("upload")
        .to_owned();
    let mime = mime_for(&name)
        .ok_or_else(|| format!("{name}: not an image or audio format this server accepts"))?;
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| format!("reading {name} failed: {err}"))?;
    Ok(MediaOffer {
        sha256: sha256_hex(&bytes),
        size: bytes.len() as u64,
        mime: mime.to_owned(),
        name,
    })
}

/// PUT the file the server just accepted. `expected_sha256` is what the offer
/// claimed; a file edited between the offer and the upload is refused here
/// rather than server-side, because only this side knows why.
#[tauri::command]
pub async fn media_upload(
    state: State<'_, TransportState>,
    path: String,
    upload_id: String,
    expected_sha256: String,
) -> Result<String, String> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| format!("reading {path} failed: {err}"))?;
    let actual = sha256_hex(&bytes);
    if actual != expected_sha256.to_ascii_lowercase() {
        return Err("the file changed after it was offered — pick it again".to_owned());
    }
    let handle = state.handle().await.ok_or("not connected")?;
    handle.put_blob(upload_id, bytes).await
}

#[cfg(test)]
mod tests {
    use super::mime_for;

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
