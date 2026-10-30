//! In-game browser window (the overlay's Browser tab, Steam-style).
//!
//! The overlay panel cannot host the page itself: the overlay window is
//! transparent and a child WebView2 does not paint into a layered window, so
//! the browser gets its own opaque, always-on-top window that floats over the
//! game. The window's own webview is the chrome (`browser.html`: tab strip,
//! address bar, transport buttons) and every tab is a child webview that the
//! chrome places through `overlay_browser_show`. Only the active tab is shown;
//! the others are parked off-screen with their state (and their session) kept.
//!
//! WebView2 shares the app's persistent profile, so sign-ins — Google among
//! them — survive between sessions; nothing lives only in memory.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewBuilder, WebviewUrl};

/// Browser window label (`browser.html` runs here).
pub const WINDOW_LABEL: &str = "overlay-browser";
/// Start page. Google covers search, mail and YouTube with one sign-in.
pub const HOME_URL: &str = "https://www.google.com/";
const PAGE_PREFIX: &str = "overlay-browser-page-";
/// More tabs than this stop being useful in an overlay window.
const MAX_TABS: usize = 8;
/// Parked here while a tab is not the active one.
const OFFSCREEN: f64 = -10000.0;

/// Tracks whether the browser window is currently open / visible.
static IS_OPEN: AtomicBool = AtomicBool::new(false);
/// Picture-in-picture mode: a small corner window that survives the panel.
static PIP: AtomicBool = AtomicBool::new(false);
/// The full-window placement saved when PiP started, in logical units.
static PIP_RESTORE: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);
/// 0 top-right, 1 bottom-right, 2 bottom-left, 3 top-left.
static PIP_CORNER: AtomicUsize = AtomicUsize::new(0);
/// One open tab: its id and the page it points at.
static TABS: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static ACTIVE: Mutex<u32> = Mutex::new(0);
/// Page labels parked with `webview_power::suspend`. A second suspend on an
/// already-parked tab only makes WebView2 log a failure on every resize.
static SUSPENDED_TABS: Mutex<Vec<u32>> = Mutex::new(Vec::new());

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn ShowWindow(hwnd: *mut core::ffi::c_void, cmd: i32) -> i32;
    fn SetWindowPos(
        hwnd: *mut core::ffi::c_void,
        insert_after: *mut core::ffi::c_void,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
}

