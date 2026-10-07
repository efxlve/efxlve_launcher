//! Embedded store child webviews.
//!
//! Store pages send `X-Frame-Options`, so each storefront is a native WebView2
//! child of the main window. Never pass `additional_browser_args` to
//! `WebviewBuilder`; that flag silently breaks child webview rendering.
//!
//! The injected page script is `store_extension.js`, not a string in this file.

use tauri::{AppHandle, Manager};

/// Shows the Epic Store as an embedded webview inside the MAIN window.
/// Reason: Epic sends `X-Frame-Options: SAMEORIGIN`, so it cannot be embedded
/// with an iframe; therefore a native child webview is placed in the content area
/// (using the `add_child` API behind the `unstable` feature).
/// The top bar stays on top as HTML and the tabs keep working.
///

/// Left/top insets (logical px) of the store area, reported by the frontend
/// shell (sidebar width + window bar height). Stored as f64 bits so the native
/// resize hook can re-apply them without an IPC round trip.
static STORE_INSET_LEFT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static STORE_INSET_TOP: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static STORE_INSET_BOTTOM: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Whether the store webview is currently shown; a hidden view must stay off-screen on resize.
static STORE_VISIBLE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// Command palette is open. The child webview stays off-screen until this clears,
/// so a window resize cannot place it over the palette.
static STORE_PALETTE_OPEN: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
/// Bumped every time the store is hidden. A show that started earlier must not
/// paint the webview back on top of another page.
static STORE_EPOCH: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// A storefront that is loading away from a sign-in page. It becomes visible
/// when its page has painted; `NO_PENDING_LOAD` means nothing is waiting.
const NO_PENDING_LOAD: u64 = u64::MAX;
static SHOW_AFTER_LOAD_EPOCH: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(NO_PENDING_LOAD);
/// Bounds for the pending storefront. A parked webview sits off-screen, so the
/// area must be re-applied before it is shown again.
static PENDING_RECT: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);

fn remember_store_insets(left: f64, top: f64, bottom: f64) {
    use std::sync::atomic::Ordering::Relaxed;
    STORE_INSET_LEFT.store(left.max(0.0).to_bits(), Relaxed);
    STORE_INSET_TOP.store(top.max(0.0).to_bits(), Relaxed);
    STORE_INSET_BOTTOM.store(bottom.max(0.0).to_bits(), Relaxed);
}

/// Computes the store webview bounds `(x, y, width, height)` for a window of the
/// given logical size, filling the area between the left/top/bottom insets.
fn store_bounds(win_w: f64, win_h: f64, left: f64, top: f64, bottom: f64) -> (f64, f64, f64, f64) {
    let left = left.max(0.0);
    let top = top.max(0.0);
    let bottom = bottom.max(0.0);
    (
        left,
        top,
        (win_w - left).max(100.0),
        (win_h - top - bottom).max(100.0),
    )
}

/// The child webview may sit in the content area only while the store page is
/// showing and the command palette is closed.
fn store_child_on_screen(store_visible: bool, palette_open: bool) -> bool {
    store_visible && !palette_open
}

/// Bounds a resize may apply to the store child webview.
/// `None` leaves it off-screen: the store is hidden, or the command palette is
/// open. A resize must not pull the webview back over the palette, and it must
/// not hide it again (a second hide/show is the close flicker).
fn store_resize_bounds(
    store_visible: bool,
    palette_open: bool,
    win_w: f64,
    win_h: f64,
    left: f64,
    top: f64,
    bottom: f64,
) -> Option<(f64, f64, f64, f64)> {
    if !store_child_on_screen(store_visible, palette_open) {
        return None;
    }
    Some(store_bounds(win_w, win_h, left, top, bottom))
}

/// What one palette hold/release call is allowed to do.
/// A second call for the same transition is `Ignore`, so one close cannot
/// show, hide, and show the child webview again.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StoreHoldEffect {
    Park,
    Show,
    ReleaseHidden,
    Ignore,
}

fn store_hold_effect(
    palette_open: bool,
    store_visible: bool,
    hold: bool,
    restore: bool,
) -> StoreHoldEffect {
    if hold {
        if palette_open {
            StoreHoldEffect::Ignore
        } else {
            StoreHoldEffect::Park
        }
    } else if !palette_open {
        StoreHoldEffect::Ignore
    } else if restore && store_visible {
        StoreHoldEffect::Show
    } else {
        StoreHoldEffect::ReleaseHidden
    }
}

fn webview_rect(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: tauri::Position::Logical(tauri::LogicalPosition::new(x, y)),
        size: tauri::Size::Logical(tauri::LogicalSize::new(width, height)),
    }
}

fn bounds_key(x: f64, y: f64, width: f64, height: f64) -> (i32, i32, i32, i32) {
    (
        x.round() as i32,
        y.round() as i32,
        width.round() as i32,
        height.round() as i32,
    )
}

/// Last rect sent to the child. A resize echo of that same rect must not
/// apply bounds again; split position/size updates were collapsing it to 1x1
/// and forcing a second show.
static STORE_APPLIED_BOUNDS: std::sync::Mutex<Option<(i32, i32, i32, i32)>> =
    std::sync::Mutex::new(None);

fn bounds_already_applied(x: f64, y: f64, width: f64, height: f64) -> bool {
    STORE_APPLIED_BOUNDS.lock().ok().and_then(|slot| *slot) == Some(bounds_key(x, y, width, height))
}

