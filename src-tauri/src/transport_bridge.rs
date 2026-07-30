//! Tauri glue for the transport actor: three commands in, one event stream out.
//!
//! The WebView never touches the network. It calls `transport_connect` /
//! `transport_send` / `transport_disconnect`, and consumes every
//! [`TransportEvent`] (status + frames) from the `loreweaver://transport`
//! event channel.

use loreweaver_transport::client::{self, ClientHandle, ConnectParams, NetworkProfile};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

pub const TRANSPORT_EVENT: &str = "loreweaver://transport";

#[derive(Default)]
pub struct TransportState(Mutex<Option<ClientHandle>>);

impl TransportState {
    /// A clone of the live connection handle, if any (for sibling modules —
    /// the asset cache pulls blobs over the same authenticated connection).
    pub async fn handle(&self) -> Option<ClientHandle> {
        self.0.lock().await.clone()
    }
}

#[tauri::command]
pub async fn transport_connect(
    app: AppHandle,
    state: State<'_, TransportState>,
    ticket: String,
    key: String,
    name: Option<String>,
) -> Result<(), String> {
    let mut slot = state.0.lock().await;
    if let Some(previous) = slot.take() {
        previous.close();
    }
    let params = ConnectParams {
        ticket,
        key,
        name,
        client_name: "loreweaver-studio".to_owned(),
        client_version: env!("CARGO_PKG_VERSION").to_owned(),
        network: NetworkProfile::N0,
    };
    let (handle, mut events) = client::connect(params);
    tauri::async_runtime::spawn(async move {
        while let Some(event) = events.recv().await {
            let _ = app.emit(TRANSPORT_EVENT, &event);
        }
    });
    *slot = Some(handle);
    Ok(())
}

#[tauri::command]
pub async fn transport_send(state: State<'_, TransportState>, frame: Value) -> Result<(), String> {
    state
        .0
        .lock()
        .await
        .as_ref()
        .ok_or_else(|| "not connected".to_owned())?
        .send_frame(frame)
        .map_err(|err| err.to_string())
}

#[tauri::command]
pub async fn transport_disconnect(state: State<'_, TransportState>) -> Result<(), String> {
    if let Some(handle) = state.0.lock().await.take() {
        handle.close();
    }
    Ok(())
}
