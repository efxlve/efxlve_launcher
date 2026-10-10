//! In-game overlay: window control, hotkey, metrics and the native HUD.
//!
//! External overlay only: no DLL injection and no game-process hooks. The panel
//! is a hidden Tauri window shown over the game; the always-on HUD is a native
//! layered window because WebView2 cannot combine per-pixel transparency with
//! click-through (see docs/OVERLAY_ROADMAP.md).
//!
//! The panel is driven entirely from Rust: the hotkey thread shows/hides the
//! window and emits `overlay-open` / `overlay-close` with the running game.

pub mod browser;
pub mod hotkey;
pub mod hud;
pub mod metrics;

use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const OVERLAY_LABEL: &str = "overlay";

/// Elevated one-liner that grants the current user the FPS trace permission.
#[cfg(windows)]
const FPS_ENABLE_SCRIPT: &str =
    "$g = Get-LocalGroup -SID S-1-5-32-559; Add-LocalGroupMember -Group $g -Member ($env:USERDOMAIN + '\\' + $env:USERNAME)";

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

/// Shows a temporary notification over the game (game start: "Shift+Tab opens
/// the overlay"). The Windows toast is invisible for many setups, this card is
/// not. `title` is the bold line, `body` the muted one.
#[tauri::command]
pub fn overlay_flash_hint(title: String, body: String) {
    if title.trim().is_empty() && body.trim().is_empty() {
        return;
    }
    hud::notify(&title, &body);
}

/// One-time elevation: adds the current user to the "Performance Log Users"
/// group (locale-independent well-known SID) so the ETW FPS session can start.
/// Windows applies group changes on the next sign-in.
///
/// Returns "started" when the elevation prompt was accepted, "denied" when it
/// was declined or could not be shown, "already" when FPS is already running.
#[tauri::command]
pub fn overlay_enable_fps() -> String {
    if metrics::fps_available() {
        return "already".to_string();
    }
    #[cfg(windows)]
    {
        use windows::core::w;
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        // -EncodedCommand (UTF-16LE base64) avoids every command-line quoting
        // pitfall; the script itself is plain and has no nested quotes.
        let encoded = base64_utf16le(FPS_ENABLE_SCRIPT);
        let params = format!(
            "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {encoded}"
        );
        let params_wide: Vec<u16> = params.encode_utf16().chain(std::iter::once(0)).collect();

        let result = unsafe {
            ShellExecuteW(
                None,
                w!("runas"),
                w!("powershell.exe"),
                windows::core::PCWSTR(params_wide.as_ptr()),
                None,
                SW_SHOWNORMAL,
            )
        };
        // The shell returns a value <= 32 when it could not start the process
        // (declined UAC prompt included).
        if result.0 as isize > 32 {
            "started".to_string()
        } else {
            "denied".to_string()
        }
    }
    #[cfg(not(windows))]
    {
        "unsupported".to_string()
    }
}