/// Brings the browser window to the top of the z-order and sets focus.
#[tauri::command]
pub fn overlay_browser_raise(app: AppHandle) {
    if let Some(win) = app.get_window(WINDOW_LABEL) {
        let _ = win.set_focus();
        #[cfg(windows)]
        if let Ok(raw) = win.hwnd() {
            unsafe {
                SetWindowPos(
                    raw.0 as *mut core::ffi::c_void,
                    -1isize as *mut core::ffi::c_void, // HWND_TOPMOST
                    0, 0, 0, 0,
                    0x0001 | 0x0002, // SWP_NOSIZE | SWP_NOMOVE
                );
            }
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TabInfo {
    id: u32,
    url: String,
    active: bool,
}

fn tab_list() -> Vec<(u32, String)> {
    TABS.lock().map(|list| list.clone()).unwrap_or_default()
}

fn active_id() -> u32 {
    ACTIVE.lock().map(|id| *id).unwrap_or(0)
}

fn set_active(id: u32) {
    if let Ok(mut slot) = ACTIVE.lock() {
        *slot = id;
    }
}

fn suspend_tab(id: u32, view: &tauri::Webview) {
    if SUSPENDED_TABS
        .lock()
        .map(|list| list.contains(&id))
        .unwrap_or(false)
    {
        return;
    }
    if crate::webview_power::suspend(view) {
        if let Ok(mut list) = SUSPENDED_TABS.lock() {
            if !list.contains(&id) {
                list.push(id);
            }
        }
    }
}

fn resume_tab(id: u32, view: &tauri::Webview) {
    if let Ok(mut list) = SUSPENDED_TABS.lock() {
        list.retain(|tab| *tab != id);
    }
    // Wake even if the bookkeeping says the tab was not suspended: a failed or
    // raced resume must not leave a visible tab frozen.
    let _ = crate::webview_power::resume(view);
}

fn forget_tab(id: u32) {
    if let Ok(mut list) = SUSPENDED_TABS.lock() {
        list.retain(|tab| *tab != id);
    }
}

fn page_label(id: u32) -> String {
    format!("{PAGE_PREFIX}{id}")
}

fn tab_id_from_label(label: &str) -> Option<u32> {
    label.strip_prefix(PAGE_PREFIX)?.parse().ok()
}

fn page_rect(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: tauri::Position::Logical(tauri::LogicalPosition::new(x, y)),
        size: tauri::Size::Logical(tauri::LogicalSize::new(width, height)),
    }
}

/// The chrome page renders the strip from this: every tab, newest state.
fn emit_tabs(app: &AppHandle) {
    let active = active_id();
    let tabs = tab_list()
        .into_iter()
        .map(|(id, url)| TabInfo {
            id,
            url,
            active: id == active,
        })
        .collect();
    let payload = TabListPayload { tabs };
    let _ = app.emit_to(WINDOW_LABEL, "overlay-browser-tabs", payload.clone());
    let _ = app.emit("overlay-browser-tabs", payload);
}

fn remember_url(id: u32, url: &str) {
    if let Ok(mut list) = TABS.lock() {
        if let Some(entry) = list.iter_mut().find(|(tab, _)| *tab == id) {
            entry.1 = url.to_string();
        }
    }
}

/// Shows the active tab at `rect` and parks every other one.
fn place_tabs(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) {
    if !IS_OPEN.load(Ordering::Relaxed) {
        return;
    }
    let active = active_id();
    let rect = page_rect(x, y, width.max(100.0), height.max(100.0));
    let offscreen = page_rect(OFFSCREEN, OFFSCREEN, 100.0, 100.0);
    for (id, _) in tab_list() {
        let Some(view) = app.get_webview(&page_label(id)) else {
            continue;
        };
        if id == active {
            let _ = view.set_bounds(rect);
            resume_tab(id, &view);
            let _ = view.show();
        } else {
            let _ = view.set_bounds(offscreen);
            let _ = view.hide();
            suspend_tab(id, &view);
        }
    }
}

/// Address-bar input to a URL: bare hosts get `https://`, anything that is not
/// a host (spaces, no dot) becomes a Google search.
pub fn normalize_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return HOME_URL.to_string();
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return trimmed.to_string();
    }
    let host_like = !trimmed.contains(' ')
        && (trimmed.contains('.') || lower.starts_with("localhost"));
    if host_like {
        format!("https://{trimmed}")
    } else {
        let query: String = trimmed
            .chars()
            .map(|c| if c == ' ' { '+' } else { c })
            .collect();
        format!("https://www.google.com/search?q={query}")
    }
}

/// Places the page webviews (chrome reports its frame; inactive tabs park).
#[tauri::command]
pub fn overlay_browser_show(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !IS_OPEN.load(Ordering::Relaxed) {
        return Ok(());
    }
    place_tabs(&app, x, y, width, height);
    Ok(())
}

/// Loads what the address bar holds (or the home page when empty) in the
/// active tab.
#[tauri::command]
pub fn overlay_browser_navigate(app: AppHandle, url: String) -> Result<(), String> {
    let target = normalize_url(&url);
    let parsed = target
        .parse::<url::Url>()
        .map_err(|_| "@t:win.invalidUrl".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("@t:win.invalidUrl".to_string());
    }
    let Some(view) = app.get_webview(&page_label(active_id())) else {
        return Ok(());
    };
    // The tab may have been parked with `TrySuspend` while the browser was
    // hidden; a suspended renderer cannot start the navigation.
    resume_tab(active_id(), &view);
    remember_url(active_id(), &target);
    emit_tabs(&app);
    view.navigate(parsed).map_err(|e| e.to_string())
}

