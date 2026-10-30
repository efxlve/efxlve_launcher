//! In-game overlay: window control, hotkey, metrics, the native metrics strip
//! and the achievement toast.
//!
//! External overlay only: no DLL injection and no game-process hooks. The panel
//! is a hidden Tauri window shown over the game. The always-on metrics strip is
//! a native layered window because it repaints every second and must cost
//! nothing; the achievement toast is a transparent, click-through WebView2
//! window that renders the same card component as the Settings preview.
//!
//! Closing the panel with a pinned widget turns it into ghost mode instead of
//! hiding it: the window stays on screen as a click-through HUD (`ghost.rs`),
//! the page drops the scrim and every unpinned card, and the game keeps focus.
//!
//! The panel is driven entirely from Rust: the hotkey thread shows/hides the
//! window and emits `overlay-open` / `overlay-close` with the running game.

pub mod browser;
pub mod ghost;
pub mod hotkey;
pub mod hud;
pub mod metrics;
pub mod toast;

use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

pub const OVERLAY_LABEL: &str = "overlay";

/// Invalidates a pending idle release of the panel. Any show/teardown bumps it;
/// a timer only destroys the window when its captured value is still current.
static PANEL_GENERATION: AtomicU64 = AtomicU64::new(0);

/// How long a closed panel may keep its WebView2 renderer alive. The first open
/// after this rebuilds the page (the ready handshake restores the context), so
/// the memory comes back only while the overlay is actually in use.
const PANEL_IDLE_RELEASE: std::time::Duration = std::time::Duration::from_secs(120);

/// Elevated one-liner that grants the current user the FPS trace permission.
#[cfg(windows)]
const FPS_ENABLE_SCRIPT: &str =
    "$g = Get-LocalGroup -SID S-1-5-32-559; Add-LocalGroupMember -Group $g -Member ($env:USERDOMAIN + '\\' + $env:USERNAME)";

pub(crate) struct OverlayState {
    /// Shift+Tab hotkey enabled.
    pub enabled: bool,
    /// Always-on mini HUD wanted by the user.
    pub hud: bool,
    /// Panel currently visible (ghost mode is not visible: it takes no input).
    pub visible: bool,
    /// Pinned widgets are on screen: the panel stays as a click-through HUD.
    pub ghost: bool,
    /// How many pinned widgets the page reports as open.
    pub pinned: u32,
    /// The running game opted out of the overlay: nothing may run for it.
    pub game_disabled: bool,
    /// Hotkey preset id ("shift+tab", "shift+f4", "ctrl+shift+o").
    pub hotkey: String,
    /// Parsed form of `hotkey`; `None` means the default Shift+Tab.
    pub combo: Option<HotkeyCombo>,
    /// The Settings recorder is listening: the old shortcut must not fire.
    pub capturing: bool,
    /// Game window captured when the panel opened, for focus restore.
    pub game_hwnd: isize,
    pub game_app: String,
    pub game_title: String,
}

pub(crate) static STATE: Mutex<OverlayState> = Mutex::new(OverlayState {
    enabled: true,
    hud: false,
    visible: false,
    ghost: false,
    pinned: 0,
    game_disabled: false,
    hotkey: String::new(),
    combo: None,
    capturing: false,
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
        Ok(s) => serde_json::json!({
            "enabled": s.enabled,
            "hud": s.hud,
            "visible": s.visible,
            "ghost": s.ghost,
            "gameDisabled": s.game_disabled,
            "hotkey": hotkey_id(&s),
            "running": s.enabled && !s.game_disabled,
        }),
        Err(_) => serde_json::json!({
            "enabled": true,
            "hud": false,
            "visible": false,
            "ghost": false,
            "gameDisabled": false,
            "hotkey": "shift+tab",
            "running": true,
        }),
    }
}

/// The panel reports how many pinned widgets are open. While that count is
/// above zero, closing the panel enters ghost mode instead of hiding it; the
/// page owns the pin list, so Rust only needs the number.
#[tauri::command]
pub fn overlay_set_pinned(count: u32) {
    if let Ok(mut s) = STATE.lock() {
        s.pinned = count.min(32);
    }
}

