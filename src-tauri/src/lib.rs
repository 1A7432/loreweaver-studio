mod transport_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(transport_bridge::TransportState::default())
        .invoke_handler(tauri::generate_handler![
            transport_bridge::transport_connect,
            transport_bridge::transport_send,
            transport_bridge::transport_disconnect
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
