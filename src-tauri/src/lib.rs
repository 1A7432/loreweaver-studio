mod asset_cache;
mod engine;
mod files;
mod host_local;
mod llm;
mod media;
mod panel_serve;
mod report;
mod transport_bridge;

use tauri_plugin_window_state::StateFlags;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // The window reopens where and as large as it was left. Only the
        // geometry is kept: a saved "hidden" or "undecorated" must never be
        // able to bring the app back up as a window nobody can see or move.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    StateFlags::SIZE
                        | StateFlags::POSITION
                        | StateFlags::MAXIMIZED
                        | StateFlags::FULLSCREEN,
                )
                .build(),
        )
        // Opener is driven from Rust only (`report::report_open`); no capability
        // grants it to the WebView.
        .plugin(tauri_plugin_opener::init())
        .manage(transport_bridge::TransportState::default())
        .manage(panel_serve::PanelServeState::default())
        .manage(host_local::HostLocalState::default())
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
            host_local::host_local_start,
            host_local::host_local_stop,
            host_local::host_local_status,
            llm::llm_chat,
            asset_cache::asset_cache_status,
            asset_cache::asset_fetch,
            asset_cache::asset_read_base64,
            media::media_prepare,
            media::media_upload,
            report::report_fetch,
            report::report_save,
            report::report_open,
            panel_serve::panel_serve_register,
            panel_serve::panel_serve_unregister
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