/// A parsed overlay hotkey: modifiers plus one virtual-key code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct HotkeyCombo {
    pub ctrl: bool,
    pub alt: bool,
    pub shift: bool,
    pub vk: i32,
}

/// Virtual-key code for a key name written by the launcher ("k", "f4",
/// "pageup", "`"…). The names come from the recorder in Settings, so both
/// sides share one vocabulary.
pub(crate) fn vk_for_key(name: &str) -> Option<i32> {
    let named = match name {
        "tab" => 0x09,
        "enter" => 0x0D,
        "space" => 0x20,
        "backspace" => 0x08,
        "insert" => 0x2D,
        "delete" => 0x2E,
        "home" => 0x24,
        "end" => 0x23,
        "pageup" => 0x21,
        "pagedown" => 0x22,
        "left" => 0x25,
        "up" => 0x26,
        "right" => 0x27,
        "down" => 0x28,
        "-" => 0xBD,
        "=" => 0xBB,
        "[" => 0xDB,
        "]" => 0xDD,
        ";" => 0xBA,
        "'" => 0xDE,
        "," => 0xBC,
        "." => 0xBE,
        "/" => 0xBF,
        "\\" => 0xDC,
        "`" => 0xC0,
        _ => {
            if let Some(digits) = name.strip_prefix('f') {
                let number: u32 = digits.parse().ok()?;
                if (1..=24).contains(&number) {
                    return Some(0x70 + number as i32 - 1);
                }
                return None;
            }
            let mut chars = name.chars();
            let (Some(ch), None) = (chars.next(), chars.next()) else {
                return None;
            };
            let upper = ch.to_ascii_uppercase();
            if upper.is_ascii_alphanumeric() {
                return Some(upper as i32);
            }
            return None;
        }
    };
    Some(named)
}

/// Parses "ctrl+shift+k", "shift+tab", "alt+f4".
///
/// At least one modifier is required: a bare key would swallow normal typing.
pub(crate) fn parse_hotkey(spec: &str) -> Option<HotkeyCombo> {
    let parts: Vec<&str> = spec
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();
    if parts.len() < 2 {
        return None;
    }
    let (key, modifiers) = parts.split_last()?;
    let mut combo = HotkeyCombo {
        ctrl: false,
        alt: false,
        shift: false,
        vk: vk_for_key(&key.to_ascii_lowercase())?,
    };
    for modifier in modifiers {
        match modifier.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => combo.ctrl = true,
            "alt" => combo.alt = true,
            "shift" => combo.shift = true,
            _ => return None,
        }
    }
    if !combo.ctrl && !combo.alt && !combo.shift {
        return None;
    }
    Some(combo)
}

/// Pauses the global shortcut while the Settings recorder listens. Without
/// this the old combination opens the panel over the capture.
#[tauri::command]
pub fn overlay_set_hotkey_capture(capturing: bool) {
    if let Ok(mut s) = STATE.lock() {
        s.capturing = capturing;
    }
}

/// Turns the whole overlay service on or off. Off is a real stop: the panel
/// window is destroyed (its WebView2 renderers exit with it), the mini HUD is
/// hidden and the metrics worker is told to leave, so nothing of the overlay
/// keeps running behind a multiplayer game. On is only a state change: the
/// panel is built when the user opens it, never at boot.
#[tauri::command]
pub fn overlay_set_enabled(app: AppHandle, enabled: bool) {
    if let Ok(mut s) = STATE.lock() {
        s.enabled = enabled;
    }
    if !enabled {
        teardown(&app);
    }
}

/// Sets the hotkey from a spec like "ctrl+shift+k". Rejects a combination
/// without a modifier and anything the key table does not know.
#[tauri::command]
pub fn overlay_set_hotkey(spec: String) -> Result<(), String> {
    let Some(combo) = parse_hotkey(&spec) else {
        return Err("unsupported hotkey".into());
    };
    let normalized = spec
        .split('+')
        .map(|part| part.trim().to_ascii_lowercase())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("+");
    if let Ok(mut s) = STATE.lock() {
        s.hotkey = normalized;
        s.combo = Some(combo);
    }
    Ok(())
}

