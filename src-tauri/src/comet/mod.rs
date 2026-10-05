//! Comet: GOG Galaxy Communication Service replacement.
//!
//! GOG games unlock achievements through the Galaxy SDK, which talks to a local
//! Communication Service. With the official Galaxy client closed, a game
//! launched from here has nobody to talk to and the unlock is lost. Comet
//! (<https://github.com/imLinguin/comet>, Apache-2.0) implements that service;
//! this module downloads its release binary once, runs it for the duration of a
//! GOG session, and the regular API sync picks the new unlocks up afterwards.

mod binary;
mod service;

pub use binary::ensure_binary;
pub use service::{is_running, start_for_session, stop};

/// Whether Comet should run for GOG sessions. On unless the user opted out.
pub fn enabled(app: &tauri::AppHandle) -> bool {
    crate::load_settings(app).gog_comet_enabled.unwrap_or(true)
}

/// Persists the Comet toggle and stops a running instance when disabled.
#[tauri::command]
pub fn epic_set_gog_comet(app: tauri::AppHandle, enabled: bool) {
    let mut s = crate::load_settings(&app);
    s.gog_comet_enabled = Some(enabled);
    crate::save_settings(&app, &s);
    if !enabled {
        service::stop();
    }
}

/// Warms the Comet binary in the background so the first GOG launch is instant.
#[tauri::command]
pub async fn comet_prepare(app: tauri::AppHandle) -> bool {
    enabled(&app) && ensure_binary(&app).await.is_ok()
}