fn remember_applied_bounds(x: f64, y: f64, width: f64, height: f64) {
    if let Ok(mut slot) = STORE_APPLIED_BOUNDS.lock() {
        *slot = Some(bounds_key(x, y, width, height));
    }
}

static ACTIVE_STORE_LABEL: std::sync::Mutex<String> = std::sync::Mutex::new(String::new());

/// Storefront hosted in the embedded store view. `epic` additionally gets the
/// owned-library decoration; every other storefront is a plain web storefront.
fn store_id_for_url(url: &str) -> &'static str {
    let url = url.to_ascii_lowercase();
    if url.contains("gog.com") {
        "gog"
    } else if url.contains("steampowered.com") {
        "steam"
    } else if url.contains("ubisoft.com") || url.contains("ubi.com") {
        // The store lives on store.ubi.com, which does not contain "ubisoft.com".
        "ubisoft"
    } else if url.contains("ea.com") {
        "ea"
    } else if url.contains("xbox.com") || url.contains("microsoft.com") {
        "xbox"
    } else if url.contains("battle.net") {
        "battlenet"
    } else if url.contains("luna.amazon.com") {
        "luna"
    } else if url.contains("riotgames.com") {
        "riot"
    } else {
        "epic"
    }
}

/// Store label (`store-view-<id>`) back to its store id.
fn store_id_for_label(label: &str) -> String {
    label
        .strip_prefix("store-view-")
        .unwrap_or(label)
        .to_string()
}

/// Sign-in pages a store tab can be left on. Opening the tab again must return
/// to the storefront instead of showing the account/client page.
fn is_login_page(url: &url::Url) -> bool {
    matches!(
        url.host_str(),
        Some("connect.cdn.ubisoft.com") | Some("account.battle.net")
    )
}

/// Ubisoft's overlay login page: the same start URL the sign-in action and the
/// Galaxy Uplay plugin use. The storefront's own LOG IN button opens a popup to
/// `connect.ubisoft.com`, which a child webview cannot show, so that click is
/// routed here instead.
const UBISOFT_OVERLAY_LOGIN: &str = "https://connect.cdn.ubisoft.com/overlay/default/?env=prod&isStandalone=true&platform=pc&deviceType=desktop&locale=en-US&spaceId=0a706b37-4b88-4437-b8f4-4ed2458c9518&applicationId=20adeb9c-6dad-404e-af1e-b12b4594e86e&country=US&region=WW&ownershipGroup=empty";

/// A Ubisoft sign-in URL: the store's LOG IN hands a webauth/connect page to
/// `window.open`. Every other popup keeps the default (denied) behaviour.
fn is_ubisoft_auth_url(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    let ubi_host = host == "ubisoft.com"
        || host.ends_with(".ubisoft.com")
        || host == "ubi.com"
        || host.ends_with(".ubi.com");
    if !ubi_host {
        return false;
    }
    let path = url.path().to_ascii_lowercase();
    ["login", "webauth", "signin", "auth", "connect", "overlay"]
        .iter()
        .any(|needle| path.contains(needle))
}

/// Shows a storefront that was waiting for its page load. The epoch guards
/// against a tab switch or a hide that happened in the meantime, and the saved
/// rect puts the parked webview back inside the content area.
fn show_pending_store(app: &tauri::AppHandle, label: &str, epoch: u64) {
    use std::sync::atomic::Ordering::SeqCst;
    if SHOW_AFTER_LOAD_EPOCH.load(SeqCst) != epoch || STORE_EPOCH.load(SeqCst) != epoch {
        return;
    }
    SHOW_AFTER_LOAD_EPOCH.store(NO_PENDING_LOAD, SeqCst);
    if STORE_PALETTE_OPEN.load(SeqCst) {
        return;
    }
    let rect = PENDING_RECT.lock().ok().and_then(|mut slot| slot.take());
    if let Some(window) = app.get_window("main") {
        if let Some(v) = window.get_webview(label) {
            if let Some((x, y, width, height)) = rect {
                let _ = v.set_bounds(webview_rect(x, y, width, height));
                remember_applied_bounds(x, y, width, height);
            }
            let _ = v.show();
            STORE_VISIBLE.store(true, SeqCst);
        }
    }
}

/// How many storefronts may stay alive at once. Each one is another WebView2
/// renderer in the same process as the main window (about 60-260 MB). More
/// than one pushes that process over the edge: Windows kills it, the window
/// and its icon disappear, and Task Manager is left with "WebView2 Manager".
const MAX_WARM_STORES: usize = 1;

/// Alive storefront labels, most recently used first.
static STORE_WARM_ORDER: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Marks one storefront as recently used.
fn touch_store_warm(label: &str) {
    if let Ok(mut order) = STORE_WARM_ORDER.lock() {
        order.retain(|entry| entry != label);
        order.insert(0, label.to_string());
    }
}

/// Closes the storefronts beyond `MAX_WARM_STORES` and returns their ids.
fn prune_store_views() -> Vec<String> {
    let mut closed = Vec::new();
    let labels: Vec<String> = match STORE_WARM_ORDER.lock() {
        Ok(mut order) => {
            if order.len() <= MAX_WARM_STORES {
                return closed;
            }
            order.split_off(MAX_WARM_STORES)
        }
        Err(_) => return closed,
    };
    for label in labels {
        closed.push(store_id_for_label(&label));
    }
    closed
}