/// Transport buttons of the chrome page: back, forward, reload, home.
#[tauri::command]
pub fn overlay_browser_action(app: AppHandle, action: String) -> Result<(), String> {
    let Some(view) = app.get_webview(&page_label(active_id())) else {
        return Ok(());
    };
    match action.as_str() {
        "back" => view.eval("history.back()").map_err(|e| e.to_string()),
        "forward" => view.eval("history.forward()").map_err(|e| e.to_string()),
        "reload" => view.eval("location.reload()").map_err(|e| e.to_string()),
        "home" => match HOME_URL.parse::<url::Url>() {
            Ok(home) => {
                remember_url(active_id(), HOME_URL);
                emit_tabs(&app);
                view.navigate(home).map_err(|e| e.to_string())
            }
            Err(_) => Ok(()),
        },
        _ => Ok(()),
    }
}

/// Opens one more tab (Google when no URL is given) and focuses it.
#[tauri::command]
pub async fn overlay_browser_new_tab(
    app: AppHandle,
    url: Option<String>,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<TabListPayload, String> {
    if tab_list().len() >= MAX_TABS {
        return Ok(tab_list_payload());
    }
    let target = normalize_url(url.as_deref().unwrap_or(HOME_URL));
    let parsed = target
        .parse::<url::Url>()
        .map_err(|_| "@t:win.invalidUrl".to_string())?;
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut list) = TABS.lock() {
        list.push((id, target.clone()));
    }
    set_active(id);

    let app_nav = app.clone();
    let label = page_label(id);
    let app_popup = app.clone();
    // A child webview builder must not call `additional_browser_args`: that flag
    // silently breaks child webview rendering.
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .background_color(tauri::webview::Color(16, 17, 24, 255))
        .on_navigation(move |url| {
            // Keep the strip and the address bar in step with the page.
            let tab = tab_id_from_label(&label);
            if let Some(tab) = tab {
                remember_url(tab, url.as_str());
            }
            let payload_url = serde_json::json!({ "id": tab.unwrap_or(0), "url": url.as_str() });
            let _ = app_nav.emit_to(WINDOW_LABEL, "overlay-browser-url", payload_url.clone());
            let _ = app_nav.emit("overlay-browser-url", payload_url);
            let payload_tabs = tab_list_payload();
            let _ = app_nav.emit_to(WINDOW_LABEL, "overlay-browser-tabs", payload_tabs.clone());
            let _ = app_nav.emit("overlay-browser-tabs", payload_tabs);
            true
        })
        .on_new_window(move |target_url, _| {
            let payload = target_url.to_string();
            let _ = app_popup.emit_to(WINDOW_LABEL, "overlay-browser-new-tab", payload.clone());
            let _ = app_popup.emit("overlay-browser-new-tab", payload);
            tauri::webview::NewWindowResponse::Deny
        });

    let host = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let pos = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
    let size = tauri::Size::Logical(tauri::LogicalSize::new(width.max(100.0), height.max(100.0)));
    let handle = tokio::task::spawn_blocking(move || host.add_child(builder, pos, size));
    match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(Ok(_))) => {}
        Ok(Ok(Err(e))) => {
            forget_tab(id);
            if let Ok(mut list) = TABS.lock() {
                list.retain(|(tab, _)| *tab != id);
            }
            return Err(e.to_string());
        }
        Ok(Err(_)) => {
            forget_tab(id);
            return Err("@t:store.viewCreateFailed".into());
        }
        Err(_) => {
            forget_tab(id);
            return Err("@t:store.viewTimeout".into());
        }
    }
    place_tabs(&app, x, y, width, height);
    emit_tabs(&app);
    Ok(tab_list_payload())
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TabListPayload {
    tabs: Vec<TabInfo>,
}

fn tab_list_payload() -> TabListPayload {
    let active = active_id();
    TabListPayload {
        tabs: tab_list()
            .into_iter()
            .map(|(id, url)| TabInfo {
                id,
                url,
                active: id == active,
            })
            .collect(),
    }
}

/// Current tab list. The chrome page asks for it on load: a strip event fired
/// before its listener existed would otherwise leave the strip empty.
#[tauri::command]
pub fn overlay_browser_tabs() -> TabListPayload {
    tab_list_payload()
}

