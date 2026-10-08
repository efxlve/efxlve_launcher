//! In-game overlay: window control, hotkey, metrics and the native HUD.
//!
//! External overlay only: no DLL injection and no game-process hooks. The panel
//! is a hidden Tauri window shown over the game; the always-on HUD is a native
//! layered window because WebView2 cannot combine per-pixel transparency with
//! click-through (see docs/OVERLAY_ROADMAP.md).
//!
//! The panel is driven entirely from Rust: the hotkey thread shows/hides the
//! window and emits `overlay-open` / `overlay-close` with the running game.

pub mod hotkey;
pub mod hud;
pub mod media;
pub mod metrics;

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const OVERLAY_LABEL: &str = "overlay";

pub(crate) struct OverlayState {
    /// Shift+Tab hotkey enabled.
    pub enabled: bool,
    /// Always-on mini HUD wanted by the user.
    pub hud: bool,
    /// Panel currently visible.
    pub visible: bool,
    /// Game window captured when the panel opened, for focus restore.
    pub game_hwnd: isize,
    pub game_app: String,
    pub game_title: String,
}

pub(crate) static STATE: Mutex<OverlayState> = Mutex::new(OverlayState {
    enabled: true,
    hud: false,
    visible: false,
    game_hwnd: 0,
    game_app: String::new(),
    game_title: String::new(),
});

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OverlayOpenPayload {
    pub app_name: String,
    pub title: String,
}

#[tauri::command]
pub fn overlay_get_state() -> serde_json::Value {
    match STATE.lock() {
        Ok(s) => serde_json::json!({ "enabled": s.enabled, "hud": s.hud, "visible": s.visible }),
        Err(_) => serde_json::json!({ "enabled": true, "hud": false, "visible": false }),
    }
}

/// Enables or disables the Shift+Tab hotkey. Disabling hides the panel too.
#[tauri::command]
pub fn overlay_set_enabled(app: AppHandle, enabled: bool) {
    if let Ok(mut s) = STATE.lock() {
        s.enabled = enabled;
    }
    if !enabled {
        hide(&app);
    }
}

/// Turns the always-on mini HUD on or off (the UI persists the choice).
#[tauri::command]
pub fn overlay_set_hud(app: AppHandle, enabled: bool) {
    if let Ok(mut s) = STATE.lock() {
        s.hud = enabled;
    }
    if enabled {
        metrics::ensure_running(app.clone());
    } else {
        hud::hide();
    }
}

#[tauri::command]
pub fn overlay_hide(app: AppHandle) {
    hide(&app);
}

/// Brings the launcher window back in front (Home tab action).
#[tauri::command]
pub fn overlay_show_launcher(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

/// Manual open. The Shift+Tab hotkey is the normal path; this one lets the
/// overlay (or tests) open the panel without a game when needed.
#[tauri::command]
pub fn overlay_show(app: AppHandle) {
    if let Some((app_name, title)) = crate::legendary::screenshots::get_active_running_game() {
        if let Ok(mut s) = STATE.lock() {
            s.game_hwnd = hud::foreground_window();
            s.game_app = app_name;
            s.game_title = title;
        }
    }
    show(&app);
}

/// Shows the panel over the game monitor and announces the game context.
pub(crate) fn show(app: &AppHandle) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    let hwnd = STATE.lock().map(|s| s.game_hwnd).unwrap_or(0);
    place_over_game(&win, hwnd);
    let _ = win.show();
    let _ = win.set_focus();
    let payload = match STATE.lock() {
        Ok(mut s) => {
            s.visible = true;
            OverlayOpenPayload {
                app_name: s.game_app.clone(),
                title: s.game_title.clone(),
            }
        }
        Err(_) => OverlayOpenPayload {
            app_name: String::new(),
            title: String::new(),
        },
    };
    let _ = app.emit_to(OVERLAY_LABEL, "overlay-open", payload);
    metrics::ensure_running(app.clone());
}

/// Hides the panel and returns focus to the game window it opened over.
pub(crate) fn hide(app: &AppHandle) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    let _ = win.hide();
    let hwnd = match STATE.lock() {
        Ok(mut s) => {
            s.visible = false;
            s.game_hwnd
        }
        Err(_) => 0,
    };
    hud::focus_window(hwnd);
    let _ = app.emit_to(OVERLAY_LABEL, "overlay-close", ());
}

/// Fills the monitor that hosts the game window; keeps the current monitor when
/// no game window is known.
fn place_over_game(win: &tauri::WebviewWindow, hwnd: isize) {
    if let Some((x, y, w, h)) = hud::monitor_rect_for(hwnd) {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    }
}

/// Boot: starts the Shift+Tab listener. Called once from `main.rs` setup.
pub fn start(app: AppHandle) {
    hotkey::start(app);
}
