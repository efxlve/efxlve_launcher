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

/// Re-raises the dropdown after another child changed its own bounds. `show`
/// and `set_bounds` can lift that child above the dropdown, and WebView2 may
/// apply the new z-order a beat later, so the raise is repeated once.
pub fn raise_if_open_soon(window: &tauri::Window) {
    if !OVERLAY_OPEN.load(std::sync::atomic::Ordering::Relaxed) {
        return;
    }
    raise_if_open(window);
    let host = window.clone();
    tauri::async_runtime::spawn(async move {
        for delay in [140u64, 420] {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            raise_if_open(&host);
        }
    });
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

/// Binds the dropdown's clicks after every document write.
///
/// The host is a local app page (`notif-overlay.html`), so `document.open()`
/// keeps the app origin and the IPC bridge stays usable. A command is the
/// reliable channel: the old fake navigation (`https://efxlve.local/act`) is a
/// cross-origin hop that WebView2 can drop, which left every row dead over the
/// store, Spotify and Discord pages. That navigation remains as a fallback.
const OVERLAY_BIND_SCRIPT: &str = r#"
(() => {
  const send = (act, id) => {
    const ipc = window.__TAURI_INTERNALS__;
    if (ipc && ipc.invoke) {
      ipc.invoke("notif_overlay_act", { act, id: id || "" }).catch(() => {
        location.href = "https://efxlve.local/act?act=" + encodeURIComponent(act) +
          "&id=" + encodeURIComponent(id || "") + "&t=" + Date.now();
      });
      return;
    }
    location.href = "https://efxlve.local/act?act=" + encodeURIComponent(act) +
      "&id=" + encodeURIComponent(id || "") + "&t=" + Date.now();
  };
  document.addEventListener("click", (event) => {
    const node = event.target && event.target.closest ? event.target.closest("[data-act]") : null;
    if (!node) return;
    event.preventDefault();
    send(node.getAttribute("data-act") || "", node.getAttribute("data-id") || "");
  });
  // The dropdown owns the keyboard once it is clicked; Escape must still close
  // it (and the changelog card, which shares this host).
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    send("overlay-close", "");
  });
})()
"#;

fn publish_document(webview: &tauri::Webview, document: &str) {
    if let Ok(mut slot) = PENDING_HTML.lock() {
        *slot = document.to_string();
    }
    let _ = webview.eval(&format!("{}{}", write_document_js(document), OVERLAY_BIND_SCRIPT));
}

/// The changelog card shares its stylesheet with the app: `modals.css` imports
/// `src/styles/changelog.css` and this host embeds the same file, so both paint
/// one card.
const CHANGELOG_CSS: &str = include_str!("../../src/styles/changelog.css");