/// Closes one tab; the last tab closes the whole window.
#[tauri::command]
pub fn overlay_browser_close_tab(app: AppHandle, id: u32, x: f64, y: f64, width: f64, height: f64) -> TabListPayload {
    if let Some(view) = app.get_webview(&page_label(id)) {
        forget_tab(id);
        let _ = view.close();
    }
    let mut remaining = Vec::new();
    if let Ok(mut list) = TABS.lock() {
        list.retain(|(tab, _)| *tab != id);
        remaining = list.clone();
    }
    if remaining.is_empty() {
        set_active(0);
        overlay_browser_close(app.clone());
        emit_tabs(&app);
        return tab_list_payload();
    }
    if active_id() == id {
        // Focus the neighbour that took its place.
        let next = remaining
            .iter()
            .map(|(tab, _)| *tab)
            .next_back()
            .unwrap_or(0);
        set_active(next);
    }
    place_tabs(&app, x, y, width, height);
    emit_tabs(&app);
    tab_list_payload()
}

/// Makes one tab the visible one.
#[tauri::command]
pub fn overlay_browser_activate_tab(app: AppHandle, id: u32, x: f64, y: f64, width: f64, height: f64) -> TabListPayload {
    let known = tab_list().iter().any(|(tab, _)| *tab == id);
    if !known {
        return tab_list_payload();
    }
    set_active(id);
    place_tabs(&app, x, y, width, height);
    emit_tabs(&app);
    tab_list_payload()
}

/// Moves the browser window position during drag.
#[tauri::command]
pub fn overlay_browser_set_position(app: AppHandle, x: i32, y: i32) {
    if let Some(w) = app.get_window(WINDOW_LABEL) {
        #[cfg(windows)]
        if let Ok(raw) = w.hwnd() {
            unsafe {
                SetWindowPos(
                    raw.0 as *mut core::ffi::c_void,
                    core::ptr::null_mut(),
                    x, y, 0, 0,
                    0x0001 | 0x0010, // SWP_NOSIZE | SWP_NOACTIVATE
                );
            }
        }
        let _ = w.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// Parks and hides all child page webviews so they cannot remain visible when
/// the browser window itself is hidden.
fn hide_all_tabs(app: &AppHandle) {
    let offscreen = page_rect(OFFSCREEN, OFFSCREEN, 100.0, 100.0);
    for (id, _) in tab_list() {
        if let Some(view) = app.get_webview(&page_label(id)) {
            let _ = view.set_bounds(offscreen);
            let _ = view.hide();
            suspend_tab(id, &view);
        }
    }
}

fn emit_browser_state(app: &AppHandle, open: bool) {
    let _ = app.emit("overlay-browser-state", serde_json::json!({ "open": open }));
}

/// The 16:9 player's size and corner on the game monitor, in logical units.
fn pip_placement(scale: f64) -> (f64, f64, f64, f64) {
    let (mx, my, mw, mh) = super::hud::monitor_rect_for(
        super::STATE
            .lock()
            .map(|state| state.game_hwnd)
            .unwrap_or(0),
    )
    .unwrap_or((0, 0, 1920, 1080));
    let left = mx as f64 / scale;
    let top = my as f64 / scale;
    let monitor_w = mw as f64 / scale;
    let monitor_h = mh as f64 / scale;
    let width = (monitor_w * 0.38).clamp(320.0, 520.0);
    let height = (width * 9.0 / 16.0 + 28.0).round();
    let (x, y) = corner_position(
        PIP_CORNER.load(Ordering::Relaxed),
        left,
        top,
        monitor_w,
        monitor_h,
        width,
        height,
        16.0,
    );
    (x, y, width, height)
}

/// Maps a corner index (0 top-right, then clockwise) to a logical position.
fn corner_position(
    corner: usize,
    left: f64,
    top: f64,
    monitor_w: f64,
    monitor_h: f64,
    width: f64,
    height: f64,
    margin: f64,
) -> (f64, f64) {
    let x = if corner == 2 || corner == 3 {
        left + margin
    } else {
        left + monitor_w - width - margin
    };
    let y = if corner == 1 || corner == 2 {
        top + monitor_h - height - margin
    } else {
        top + margin
    };
    (x, y)
}

/// Moves the corner player to the next corner; the next PiP starts there too.
#[tauri::command]
pub fn overlay_browser_cycle_pip_corner(app: AppHandle) -> bool {
    let next = (PIP_CORNER.load(Ordering::Relaxed) + 1) % 4;
    PIP_CORNER.store(next, Ordering::Relaxed);
    if !PIP.load(Ordering::Relaxed) {
        return false;
    }
    let Some(window) = app.get_window(WINDOW_LABEL) else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
    let (x, y, _, _) = pip_placement(scale);
    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
    true
}

/// Enters or leaves picture-in-picture: a small 16:9 window in a corner of the
/// game monitor. The chrome hides its bars and shows a 28 px PiP bar; the page
/// keeps the rest.
#[tauri::command]
pub fn overlay_browser_set_pip(app: AppHandle, enabled: bool) -> bool {
    if enabled == PIP.load(Ordering::Relaxed) {
        return enabled;
    }
    let Some(window) = app.get_window(WINDOW_LABEL) else {
        return false;
    };
    let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
    if enabled {
        if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
            if let Ok(mut slot) = PIP_RESTORE.lock() {
                *slot = Some((
                    position.x as f64 / scale,
                    position.y as f64 / scale,
                    size.width as f64 / scale,
                    size.height as f64 / scale,
                ));
            }
        }
        let (x, y, width, height) = pip_placement(scale);
        PIP.store(true, Ordering::Relaxed);
        let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(280.0, 180.0))));
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        let _ = app.emit_to(
            WINDOW_LABEL,
            "overlay-browser-pip",
            serde_json::json!({ "enabled": true }),
        );
        true
    } else {
        PIP.store(false, Ordering::Relaxed);
        let restore = PIP_RESTORE.lock().ok().and_then(|mut slot| slot.take());
        let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(560.0, 380.0))));
        if let Some((x, y, width, height)) = restore {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                width.max(560.0),
                height.max(380.0),
            )));
            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
        }
        let _ = app.emit_to(
            WINDOW_LABEL,
            "overlay-browser-pip",
            serde_json::json!({ "enabled": false }),
        );
        false
    }
}