/// The configured hotkey, with the default filled in.
fn hotkey_id(state: &OverlayState) -> String {
    if state.hotkey.is_empty() {
        "shift+tab".to_string()
    } else {
        state.hotkey.clone()
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
pub fn overlay_flash_hint(app: AppHandle, title: String, body: String) {
    if title.trim().is_empty() && body.trim().is_empty() {
        return;
    }
    crate::steam::show_system_hint(&app, &title, &body);
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

/// Brings the overlay window to the top of the z-order and sets focus.
#[tauri::command]
pub fn overlay_raise(app: AppHandle) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = win.set_focus();
        #[cfg(windows)]
        if let Ok(raw) = win.hwnd() {
            unsafe {
                hud::SetWindowPos(
                    raw.0 as *mut core::ffi::c_void,
                    -1isize as *mut core::ffi::c_void, // HWND_TOPMOST
                    0, 0, 0, 0,
                    0x0001 | 0x0002, // SWP_NOSIZE | SWP_NOMOVE
                );
            }
        }
    }
}

/// Sets the currently active game context for the overlay.
///
/// `disabled` is the per-game opt-out: a multiplayer title where the user does
/// not want any overlay surface running. It stops the service for as long as
/// that game is the active one. The panel itself is built only when it is
/// opened, so a game that never uses the overlay costs no extra renderer.
#[tauri::command]
pub fn overlay_set_active_game(app: AppHandle, app_name: String, title: String, disabled: bool) {
    let (stopped, switched) = if let Ok(mut s) = STATE.lock() {
        // A ghost HUD belongs to the game it was pinned over; a new game must
        // not inherit the old one's cards.
        let switched = !s.game_app.is_empty() && s.game_app != app_name;
        s.game_app = app_name;
        s.game_title = title;
        s.game_disabled = disabled;
        (disabled, switched)
    } else {
        (disabled, false)
    };
    if stopped {
        teardown(&app);
    } else {
        if switched {
            let ghost = STATE.lock().map(|s| s.ghost).unwrap_or(false);
            if ghost {
                hide_now(&app);
            }
        }
        // Warm the toast page while the game runs: the first card then only
        // has to show a window, not boot a WebView2 renderer.
        let options = crate::steam::achievement_notification_options(&app);
        if options.enabled && options.overlay {
            crate::overlay::toast::prewarm(&app);
        }
    }
}

/// Clears the active game context when a title stops.
#[tauri::command]
pub fn overlay_clear_active_game(app: AppHandle, app_name: String) {
    let cleared = if let Ok(mut s) = STATE.lock() {
        if s.game_app == app_name || s.game_disabled {
            s.game_app.clear();
            s.game_title.clear();
            s.game_disabled = false;
            true
        } else {
            false
        }
    } else {
        false
    };
    if cleared {
        crate::overlay::toast::release(&app);
        // The game is gone: a ghost HUD would float over the desktop. An open
        // panel stays for the launcher context; the hotkey watch closes it.
        let ghost = STATE.lock().map(|s| s.ghost).unwrap_or(false);
        if ghost {
            hide_now(&app);
        }
    }
}

/// Destroys every overlay surface. The panel window goes away completely, so
/// WebView2 stops its renderers instead of leaving them parked in the task
/// manager; the HUD and the metrics worker stop with it.
///
/// The destroy itself runs on a worker: `Window::destroy` waits for the event
/// loop to answer, and a command handler that already owns the loop would
/// deadlock the whole app there.
pub(crate) fn teardown(app: &AppHandle) {
    PANEL_GENERATION.fetch_add(1, Ordering::Relaxed);
    // A stop is a real stop: never leave a ghost HUD behind.
    hide_now(app);
    browser::close_window(app);
    hud::hide();
    metrics::stop();
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Some(win) = handle.get_webview_window(OVERLAY_LABEL) {
            let _ = win.destroy();
        }
    });
}