/// One position+size update. `set_position` then `set_size` reads the parked
/// 1x1 size back and collapses the webview after it has just been shown.
fn move_store_bounds(
    window: &tauri::Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if bounds_already_applied(x, y, width, height) {
        return Ok(());
    }
    let views = store_views(window);
    if views.is_empty() {
        return Ok(());
    }
    let active = ACTIVE_STORE_LABEL
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default();
    let rect = webview_rect(x, y, width, height);
    // Parked at the content size, not 1x1: a 1x1 viewport makes the store page
    // reflow to a mobile breakpoint, so every switch back would repaint the whole
    // page. Off-screen + hidden costs nothing while the user browses stores;
    // leaving the store still shrinks everything through `park_store_offscreen`.
    let offscreen = webview_rect(-10000.0, -10000.0, width, height);
    for v in &views {
        if active.is_empty() || v.label() == active {
            v.set_bounds(rect).map_err(|e| e.to_string())?;
        } else {
            let _ = v.set_bounds(offscreen);
            let _ = v.hide();
        }
    }
    remember_applied_bounds(x, y, width, height);
    // set_bounds can lift the store above the notification layer.
    crate::notif_overlay::raise_if_open(window);
    Ok(())
}

/// Size to use while a store child is parked off-screen.
/// A 1×1 bounds update is what makes the main window restore from a dot:
/// WebView2 copies that size onto the parent.
fn parked_content_size(window: &tauri::Window) -> (f64, f64) {
    let Ok(physical) = window.inner_size() else {
        return (1280.0, 800.0);
    };
    if !resize_is_a_real_frame(physical.width, physical.height) {
        return (1280.0, 800.0);
    }
    let Ok(scale) = window.scale_factor() else {
        return (1280.0, 800.0);
    };
    let logical = physical.to_logical::<f64>(scale);
    (logical.width.max(100.0), logical.height.max(100.0))
}

/// Moves every store child webview off-screen and hides it once.
/// Shared by `hide_store_view` and the command-palette hold.
fn park_store_offscreen(window: &tauri::Window) -> Result<(), String> {
    const X: f64 = -10000.0;
    const Y: f64 = -10000.0;
    let views = store_views(window);
    if views.is_empty() {
        return Ok(());
    }
    let (width, height) = parked_content_size(window);
    let rect = webview_rect(X, Y, width, height);
    for v in &views {
        v.set_bounds(rect).map_err(|e| e.to_string())?;
    }
    for v in &views {
        v.hide().map_err(|e| e.to_string())?;
    }
    remember_applied_bounds(X, Y, width, height);
    Ok(())
}

/// Shows the parked child at one rect. Callers must not follow this with a
/// second show or a hide in the same close.
fn show_store_bounds(
    window: &tauri::Window,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let width = width.max(100.0);
    let height = height.max(100.0);
    let views = store_views(window);
    if views.is_empty() {
        return Ok(());
    }
    let active = ACTIVE_STORE_LABEL
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default();
    let rect = webview_rect(x, y, width, height);
    let offscreen = webview_rect(-10000.0, -10000.0, width, height);
    if !bounds_already_applied(x, y, width, height) {
        for v in &views {
            if active.is_empty() || v.label() == active {
                v.set_bounds(rect).map_err(|e| e.to_string())?;
            } else {
                let _ = v.set_bounds(offscreen);
            }
        }
        remember_applied_bounds(x, y, width, height);
    }
    for v in &views {
        if active.is_empty() || v.label() == active {
            v.show().map_err(|e| e.to_string())?;
        } else {
            let _ = v.hide();
        }
    }
    crate::notif_overlay::raise_if_open(window);
    Ok(())
}

fn store_views(window: &tauri::Window) -> Vec<tauri::Webview> {
    window
        .webviews()
        .into_iter()
        .filter(|w| {
            w.label().starts_with("epic-store-view") || w.label().starts_with("store-view-")
        })
        .collect()
}

fn to_epic_slug_rust(title: &str) -> String {
    let lower = title.to_lowercase();
    let mut slug = String::new();
    let mut prev_dash = false;
    for c in lower.chars() {
        if c.is_alphanumeric() {
            slug.push(c);
            prev_dash = false;
        } else if !prev_dash && !slug.is_empty() {
            slug.push('-');
            prev_dash = true;
        }
    }
    if slug.ends_with('-') {
        slug.pop();
    }
    slug
}

fn get_owned_games_json() -> String {
    let config_dir = crate::legendary::skip::default_config_dir();
    // Prefer the consolidated snapshot (1 file) over ~900 metadata files.
    let games = match crate::legendary::cache::read_library_snapshot(&config_dir) {
        Some(g) => g,
        None => crate::legendary::cache::read_cached_games(&config_dir),
    };
    let installed = crate::legendary::cache::read_installed(&config_dir);
    let installed_set: std::collections::HashSet<String> =
        installed.into_iter().map(|g| g.app_name).collect();

    let mut list = Vec::with_capacity(games.len());
    for g in games {
        let title = g.app_title.trim().to_string();
        if title.is_empty() {
            continue;
        }
        let is_installed = installed_set.contains(&g.app_name);
        let slug = to_epic_slug_rust(&title);
        list.push(serde_json::json!({
            "a": g.app_name,
            "t": title,
            "s": slug,
            "i": is_installed
        }));
    }
    serde_json::to_string(&list).unwrap_or_else(|_| "[]".to_string())
}