/// True while the browser is the small corner window.
#[tauri::command]
pub fn overlay_browser_is_pip() -> bool {
    PIP.load(Ordering::Relaxed)
}

/// Checks whether the in-game browser window is currently visible.
#[tauri::command]
pub fn overlay_browser_is_open(app: AppHandle) -> bool {
    if !IS_OPEN.load(Ordering::Relaxed) {
        return false;
    }
    if let Some(w) = app.get_window(WINDOW_LABEL) {
        if let Ok(vis) = w.is_visible() {
            return vis;
        }
    }
    app.get_webview_window(WINDOW_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false)
}

/// Hides the browser window (the tabs and their pages stay alive).
#[tauri::command]
pub fn overlay_browser_close(app: AppHandle) {
    let pip = PIP.load(Ordering::Relaxed);
    hide_window(&app);
    if pip {
        // Closing the corner player must give the game its keyboard back, not
        // wake the panel behind it.
        let hwnd = super::STATE
            .lock()
            .map(|state| state.game_hwnd)
            .unwrap_or(0);
        super::hud::focus_window(hwnd);
    } else {
        wake_overlay(&app);
    }
}

/// Hides the browser window when the overlay itself closes, unless the user
/// pinned it as a picture-in-picture player.
pub fn hide_with_overlay(app: &AppHandle) {
    if PIP.load(Ordering::Relaxed) {
        return;
    }
    hide_window(app);
}

/// True while the corner player is pinned; the game-exit path uses it.
pub fn is_pip() -> bool {
    PIP.load(Ordering::Relaxed)
}

