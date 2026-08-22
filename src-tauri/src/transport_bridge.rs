//! Tauri glue for the transport actor: three commands in, one event stream out.
//!
//! The WebView never touches the network. It calls `transport_connect` /
//! `transport_send` / `transport_disconnect`, and consumes every
//! [`TransportEvent`] (status + frames) from the `loreweaver://transport`
//! event channel. Each explicit connect carries a **bridge** connection id —
//! stamped onto the envelope, never onto the protocol wire frame — so the
//! WebView can drop events from a generation it has already left.

use loreweaver_transport::client::{
    self, ClientHandle, ConnectParams, NetworkProfile, TransportEvent,
};
use serde_json::{json, Value};
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

/// Stamp the bridge generation onto a transport event without touching the
/// protocol frame payload. Late events already sitting in the Tauri/JS queue
/// still carry the id they were minted with; the WebView is the one that
/// drops a stale generation — a check here cannot see those.
pub fn bridged_event(connection_id: &str, event: &TransportEvent) -> Value {
    let mut payload = serde_json::to_value(event).expect("transport events are JSON");
    payload
        .as_object_mut()
        .expect("event object")
        .insert("connectionId".to_owned(), json!(connection_id));
    payload
}

#[tauri::command]
pub async fn transport_connect(
    app: AppHandle,
    state: State<'_, TransportState>,
    ticket: String,
    key: String,
    name: Option<String>,
    connection_id: String,
) -> Result<(), String> {
    if connection_id.is_empty() {
        return Err("connection id is required".to_owned());
    }
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
            let _ = app.emit(TRANSPORT_EVENT, &bridged_event(&connection_id, &event));
        }
    });
    *slot = Some(handle);
    Ok(())
}

#[tauri::command]
pub async fn transport_send(state: State<'_, TransportState>, frame: Value) -> Result<(), String> {
    let handle = state
        .0
        .lock()
        .await
        .as_ref()
        .cloned()
        .ok_or_else(|| "not connected".to_owned())?;
    handle.send_frame(frame).await
}

#[tauri::command]
pub async fn transport_disconnect(state: State<'_, TransportState>) -> Result<(), String> {
    if let Some(handle) = state.0.lock().await.take() {
        handle.close();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::bridged_event;
    use loreweaver_transport::client::{ConnStatus, TransportEvent};
    use serde_json::json;

    #[test]
    fn stamps_connection_id_on_the_envelope_not_the_wire_frame() {
        let frame = json!({
            "type": "narrative",
            "id": "n1",
            "speaker": "kp",
            "text": "from the old room",
            "format": "markdown",
        });
        let event = TransportEvent::Frame {
            frame: frame.clone(),
        };
        let payload = bridged_event("gen-1", &event);
        assert_eq!(payload["connectionId"], "gen-1");
        assert_eq!(payload["kind"], "frame");
        assert_eq!(payload["frame"], frame);
        assert!(payload["frame"].get("connectionId").is_none());
    }

    #[test]
    fn stamps_status_events_the_same_way() {
        let event = TransportEvent::Status {
            status: ConnStatus::Offline,
            attempt: 0,
            error: None,
        };
        let payload = bridged_event("gen-old", &event);
        assert_eq!(payload["connectionId"], "gen-old");
        assert_eq!(payload["kind"], "status");
        assert_eq!(payload["status"], "offline");
        assert!(payload.get("frame").is_none());
    }
}
