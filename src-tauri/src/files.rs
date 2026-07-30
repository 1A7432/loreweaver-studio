//! Filesystem glue for the forge: dialog-picked reads/writes stay in the
//! WebView; the actual I/O happens here. The pack-source writer is the one
//! place a whole directory tree lands on disk, so relative paths are
//! validated against traversal and overwrite only ever clears a directory
//! that provably is a pack source (it contains a pack.yaml we wrote).

use base64::Engine as _;
use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};

/// Cap aligned with the card parser (engine `MAX_CARD_FILE_BYTES`).
const MAX_READ_BYTES: u64 = 16 * 1024 * 1024;

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|err| format!("writing {path} failed: {err}"))
}

#[derive(Serialize)]
pub struct ReadFileResult {
    pub name: String,
    pub base64: String,
}

#[tauri::command]
pub async fn read_file_base64(path: String) -> Result<ReadFileResult, String> {
    let meta = tokio::fs::metadata(&path)
        .await
        .map_err(|err| format!("reading {path} failed: {err}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a regular file"));
    }
    if meta.len() > MAX_READ_BYTES {
        return Err(format!("{path} exceeds the {MAX_READ_BYTES}-byte cap"));
    }
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|err| format!("reading {path} failed: {err}"))?;
    let name = Path::new(&path)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    Ok(ReadFileResult {
        name,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[derive(Deserialize)]
pub struct PackTextEntry {
    pub path: String,
    pub contents: String,
}

#[derive(Deserialize)]
pub struct PackBinaryEntry {
    pub path: String,
    pub base64: String,
}

/// Reject anything that could escape the pack root: absolute paths, `..`/`.`
/// segments, empty paths. Mirrors the engine's zip-slip red line in spirit.
fn validated_relative(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let rel = Path::new(relative);
    if relative.is_empty() || rel.is_absolute() {
        return Err(format!("unsafe pack path: {relative:?}"));
    }
    for component in rel.components() {
        match component {
            Component::Normal(part) if !part.is_empty() => {}
            _ => return Err(format!("unsafe pack path: {relative:?}")),
        }
    }
    Ok(root.join(rel))
}

/// Write a pack SOURCE tree under `root_dir` (creating it). With `overwrite`,
/// an existing root is cleared first — but only when it already looks like a
/// pack source (has a pack.yaml), so a mispicked directory is never wiped.
#[tauri::command]
pub async fn write_pack_source(
    root_dir: String,
    files: Vec<PackTextEntry>,
    binaries: Vec<PackBinaryEntry>,
    overwrite: bool,
) -> Result<usize, String> {
    let root = PathBuf::from(&root_dir);
    if root.exists() {
        let manifest = root.join("pack.yaml");
        let has_entries = std::fs::read_dir(&root)
            .map(|mut dir| dir.next().is_some())
            .unwrap_or(false);
        if has_entries {
            if !overwrite {
                return Err(format!("{root_dir} already exists and is not empty"));
            }
            if !manifest.is_file() {
                return Err(format!(
                    "{root_dir} is not a pack source directory (no pack.yaml); refusing to clear it"
                ));
            }
            tokio::fs::remove_dir_all(&root)
                .await
                .map_err(|err| format!("clearing {root_dir} failed: {err}"))?;
        }
    }

    let mut written = 0usize;
    for entry in &files {
        let target = validated_relative(&root, &entry.path)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| format!("creating {} failed: {err}", parent.display()))?;
        }
        tokio::fs::write(&target, &entry.contents)
            .await
            .map_err(|err| format!("writing {} failed: {err}", target.display()))?;
        written += 1;
    }
    for entry in &binaries {
        let target = validated_relative(&root, &entry.path)?;
        if let Some(parent) = target.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|err| format!("creating {} failed: {err}", parent.display()))?;
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(entry.base64.as_bytes())
            .map_err(|err| format!("decoding {} failed: {err}", entry.path))?;
        tokio::fs::write(&target, bytes)
            .await
            .map_err(|err| format!("writing {} failed: {err}", target.display()))?;
        written += 1;
    }
    Ok(written)
}

#[cfg(test)]
mod tests {
    use super::validated_relative;
    use std::path::Path;

    #[test]
    fn relative_paths_validate() {
        let root = Path::new("/tmp/pack");
        assert!(validated_relative(root, "cards/a.json").is_ok());
        assert!(validated_relative(root, "../escape").is_err());
        assert!(validated_relative(root, "/abs").is_err());
        assert!(validated_relative(root, "a/../b").is_err());
        assert!(validated_relative(root, "").is_err());
    }
}