/// Cached owned-library payload plus the snapshot stamp it was built from.
static OWNED_GAMES_CACHE: std::sync::Mutex<Option<((u64, u64), String)>> =
    std::sync::Mutex::new(None);

/// Modification time and size of the library snapshot; any library sync replaces
/// the file, so the stamp changes with it.
fn snapshot_stamp(config_dir: &std::path::Path) -> (u64, u64) {
    let path = config_dir.join("efxlve_library_snapshot.json");
    match std::fs::metadata(&path) {
        Ok(meta) => {
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::SystemTime::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            (modified, meta.len())
        }
        Err(_) => (0, 0),
    }
}

/// The owned-library payload for the Epic storefront, rebuilt only when the
/// snapshot changes. Building it reads and slugifies every owned game (820 games
/// measured at ~87 KB of JSON), which must not run on every store open.
fn owned_games_payload() -> String {
    let config_dir = crate::legendary::skip::default_config_dir();
    let stamp = snapshot_stamp(&config_dir);
    if let Ok(cache) = OWNED_GAMES_CACHE.lock() {
        if let Some((cached_stamp, payload)) = cache.as_ref() {
            if *cached_stamp == stamp {
                return payload.clone();
            }
        }
    }
    let payload = get_owned_games_json();
    if let Ok(mut cache) = OWNED_GAMES_CACHE.lock() {
        *cache = Some((stamp, payload.clone()));
    }
    payload
}

/// Page script for the embedded store (`store_extension.js`).
const STORE_EXTENSION_SCRIPT: &str = include_str!("store_extension.js");

fn js_string(value: &str) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string())
}