/// Base64 of a string's UTF-16LE bytes, for PowerShell `-EncodedCommand`.
#[cfg(windows)]
fn base64_utf16le(text: &str) -> String {
    let bytes: Vec<u8> = text.encode_utf16().flat_map(|unit| unit.to_le_bytes()).collect();
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
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

/// Sets the currently active game context for the overlay.
#[tauri::command]
pub fn overlay_set_active_game(app_name: String, title: String) {
    if let Ok(mut s) = STATE.lock() {
        s.game_app = app_name;
        s.game_title = title;
    }
}

/// Clears the active game context when a title stops.
#[tauri::command]
pub fn overlay_clear_active_game(app_name: String) {
    if let Ok(mut s) = STATE.lock() {
        if s.game_app == app_name {
            s.game_app.clear();
            s.game_title.clear();
        }
    }
}

/// Manual open. The Shift+Tab hotkey is the normal path; this one lets the
/// overlay (or tests) open the panel without a game when needed.
#[tauri::command]
pub fn overlay_show(app: AppHandle) {
    if let Some((app_name, title)) = crate::legendary::screenshots::get_active_running_game() {
        // Prefer the game's own window so the panel lands on its monitor.
        let pids = crate::legendary::screenshots::active_game_pids();
        let mut hwnd = hud::find_game_window(&pids);
        if hwnd == 0 {
            hwnd = hud::foreground_window();
        }
        if let Ok(mut s) = STATE.lock() {
            s.game_hwnd = hwnd;
            s.game_app = app_name;
            s.game_title = title;
        }
    } else {
        // Opened over the launcher (or any app): follow that window so the
        // panel is not closed by the game-window watch right away.
        let hwnd = hud::foreground_window();
        let title = hud::window_title(hwnd);
        if let Ok(mut s) = STATE.lock() {
            if s.game_hwnd == 0 {
                s.game_hwnd = hwnd;
            }
            if s.game_app.is_empty() && !title.is_empty() {
                s.game_app = format!("game::{title}");
                s.game_title = title;
            }
        }
    }
    show(&app);
}

/// Shows the panel over the game monitor and announces the game context.
pub(crate) fn show(app: &AppHandle) {
    // The panel and the browser window share the screen (a WebView2 keeps a bad
    // frame when another topmost window covers it), so exactly one of them is
    // up: a shown panel sends the browser away, the Browser tab brings it back.
    browser::hide_window(app);
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    let hwnd = STATE.lock().map(|s| s.game_hwnd).unwrap_or(0);
    place_over_game(&win, hwnd);
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_always_on_top(true);
    let _ = win.set_focus();
    #[cfg(windows)]
    if let Ok(raw_hwnd) = win.hwnd() {
        hud::focus_window(raw_hwnd.0 as isize);
    }
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
    let _ = app.emit("overlay-open", payload.clone());
    let _ = app.emit_to(OVERLAY_LABEL, "overlay-open", payload);
    metrics::ensure_running(app.clone());
}

/// Hides the panel and returns focus to the game window it opened over.
pub(crate) fn hide(app: &AppHandle) {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    // The browser window floats over the game like the panel does: it goes with it.
    browser::hide_window(app);
    let _ = win.hide();
    let hwnd = match STATE.lock() {
        Ok(mut s) => {
            s.visible = false;
            // Forget the window handle: the next open captures (or re-finds)
            // the game window, so a stale dead handle cannot close it later.
            let hwnd = s.game_hwnd;
            s.game_hwnd = 0;
            hwnd
        }
        Err(_) => 0,
    };
    hud::focus_window(hwnd);
    let _ = app.emit("overlay-close", ());
    let _ = app.emit_to(OVERLAY_LABEL, "overlay-close", ());
}

/// Fills the monitor that hosts the game window; keeps the current monitor when
/// no game window is known.
fn place_over_game(win: &tauri::WebviewWindow, hwnd: isize) {
    if let Some((x, y, w, h)) = hud::monitor_rect_for(hwnd) {
        #[cfg(windows)]
        if let Ok(raw_hwnd) = win.hwnd() {
            unsafe {
                hud::SetWindowPos(
                    raw_hwnd.0 as *mut core::ffi::c_void,
                    -1isize as *mut core::ffi::c_void, // HWND_TOPMOST
                    x,
                    y,
                    w as i32,
                    h as i32,
                    0x0040, // SWP_SHOWWINDOW
                );
            }
        }
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    }
}

/// Boot: starts the Shift+Tab listener. Called once from `main.rs` setup.
pub fn start(app: AppHandle) {
    hotkey::start(app);
}

#[cfg(all(test, windows))]
mod tests {
    use super::{base64_utf16le, FPS_ENABLE_SCRIPT};

    /// Must match PowerShell's Unicode.GetBytes + ToBase64String, otherwise
    /// -EncodedCommand would execute garbage after the UAC prompt.
    #[test]
    fn fps_enable_script_encodes_like_powershell() {
        assert_eq!(
            base64_utf16le(FPS_ENABLE_SCRIPT),
            "JABnACAAPQAgAEcAZQB0AC0ATABvAGMAYQBsAEcAcgBvAHUAcAAgAC0AUwBJAEQAIABTAC0AMQAtADUALQAzADIALQA1ADUAOQA7ACAAQQBkAGQALQBMAG8AYwBhAGwARwByAG8AdQBwAE0AZQBtAGIAZQByACAALQBHAHIAbwB1AHAAIAAkAGcAIAAtAE0AZQBtAGIAZQByACAAKAAkAGUAbgB2ADoAVQBTAEUAUgBEAE8ATQBBAEkATgAgACsAIAAnAFwAJwAgACsAIAAkAGUAbgB2ADoAVQBTAEUAUgBOAEEATQBFACkA"
        );
    }
}
