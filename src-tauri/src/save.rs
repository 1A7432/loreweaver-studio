//! A room save, out and back in (protocol 3.0 `save`, `docs/protocol.md` §6.7 and §11).
//!
//! The save is the whole room as one JSON file, and it never travels in a frame: `save
//! {op: "export"}` stores it on the server where only admins can fetch it and answers with
//! its reference `{hash, mime, size, name}`; restoring offers the file with `media.offer
//! {purpose: "save"}`, PUTs it, and runs `save {op: "import", file: <hash>}`. The CONTROL half
//! (the two commands and the offer) is frames, so the WebView's protocol session owns it; the
//! BYTE half is here, so the file's bytes never enter the WebView — in either direction.
//!
//! A save holds every secret of the room. What this module does with it:
//!   - a fetched save goes straight from the byte channel, in memory, to the one file the
//!     admin picked in the native save dialog — never through `asset_cache` (whose folder the
//!     `panel://` scheme serves) or the report cache, never into any other folder;
//!   - it is checked before anything is written: the type the answer named, the exact size
//!     the answer named, and the SHA-256 the answer named;
//!   - it is written to a fresh temporary file beside the destination, created for this
//!     write alone (`create_new`) and, on Unix, readable and writable by this user only
//!     (mode 0600), then renamed over the destination: a write that fails part-way leaves no
//!     half file, and a replaced file does not keep its old permissions;
//!   - nothing of its content is ever logged, returned or put in an error: the WebView is told
//!     the size, and failures name a code (and, for a local failure, English detail with no
//!     content in it).
//!
//! Its size limit is the server's default for one save file ([`MAX_SAVE_BYTES`], 256 MiB),
//! the one fetch that names a ceiling larger than [`loreweaver_transport::MAX_BLOB_BYTES`].

use std::fs::{self, OpenOptions};
use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicU32, Ordering};

use loreweaver_transport::bytes::{is_content_hash, ByteFile};
use loreweaver_transport::link::LinkHandle;
use serde::Serialize;
use tauri::State;

use crate::asset_cache::sha256_hex;
use crate::failure::Failure;
use crate::media::{read_capped_file_with, receipt_matches};
use crate::transport_bridge::TransportState;

pub use loreweaver_transport::MAX_SAVE_BYTES;

/// The type a save travels as, both ways.
pub const SAVE_MIME: &str = "application/json";

/// What `media.offer {purpose: "save"}` says about a save file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveFile {
    pub name: String,
    pub mime: String,
    pub size: u64,
    pub sha256: String,
}