#[tauri::command]
pub async fn show_store_view(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    bottom: Option<f64>,
    url: String,
    recreate: bool,
    owned_label: Option<String>,
) -> Result<String, String> {
    use tauri::{LogicalPosition, LogicalSize, Position, Size, WebviewBuilder, WebviewUrl};

    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let pos = Position::Logical(LogicalPosition::new(x, y));
    let size = Size::Logical(LogicalSize::new(width.max(100.0), height.max(100.0)));
    remember_store_insets(x, y, bottom.unwrap_or(0.0));
    let epoch = STORE_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    STORE_VISIBLE.store(true, std::sync::atomic::Ordering::SeqCst);
    // A new show request cancels a storefront that was still waiting to appear.
    SHOW_AFTER_LOAD_EPOCH.store(NO_PENDING_LOAD, std::sync::atomic::Ordering::SeqCst);
    if let Ok(mut slot) = PENDING_RECT.lock() {
        *slot = None;
    }

    let store_id = store_id_for_url(&url);
    // Only the Epic storefront is decorated with the owned library, and building
    // that payload reads and serialises every owned game: the other storefronts
    // skip it entirely. The empty array keeps the injected script valid.
    let owned_games = if store_id == "epic" {
        owned_games_payload()
    } else {
        "[]".to_string()
    };
    let owned_label_js = js_string(owned_label.as_deref().unwrap_or(""));
    let target_label = format!("store-view-{store_id}");
    if let Ok(mut active) = ACTIVE_STORE_LABEL.lock() {
        *active = target_label.clone();
    }
    touch_store_warm(&target_label);
    // Every alive storefront is a renderer process, so only the three most recent
    // ones survive; the frontend is told which storefronts went away (it tracks
    // the warm set for its loading screen).
    for closed_id in prune_store_views() {
        let closed_label = format!("store-view-{closed_id}");
        if let Some(view) = store_views(&window)
            .into_iter()
            .find(|w| w.label() == closed_label)
        {
            let _ = view.close();
        }
        use tauri::Emitter;
        let _ = app.emit(
            "efxlve-store-closed",
            serde_json::json!({ "store": closed_id }),
        );
    }

    // Park & hide any other store webviews so only the active store view is
    // visible. Parking keeps the desktop viewport size (see `move_store_bounds`),
    // so the inactive store does not reflow to a mobile layout while it waits.
    let offscreen = webview_rect(-10000.0, -10000.0, width.max(100.0), height.max(100.0));
    for v in store_views(&window) {
        if v.label() != target_label {
            let _ = v.set_bounds(offscreen);
            let _ = v.hide();
        }
    }

    // If the webview for THIS store already exists, show it INSTANTLY (0 ms) without waiting for any network request
    if !recreate {
        if let Some(v) = store_views(&window)
            .into_iter()
            .find(|w| w.label() == target_label)
        {
            // A tab left on its sign-in page loads the storefront while hidden
            // and appears only once the store has painted, so opening the tab
            // never flashes the account/client UI.
            if v.url().ok().map(|u| is_login_page(&u)).unwrap_or(false) {
                if let Ok(target) = url.parse::<url::Url>() {
                    let _ = v.hide();
                    STORE_VISIBLE.store(false, std::sync::atomic::Ordering::SeqCst);
                    SHOW_AFTER_LOAD_EPOCH.store(epoch, std::sync::atomic::Ordering::SeqCst);
                    if let Ok(mut slot) = PENDING_RECT.lock() {
                        *slot = Some((x, y, width.max(100.0), height.max(100.0)));
                    }
                    let _ = v.navigate(target);
                    // Safety net: a page that never reports a finished load must
                    // still become visible.
                    let app_show = app.clone();
                    let label_show = target_label.clone();
                    tauri::async_runtime::spawn(async move {
                        tokio::time::sleep(std::time::Duration::from_millis(2500)).await;
                        show_pending_store(&app_show, &label_show, epoch);
                    });
                    return Ok("@t:store.pending".into());
                }
            }
            // The palette hold parks the webview; do not move it back on screen.
            if STORE_PALETTE_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = park_store_offscreen(&window);
            } else {
                // One position+size update: a split move leaves the parked size
                // applied for a frame and folds the webview back to its old box.
                let _ = v.set_bounds(webview_rect(x, y, width.max(100.0), height.max(100.0)));
                remember_applied_bounds(x, y, width.max(100.0), height.max(100.0));
                v.show().map_err(|e| e.to_string())?;
            }
            if STORE_EPOCH.load(std::sync::atomic::Ordering::SeqCst) != epoch {
                STORE_VISIBLE.store(false, std::sync::atomic::Ordering::SeqCst);
                let _ = park_store_offscreen(&window);
                // The player already left the store: report honestly so the frontend
                // keeps (or repaints) its loading screen instead of trusting a view
                // that is parked off-screen.
                return Ok("@t:store.pending".into());
            }
            if STORE_PALETTE_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = park_store_offscreen(&window);
            }
            if store_id == "epic" {
                let _ = v.eval(&format!("window.__EFXLVE_OWNED_LABEL = {owned_label_js}; window.__EFXLVE_GAMES = {owned_games}; if(typeof scanAndDecorate==='function') scanAndDecorate();"));
            }
            if let Ok(target) = url.parse::<url::Url>() {
                if let Ok(cur) = v.url() {
                    // A store home URL is not reloaded on every tab click.
                    let store_home = target.as_str().ends_with(".com/")
                        || target.as_str().ends_with(".com/en")
                        || target.as_str().ends_with(".com")
                        || target.as_str().ends_with(".net/")
                        || target.as_str().ends_with(".net");
                    if cur.as_str() != target.as_str() && !store_home {
                        let _ = v.navigate(target);
                    }
                }
            }
            if STORE_PALETTE_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = park_store_offscreen(&window);
                return Ok("@t:store.pending".into());
            }
            // The storefront is on screen: the frontend may drop its loading screen.
            return Ok("@t:win.focused".into());
        }
    } else {
        if let Some(v) = store_views(&window)
            .into_iter()
            .find(|w| w.label() == target_label)
        {
            let _ = v.close();
        }
    }

    let parsed: url::Url = url.parse().map_err(|_| "@t:win.invalidUrl".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("@t:win.onlyHttp".to_string()),
    }

    let app_nav = app.clone();
    // additional_browser_args blanks this child webview. Leave the builder without it.
    let mut builder = WebviewBuilder::new(target_label.clone(), WebviewUrl::External(parsed))
        // Native WebView2 background is pure obsidian: white flashes (FOUC) during page transitions are prevented.
        .background_color(tauri::webview::Color(14, 15, 18, 255))
        .on_page_load(move |webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            // A storefront that navigated away from a sign-in page becomes
            // visible now, once the store has actually painted.
            let pending = SHOW_AFTER_LOAD_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
            if pending != NO_PENDING_LOAD {
                show_pending_store(webview.app_handle(), webview.label(), pending);
            }
            // The storefront painted: the frontend can drop its progress sweep.
            use tauri::Emitter;
            let _ = webview.app_handle().emit(
                "efxlve-store-ready",
                serde_json::json!({ "store": store_id_for_label(webview.label()) }),
            );
        })
        .on_navigation(move |url| {
            if url.scheme() == "https" && url.host_str() == Some("efxlve.local") {
                // A click on the store, while the notification layer is open, asks
                // the shell to close that layer. The store page itself stays put.
                if url.path() == "/bnet-library" {
                    crate::companion::accept_bnet_library(&app_nav, url.fragment().unwrap_or(""));
                    return false;
                }
                if url.path() == "/ubi-session" {
                    crate::companion::accept_ubi_session(&app_nav, url.fragment().unwrap_or(""));
                    return false;
                }
                if url.path() == "/notif-close" {
                    let _ = app_nav.emit(
                        "notif-overlay-act",
                        serde_json::json!({ "act": "overlay-close" }),
                    );
                    return false;
                }
                let query: std::collections::HashMap<_, _> =
                    url.query_pairs().into_owned().collect();
                let app_name = query.get("app").cloned().unwrap_or_default();
                let title = query.get("title").cloned().unwrap_or_default();
                let slug = query.get("slug").cloned().unwrap_or_default();
                use tauri::Emitter;
                let _ = app_nav.emit(
                    "efxlve-open-game-from-store",
                    serde_json::json!({
                        "appName": app_name,
                        "title": title,
                        "slug": slug
                    }),
                );
                return false;
            }
            if url.path().contains("/download")
                || url.host_str() == Some("launcher-public-service-prod06.ol.epicgames.com")
            {
                return false;
            }
            true
        })
        .on_new_window({
            // Fallback for popups that bypass the injected script (`target=_blank`
            // links). A child webview cannot show them, so the Ubisoft tab goes to
            // the overlay login page; every other popup stays denied.
            let app_popup = app.clone();
            let popup_label = target_label.clone();
            move |url, _features| {
                if store_id == "ubisoft" && is_ubisoft_auth_url(&url) {
                    if let Some(view) = app_popup.get_webview(&popup_label) {
                        if let Ok(target) = UBISOFT_OVERLAY_LOGIN.parse::<url::Url>() {
                            let _ = view.navigate(target);
                        }
                    }
                }
                tauri::webview::NewWindowResponse::Deny
            }
        });
    if store_id == "battlenet" {
        builder = builder.initialization_script(crate::companion::bnet_watch_script());
    }
    if store_id == "ubisoft" {
        // The overlay URL is filled into the script so the storefront's LOG IN
        // popup can continue on the page the session capture understands.
        let ubi_script = crate::companion::ubi_watch_script()
            .replace("__EFXLVE_UBI_OVERLAY__", UBISOFT_OVERLAY_LOGIN);
        builder = builder.initialization_script(ubi_script);
    }
    // The Xbox storefront only ships a light theme; this paints it with the
    // launcher's dark surface and flips its header to Microsoft's dark theme.
    if store_id == "xbox" {
        builder = builder.initialization_script(crate::store_theme::XBOX_DARK_SCRIPT);
    }
    // The 44 KB storefront decoration only exists for the Epic store: injecting it
    // into the other storefronts meant parsing and running a script that finds
    // nothing, on every document load.
    if store_id == "epic" {
        let init_script = format!(
            "window.__EFXLVE_OWNED_LABEL = {owned_label_js};\nwindow.__EFXLVE_GAMES = {owned_games};\n{STORE_EXTENSION_SCRIPT}"
        );
        builder = builder.initialization_script(&init_script);
    }
    // add_child posts work to the main thread and waits; to avoid locking the UI
    // on a possible hang, it runs on a separate thread with a timeout.
    let handle = tokio::task::spawn_blocking(move || window.add_child(builder, pos, size));
    match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(Ok(_))) => {
            let window = app
                .get_window("main")
                .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
            if STORE_EPOCH.load(std::sync::atomic::Ordering::SeqCst) != epoch {
                STORE_VISIBLE.store(false, std::sync::atomic::Ordering::SeqCst);
                let _ = park_store_offscreen(&window);
            } else if STORE_PALETTE_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = park_store_offscreen(&window);
            }
            Ok("@t:store.opened".into())
        }
        Ok(Ok(Err(e))) => {
            eprintln!("[store-view] add_child error: {e}");
            Err(e.to_string())
        }
        Ok(Err(join_err)) => {
            eprintln!("[store-view] thread error: {join_err}");
            Err("@t:store.viewCreateFailed".into())
        }
        Err(_) => {
            eprintln!("[store-view] TIMEOUT (20s)");
            Err("@t:store.viewTimeout".into())
        }
    }
}