/// Creates the overlay window from the manifest when it is missing. Returns
/// true when this call built it, so the caller knows the page still has to
/// finish loading.
pub(crate) fn ensure_window(app: &AppHandle) -> Result<bool, String> {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        // A warm panel already has the layered style; prepare is a no-op then.
        ghost::prepare(&win);
        return Ok(false);
    }
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == OVERLAY_LABEL)
        .ok_or_else(|| "no `overlay` window in tauri.conf.json".to_string())?
        .clone();
    let win = tauri::WebviewWindowBuilder::from_config(app, &config)
        .map_err(|error| error.to_string())?
        .build()
        .map_err(|error| error.to_string())?;
    // Ghost mode needs the layered style for cross-process pass-through, and
    // adding it to a visible window can drop per-pixel alpha. Do it while the
    // window is still hidden.
    ghost::prepare(&win);
    Ok(true)
}

/// Manual open. The hotkey is the normal path; this one lets the overlay (or
/// tests) open the panel without a game when needed.
#[tauri::command]
pub fn overlay_show(app: AppHandle) {
    let allowed = STATE
        .lock()
        .map(|s| s.enabled && !s.game_disabled)
        .unwrap_or(true);
    if !allowed {
        return;
    }
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
    let allowed = STATE
        .lock()
        .map(|s| s.enabled && !s.game_disabled)
        .unwrap_or(true);
    if !allowed {
        return;
    }
    // A show cancels any pending idle release and makes the current one stale.
    PANEL_GENERATION.fetch_add(1, Ordering::Relaxed);
    // Mark the panel visible before building it: a freshly created page can
    // call `overlay_page_ready` as soon as its listeners are up, and that
    // replay must see an open request.
    let payload = match STATE.lock() {
        Ok(mut s) => {
            s.ghost = false;
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
    // The window is created on demand: it does not exist while the overlay is
    // switched off.
    let created = match ensure_window(app) {
        Ok(created) => created,
        Err(_) => {
            if let Ok(mut s) = STATE.lock() {
                s.visible = false;
            }
            return;
        }
    };
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    // A show is always interactive: clear any ghost flags, including ones left
    // by a close that raced another close. The call is a no-op on a clean panel.
    #[cfg(windows)]
    ghost::set_click_through(&win, false);
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
    // A freshly created page has no listener yet; its ready signal replays this
    // payload once. An already warm panel gets it now.
    if !created {
        let _ = app.emit("overlay-open", payload.clone());
        let _ = app.emit_to(OVERLAY_LABEL, "overlay-open", payload);
    }
    metrics::ensure_running(app.clone());
}

/// The panel page finished loading and its listeners are up.
///
/// A panel created by `show` becomes visible before its page has painted, so
/// the `overlay-open` emitted at creation can arrive before the listener exists.
/// Replaying it here means the first Shift+Tab on a freshly built panel still
/// gets the game context. A page that boots after the panel already ghosted
/// gets the ghost event instead.
#[tauri::command]
pub fn overlay_page_ready(app: AppHandle) {
    let (visible, ghost, payload) = match STATE.lock() {
        Ok(s) => (
            s.visible,
            s.ghost,
            OverlayOpenPayload {
                app_name: s.game_app.clone(),
                title: s.game_title.clone(),
            },
        ),
        Err(_) => return,
    };
    if visible {
        let _ = app.emit_to(OVERLAY_LABEL, "overlay-open", payload);
    } else if ghost {
        // The panel was closed before its page finished booting: the ghost
        // event from `enter_ghost` arrived too early. Replay it now so the
        // scrim and the unpinned cards do not stay on screen.
        let _ = app.emit_to(OVERLAY_LABEL, "overlay-ghost", payload);
    }
}

/// Closes the panel. With a pinned widget on screen the close becomes ghost
/// mode instead: the window stays, drops every input flag and keeps only the
/// pinned cards visible over the game. Without one it hides as before.
pub(crate) fn hide(app: &AppHandle) {
    #[cfg(windows)]
    {
        let pinned = STATE.lock().map(|s| s.pinned > 0).unwrap_or(false);
        if pinned && enter_ghost(app) {
            return;
        }
    }
    hide_now(app);
}

/// Turns the visible panel into a click-through HUD.
///
/// Returns false when there is no visible panel to keep; the caller then hides
/// normally. The game gets focus back, so every click and key belongs to it
/// while the pinned cards stay readable above it.
#[cfg(windows)]
fn enter_ghost(app: &AppHandle) -> bool {
    let Some(win) = app.get_webview_window(OVERLAY_LABEL) else {
        return false;
    };
    if !win.is_visible().unwrap_or(false) {
        return false;
    }
    let already = match STATE.lock() {
        Ok(mut s) => {
            let already = s.ghost;
            s.visible = false;
            s.ghost = true;
            already
        }
        Err(_) => false,
    };
    if already {
        return true;
    }
    // A ghost panel is not idle: cancel any pending renderer release.
    PANEL_GENERATION.fetch_add(1, Ordering::Relaxed);
    // The browser window floats over the game like the panel does: it goes
    // with it, and it is not a pinnable surface.
    browser::hide_window(app);
    ghost::set_click_through(&win, true);
    let _ = win.set_always_on_top(true);
    // A hard hide can race this transition (game exit, service stop). If the
    // window is already gone, undo the state and let the caller hide normally.
    if !win.is_visible().unwrap_or(false) {
        ghost::set_click_through(&win, false);
        if let Ok(mut s) = STATE.lock() {
            s.ghost = false;
        }
        return false;
    }
    // Keep `game_hwnd`: the dead-window watch still needs it, and the next
    // Shift+Tab returns the panel to that monitor.
    let (hwnd, payload) = match STATE.lock() {
        Ok(s) => (
            s.game_hwnd,
            OverlayOpenPayload {
                app_name: s.game_app.clone(),
                title: s.game_title.clone(),
            },
        ),
        Err(_) => (
            0,
            OverlayOpenPayload {
                app_name: String::new(),
                title: String::new(),
            },
        ),
    };
    hud::focus_window(hwnd);
    // The page drops the scrim, the bar and every unpinned widget. Its clock
    // and media timers stay alive: a pinned performance or music card must
    // keep updating while the game runs. The payload lets a page that booted
    // after this event still lay out the right game's widgets.
    let _ = app.emit_to(OVERLAY_LABEL, "overlay-ghost", payload);
    true
}

/// Hides the panel for real and returns focus to the game window it opened
/// over. Also used when a ghost panel must go away (game exit, service stop).
pub(crate) fn hide_now(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(OVERLAY_LABEL) {
        #[cfg(windows)]
        // Idempotent: clears a ghost panel's input flags, no-op otherwise.
        ghost::set_click_through(&win, false);
        let _ = win.hide();
    }
    // The browser window floats over the game like the panel does: it goes with it.
    browser::hide_window(app);
    let hwnd = match STATE.lock() {
        Ok(mut s) => {
            s.visible = false;
            s.ghost = false;
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
    let _ = app.emit_to(browser::WINDOW_LABEL, "overlay-close", ());

    // A closed panel does not need to keep a WebView2 renderer parked in the
    // background. The page is rebuilt on the next open and the ready handshake
    // replays the game context, so this is invisible apart from the first
    // ~200 ms of that open.
    let generation = PANEL_GENERATION.fetch_add(1, Ordering::Relaxed) + 1;
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(PANEL_IDLE_RELEASE);
        if PANEL_GENERATION.load(Ordering::Relaxed) != generation {
            return;
        }
        if STATE
            .lock()
            .map(|s| s.visible || s.ghost)
            .unwrap_or(false)
        {
            return;
        }
        browser::close_window(&handle);
        if let Some(win) = handle.get_webview_window(OVERLAY_LABEL) {
            let _ = win.destroy();
        }
    });
}

/// Fills the monitor that hosts the game window; keeps the current monitor when
/// no game window is known.
fn place_over_game(win: &tauri::WebviewWindow, hwnd: isize) {
    let monitor = hud::monitor_rect_for(hwnd).or_else(|| {
        // Win32 helpers are stubs on Linux/macOS; the current Tauri monitor is
        // the correct target there (and a useful fallback on Windows too).
        win.current_monitor().ok().flatten().map(|monitor| {
            let position = monitor.position();
            let size = monitor.size();
            (position.x, position.y, size.width, size.height)
        })
    });
    if let Some((x, y, w, h)) = monitor {
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
