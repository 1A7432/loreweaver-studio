mod engine;
mod files;
mod llm;
mod secrets;
mod transport_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(transport_bridge::TransportState::default())
        .invoke_handler(tauri::generate_handler![
            transport_bridge::transport_connect,
            transport_bridge::transport_send,
            transport_bridge::transport_disconnect,
            files::write_text_file,
            files::read_file_base64,
            files::write_pack_source,
            engine::probe_engine_cli,
            engine::run_engine_cli,
            secrets::secret_set,
            secrets::secret_exists,
            secrets::secret_delete,
            llm::llm_chat
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
