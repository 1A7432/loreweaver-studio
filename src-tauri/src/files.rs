//! Filesystem glue for exports: the WebView picks a destination via the
//! dialog plugin, then hands the path here for the actual write.

#[tauri::command]
pub async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    tokio::fs::write(&path, contents)
        .await
        .map_err(|err| format!("writing {path} failed: {err}"))
}
