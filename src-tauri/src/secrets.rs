//! OS-credential-store storage for LLM API keys (macOS Keychain / Windows
//! Credential Manager / Linux Secret Service via the `keyring` crate).
//!
//! Deliberate shape: there is NO `secret_get` command. Keys go IN from the
//! WebView and are only ever read back inside `llm.rs` when a request is
//! made — plaintext keys never travel back across the Tauri bridge and are
//! never persisted anywhere else.

const SERVICE: &str = "dev.loreweaver.studio";

fn entry(account: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, account).map_err(|err| err.to_string())
}

pub fn read_secret(account: &str) -> Result<String, String> {
    entry(account)?.get_password().map_err(|err| match err {
        keyring::Error::NoEntry => "no API key stored for this provider".to_owned(),
        other => other.to_string(),
    })
}

#[tauri::command]
pub async fn secret_set(account: String, value: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        entry(&account)?
            .set_password(&value)
            .map_err(|err| err.to_string())
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn secret_exists(account: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || match entry(&account)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(err) => Err(err.to_string()),
    })
    .await
    .map_err(|err| err.to_string())?
}

#[tauri::command]
pub async fn secret_delete(account: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || match entry(&account)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    })
    .await
    .map_err(|err| err.to_string())?
}