fn overlay_document(panel_html: &str) -> String {
    const CSS: &str = r#"
      html, body { margin: 0; height: 100%; background: #000000; color: #fff; overflow: hidden;
        font-family: "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif; }
      * { scrollbar-width: thin; scrollbar-color: rgba(255, 255, 255, 0.14) transparent; }
      button { font-family: inherit; }
      .notif-panel { position: static; width: 100%; height: 100%; max-height: none; box-sizing: border-box;
        display: flex; flex-direction: column; overflow: hidden; background: var(--surface-1, #0a0a0a);
        border: 1px solid var(--line-strong, rgba(255,255,255,0.12)); border-radius: var(--r-md, 10px); }
      .notif-head { display: flex; align-items: center; justify-content: space-between; gap: 10px;
        padding: 12px 14px; border-bottom: 1px solid var(--line, rgba(255,255,255,0.06)); }
      .notif-title { display: inline-flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 600; }
      .notif-head-actions { display: flex; gap: 4px; }
      .notif-action { border: none; background: transparent; color: var(--text-2, #9a9a9a); font-size: 12px;
        padding: 4px 6px; border-radius: 4px; cursor: pointer; }
      .notif-action:hover { background: var(--surface-2, #141414); color: var(--text, #ffffff); }
      .notif-tabs { display: flex; align-items: center; gap: 14px; padding: 0 14px;
        border-bottom: 1px solid var(--line, rgba(255,255,255,0.06)); }
      .notif-tabs .tab { position: relative; height: 35px; padding: 0; border: none; background: none;
        color: var(--text-2, #9a9a9a); font-size: 12.5px; font-weight: 500; cursor: pointer;
        display: inline-flex; align-items: center; gap: 5px; }
      .notif-tabs .tab svg { width: 13px; height: 13px; opacity: 0.75; }
      .notif-tabs .tab.active svg { opacity: 1; }
      .notif-tabs .tab:hover, .notif-tabs .tab.active { color: var(--text, #ffffff); }
      .notif-tabs .tab.active::after { content: ""; position: absolute; left: 0; right: 0; bottom: -1px;
        height: 2px; background: var(--accent, #ffffff); }
      .notif-tabs .tab .count { display: inline-flex; align-items: center; justify-content: center;
        min-width: 17px; height: 17px; padding: 0 5px; border-radius: 9px;
        background: var(--surface-3, #1e1e1e); color: var(--text-2, #9a9a9a);
        font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; }
      .notif-tabs .tab.active .count { color: var(--text, #ffffff); }
      .notif-list { overflow-y: auto; flex: 1; min-height: 0; display: flex; flex-direction: column; }
      .notif-item { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 10px 14px;
        text-align: left; border: none; border-bottom: 1px solid var(--line, rgba(255,255,255,0.06));
        background: transparent; color: var(--text, #ffffff); cursor: pointer; }
      .notif-item:hover { background: var(--surface-2, #141414); }
      .notif-item.unread { background: var(--accent-tint, rgba(255,255,255,0.08)); }
      .notif-item-icon { width: 28px; height: 28px; border-radius: 6px; flex-shrink: 0;
        display: grid; place-items: center; background: var(--surface-2, #141414); color: var(--text-2, #9a9a9a); }
      .notif-item-art { position: relative; overflow: hidden; }
      .notif-art { position: absolute; inset: 0; background-position: center; background-size: cover; }
      .notif-item-store { align-self: center; margin-left: auto; flex-shrink: 0; opacity: 0.75; }
      .notif-item-store img { display: block; }
      .notif-item-icon.kind-download { color: var(--ok, #2fb36d); }
      .notif-item-icon.kind-update { color: var(--warn, #e0a32e); }
      .notif-item-icon.kind-app { color: var(--warn, #e0a32e); }
      .notif-item-icon.kind-error { color: var(--err, #e5484d); }
      .notif-item-icon.kind-social { color: var(--accent, #ffffff); }
      .notif-item-icon.kind-achievement { color: var(--warn, #e0a32e); }
      .notif-item-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
      .notif-item-title { font-size: 13px; font-weight: 500; }
      .notif-item-text { font-size: 12px; color: var(--text-2, #9a9a9a); overflow: hidden;
        display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
      .notif-item-act { display: inline-flex; align-items: center; gap: 4px; align-self: flex-start; margin-top: 2px;
        height: 20px; padding: 0 7px; border-radius: 4px; background: var(--accent, #ffffff);
        color: var(--on-accent, #000000); font-size: 11px; font-weight: 600; }
      .notif-item-act svg { width: 12px; height: 12px; }
      .notif-item-time { font-size: 11px; color: var(--text-3, #5c5c5c); font-variant-numeric: tabular-nums; }
      .notif-empty { display: flex; flex-direction: column; align-items: center; gap: 8px;
        padding: 32px 0; color: var(--text-3, #5c5c5c); font-size: 13px; }
      .notif-empty p { margin: 0; }
    "#;
    // The changelog card fills a host that is already sized to it.
    const FRAME: &str = r#"
      .changelog-backdrop { position: absolute; inset: 0; display: flex; padding: 0; background: transparent; }
      .changelog-dialog { width: 100%; height: 100%; max-width: none; max-height: none; }
    "#;
    format!(
        "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><style>{CSS}\n{CHANGELOG_CSS}\n{FRAME}</style></head><body>{panel_html}</body></html>"
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
    if (typeof window.__efxlveCommand === "function") {
      window.__efxlveCommand("notif-close");
      return;
    }
    location.href = "https://efxlve.local/notif-close?t=" + Date.now();
  }, true);
})()
"#;

fn embedded_children(window: &tauri::Window) -> Vec<tauri::Webview> {
    window
        .webviews()
        .into_iter()
        .filter(|w| {
            let label = w.label();
            // The storefronts, the Spotify page and the Discord page all cover
            // the content area.
            label.starts_with("store-view-")
                || label.starts_with("epic-store-view")
                || label == "spotify-player"
                || label == "discord-view"
        })
        .collect()
}

fn arm_embedded_clicks(window: &tauri::Window, armed: bool) {
    let script = if armed {
        ARM_STORE_CLICK
    } else {
        "window.__efxlveNotifAway = false;"
    };
    for view in embedded_children(window) {
        let _ = view.eval(script);
    }
}

/// Re-runs the covering match once the fresh bounds have landed: on the first
/// placement the child still reports its old rect, so the immediate match can
/// miss and the panel stays below the storefront/Spotify child.
fn raise_covering_soon(window: &tauri::Window, x: f64, y: f64, width: f64, height: f64) {
    let host = window.clone();
    tauri::async_runtime::spawn(async move {
        for delay in [180u64, 520] {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            raise_child_covering(&host, x, y, width, height);
        }
    });
}

/// Sizes the host, waits a beat, then shows it: a visible child paints at its
/// previous bounds for a frame (the "opens small, then jumps" flash). Callers
/// hide the host first. Also re-raises it above the storefront/Spotify siblings.
async fn present_overlay(webview: &tauri::Webview, window: &tauri::Window, x: f64, y: f64, width: f64, height: f64) {
    let width = width.max(160.0);
    let height = height.max(72.0);
    if let Ok(mut slot) = OVERLAY_RECT.lock() {
        *slot = (x, y, width, height);
    }
    let _ = webview.set_bounds(panel_rect(x, y, width, height));
    tokio::time::sleep(std::time::Duration::from_millis(40)).await;
    let _ = webview.show();
    raise_child_covering(window, x, y, width, height);
    raise_covering_soon(window, x, y, width, height);
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
        let _ = webview.hide();
        publish_document(&webview, &document);
        present_overlay(&webview, &window, x, y, width, height).await;
        arm_embedded_clicks(&window, true);
        return Ok(());
    }

    let app_nav = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        LABEL,
        tauri::WebviewUrl::App("notif-overlay.html".into()),
    )
    .background_color(tauri::webview::Color(0, 0, 0, 255))
    .on_page_load(move |webview, payload| {
        if payload.event() != tauri::webview::PageLoadEvent::Finished {
            return;
        }
        if let Ok(html) = PENDING_HTML.lock() {
            if !html.is_empty() {
                let _ = webview.eval(&format!("{}{}", write_document_js(&html), OVERLAY_BIND_SCRIPT));
            }
        }
        if let Some(host) = webview.app_handle().get_window("main") {
            raise_if_open(&host);
        }
    })
    .on_navigation(move |target| {
        // The host page is the app's own local document: it must load, and
        // keeping it local is what lets the dropdown use the IPC bridge.
        if target.scheme() == "about" || target.path() == "/notif-overlay.html" {
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
            // The local host page can finish loading before an eval is
            // possible, and the page-load write is the only other path: a
            // freshly created host must get its document here or the first
            // open shows a blank panel.
            let _ = webview.hide();
            publish_document(&webview, &document);
            if let Some(host) = app.get_window("main") {
                present_overlay(&webview, &host, x, y, width, height).await;
                arm_embedded_clicks(&host, true);
            }
            let again = webview.clone();
            let retry_doc = document.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_millis(400)).await;
                publish_document(&again, &retry_doc);
            });
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
    // A move while the host is open: no hide/show, that would flicker.
    if let Ok(mut slot) = OVERLAY_RECT.lock() {
        *slot = (x, y, width, height);
    }
    let _ = webview.set_bounds(panel_rect(x, y, width, height));
    let _ = webview.show();
    raise_child_covering(&window, x, y, width, height);
    Ok(())
}

/// A click inside the dropdown. The overlay document has the app's IPC bridge,
/// so it reports the action here instead of pretending to navigate: a fake
/// navigation is dropped by some WebView2 builds, which left every row dead.
/// Emitting the event keeps the same handler the browser (HTML) panel uses.
#[tauri::command]
pub fn notif_overlay_act(app: AppHandle, act: String, id: Option<String>) -> Result<(), String> {
    app.emit(
        "notif-overlay-act",
        serde_json::json!({ "act": act, "id": id.unwrap_or_default() }),
    )
    .map_err(|error| error.to_string())
}

/// Hides the dropdown without shrinking it to 1×1.
#[tauri::command]
pub fn hide_notif_overlay(app: AppHandle) -> Result<(), String> {
    OVERLAY_EPOCH.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    OVERLAY_OPEN.store(false, std::sync::atomic::Ordering::Relaxed);
    let Some(window) = app.get_window("main") else {
        return Ok(());
    };
    arm_embedded_clicks(&window, false);
    let Some(webview) = window.get_webview(LABEL) else {
        return Ok(());
    };
    // Parked off-screen, but at its last size: shrinking it here made the next
    // open paint a frame at that smaller size before the new bounds landed.
    let (_, _, width, height) = OVERLAY_RECT
        .lock()
        .map(|slot| *slot)
        .unwrap_or((-10000.0, -10000.0, 360.0, 480.0));
    let _ = webview.set_bounds(panel_rect(-10000.0, -10000.0, width, height));
    let _ = webview.hide();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{notif_act_from_url, overlay_document, OVERLAY_BIND_SCRIPT};

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
        // The click handler is installed after the write, on the local host
        // page, so it can reach the shell through the IPC bridge.
        assert!(!doc.contains("<script>"));
        assert!(OVERLAY_BIND_SCRIPT.contains("notif_overlay_act"));
        assert!(OVERLAY_BIND_SCRIPT.contains("efxlve.local/"));
    }
}