/// Hides the browser window for real (close button, game exit, teardown).
pub fn hide_window(app: &AppHandle) {
    let was_pip = PIP.swap(false, Ordering::Relaxed);
    let restore = PIP_RESTORE.lock().ok().and_then(|mut slot| slot.take());
    let _ = app.emit_to(
        WINDOW_LABEL,
        "overlay-browser-pip",
        serde_json::json!({ "enabled": false }),
    );
    IS_OPEN.store(false, Ordering::Relaxed);
    hide_all_tabs(app);

    if let Some(window) = app.get_window(WINDOW_LABEL) {
        if was_pip {
            // Closing the corner player leaves a full-size window behind for
            // the next open, not the 480 px rectangle.
            let _ = window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(560.0, 380.0))));
            if let Some((x, y, width, height)) = restore {
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(
                    width.max(560.0),
                    height.max(380.0),
                )));
                let _ = window
                    .set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
            }
        }
        #[cfg(windows)]
        if let Ok(raw) = window.hwnd() {
            unsafe {
                ShowWindow(raw.0 as *mut core::ffi::c_void, 0); // SW_HIDE
                SetWindowPos(
                    raw.0 as *mut core::ffi::c_void,
                    -2isize as *mut core::ffi::c_void, // HWND_NOTOPMOST
                    0, 0, 0, 0,
                    0x0001 | 0x0002 | 0x0010, // SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE
                );
            }
        }
        let _ = window.set_always_on_top(false);
        let _ = window.hide();
    }
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
    emit_browser_state(app, false);
}

/// Closes the browser host for good when the overlay service stops: hiding it
/// would leave the tab webviews alive in the task manager.
pub fn close_window(app: &AppHandle) {
    hide_window(app);
    if let Ok(mut list) = SUSPENDED_TABS.lock() {
        list.clear();
    }
    let handle = app.clone();
    // `destroy` waits for the event loop; callers are command handlers.
    std::thread::spawn(move || {
        if let Some(window) = handle.get_window(WINDOW_LABEL) {
            let _ = window.destroy();
        }
    });
}

/// One-frame size nudge: forces the overlay webview to repaint its surface.
fn wake_overlay(app: &AppHandle) {
    let Some(window) = app.get_webview_window(crate::overlay::OVERLAY_LABEL) else {
        return;
    };
    let Ok(size) = window.inner_size() else {
        return;
    };
    let nudged = tauri::PhysicalSize {
        width: size.width,
        height: size.height.saturating_sub(1).max(1),
    };
    let _ = window.set_size(tauri::Size::Physical(nudged));
    let _ = window.set_size(tauri::Size::Physical(size));
}

/// Where the browser window opens: centered on the monitor the overlay panel
/// sits on, in logical units. The monitor rect comes back in physical pixels,
/// so an unscaled rect lands off-screen on a scaled display.
fn browser_placement(app: &AppHandle) -> (f64, f64, f64, f64) {
    let fallback = (0.0, 0.0, 860.0, 580.0);
    let Some(overlay) = app.get_webview_window(crate::overlay::OVERLAY_LABEL) else {
        return fallback;
    };
    let Ok(Some(monitor)) = overlay.current_monitor() else {
        return fallback;
    };
    let scale = monitor.scale_factor();
    let scale = if scale > 0.1 { scale } else { 1.0 };
    let mon_w = monitor.size().width as f64 / scale;
    let mon_h = monitor.size().height as f64 / scale;
    let mon_x = monitor.position().x as f64 / scale;
    let mon_y = monitor.position().y as f64 / scale;
    let width = (mon_w * 0.65).clamp(720.0, 1150.0);
    let height = (mon_h * 0.70).clamp(480.0, 780.0);
    let x = mon_x + ((mon_w - width) / 2.0);
    let y = mon_y + ((mon_h - height) / 2.0);
    (x, y, width, height)
}

