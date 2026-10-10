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

use std::sync::atomic::{AtomicU32, Ordering};
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

/// One open tab: its id and the page it points at.
static TABS: Mutex<Vec<(u32, String)>> = Mutex::new(Vec::new());
static NEXT_ID: AtomicU32 = AtomicU32::new(1);
static ACTIVE: Mutex<u32> = Mutex::new(0);

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
    let _ = app.emit_to(WINDOW_LABEL, "overlay-browser-tabs", TabListPayload { tabs });
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
    let active = active_id();
    let rect = page_rect(x, y, width.max(100.0), height.max(100.0));
    let offscreen = page_rect(OFFSCREEN, OFFSCREEN, 100.0, 100.0);
    for (id, _) in tab_list() {
        let Some(view) = app.get_webview(&page_label(id)) else {
            continue;
        };
        if id == active {
            let _ = view.set_bounds(rect);
            let _ = view.show();
        } else {
            let _ = view.set_bounds(offscreen);
            let _ = view.hide();
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
) -> Result<(), String> {
    if tab_list().len() >= MAX_TABS {
        return Ok(());
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
    // A child webview builder must not call `additional_browser_args`: that flag
    // silently breaks child webview rendering.
    let builder = WebviewBuilder::new(&label, WebviewUrl::External(parsed))
        .background_color(tauri::webview::Color(10, 10, 10, 255))
        .on_navigation(move |url| {
            // Keep the strip and the address bar in step with the page.
            let tab = tab_id_from_label(&label);
            if let Some(tab) = tab {
                remember_url(tab, url.as_str());
            }
            let _ = app_nav.emit_to(
                WINDOW_LABEL,
                "overlay-browser-url",
                serde_json::json!({ "id": tab.unwrap_or(0), "url": url.as_str() }),
            );
            let _ = app_nav.emit_to(WINDOW_LABEL, "overlay-browser-tabs", tab_list_payload());
            true
        })        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);

    let host = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let pos = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
    let size = tauri::Size::Logical(tauri::LogicalSize::new(width.max(100.0), height.max(100.0)));
    let handle = tokio::task::spawn_blocking(move || host.add_child(builder, pos, size));
    match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(Ok(_))) => {}
        Ok(Ok(Err(e))) => {
            if let Ok(mut list) = TABS.lock() {
                list.retain(|(tab, _)| *tab != id);
            }
            return Err(e.to_string());
        }
        Ok(Err(_)) => return Err("@t:store.viewCreateFailed".into()),
        Err(_) => return Err("@t:store.viewTimeout".into()),
    }
    place_tabs(&app, x, y, width, height);
    emit_tabs(&app);
    Ok(())
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
pub fn overlay_browser_close_tab(app: AppHandle, id: u32, x: f64, y: f64, width: f64, height: f64) {
    if let Some(view) = app.get_webview(&page_label(id)) {
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
        return;
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
}

/// Makes one tab the visible one.
#[tauri::command]
pub fn overlay_browser_activate_tab(app: AppHandle, id: u32, x: f64, y: f64, width: f64, height: f64) {
    let known = tab_list().iter().any(|(tab, _)| *tab == id);
    if !known {
        return;
    }
    set_active(id);
    place_tabs(&app, x, y, width, height);
    emit_tabs(&app);
}

/// Hides the browser window (the tabs and their pages stay alive).
#[tauri::command]
pub fn overlay_browser_close(app: AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
    // The panel was covered while the browser was up: nudge it so its webview
    // repaints (WebView2 keeps a stale frame after a full cover).
    wake_overlay(&app);
}

/// Hides the browser window when the overlay itself closes.
pub fn hide_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.hide();
    }
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
    let fallback = (0.0, 0.0, 1280.0, 800.0);
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
    let width = (mon_w * 0.85).min(1400.0).max(640.0);
    let height = (mon_h * 0.85).min(900.0).max(480.0);
    let x = mon_x + ((mon_w - width) / 2.0);
    let y = mon_y + ((mon_h - height) / 2.0);
    (x, y, width, height)
}

/// Opens (or re-shows) the browser window; a URL navigates the active tab.
#[tauri::command]
pub async fn overlay_browser_open(app: AppHandle, url: Option<String>) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        if let Some(url) = url.as_deref().filter(|u| !u.trim().is_empty()) {
            let _ = overlay_browser_navigate(app.clone(), url.to_string());
        }
        // Already up and in front: nothing to raise, so a repeated call (any
        // path that asks twice) cannot churn show/hide and focus.
        if window.is_visible().unwrap_or(false) {
            if !window.is_focused().unwrap_or(false) {
                let _ = window.set_focus();
            }
            emit_tabs(&app);
            return Ok(());
        }
        // Every tab was closed earlier: the window is now empty, so open a fresh
        // page before bringing it forward.
        if tab_list().is_empty() {
            let scale = window.scale_factor().unwrap_or(1.0).max(0.1);
            let (width, height) = window
                .inner_size()
                .map(|size| (size.width as f64 / scale, size.height as f64 / scale))
                .unwrap_or((900.0, 640.0));
            overlay_browser_new_tab(app.clone(), None, 0.0, 90.0, width, height - 90.0).await?;
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
        emit_tabs(&app);
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
    .min_inner_size(520.0, 360.0)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .background_color(tauri::webview::Color(10, 10, 10, 255))
    .build()
    .map_err(|e| e.to_string())?;

    // First tab: Google (or the requested URL). The chrome page reports the
    // real frame rect right after load and `overlay_browser_show` re-places it
    // (this guess is drag strip 12px + tab strip 34px + chrome bar 44px).
    let target = normalize_url(url.as_deref().unwrap_or(HOME_URL));
    overlay_browser_new_tab(app.clone(), Some(target), 0.0, 90.0, width, height - 90.0).await?;
    if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
        let _ = window.show();
        let _ = window.set_focus();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::normalize_url;

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