/// Resizes the embedded store view (does not reload the page).
#[tauri::command]
pub fn resize_store_view(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    bottom: Option<f64>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering::SeqCst;
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    // Minimize reports a 0×0 client. Applying that here resizes the parent.
    if window.is_minimized().unwrap_or(false) {
        return Ok(());
    }
    if let Ok(size) = window.inner_size() {
        if !resize_is_a_real_frame(size.width, size.height) {
            return Ok(());
        }
    }
    remember_store_insets(x, y, bottom.unwrap_or(0.0));
    let palette_open = STORE_PALETTE_OPEN.load(SeqCst);
    // Palette-open resizes must not hide or show. Parking here races the
    // single restore and flashes the child closed, then open again.
    if !store_child_on_screen(STORE_VISIBLE.load(SeqCst), palette_open) {
        return Ok(());
    }
    let _ = move_store_bounds(&window, x, y, width.max(100.0), height.max(100.0));
    Ok(())
}

/// Hides the embedded store view (its state is preserved).
/// The child is moved off-screen at its current size and hidden, so a later
/// restore does not animate the main window up from a 1×1 frame.
#[tauri::command]
pub fn hide_store_view(app: AppHandle) -> Result<String, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    STORE_EPOCH.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    STORE_VISIBLE.store(false, std::sync::atomic::Ordering::SeqCst);
    park_store_offscreen(&window)?;
    Ok("gizlendi".into())
}

/// Parks the store child webview while the command palette is open, then puts
/// it back when the palette closes. `restore` is false when the user has left
/// the store (or another launcher surface is covering it) before the hold ends.
#[tauri::command]
pub fn set_store_palette_hold(
    app: AppHandle,
    hold: bool,
    restore: bool,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    bottom: Option<f64>,
) -> Result<(), String> {
    use std::sync::atomic::Ordering::SeqCst;
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    match store_hold_effect(
        STORE_PALETTE_OPEN.load(SeqCst),
        STORE_VISIBLE.load(SeqCst),
        hold,
        restore,
    ) {
        StoreHoldEffect::Ignore => Ok(()),
        StoreHoldEffect::Park => {
            STORE_PALETTE_OPEN.store(true, SeqCst);
            let _ = park_store_offscreen(&window);
            Ok(())
        }
        StoreHoldEffect::ReleaseHidden => {
            STORE_PALETTE_OPEN.store(false, SeqCst);
            Ok(())
        }
        StoreHoldEffect::Show => {
            STORE_PALETTE_OPEN.store(false, SeqCst);
            remember_store_insets(x, y, bottom.unwrap_or(0.0));
            show_store_bounds(&window, x, y, width, height)?;
            // A hide that landed while we were showing wins; do not show again.
            if STORE_PALETTE_OPEN.load(SeqCst) || !STORE_VISIBLE.load(SeqCst) {
                let _ = park_store_offscreen(&window);
            }
            Ok(())
        }
    }
}