/// Whether bytes start the way a save does: one JSON object (an optional byte-order mark and
/// whitespace, then `{`). The server judges the rest; this only keeps a picture or a list from
/// being offered as a room (the server refuses those too).
pub fn looks_like_save(bytes: &[u8]) -> bool {
    let body = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    body.iter()
        .find(|byte| !matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        .is_some_and(|byte| *byte == b'{')
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("save.json")
        .to_owned()
}

/// Read a save file within [`MAX_SAVE_BYTES`] and refuse what does not start like one.
async fn read_save(path: &Path) -> Result<Vec<u8>, Failure> {
    let shown = path.to_string_lossy();
    let bytes = read_capped_file_with(&shown, MAX_SAVE_BYTES).await?;
    if !looks_like_save(&bytes) {
        return Err(Failure::local(
            "not_a_save",
            format!("{}: does not start like a save file", file_name(path)),
        ));
    }
    Ok(bytes)
}

/// Read and hash a save file: what the offer says about it.
pub async fn prepare(path: &Path) -> Result<SaveFile, Failure> {
    let bytes = read_save(path).await?;
    Ok(SaveFile {
        name: file_name(path),
        mime: SAVE_MIME.to_owned(),
        size: bytes.len() as u64,
        sha256: sha256_hex(&bytes),
    })
}

/// PUT a save file the server accepted (`media.offer` answered `{upload_id}`). The file is
/// read again and must still be what was offered; the receipt must name those very bytes.
pub async fn send(
    handle: &LinkHandle,
    path: &Path,
    upload_id: String,
    expected_sha256: &str,
) -> Result<ByteFile, Failure> {
    let bytes = read_save(path).await?;
    let sha256 = sha256_hex(&bytes);
    if sha256 != expected_sha256.to_ascii_lowercase() {
        return Err(Failure::local(
            "changed",
            "the file changed after it was offered",
        ));
    }
    let size = bytes.len() as u64;
    let receipt = handle.put(upload_id, bytes).await?;
    receipt_matches(&receipt.hash, receipt.size, &sha256, size)?;
    Ok(receipt)
}

/// Fetch the save an export named — `hash` and `size` are the answer's own — check it, and
/// write it, private to this user, at `dest`. Answers the bytes written.
pub async fn fetch_to(
    handle: &LinkHandle,
    hash: &str,
    size: u64,
    dest: &Path,
) -> Result<u64, Failure> {
    if !is_content_hash(hash) {
        return Err(Failure::local("bad_hash", "not a content hash"));
    }
    if size > MAX_SAVE_BYTES {
        return Err(Failure::local(
            "too_large",
            format!("{size} bytes exceeds the {MAX_SAVE_BYTES}-byte save cap"),
        ));
    }
    if dest.is_dir() {
        return Err(Failure::local("not_a_file", "the destination is a folder"));
    }
    let fetched = handle.fetch_within(hash.to_owned(), MAX_SAVE_BYTES).await?;
    if fetched.file.mime != SAVE_MIME {
        return Err(Failure::local(
            "not_a_save",
            format!("the server sent {:?}", fetched.file.mime),
        ));
    }
    if fetched.bytes.len() as u64 != size {
        return Err(Failure::local(
            "size_mismatch",
            format!(
                "{} bytes arrived, the answer named {size}",
                fetched.bytes.len()
            ),
        ));
    }
    if sha256_hex(&fetched.bytes) != hash {
        return Err(Failure::local(
            "hash_mismatch",
            "the bytes do not hash to the answer's",
        ));
    }
    write_private(dest, &fetched.bytes)
        .map_err(|err| Failure::local("write_failed", format!("writing the save failed: {err}")))?;
    Ok(size)
}

/// Write `bytes` at `dest` through a fresh temporary file beside it — created for this write
/// alone, mode 0600 on Unix — renamed over `dest` once complete. On any failure the temporary
/// file is removed and `dest` is left as it was.
pub fn write_private(dest: &Path, bytes: &[u8]) -> std::io::Result<()> {
    static COUNTER: AtomicU32 = AtomicU32::new(0);
    let dir = match dest.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent,
        _ => Path::new("."),
    };
    let stem = dest
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "save".to_owned());
    let temp = dir.join(format!(
        ".{stem}.{}-{}.part",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options.open(&temp)?;
    let written = file
        .write_all(bytes)
        .and_then(|()| file.sync_all())
        .and_then(|()| {
            drop(file);
            fs::rename(&temp, dest)
        });
    if written.is_err() {
        let _ = fs::remove_file(&temp);
    }
    written
}

async fn live(state: &TransportState) -> Result<LinkHandle, Failure> {
    state
        .handle()
        .await
        .ok_or_else(|| Failure::local("not_connected", "no live link"))
}

/// Read and hash a save file the admin picked: what `media.offer {purpose: "save"}` says.
#[tauri::command]
pub async fn save_prepare(path: String) -> Result<SaveFile, Failure> {
    prepare(Path::new(&path)).await
}

/// PUT an accepted save upload; answers the server's receipt (checked against what was sent).
#[tauri::command]
pub async fn save_upload(
    state: State<'_, TransportState>,
    path: String,
    upload_id: String,
    expected_sha256: String,
) -> Result<ByteFile, Failure> {
    let handle = live(&state).await?;
    send(&handle, Path::new(&path), upload_id, &expected_sha256).await
}

/// Fetch the save an export named and write it at the path the save dialog returned.
#[tauri::command]
pub async fn save_fetch(
    state: State<'_, TransportState>,
    hash: String,
    size: u64,
    path: String,
) -> Result<u64, Failure> {
    let handle = live(&state).await?;
    fetch_to(&handle, &hash, size, Path::new(&path)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "lw-save-{tag}-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed),
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_save_starts_like_one_json_object() {
        assert!(looks_like_save(b"{}"));
        assert!(looks_like_save(b" \r\n\t{\"format\":1}"));
        assert!(looks_like_save(b"\xef\xbb\xbf{}"));
        assert!(!looks_like_save(b"[1,2]"));
        assert!(!looks_like_save(b"\x89PNG"));
        assert!(!looks_like_save(b""));
        assert!(!looks_like_save(b"   "));
    }

    #[test]
    fn the_cap_is_the_server_default_for_a_save_file() {
        // `docs/protocol.md` §12.4: a save file at most 256 MiB.
        assert_eq!(MAX_SAVE_BYTES, 256 * 1024 * 1024);
        const { assert!(MAX_SAVE_BYTES > loreweaver_transport::MAX_BLOB_BYTES) };
    }

    #[test]
    fn a_written_save_is_private_complete_and_leaves_nothing_beside_it() {
        let dir = temp_dir("write");
        let dest = dir.join("room.json");
        // An earlier file, readable by everyone, is replaced — and does not lend its mode.
        fs::write(&dest, b"old").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            fs::set_permissions(&dest, fs::Permissions::from_mode(0o644)).unwrap();
        }
        write_private(&dest, b"{\"room\":true}").unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"{\"room\":true}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = fs::metadata(&dest).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600, "mode {mode:o}");
        }
        let names: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("room.json")]);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_write_into_a_folder_that_is_not_there_fails_and_writes_nothing() {
        let dir = temp_dir("missing");
        let dest = dir.join("absent").join("room.json");
        assert!(write_private(&dest, b"{}").is_err());
        assert!(!dest.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn prepare_describes_the_file_and_refuses_what_is_not_a_save() {
        let dir = temp_dir("prepare");
        let path = dir.join("night.json");
        fs::write(&path, b"{\"format\":\"loreweaver-room\"}").unwrap();
        let file = prepare(&path).await.unwrap();
        assert_eq!(
            file,
            SaveFile {
                name: "night.json".to_owned(),
                mime: SAVE_MIME.to_owned(),
                size: 28,
                sha256: sha256_hex(b"{\"format\":\"loreweaver-room\"}"),
            }
        );
        let list = dir.join("list.json");
        fs::write(&list, b"[1,2]").unwrap();
        let err = prepare(&list).await.unwrap_err();
        assert_eq!(err.code, "not_a_save");
        assert!(!err.server);
        assert!(!err.message.contains("[1,2]"), "no content in an error");
        let err = prepare(&dir).await.unwrap_err();
        assert_eq!(err.code, "not_a_file");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_save_file_serializes_as_the_offer_takes_it() {
        let json = serde_json::to_value(SaveFile {
            name: "a.json".to_owned(),
            mime: SAVE_MIME.to_owned(),
            size: 2,
            sha256: "ab".to_owned(),
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({"name": "a.json", "mime": "application/json", "size": 2, "sha256": "ab"})
        );
    }
}