/// Opens (or re-shows) the browser window; a URL navigates the active tab.
#[tauri::command]
pub async fn overlay_browser_open(app: AppHandle, url: Option<String>) -> Result<(), String> {
    IS_OPEN.store(true, Ordering::Relaxed);
    // Reopening the browser from the panel leaves the corner player behind and
    // returns to the full window.
    if PIP.load(Ordering::Relaxed) {
        overlay_browser_set_pip(app.clone(), false);
    }

    if let Some(window) = app.get_window(WINDOW_LABEL) {
        #[cfg(windows)]
        if let Ok(raw) = window.hwnd() {
            unsafe {
                ShowWindow(raw.0 as *mut core::ffi::c_void, 5); // SW_SHOW
                SetWindowPos(
                    raw.0 as *mut core::ffi::c_void,
                    -1isize as *mut core::ffi::c_void, // HWND_TOPMOST
                    0, 0, 0, 0,
                    0x0001 | 0x0002 | 0x0040, // SWP_NOSIZE | SWP_NOMOVE | SWP_SHOWWINDOW
                );
            }
        }
        let _ = window.set_always_on_top(true);
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();

        // A crash or a forced close can leave the window at the PiP rectangle.
        // Reopen at the normal size instead of a cramped chrome.
        let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
        if window
            .inner_size()
            .map(|size| {
                size.width as f64 / scale < 560.0 || size.height as f64 / scale < 380.0
            })
            .unwrap_or(false)
        {
            let (x, y, width, height) = browser_placement(&app);
            let _ = window
                .set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize::new(560.0, 380.0))));
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize::new(width, height)));
            let _ =
                window.set_position(tauri::Position::Logical(tauri::LogicalPosition::new(x, y)));
        }

        if let Some(target) = url.as_deref().filter(|u| !u.trim().is_empty()) {
            let _ = overlay_browser_navigate(app.clone(), target.to_string());
        }

        let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
        let (width, height) = window
            .inner_size()
            .map(|size| (size.width as f64 / scale, size.height as f64 / scale))
            .unwrap_or((860.0, 580.0));

        if tab_list().is_empty() {
            overlay_browser_new_tab(app.clone(), None, 0.0, 110.0, width, height - 110.0).await?;
        } else {
            place_tabs(&app, 0.0, 110.0, width, (height - 110.0).max(100.0));
        }

        emit_tabs(&app);
        emit_browser_state(&app, true);
        return Ok(());
    }

    let (x, y, width, height) = browser_placement(&app);
    tauri::WebviewWindowBuilder::new(
        &app,
        WINDOW_LABEL,
        WebviewUrl::App("browser.html".into()),
    )
    .title("Efxlve Browser")
    .inner_size(width, height)
    .position(x, y)
    .min_inner_size(560.0, 380.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .background_color(tauri::webview::Color(16, 17, 24, 255))
    .build()
    .map_err(|e| e.to_string())?;

    let target = normalize_url(url.as_deref().unwrap_or(HOME_URL));
    overlay_browser_new_tab(app.clone(), Some(target), 0.0, 110.0, width, height - 110.0).await?;
    if let Some(window) = app.get_window(WINDOW_LABEL) {
        #[cfg(windows)]
        if let Ok(raw) = window.hwnd() {
            unsafe {
                ShowWindow(raw.0 as *mut core::ffi::c_void, 5);
                SetWindowPos(
                    raw.0 as *mut core::ffi::c_void,
                    -1isize as *mut core::ffi::c_void,
                    0, 0, 0, 0,
                    0x0001 | 0x0002 | 0x0040,
                );
            }
        }
        let _ = window.set_always_on_top(true);
        let _ = window.show();
        let _ = window.set_focus();
    }
    emit_browser_state(&app, true);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{corner_position, normalize_url};

    #[test]
    fn pip_corners_follow_the_clockwise_order() {
        // 0 top-right, 1 bottom-right, 2 bottom-left, 3 top-left.
        assert_eq!(corner_position(0, 0.0, 0.0, 1920.0, 1080.0, 480.0, 298.0, 16.0), (1424.0, 16.0));
        assert_eq!(corner_position(1, 0.0, 0.0, 1920.0, 1080.0, 480.0, 298.0, 16.0), (1424.0, 766.0));
        assert_eq!(corner_position(2, 0.0, 0.0, 1920.0, 1080.0, 480.0, 298.0, 16.0), (16.0, 766.0));
        assert_eq!(corner_position(3, 0.0, 0.0, 1920.0, 1080.0, 480.0, 298.0, 16.0), (16.0, 16.0));
    }

    #[test]
    fn address_bar_input_becomes_a_url() {
        assert_eq!(normalize_url(""), "https://www.google.com/");
        assert_eq!(normalize_url("google.com"), "https://google.com");
        assert_eq!(normalize_url("https://gmail.com"), "https://gmail.com");
        assert_eq!(normalize_url("HTTP://example.com"), "HTTP://example.com");
        assert_eq!(
            normalize_url("steam overlay browser"),
            "https://www.google.com/search?q=steam+overlay+browser"
        );
        // A bare word is a search, not a host.
        assert_eq!(
            normalize_url("youtube"),
            "https://www.google.com/search?q=youtube"
        );
    }
}
