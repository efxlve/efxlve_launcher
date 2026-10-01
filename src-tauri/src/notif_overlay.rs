//! Notification dropdown drawn above the store child webview.
//!
//! The store is a native WebView2 child, so it paints over the main document.
//! This second child is only the dropdown. It stays the same size as the panel
//! and is raised after every store bounds change, so the store page does not
//! move and does not cover the list.

use tauri::{AppHandle, Emitter, Manager};

const LABEL: &str = "notif-overlay";

static OVERLAY_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Bumped on hide so a show that was already in flight does not reopen the panel.
static OVERLAY_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Last logical rect of the open dropdown, used to find its native child window.
static OVERLAY_RECT: std::sync::Mutex<(f64, f64, f64, f64)> = std::sync::Mutex::new((0.0, 0.0, 0.0, 0.0));

/// Puts the notification child above the store, if the panel is open.
pub fn raise_if_open(window: &tauri::Window) {
    if !OVERLAY_OPEN.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    let Some(rect) = OVERLAY_RECT.lock().ok().map(|slot| *slot) else {
        return;
    };
    raise_child_covering(window, rect.0, rect.1, rect.2, rect.3);
}

/// WebView2 child controllers have no Tauri hwnd. The dropdown is the direct
/// child whose client rect matches the panel, and that window is moved to the
/// top of the sibling z-order so the store cannot cover it.
fn raise_child_covering(host: &tauri::Window, x: f64, y: f64, width: f64, height: f64) {
    #[cfg(windows)]
    {
        let Ok(parent) = host.hwnd() else {
            return;
        };
        let scale = host.scale_factor().unwrap_or(1.0);
        let mut hit = ChildHit {
            parent: parent.0,
            x: (x * scale).round() as i32,
            y: (y * scale).round() as i32,
            w: (width * scale).round() as i32,
            h: (height * scale).round() as i32,
            found: core::ptr::null_mut(),
        };
        unsafe {
            EnumChildWindows(parent.0, Some(on_child), &mut hit as *mut ChildHit as isize);
            if hit.found.is_null() {
                return;
            }
            let _ = SetWindowPos(
                hit.found,
                core::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (host, x, y, width, height);
    }
}

#[cfg(windows)]
struct ChildHit {
    parent: *mut core::ffi::c_void,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
    found: *mut core::ffi::c_void,
}

#[cfg(windows)]
#[repr(C)]
struct WinRect {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[cfg(windows)]
#[repr(C)]
struct WinPoint {
    x: i32,
    y: i32,
}

#[cfg(windows)]
const SWP_NOSIZE: u32 = 0x0001;
#[cfg(windows)]
const SWP_NOMOVE: u32 = 0x0002;
#[cfg(windows)]
const SWP_NOACTIVATE: u32 = 0x0010;
#[cfg(windows)]
const SWP_SHOWWINDOW: u32 = 0x0040;

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn EnumChildWindows(
        parent: *mut core::ffi::c_void,
        callback: Option<unsafe extern "system" fn(*mut core::ffi::c_void, isize) -> i32>,
        param: isize,
    ) -> i32;
    fn GetParent(hwnd: *mut core::ffi::c_void) -> *mut core::ffi::c_void;
    fn GetWindowRect(hwnd: *mut core::ffi::c_void, rect: *mut WinRect) -> i32;
    fn ScreenToClient(hwnd: *mut core::ffi::c_void, point: *mut WinPoint) -> i32;
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

#[cfg(windows)]
unsafe extern "system" fn on_child(hwnd: *mut core::ffi::c_void, param: isize) -> i32 {
    let hit = &mut *(param as *mut ChildHit);
    if GetParent(hwnd) != hit.parent {
        return 1;
    }
    let mut rect = WinRect { left: 0, top: 0, right: 0, bottom: 0 };
    if GetWindowRect(hwnd, &mut rect) == 0 {
        return 1;
    }
    let mut origin = WinPoint { x: rect.left, y: rect.top };
    if ScreenToClient(hit.parent, &mut origin) == 0 {
        return 1;
    }
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let near = |a: i32, b: i32| (a - b).abs() <= 8;
    if near(origin.x, hit.x) && near(origin.y, hit.y) && near(width, hit.w) && near(height, hit.h) {
        hit.found = hwnd;
        return 0;
    }
    1
}

fn panel_rect(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: tauri::Position::Logical(tauri::LogicalPosition::new(x, y)),
        size: tauri::Size::Logical(tauri::LogicalSize::new(width.max(160.0), height.max(72.0))),
    }
}

/// `act` and `id` from a dropdown click (`https://efxlve.local/act?...`).
pub(crate) fn notif_act_from_url(url: &url::Url) -> Option<(String, String)> {
    if url.host_str() != Some("efxlve.local") || url.path() != "/act" {
        return None;
    }
    let mut act = String::new();
    let mut id = String::new();
    for (key, value) in url.query_pairs() {
        if key == "act" {
            act = value.into_owned();
        } else if key == "id" {
            id = value.into_owned();
        }
    }
    if act.is_empty() {
        None
    } else {
        Some((act, id))
    }
}

static PENDING_HTML: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

fn write_document_js(document: &str) -> String {
    let payload = serde_json::to_string(document).unwrap_or_else(|_| "\"\"".to_string());
    format!("document.open();document.write({payload});document.close();")
}

fn publish_document(webview: &tauri::Webview, document: &str) {
    if let Ok(mut slot) = PENDING_HTML.lock() {
        *slot = document.to_string();
    }
    let _ = webview.eval(&write_document_js(document));
}

fn overlay_document(panel_html: &str) -> String {
    const CSS: &str = r#"
      html, body { margin: 0; height: 100%; background: #0a0a0a; color: #fff; overflow: hidden;
        font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
      button { font-family: inherit; }
      .notif-panel { position: static; width: 100%; height: 100%; max-height: none; box-sizing: border-box;
        display: flex; flex-direction: column; overflow: hidden; background: #0a0a0a;
        border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; }
      .notif-head { display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 12px 14px; border-bottom: 1px solid rgba(255,255,255,0.06); }
      .notif-title { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; }
      .notif-head-actions { display: flex; gap: 4px; }
      .notif-action { border: none; background: transparent; color: #9a9a9a; font-size: 12px;
        padding: 4px 6px; border-radius: 4px; cursor: pointer; }
      .notif-action:hover { background: #141414; color: #fff; }
      .notif-list { overflow-y: auto; display: flex; flex-direction: column; }
      .notif-item { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 10px 14px;
        text-align: left; border: none; border-bottom: 1px solid rgba(255,255,255,0.06);
        background: transparent; color: #fff; cursor: pointer; }
      .notif-item:hover { background: #141414; }
      .notif-item.unread { background: rgba(255,255,255,0.08); }
      .notif-item-icon { width: 28px; height: 28px; border-radius: 6px; flex-shrink: 0;
        display: grid; place-items: center; background: #141414; color: #9a9a9a; }
      .notif-item-icon.kind-download { color: #2fb36d; }
      .notif-item-icon.kind-update { color: #e0a32e; }
      .notif-item-icon.kind-error { color: #e5484d; }
      .notif-item-icon.kind-social { color: #fff; }
      .notif-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
      .notif-item-title { font-size: 13px; font-weight: 500; }
      .notif-item-text { font-size: 12px; color: #9a9a9a; overflow: hidden;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .notif-item-time { font-size: 11px; color: #5c5c5c; font-variant-numeric: tabular-nums; }
      .notif-empty { display: flex; flex-direction: column; align-items: center; gap: 8px;
        padding: 32px 0; color: #5c5c5c; font-size: 13px; }
      .notif-empty p { margin: 0; }
    "#;
    const SCRIPT: &str = r#"
      document.addEventListener("click", function (event) {
        var node = event.target && event.target.closest ? event.target.closest("[data-act]") : null;
        if (!node) return;
        event.preventDefault();
        var act = encodeURIComponent(node.getAttribute("data-act") || "");
        var id = encodeURIComponent(node.getAttribute("data-id") || "");
        location.href = "https://efxlve.local/act?act=" + act + "&id=" + id;
      });
    "#;
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>{CSS}</style></head><body>{panel_html}<script>{SCRIPT}</script></body></html>"
    )
}

const ARM_STORE_CLICK: &str = r#"
(() => {
  window.__efxlveNotifAway = true;
  if (window.__efxlveNotifAwayBound) return;
  window.__efxlveNotifAwayBound = true;
  document.addEventListener("pointerdown", (ev) => {
    if (!window.__efxlveNotifAway) return;
    window.__efxlveNotifAway = false;
    ev.preventDefault();
    ev.stopPropagation();
    location.href = "https://efxlve.local/notif-close";
  }, true);
})()
"#;

fn store_children(window: &tauri::Window) -> Vec<tauri::Webview> {
    window
        .webviews()
        .into_iter()
        .filter(|w| {
            w.label().starts_with("store-view-") || w.label().starts_with("epic-store-view")
        })
        .collect()
}

fn arm_store_clicks(window: &tauri::Window, armed: bool) {
    let script = if armed {
        ARM_STORE_CLICK
    } else {
        "window.__efxlveNotifAway = false;"
    };
    for view in store_children(window) {
        let _ = view.eval(script);
    }
}

fn place_overlay(window: &tauri::Window, webview: &tauri::Webview, x: f64, y: f64, width: f64, height: f64) {
    let width = width.max(160.0);
    let height = height.max(72.0);
    if let Ok(mut slot) = OVERLAY_RECT.lock() {
        *slot = (x, y, width, height);
    }
    let _ = webview.set_bounds(panel_rect(x, y, width, height));
    let _ = webview.show();
    raise_child_covering(window, x, y, width, height);
}

/// Opens the dropdown above the store. `html` is the `.notif-panel` markup.
#[tauri::command]
pub async fn show_notif_overlay(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    html: String,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let document = overlay_document(&html);
    let epoch = OVERLAY_EPOCH.load(std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut slot) = PENDING_HTML.lock() {
        *slot = document.clone();
    }

    if let Some(webview) = window.get_webview(LABEL) {
        if OVERLAY_EPOCH.load(std::sync::atomic::Ordering::Relaxed) != epoch {
            return Ok(());
        }
        OVERLAY_OPEN.store(true, std::sync::atomic::Ordering::Relaxed);
        place_overlay(&window, &webview, x, y, width, height);
        publish_document(&webview, &document);
        arm_store_clicks(&window, true);
        return Ok(());
    }

    let blank = url::Url::parse("about:blank").map_err(|e| e.to_string())?;
    let app_nav = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(LABEL, tauri::WebviewUrl::External(blank))
        .background_color(tauri::webview::Color(10, 10, 10, 255))
        .on_page_load(move |webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            if let Ok(html) = PENDING_HTML.lock() {
                if !html.is_empty() {
                    let _ = webview.eval(&write_document_js(&html));
                }
            }
            if let Some(host) = webview.app_handle().get_window("main") {
                raise_if_open(&host);
            }
        })
        .on_navigation(move |target| {
            if target.scheme() == "about" {
                return true;
            }
            if let Some((act, id)) = notif_act_from_url(target) {
                let _ = app_nav.emit(
                    "notif-overlay-act",
                    serde_json::json!({ "act": act, "id": id }),
                );
            }
            false
        });

    let pos = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
    let size = tauri::Size::Logical(tauri::LogicalSize::new(width.max(160.0), height.max(72.0)));
    let handle = tokio::task::spawn_blocking(move || window.add_child(builder, pos, size));
    match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(Ok(webview))) => {
            if OVERLAY_EPOCH.load(std::sync::atomic::Ordering::Relaxed) != epoch {
                let _ = webview.hide();
                return Ok(());
            }
            OVERLAY_OPEN.store(true, std::sync::atomic::Ordering::Relaxed);
            if let Some(host) = app.get_window("main") {
                place_overlay(&host, &webview, x, y, width, height);
                arm_store_clicks(&host, true);
            }
            Ok(())
        }
        Ok(Ok(Err(e))) => Err(e.to_string()),
        Ok(Err(_)) => Err("@t:store.viewCreateFailed".into()),
        Err(_) => Err("@t:store.viewTimeout".into()),
    }
}

/// Moves an open dropdown. Does not reload the list.
#[tauri::command]
pub fn move_notif_overlay(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if !OVERLAY_OPEN.load(std::sync::atomic::Ordering::Relaxed) {
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let Some(webview) = window.get_webview(LABEL) else {
        return Ok(());
    };
    place_overlay(&window, &webview, x, y, width, height);
    Ok(())
}

/// Hides the dropdown without shrinking it to 1×1.
#[tauri::command]
pub fn hide_notif_overlay(app: AppHandle) -> Result<(), String> {
    OVERLAY_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    OVERLAY_OPEN.store(false, std::sync::atomic::Ordering::Relaxed);
    let Some(window) = app.get_window("main") else {
        return Ok(());
    };
    arm_store_clicks(&window, false);
    let Some(webview) = window.get_webview(LABEL) else {
        return Ok(());
    };
    let parked = tauri::Rect {
        position: tauri::Position::Logical(tauri::LogicalPosition::new(-10000.0, -10000.0)),
        size: tauri::Size::Logical(tauri::LogicalSize::new(360.0, 480.0)),
    };
    let _ = webview.set_bounds(parked);
    let _ = webview.hide();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{notif_act_from_url, overlay_document};

    #[test]
    fn a_dropdown_click_carries_the_action() {
        let url = url::Url::parse("https://efxlve.local/act?act=notif-open&id=Sugar").unwrap();
        assert_eq!(
            notif_act_from_url(&url),
            Some(("notif-open".into(), "Sugar".into()))
        );
        let other = url::Url::parse("https://efxlve.local/open-game?app=Sugar").unwrap();
        assert_eq!(notif_act_from_url(&other), None);
    }

    #[test]
    fn the_document_wraps_the_panel() {
        let doc = overlay_document("<p>hello</p>");
        assert!(doc.contains("<p>hello</p>"));
        assert!(doc.contains("https://efxlve.local/act"));
    }
}