/// Destroys the embedded store webview to release its renderer process memory
/// (a hidden WebView2 keeps a full Chromium renderer alive). It is recreated on
/// demand the next time the store is opened.
#[tauri::command]
pub fn destroy_store_view(app: AppHandle) -> Result<String, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    STORE_VISIBLE.store(false, std::sync::atomic::Ordering::Relaxed);
    if let Ok(mut active) = ACTIVE_STORE_LABEL.lock() {
        active.clear();
    }
    // Nothing is alive any more, so nothing is warm or waiting for a first paint.
    if let Ok(mut order) = STORE_WARM_ORDER.lock() {
        order.clear();
    }
    for v in store_views(&window) {
        let _ = v.close();
    }
    Ok("@t:store.closed".into())
}

/// A minimize reports a 0×0 or 1×1 client size. Applying that to the store child
/// makes the restored window pop from a dot to the full frame.
pub(crate) fn resize_is_a_real_frame(width: u32, height: u32) -> bool {
    width >= 160 && height >= 160
}

/// Keeps the store child inside the content area when the main window resizes.
pub fn on_main_window_resized(window: &tauri::Window, physical_size: tauri::PhysicalSize<u32>) {
    use std::sync::atomic::Ordering::{Relaxed, SeqCst};
    if window.is_minimized().unwrap_or(false)
        || !resize_is_a_real_frame(physical_size.width, physical_size.height)
    {
        return;
    }
    let palette_open = STORE_PALETTE_OPEN.load(SeqCst);
    let store_visible = STORE_VISIBLE.load(SeqCst);
    let Ok(scale_factor) = window.scale_factor() else {
        return;
    };
    let logical_size = physical_size.to_logical::<f64>(scale_factor);
    // `None` (palette open, or store hidden): leave the child where the hold
    // parked it. Parking again would hide a restore that just showed it.
    if let Some((x, y, w, h)) = store_resize_bounds(
        store_visible,
        palette_open,
        logical_size.width,
        logical_size.height,
        f64::from_bits(STORE_INSET_LEFT.load(Relaxed)),
        f64::from_bits(STORE_INSET_TOP.load(Relaxed)),
        f64::from_bits(STORE_INSET_BOTTOM.load(Relaxed)),
    ) {
        let _ = move_store_bounds(window, x, y, w, h);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        resize_is_a_real_frame, store_bounds, store_hold_effect, store_resize_bounds,
        StoreHoldEffect,
    };

    #[test]
    fn store_bounds_fill_content_area_between_header_and_status_bar() {
        assert_eq!(
            store_bounds(1600.0, 900.0, 225.0, 86.0, 24.0),
            (225.0, 86.0, 1375.0, 790.0)
        );
    }

    #[test]
    fn a_minimize_size_does_not_move_the_store() {
        assert!(!resize_is_a_real_frame(0, 0));
        assert!(!resize_is_a_real_frame(1, 1));
        assert!(resize_is_a_real_frame(1280, 800));
    }

    #[test]
    fn store_bounds_clamp_to_minimum_size_and_non_negative_insets() {
        assert_eq!(
            store_bounds(200.0, 120.0, 232.0, 36.0, 24.0),
            (232.0, 36.0, 100.0, 100.0)
        );
        assert_eq!(
            store_bounds(800.0, 600.0, -5.0, -1.0, -3.0),
            (0.0, 0.0, 800.0, 600.0)
        );
    }

    #[test]
    fn store_stays_offscreen_while_palette_open_including_resize() {
        // Store page is current, but the command palette is open.
        assert_eq!(
            store_resize_bounds(true, true, 1600.0, 900.0, 225.0, 36.0, 0.0),
            None
        );
        // Same window after the palette closes: the content area is restored.
        assert_eq!(
            store_resize_bounds(true, false, 1600.0, 900.0, 225.0, 36.0, 0.0),
            Some((225.0, 36.0, 1375.0, 864.0))
        );
        // Left the store entirely: a resize still must not bring the webview back.
        assert_eq!(
            store_resize_bounds(false, false, 1600.0, 900.0, 225.0, 36.0, 0.0),
            None
        );
        assert_eq!(
            store_resize_bounds(false, true, 1600.0, 900.0, 225.0, 36.0, 0.0),
            None
        );

        // One close shows once. A second release in the same turn does nothing.
        assert_eq!(
            store_hold_effect(true, true, false, true),
            StoreHoldEffect::Show
        );
        assert_eq!(
            store_hold_effect(false, true, false, true),
            StoreHoldEffect::Ignore
        );
        assert_eq!(
            store_hold_effect(true, true, true, false),
            StoreHoldEffect::Ignore
        );
        assert_eq!(
            store_hold_effect(false, true, true, false),
            StoreHoldEffect::Park
        );
        // Left the store while the palette was open: clear the hold, stay hidden.
        assert_eq!(
            store_hold_effect(true, false, false, true),
            StoreHoldEffect::ReleaseHidden
        );
        assert_eq!(
            store_hold_effect(true, true, false, false),
            StoreHoldEffect::ReleaseHidden
        );
    }

    #[test]
    fn storefronts_are_recognised_from_their_url() {
        assert_eq!(
            super::store_id_for_url("https://store.epicgames.com/p/x"),
            "epic"
        );
        assert_eq!(
            super::store_id_for_url("https://www.gog.com/en/game/x"),
            "gog"
        );
        assert_eq!(
            super::store_id_for_url("https://store.steampowered.com/app/620"),
            "steam"
        );
        assert_eq!(
            super::store_id_for_url("https://store.ubisoft.com/tr/home"),
            "ubisoft"
        );
        // The storefront's own host: "store.ubi.com" has no "ubisoft.com" in it.
        assert_eq!(
            super::store_id_for_url("https://store.ubi.com/"),
            "ubisoft"
        );
        assert_eq!(super::store_id_for_url("https://www.ea.com/games"), "ea");
        assert_eq!(
            super::store_id_for_url("https://www.xbox.com/games/browse"),
            "xbox"
        );
        assert_eq!(
            super::store_id_for_url("https://shop.battle.net/"),
            "battlenet"
        );
        assert_eq!(
            super::store_id_for_url("https://luna.amazon.com/claims/home"),
            "luna"
        );
        assert_eq!(
            super::store_id_for_url("https://www.riotgames.com/en/play"),
            "riot"
        );
        // Case does not matter, and unknown hosts fall back to the Epic storefront.
        assert_eq!(
            super::store_id_for_url("HTTPS://STORE.STEAMPOWERED.COM/app/620"),
            "steam"
        );
        assert_eq!(super::store_id_for_url("https://example.com/"), "epic");
    }

    #[test]
    fn storefront_labels_carry_the_id_back() {
        assert_eq!(super::store_id_for_label("store-view-ubisoft"), "ubisoft");
        // A legacy label keeps working instead of losing its id.
        assert_eq!(
            super::store_id_for_label("epic-store-view"),
            "epic-store-view"
        );
    }

    #[test]
    fn sign_in_pages_are_recognised() {
        let overlay = url::Url::parse("https://connect.cdn.ubisoft.com/overlay/default/?env=prod").unwrap();
        let account = url::Url::parse("https://account.battle.net/games").unwrap();
        let store = url::Url::parse("https://store.ubisoft.com/tr/home").unwrap();
        assert!(super::is_login_page(&overlay));
        assert!(super::is_login_page(&account));
        assert!(!super::is_login_page(&store));
    }

    #[test]
    fn ubisoft_sign_in_popups_are_recognised() {
        // The storefront's LOG IN popup, and the overlay page the launcher uses.
        let webauth = url::Url::parse("https://connect.ubisoft.com/v2/webauth?spaceId=x").unwrap();
        let overlay = url::Url::parse("https://connect.cdn.ubisoft.com/overlay/default/?env=prod").unwrap();
        assert!(super::is_ubisoft_auth_url(&webauth));
        assert!(super::is_ubisoft_auth_url(&overlay));
        // Store and help pages are not sign-in URLs.
        let store = url::Url::parse("https://store.ubisoft.com/us/home").unwrap();
        let help = url::Url::parse("https://www.ubisoft.com/help").unwrap();
        assert!(!super::is_ubisoft_auth_url(&store));
        assert!(!super::is_ubisoft_auth_url(&help));
        // Another store's account page is not this flow.
        let bnet = url::Url::parse("https://account.battle.net/login").unwrap();
        assert!(!super::is_ubisoft_auth_url(&bnet));
    }

    #[test]
    fn only_the_most_recent_storefronts_stay_warm() {
        let reset = |order: Vec<&str>| {
            if let Ok(mut warm) = super::STORE_WARM_ORDER.lock() {
                *warm = order.into_iter().map(str::to_string).collect();
            }
        };
        // The test follows the budget constant instead of hard-coding it: the
        // window stays responsive by keeping very few storefronts alive.
        let labels = [
            "store-view-epic",
            "store-view-gog",
            "store-view-steam",
            "store-view-ubisoft",
        ];
        reset(labels[..super::MAX_WARM_STORES].to_vec());
        assert!(
            super::prune_store_views().is_empty(),
            "the warm budget fits"
        );

        // One more closes the oldest one (the tail of the list).
        let newest = labels[super::MAX_WARM_STORES];
        super::touch_store_warm(newest);
        assert_eq!(
            super::prune_store_views(),
            vec![super::store_id_for_label(labels[super::MAX_WARM_STORES - 1])]
        );
        let order = super::STORE_WARM_ORDER
            .lock()
            .map(|o| o.clone())
            .unwrap_or_default();
        assert_eq!(order.first().map(String::as_str), Some(newest));

        // Revisiting moves a storefront to the front instead of duplicating it.
        super::touch_store_warm("store-view-gog");
        let order = super::STORE_WARM_ORDER
            .lock()
            .map(|o| o.clone())
            .unwrap_or_default();
        assert_eq!(order.first().map(String::as_str), Some("store-view-gog"));
        assert_eq!(
            order
                .iter()
                .filter(|entry| entry.as_str() == "store-view-gog")
                .count(),
            1
        );
        reset(Vec::new());
    }

    #[test]
    fn snapshot_stamp_follows_the_library_snapshot() {
        let dir = std::env::temp_dir().join("efxlve_store_stamp_test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        // No snapshot yet: the stamp stays zero so the first build always happens.
        assert_eq!(super::snapshot_stamp(&dir), (0, 0));

        let path = dir.join("efxlve_library_snapshot.json");
        std::fs::write(&path, b"[]").expect("write snapshot");
        let (_, size) = super::snapshot_stamp(&dir);
        assert_eq!(size, 2);

        // A rewrite with more games changes the stamp, so the payload is rebuilt.
        std::fs::write(&path, b"[{\"app_name\":\"x\"}]").expect("rewrite snapshot");
        let (_, size) = super::snapshot_stamp(&dir);
        assert_eq!(size, 18);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
