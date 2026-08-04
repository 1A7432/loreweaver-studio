mod asset_cache;
mod engine;
mod files;
mod llm;
mod panel_serve;
mod secrets;
mod transport_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(transport_bridge::TransportState::default())
        .manage(panel_serve::PanelServeState::default())
        // Tier-2 panel iframes load from this opaque-origin static scheme;
        // it serves only registered, hash-verified panel assets.
        .register_uri_scheme_protocol("panel", |ctx, request| {
            panel_serve::handle_panel_request(ctx.app_handle(), &request)
        })
        .invoke_handler(tauri::generate_handler![
            transport_bridge::transport_connect,
            transport_bridge::transport_send,
            transport_bridge::transport_disconnect,
            files::write_text_file,
            files::write_binary_file,
            files::read_file_base64,
            files::write_pack_source,
            engine::probe_engine_cli,
            engine::run_engine_cli,
            secrets::secret_set,
            secrets::secret_exists,
            secrets::secret_delete,
            llm::llm_chat,
            asset_cache::asset_cache_status,
            asset_cache::asset_fetch,
            panel_serve::panel_serve_register,
            panel_serve::panel_serve_unregister
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
