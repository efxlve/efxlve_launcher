//! Embedded store child webviews.
//!
//! Store pages send `X-Frame-Options`, so each storefront is a native WebView2
//! child of the main window. Never pass `additional_browser_args` to
//! `WebviewBuilder`; that flag silently breaks child webview rendering.

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
    } else if url.contains("ubisoft.com") {
        "ubisoft"
    } else if url.contains("ea.com") {
        "ea"
    } else if url.contains("xbox.com") || url.contains("microsoft.com") {
        "xbox"
    } else if url.contains("battle.net") {
        "battlenet"
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

/// How many storefronts may stay alive at once. Each one is a renderer process
/// (measured at roughly 60-260 MB working set), so the least recently used
/// storefronts are closed instead of holding all of them in RAM.
const MAX_WARM_STORES: usize = 3;

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
    Ok(())
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
    let rect = webview_rect(X, Y, 1.0, 1.0);
    for v in &views {
        v.set_bounds(rect).map_err(|e| e.to_string())?;
    }
    for v in &views {
        v.hide().map_err(|e| e.to_string())?;
    }
    remember_applied_bounds(X, Y, 1.0, 1.0);
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

const STORE_EXTENSION_SCRIPT: &str = r#"
(function() {
    'use strict';
    document.addEventListener('contextmenu', function(e) { e.preventDefault(); }, true);

    // 1. Text normalization (perfectly cleans Turkish 'İ', 'ı', accents and whitespace)
    function normalizeText(str) {
        return (str || '')
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .trim();
    }

    // SVG icons (ABSOLUTELY NO EMOJI - fully clean inline SVG, flex-aligned without shifting)
    // Library icon: identical to the library icon in the title bar (LayoutGrid / 4 squares)
    var SVG_GRID = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>';
    var SVG_GAMEPAD = SVG_GRID;
    var SVG_PLAY = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>';
    var SVG_STAR = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" fill="currentColor"/></svg>';
    var SVG_LAUNCH = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" style="display:block;flex-shrink:0;"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
    var SVG_SHIELD_GRID = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto;"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>';
    var SVG_SHIELD_GAMEPAD = SVG_SHIELD_GRID;
    var SVG_SHIELD_PLAY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="display:block;margin:0 auto;"><circle cx="12" cy="12" r="10"/><polygon points="10 8 16 12 10 16 10 8" fill="currentColor"/></svg>';

    // 2. Anti-flash, price-area label, PDP button and download-button hiding CSS
    var CSS_TEXT = `
        html, body {
            background-color: #07080d !important;
            color-scheme: dark !important;
        }

        /* Anti-FOUC overlay: holds the page in obsidian until the first paint is ready,
           then fades out smoothly. White flashes/flicker are prevented. */
        #efxlve-store-veil {
            position: fixed !important;
            inset: 0 !important;
            z-index: 2147483647 !important;
            background: #07080d !important;
            pointer-events: none !important;
            opacity: 1 !important;
            transition: opacity 0.22s ease !important;
        }
        #efxlve-store-veil.gone { opacity: 0 !important; }

        /* Fully disable badges on top of images (the user does not want them on images) */
        .efxlve-store-badge {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }

        /* Epic Games Launcher indirme butonunu kesin gizle */
        header a[href*="download" i],
        nav a[href*="download" i],
        a[href*="/download" i],
        a[href*="launcher" i][href*="download" i],
        [data-testid*="download" i],
        [data-component*="Download" i],
        [aria-label*="indir" i],
        [aria-label*="download" i],
        [title*="indir" i],
        [title*="download" i],
        .epic-nav-download,
        #eg-download-btn,
        [class*="downloadButton" i],
        [class*="download-btn" i],
        [class*="downloadLink" i],
        [class*="download_btn" i] {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            width: 0 !important;
            height: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
        }

        /* Library indicator in the price area (NOT on top of the game image!) */
        .efxlve-price-tag {
            display: inline-flex !important;
            align-items: center !important;
            gap: 6px !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            font-size: 12.5px !important;
            font-weight: 700 !important;
            line-height: 1 !important;
            letter-spacing: 0.015em !important;
            white-space: nowrap !important;
            padding: 4px 10px 4px 8px !important;
            border-radius: 6px !important;
            backdrop-filter: blur(8px) !important;
            box-sizing: border-box !important;
            transition: all 0.15s ease !important;
        }
        .efxlve-price-tag.owned {
            background: rgba(0, 116, 228, 0.16) !important;
            border: 1px solid rgba(38, 187, 255, 0.45) !important;
            color: #26bbff !important;
            box-shadow: none !important;
        }
        .efxlve-price-tag.installed {
            background: rgba(99, 102, 241, 0.14) !important;
            border: 1px solid rgba(99, 102, 241, 0.35) !important;
            color: #a5b4fc !important;
            box-shadow: 0 2px 10px rgba(99, 102, 241, 0.18) !important;
        }
        .efxlve-price-tag.wishlist {
            background: rgba(251, 191, 36, 0.12) !important;
            border: 1px solid rgba(251, 191, 36, 0.3) !important;
            color: #fde68a !important;
            box-shadow: 0 2px 10px rgba(251, 191, 36, 0.16) !important;
        }

        /* Detail page Efxlve card */
        .efxlve-pdp-card {
            position: relative !important;
            margin: 14px 0 18px 0 !important;
            padding: 14px 16px !important;
            border-radius: 12px !important;
            background: linear-gradient(145deg, rgba(22, 17, 34, 0.96), rgba(12, 11, 22, 0.98)) !important;
            border: 1px solid rgba(168, 85, 247, 0.35) !important;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.08) !important;
            overflow: hidden !important;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
            backdrop-filter: blur(12px) !important;
        }
        .efxlve-pdp-card.installed {
            border-color: rgba(99, 102, 241, 0.45) !important;
            background: linear-gradient(145deg, rgba(17, 19, 36, 0.96), rgba(11, 12, 24, 0.98)) !important;
        }
        .efxlve-pdp-card-glow {
            position: absolute !important;
            top: -30px !important;
            right: -30px !important;
            width: 110px !important;
            height: 110px !important;
            border-radius: 50% !important;
            background: radial-gradient(circle, rgba(168, 85, 247, 0.28), transparent 70%) !important;
            pointer-events: none !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-card-glow {
            background: radial-gradient(circle, rgba(99, 102, 241, 0.28), transparent 70%) !important;
        }
        .efxlve-pdp-header {
            display: flex !important;
            align-items: center !important;
            gap: 12px !important;
            margin-bottom: 12px !important;
        }
        .efxlve-pdp-icon-shield {
            width: 36px !important;
            height: 36px !important;
            border-radius: 10px !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            background: rgba(168, 85, 247, 0.14) !important;
            border: 1px solid rgba(168, 85, 247, 0.35) !important;
            color: #c084fc !important;
            flex-shrink: 0 !important;
            box-shadow: 0 2px 10px rgba(168, 85, 247, 0.18) !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-icon-shield {
            background: rgba(99, 102, 241, 0.14) !important;
            border-color: rgba(99, 102, 241, 0.35) !important;
            color: #a5b4fc !important;
            box-shadow: 0 2px 10px rgba(99, 102, 241, 0.18) !important;
        }
        .efxlve-pdp-titles {
            display: flex !important;
            flex-direction: column !important;
            gap: 3px !important;
        }
        .efxlve-pdp-tag {
            display: inline-flex !important;
            align-items: center !important;
            gap: 5px !important;
            font-size: 10px !important;
            font-weight: 800 !important;
            letter-spacing: 0.08em !important;
            color: #c084fc !important;
            text-transform: uppercase !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-tag {
            color: #a5b4fc !important;
        }
        .efxlve-pdp-dot {
            width: 6px !important;
            height: 6px !important;
            border-radius: 50% !important;
            background: #a855f7 !important;
            box-shadow: 0 0 6px #a855f7 !important;
            display: inline-block !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-dot {
            background: #6366f1 !important;
            box-shadow: 0 0 6px #6366f1 !important;
        }
        .efxlve-pdp-headline {
            font-size: 13.5px !important;
            font-weight: 700 !important;
            color: #f8fafc !important;
            line-height: 1.25 !important;
        }
        .efxlve-pdp-cta-button {
            width: 100% !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            gap: 8px !important;
            padding: 10px 16px !important;
            border-radius: 8px !important;
            font-size: 13px !important;
            font-weight: 700 !important;
            letter-spacing: 0.02em !important;
            cursor: pointer !important;
            transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
            border: 1px solid rgba(255, 255, 255, 0.16) !important;
            background: linear-gradient(135deg, #7c3aed, #a855f7) !important;
            color: #ffffff !important;
            box-shadow: 0 4px 16px rgba(124, 58, 237, 0.38) !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-cta-button {
            background: linear-gradient(135deg, #4f46e5, #6366f1) !important;
            box-shadow: 0 4px 16px rgba(99, 102, 241, 0.38) !important;
        }
        .efxlve-pdp-cta-button:hover {
            transform: translateY(-1.5px) !important;
            filter: brightness(1.1) !important;
            box-shadow: 0 6px 22px rgba(124, 58, 237, 0.55) !important;
        }
        .efxlve-pdp-card.installed .efxlve-pdp-cta-button:hover {
            box-shadow: 0 6px 22px rgba(99, 102, 241, 0.55) !important;
        }
        .efxlve-pdp-cta-button:active {
            transform: translateY(0) !important;
            filter: brightness(0.95) !important;
        }
        .efxlve-pdp-btn-chevron {
            margin-left: auto !important;
            opacity: 0.8 !important;
            transition: transform 0.15s ease !important;
        }
        .efxlve-pdp-cta-button:hover .efxlve-pdp-btn-chevron {
            transform: translateX(2px) !important;
            opacity: 1 !important;
        }
    `;

    function injectStyle(targetRoot) {
        try {
            var root = targetRoot || document.head || document.documentElement;
            if (!root) return false;
            if (root.querySelector && root.querySelector('#efxlve-store-style')) return true;
            var s = document.createElement('style');
            s.id = 'efxlve-store-style';
            s.textContent = CSS_TEXT;
            root.appendChild(s);
            return true;
        } catch(e) {
            return false;
        }
    }
    injectStyle();

    // 2b. Install the anti-FOUC overlay as early as possible, remove it smoothly on first paint.
    function installVeil() {
        try {
            if (document.getElementById('efxlve-store-veil')) return;
            var veil = document.createElement('div');
            veil.id = 'efxlve-store-veil';
            (document.body || document.documentElement).appendChild(veil);
            var revealed = false;
            function reveal() {
                if (revealed) return;
                revealed = true;
                var el = document.getElementById('efxlve-store-veil');
                if (!el) return;
                el.classList.add('gone');
                setTimeout(function() { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
            }
            if (document.readyState === 'complete') {
                requestAnimationFrame(reveal);
            } else {
                window.addEventListener('load', function() { requestAnimationFrame(reveal); }, { once: true });
            }
            // Safety net: even on a very slow network the overlay never stays permanently.
            setTimeout(reveal, 2500);
        } catch(e) {}
    }
    installVeil();

    // 3. Function that definitively hides the "Download" button at the top right
    function hideDownloadButton() {
        try {
            function scanTree(root) {
                if (!root) return;
                var sel = [
                    'header a[href*="download" i]',
                    'nav a[href*="download" i]',
                    'a[href*="/download" i]',
                    'a[href*="launcher" i][href*="download" i]',
                    '[data-testid*="download" i]',
                    '[data-component*="Download" i]',
                    '[aria-label*="indir" i]',
                    '[aria-label*="download" i]',
                    '[title*="indir" i]',
                    '[title*="download" i]',
                    '.epic-nav-download',
                    '#eg-download-btn',
                    '[class*="downloadButton" i]',
                    '[class*="download-btn" i]',
                    '[class*="downloadLink" i]',
                    '[class*="download_btn" i]'
                ].join(',');
                var elements = root.querySelectorAll(sel);
                for (var i = 0; i < elements.length; i++) {
                    var el = elements[i];
                    el.style.setProperty('display', 'none', 'important');
                    el.style.setProperty('visibility', 'hidden', 'important');
                    el.style.setProperty('pointer-events', 'none', 'important');
                    if (el.parentElement && (el.parentElement.tagName === 'LI' || el.parentElement.tagName === 'DIV')) {
                        el.parentElement.style.setProperty('display', 'none', 'important');
                    }
                }

                var candidates = root.querySelectorAll('header a, nav a, a, button, div[role="button"]');
                for (var j = 0; j < candidates.length; j++) {
                    var c = candidates[j];
                    var norm = normalizeText(c.textContent);
                    var href = (c.getAttribute('href') || '').toLowerCase();
                    var isDl = (
                        norm === 'indir' ||
                        norm === 'download' ||
                        norm === 'get epic games' ||
                        norm === 'telecharger' ||
                        norm === 'herunterladen' ||
                        norm === 'descargar' ||
                        norm === 'scarica' ||
                        norm === 'baixe o epic games' ||
                        norm.indexOf('epic games\'i indir') !== -1 ||
                        norm.indexOf('epic games\'i indirin') !== -1 ||
                        norm.indexOf('epic games indir') !== -1 ||
                        href.indexOf('download') !== -1 ||
                        href.indexOf('installer') !== -1
                    );
                    if (isDl) {
                        c.style.setProperty('display', 'none', 'important');
                        c.style.setProperty('visibility', 'hidden', 'important');
                        c.style.setProperty('pointer-events', 'none', 'important');
                        if (c.parentElement && (c.parentElement.tagName === 'LI' || c.parentElement.tagName === 'DIV')) {
                            c.parentElement.style.setProperty('display', 'none', 'important');
                        }
                    }
                }

                var allNodes = root.querySelectorAll('*');
                for (var k = 0; k < allNodes.length; k++) {
                    if (allNodes[k].shadowRoot) {
                        injectStyle(allNodes[k].shadowRoot);
                        scanTree(allNodes[k].shadowRoot);
                    }
                }
            }

            scanTree(document);
        } catch(e) {}
    }

    var dlCheckCount = 0;
    var dlCheckTimer = setInterval(function() {
        hideDownloadButton();
        dlCheckCount++;
        if (dlCheckCount > 24) clearInterval(dlCheckTimer);
    }, 250);

    // 4. Multi-language dictionary (ABSOLUTELY NO EMOJI)
    function getI18n() {
        var lang = (document.documentElement.lang || navigator.language || 'en').toLowerCase();
        var dict;
        if (lang.indexOf('tr') === 0) {
            dict = {
                owned: 'Kütüphanede',
                installed: 'Yüklü',
                wishlist: 'İstek Listesinde',
                pdpOwned: 'Bu oyun Efxlve kütüphanenizde var',
                pdpInstalled: 'Bu oyun sisteminizde kurulu',
                ctaOpen: 'Kütüphanede Aç',
                ctaLaunch: 'Kütüphaneden Başlat'
            };
        } else if (lang.indexOf('de') === 0) {
            dict = {
                owned: 'In Bibliothek',
                installed: 'Installiert',
                wishlist: 'Wunschliste',
                pdpOwned: 'Dieses Spiel ist in deiner Efxlve-Bibliothek',
                pdpInstalled: 'Dieses Spiel ist installiert',
                ctaOpen: 'In Bibliothek öffnen',
                ctaLaunch: 'Aus Bibliothek starten'
            };
        } else {
            dict = {
                owned: 'In Library',
                installed: 'Installed',
                wishlist: 'In Wishlist',
                pdpOwned: 'You already own this game in your Efxlve Library',
                pdpInstalled: 'This game is installed on this PC',
                ctaOpen: 'Open in Library',
                ctaLaunch: 'Launch from Library'
            };
        }
        if (window.__EFXLVE_OWNED_LABEL) dict.owned = window.__EFXLVE_OWNED_LABEL;
        return dict;
    }

    // Function that strips editions and suffixes (GTA V Premium Edition -> GTA 5, Watch Dogs 2 Standard Edition -> Watch Dogs 2)
    function stripEdition(title) {
        if (!title) return '';
        var s = normalizeText(title);
        // Remove edition / version phrases after a colon or dash
        s = s.replace(/\benhanced edition\b/gi, '');
        s = s.replace(/[:\-â€“â€”]\s*(standard|deluxe|gold|premium|definitive|ultimate|special|complete|anniversary|director'?s cut|remastered|goty|game of the year).*/i, '');
        
        // Remove edition words
        s = s.replace(/\b(standard|deluxe|gold|premium|definitive|ultimate|special|complete|anniversary|goty|game of the year)\s*(edition|surum|sürüm)?\b/gi, '');
        s = s.replace(/\b(director'?s cut|remastered|base game|ana oyun|temel oyun|edition|sürüm|surum)\b/gi, '');

        // Common game abbreviations (GTA V / GTA 5)
        s = s.replace(/\bgrand theft auto\b/gi, 'gta');
        s = s.replace(/\bgta\s*v\b/gi, 'gta 5');

        return s.replace(/[^a-z0-9]+/g, ' ').trim();
    }

    // Function that strips edition suffixes from URL slugs
    function stripSlugEdition(slug) {
        if (!slug) return '';
        var s = slug.toLowerCase();
        s = s.replace(/-(standard|deluxe|gold|premium|definitive|ultimate|special|complete|anniversary|collectors|goty|game-of-the-year)(-(edition|surum|paketi))?$/i, '');
        s = s.replace(/-enhanced-edition$/i, '');
        s = s.replace(/-(directors-cut|director-s-cut|remastered|remaster)$/i, '');
        s = s.replace(/-(edition|bundle|base-game)$/i, '');
        return s;
    }

    // 5. Slug and title map
    var slugMap = {};
    var strippedSlugMap = {};
    var titleMap = {};
    var strippedTitleMap = {};
    var ownedGamesList = [];
    if (window.__EFXLVE_GAMES && Array.isArray(window.__EFXLVE_GAMES)) {
        ownedGamesList = window.__EFXLVE_GAMES;
        for (var i = 0; i < window.__EFXLVE_GAMES.length; i++) {
            var item = window.__EFXLVE_GAMES[i];
            if (item) {
                if (item.s) {
                    slugMap[item.s] = item;
                    var strippedS = stripSlugEdition(item.s);
                    if (strippedS) strippedSlugMap[strippedS] = item;
                }
                if (item.t) {
                    var normT = normalizeText(item.t);
                    titleMap[normT] = item;
                    var cleanT = normT.replace(/[^a-z0-9]+/g, '');
                    if (cleanT) titleMap[cleanT] = item;
                    var tSlug = normT.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
                    if (tSlug) slugMap[tSlug] = item;

                    var st = stripEdition(item.t);
                    if (st) strippedTitleMap[st] = item;
                }
            }
        }
    }

    // Safe and exact game matching (prevents collisions between sequels/spinoffs)
    function matchGame(card, href) {
        var slug = '';
        if (href) {
            var m = href.match(/\/p\/([a-z0-9-]+)/i) || href.match(/\/bundles\/([a-z0-9-]+)/i);
            if (m && m[1]) slug = m[1].toLowerCase();
        }

        // 1. Direct and edition-stripped slug match
        if (slug) {
            if (slugMap[slug]) return slugMap[slug];
            var strippedSlug = stripSlugEdition(slug);
            if (strippedSlug && strippedSlugMap[strippedSlug]) {
                return strippedSlugMap[strippedSlug];
            }
        }

        // 2. Card title detection
        var titleEl = card.querySelector('[data-testid*="title" i], [class*="title" i], [class*="Title" i], h1, h2, h3, h4');
        var rawTitle = titleEl ? (titleEl.textContent || '').trim() : '';
        if (!rawTitle && (card === document || card === document.body)) {
            var docH1 = document.querySelector('h1');
            if (docH1) rawTitle = (docH1.textContent || '').trim();
            if (!rawTitle && document.title) {
                rawTitle = document.title.split('|')[0].split(' - ')[0].trim();
            }
        }
        if (!rawTitle) {
            var spans = card.querySelectorAll('span, div, p');
            for (var s = 0; s < spans.length; s++) {
                var txt = (spans[s].textContent || '').trim();
                if (txt.length >= 3 && txt.length <= 60 && !txt.startsWith('â‚º') && !txt.startsWith('$') && !txt.startsWith('â‚¬') && txt !== 'Ana Oyun' && txt !== 'Eklenti' && txt !== 'Temel Oyun') {
                    if (titleMap[normalizeText(txt)]) {
                        rawTitle = txt;
                        break;
                    }
                }
            }
        }

        // 3. Title match (exact and edition-stripped)
        if (rawTitle) {
            var norm = normalizeText(rawTitle);
            if (titleMap[norm]) return titleMap[norm];

            var clean = norm.replace(/[^a-z0-9]+/g, '');
            if (clean && titleMap[clean]) return titleMap[clean];

            var titleSlug = norm.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
            if (titleSlug && slugMap[titleSlug]) return slugMap[titleSlug];

            // Exact edition-stripped match (e.g. GTA V Premium Edition -> GTA 5, Watch Dogs 2 Standard Edition -> Watch Dogs 2)
            var strippedCardTitle = stripEdition(rawTitle);
            if (strippedCardTitle && strippedTitleMap[strippedCardTitle]) {
                return strippedTitleMap[strippedCardTitle];
            }
        }

        return null;
    }

    function isCardRoot(el) {
        if (!el || el === document.body) return true;
        if (el.tagName === 'A' || el.tagName === 'ARTICLE' || el.tagName === 'LI') return true;
        var c = (el.className || '').toString();
        if (/card/i.test(c)) return true;
        if (el.getAttribute('data-component') && /card/i.test(el.getAttribute('data-component'))) return true;
        return false;
    }

    // Finds the price container inside a card (discounted or standard price row)
    function getPriceContainer(card) {
        // 1. Discounted card: if a discount badge (-95%, -50%, etc.) exists, its parent is the whole price row
        var all = card.querySelectorAll('span, div, p');
        var discountEl = null;
        for (var i = 0; i < all.length; i++) {
            var t = (all[i].textContent || '').trim();
            if (/^-\s*%?\s*\d+%?$/.test(t) || all[i].matches('[class*="discount" i], [class*="Discount" i]')) {
                discountEl = all[i];
                break;
            }
        }
        if (discountEl && discountEl.parentElement && !isCardRoot(discountEl.parentElement)) {
            return discountEl.parentElement;
        }

        // 2. Standard price component (data-component or class based)
        var priceEl = card.querySelector('[data-component*="Price" i], [class*="price" i], [class*="Price" i], [data-testid*="price" i]');
        if (priceEl) {
            if (priceEl.parentElement && !isCardRoot(priceEl.parentElement) && priceEl.parentElement.querySelectorAll('span, div').length > 1) {
                return priceEl.parentElement;
            }
            return priceEl;
        }

        // 3. Detect price / free / release date from text content
        for (var j = all.length - 1; j >= 0; j--) {
            var txt = (all[j].textContent || '').trim();
            if (/^[₺$€£]|ücretsiz|ucretsiz|free|\d+[,.]\d{2}/i.test(txt)) {
                if (txt !== 'Ana Oyun' && txt !== 'Eklenti' && txt !== 'Temel Oyun' && txt !== 'Sürüm' && txt !== 'Surum') {
                    if (all[j].parentElement && !isCardRoot(all[j].parentElement) && all[j].parentElement.querySelectorAll('span, div').length > 1) {
                        return all[j].parentElement;
                    }
                    return all[j];
                }
            }
        }

        // 4. Title container fallback
        var titleEl = card.querySelector('[data-testid*="title" i], [class*="title" i], [class*="Title" i], h2, h3, h4');
        if (titleEl && titleEl.parentElement && !isCardRoot(titleEl.parentElement)) {
            return titleEl.parentElement;
        }

        return null;
    }

    // Finds the detail page purchase / library container and the action button
    function findPdpTarget() {
        var allBtns = document.querySelectorAll('button, a[role="button"], div[role="button"]');
        var actionBtn = null;
        for (var i = 0; i < allBtns.length; i++) {
            var b = allBtns[i];
            if (b.classList.contains('efxlve-pdp-cta-button')) continue;
            var btxt = normalizeText(b.textContent);
            if (
                btxt === 'kutuphanede' ||
                btxt === 'in library' ||
                btxt === 'yukle' ||
                btxt === 'indir' ||
                btxt === 'satin al' ||
                btxt === 'get' ||
                btxt.indexOf('kutuphanede') !== -1 ||
                btxt.indexOf('in library') !== -1 ||
                btxt.indexOf('satin al') !== -1
            ) {
                actionBtn = b;
                break;
            }
        }

        var box = document.querySelector('aside, [data-component*="Purchase" i], [data-component*="Sidebar" i], [class*="SideBar" i], [class*="sidebar" i], [data-testid*="purchase" i]');
        if (box) return { container: box, insertBefore: (actionBtn && actionBtn.parentElement === box ? actionBtn : box.firstChild), button: actionBtn };

        if (actionBtn) {
            var col = actionBtn.closest('aside, [class*="side" i], [class*="Side" i], section');
            if (col) return { container: col, insertBefore: col.firstChild, button: actionBtn };
            if (actionBtn.parentElement) {
                var parent = actionBtn.parentElement;
                while (parent && parent !== document.body && parent.children.length < 2) {
                    parent = parent.parentElement;
                }
                if (parent && parent !== document.body) {
                    return { container: parent, insertBefore: actionBtn.parentElement || actionBtn, button: actionBtn };
                }
                return { container: actionBtn.parentElement, insertBefore: actionBtn, button: actionBtn };
            }
        }

        var layoutCols = document.querySelectorAll('[data-component*="Layout" i] > div, [class*="Layout" i] > div');
        if (layoutCols.length >= 2) {
            var rightCol = layoutCols[layoutCols.length - 1];
            return { container: rightCol, insertBefore: rightCol.firstChild, button: actionBtn };
        }

        return null;
    }

    var isScanning = false;
    function scanAndDecorate() {
        if (isScanning) return;
        // A parked storefront is hidden: scanning its DOM only burns CPU while the
        // player is somewhere else in the launcher.
        if (document.visibilityState === 'hidden') return;
        isScanning = true;
        try {
            injectStyle();
            hideDownloadButton();
            var i18n = getI18n();

            // Fully remove old on-image badges from the DOM
            var legacyBadges = document.querySelectorAll('.efxlve-store-badge');
            for (var b = 0; b < legacyBadges.length; b++) {
                legacyBadges[b].remove();
            }

            var curPath = window.location.pathname.toLowerCase();
            var curPdpMatch = curPath.match(/\/p\/([a-z0-9-]+)/i);
            var currentPdpSlug = curPdpMatch ? curPdpMatch[1].toLowerCase() : null;

            // A. Store cards (library indicator in the price area)
            var links = document.querySelectorAll('a[href*="/p/"], a[href*="/bundles/"]');
            for (var i = 0; i < links.length; i++) {
                var link = links[i];

                if (link.closest('nav, header, [role="tablist"], [role="tab"], [data-component*="Tab"], [data-component*="Breadcrumb"], [class*="breadcrumb" i]')) {
                    continue;
                }

                var href = link.getAttribute('href') || '';
                var card = link.closest('[data-component*="Card" i], [class*="Card" i], [class*="card" i], li, article') || link;

                if (currentPdpSlug && href.toLowerCase().indexOf('/p/' + currentPdpSlug) !== -1) {
                    continue;
                }

                var match = matchGame(card, href);
                if (match) {
                    var priceContainer = getPriceContainer(card);
                    if (priceContainer) {
                        var isInstalled = !!match.i;
                        var existingTag = priceContainer.querySelector('.efxlve-price-tag');
                        var needsRender = (priceContainer.getAttribute('data-efxlve-owned') !== match.a) ||
                                          !existingTag ||
                                          (isInstalled && !existingTag.classList.contains('installed')) ||
                                          (!isInstalled && !existingTag.classList.contains('owned'));

                        if (needsRender) {
                            priceContainer.setAttribute('data-efxlve-owned', match.a);
                            priceContainer.innerHTML = '<span class="efxlve-price-tag ' + (isInstalled ? 'installed' : 'owned') + '">' +
                                (isInstalled ? SVG_PLAY : SVG_GRID) +
                                '<span>' + (isInstalled ? i18n.installed : i18n.owned) + '</span>' +
                                '</span>';
                        }

                        // On discounted cards, definitively hide old discount badges (-95%) and strikethrough prices.
                        // This walks every text node in the card, so it runs once per card DOM node: a
                        // re-rendered card arrives as a new node and is swept again, while repeated scans of
                        // the same card stay cheap.
                        if (!card.dataset || card.dataset.efxlveSwept !== '1') {
                            if (card.dataset) card.dataset.efxlveSwept = '1';
                            var leftovers = card.querySelectorAll('[class*="discount" i], [class*="Discount" i], s, del, [class*="strike" i], [class*="original" i]');
                            for (var d = 0; d < leftovers.length; d++) {
                                if (leftovers[d] !== priceContainer && !priceContainer.contains(leftovers[d])) {
                                    leftovers[d].style.setProperty('display', 'none', 'important');
                                }
                            }
                            var allDesc = card.querySelectorAll('span, div, p');
                            for (var ad = 0; ad < allDesc.length; ad++) {
                                var elDesc = allDesc[ad];
                                if (elDesc === priceContainer || priceContainer.contains(elDesc)) continue;
                                var dtxt = (elDesc.textContent || '').trim();
                                if (/^-\s*%?\s*\d+%?$/.test(dtxt)) {
                                    elDesc.style.setProperty('display', 'none', 'important');
                                } else if (/\*\s*$/.test(dtxt) && /^[₺$€£]|\d+[.,]\d{2}/.test(dtxt)) {
                                    elDesc.style.setProperty('display', 'none', 'important');
                                }
                            }
                        }
                    }
                    continue;
                } else {
                    var strayOwned = card.querySelector('[data-efxlve-owned]');
                    if (strayOwned) {
                        strayOwned.removeAttribute('data-efxlve-owned');
                        var strayTag = strayOwned.querySelector('.efxlve-price-tag');
                        if (strayTag) strayTag.remove();
                    }
                }

                // Wishlist check (added to the price area)
                var wishBtn = card.querySelector('button[aria-label*="istek" i], button[aria-label*="wishlist" i], [data-testid*="wishlist" i]');
                if (wishBtn) {
                    var aria = normalizeText(wishBtn.getAttribute('aria-label'));
                    var pressed = wishBtn.getAttribute('aria-pressed') === 'true';
                    if (pressed || aria.indexOf('kaldir') !== -1 || aria.indexOf('remove') !== -1) {
                        var priceElWish = getPriceContainer(card);
                        if (priceElWish && !priceElWish.getAttribute('data-efxlve-owned')) {
                            if (priceElWish.getAttribute('data-efxlve-wishlist') !== '1') {
                                priceElWish.setAttribute('data-efxlve-wishlist', '1');
                                priceElWish.innerHTML = '<span class="efxlve-price-tag wishlist">' +
                                    SVG_STAR +
                                    '<span>' + i18n.wishlist + '</span>' +
                                    '</span>';
                            }
                        }
                    }
                }
            }

            // B. Product Detail Page (PDP)
            if (currentPdpSlug) {
                var pageH1 = '';
                var h1El = document.querySelector('h1');
                if (h1El) pageH1 = (h1El.textContent || '').trim();
                var docTitle = document.title ? document.title.split('|')[0].split(' - ')[0].trim() : '';

                var pMatch = matchGame(document, window.location.pathname);
                if (!pMatch) pMatch = slugMap[currentPdpSlug];
                if (!pMatch) {
                    var strippedPdp = stripSlugEdition(currentPdpSlug);
                    if (strippedPdp) pMatch = strippedSlugMap[strippedPdp];
                }
                if (!pMatch && pageH1) {
                    var normH1 = normalizeText(pageH1);
                    if (titleMap[normH1]) pMatch = titleMap[normH1];
                    else if (strippedTitleMap[stripEdition(pageH1)]) pMatch = strippedTitleMap[stripEdition(pageH1)];
                }
                if (!pMatch && docTitle) {
                    var normDoc = normalizeText(docTitle);
                    if (titleMap[normDoc]) pMatch = titleMap[normDoc];
                    else if (strippedTitleMap[stripEdition(docTitle)]) pMatch = strippedTitleMap[stripEdition(docTitle)];
                }

                // Find the page's action button and purchase container
                var pdpTarget = findPdpTarget();
                var pageHasOwnedBtn = false;
                if (pdpTarget && pdpTarget.button) {
                    var btxt = normalizeText(pdpTarget.button.textContent);
                    var baria = normalizeText(pdpTarget.button.getAttribute('aria-label'));
                    if (btxt === 'kutuphanede' || btxt === 'in library' || baria.indexOf('kutuphane') !== -1 || baria.indexOf('in library') !== -1) {
                        pageHasOwnedBtn = true;
                    }
                }

                // If the Epic Store itself says "In Library" but the slug did not match, fuzzy search / safe fallback
                if (!pMatch && pageHasOwnedBtn) {
                    var targetTokens = (pageH1 || docTitle || currentPdpSlug).toLowerCase();
                    for (var og = 0; og < ownedGamesList.length; og++) {
                        var ogItem = ownedGamesList[og];
                        var ogNorm = normalizeText(ogItem.t);
                        if (ogNorm && (targetTokens.indexOf(ogNorm) !== -1 || ogNorm.indexOf(targetTokens) !== -1)) {
                            pMatch = ogItem;
                            break;
                        }
                    }
                    if (!pMatch) {
                        pMatch = {
                            a: '',
                            t: pageH1 || docTitle || currentPdpSlug,
                            s: currentPdpSlug,
                            i: false
                        };
                    }
                }

                // The custom Efxlve card on top was removed; Epic's own active blue button is used
                var strayCards = document.querySelectorAll('.efxlve-pdp-card, .efxlve-pdp-banner');
                for (var sc = 0; sc < strayCards.length; sc++) {
                    strayCards[sc].remove();
                }

                // Capture Epic's own "In Library" button, remove disabled and route to the library
                var epicButtons = document.querySelectorAll('button, a, div[role="button"]');
                for (var ebIndex = 0; ebIndex < epicButtons.length; ebIndex++) {
                    var eb = epicButtons[ebIndex];
                    var ebTxt = normalizeText(eb.textContent);
                    var ebAria = normalizeText(eb.getAttribute('aria-label'));
                    if (ebTxt === 'kutuphanede' || ebTxt === 'in library' || ebAria.indexOf('kutuphane') !== -1 || ebAria.indexOf('in library') !== -1) {
                        eb.removeAttribute('disabled');
                        eb.disabled = false;
                        eb.removeAttribute('aria-disabled');
                        eb.style.setProperty('cursor', 'pointer', 'important');
                        eb.style.setProperty('pointer-events', 'auto', 'important');
                        eb.style.setProperty('opacity', '1', 'important');
                        eb.title = getI18n().ctaOpen;
                        if (!eb.getAttribute('data-efxlve-hijacked')) {
                            eb.setAttribute('data-efxlve-hijacked', '1');
                            eb.addEventListener('click', function(ev) {
                                ev.preventDefault();
                                ev.stopPropagation();
                                ev.stopImmediatePropagation();
                                var app = (pMatch && pMatch.a) ? pMatch.a : '';
                                var slug = (pMatch && pMatch.s) ? pMatch.s : (currentPdpSlug || '');
                                var title = (pMatch && pMatch.t) ? pMatch.t : (pageH1 || docTitle || '');
                                window.location.href = 'https://efxlve.local/open-game?app=' + encodeURIComponent(app) + '&slug=' + encodeURIComponent(slug) + '&title=' + encodeURIComponent(title);
                            }, true);
                        }
                    }
                }
            } else {
                var strayPdp = document.querySelectorAll('.efxlve-pdp-card, .efxlve-pdp-banner');
                for (var sp = 0; sp < strayPdp.length; sp++) {
                    strayPdp[sp].remove();
                }
            }
        } catch(e) {
        } finally {
            isScanning = false;
        }
    }

    var debounceTimer = null;
    function scheduleScan() {
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(scanAndDecorate, 350);
    }

    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        scheduleScan();
    } else {
        document.addEventListener('DOMContentLoaded', scheduleScan);
        window.addEventListener('load', scheduleScan);
    }

    window.addEventListener('popstate', scheduleScan);
    try {
        var origPush = history.pushState;
        if (origPush) {
            history.pushState = function() {
                var ret = origPush.apply(this, arguments);
                scheduleScan();
                return ret;
            };
        }
        var origRepl = history.replaceState;
        if (origRepl) {
            history.replaceState = function() {
                var ret = origRepl.apply(this, arguments);
                scheduleScan();
                return ret;
            };
        }
    } catch(e) {}

    // Slow safety net for storefronts that swap content without adding nodes; it
    // is skipped while the store is parked (hidden), so an idle launcher does no
    // work at all, and a storefront coming back on screen rescans immediately.
    setInterval(function() {
        if (document.visibilityState === 'visible') scanAndDecorate();
    }, 3000);

    document.addEventListener('visibilitychange', function() {
        if (document.visibilityState === 'visible') scheduleScan();
    });

    try {
        var obs = new MutationObserver(function(mutations) {
            for (var i = 0; i < mutations.length; i++) {
                if (mutations[i].addedNodes && mutations[i].addedNodes.length > 0) {
                    scheduleScan();
                    break;
                }
            }
        });
        var startObserver = function() {
            if (document.body) {
                obs.observe(document.body, { childList: true, subtree: true });
            } else {
                setTimeout(startObserver, 150);
            }
        };
        startObserver();
    } catch(e) {}
})();
"#;

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
                    if cur.as_str() != target.as_str()
                        && !target.as_str().ends_with(".com/")
                        && !target.as_str().ends_with(".com/en")
                        && !target.as_str().ends_with(".com")
                    {
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
    let mut builder = WebviewBuilder::new(target_label.clone(), WebviewUrl::External(parsed))
        // Native WebView2 background is pure obsidian: white flashes (FOUC) during page transitions are prevented.
        .background_color(tauri::webview::Color(14, 15, 18, 255))
        .on_page_load(move |webview, payload| {
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
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
        });
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
/// Guaranteed hiding: in addition to `hide()` the native window is moved off-screen
/// and shrunk to 1x1, so that even with async IPC latency no pixel residue or
/// overlap can remain on screen.
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

/// Keeps the store child inside the content area when the main window resizes.
pub fn on_main_window_resized(window: &tauri::Window, physical_size: tauri::PhysicalSize<u32>) {
    use std::sync::atomic::Ordering::{Relaxed, SeqCst};
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
    use super::{store_bounds, store_hold_effect, store_resize_bounds, StoreHoldEffect};

    #[test]
    fn store_bounds_fill_content_area_between_header_and_status_bar() {
        assert_eq!(
            store_bounds(1600.0, 900.0, 225.0, 86.0, 24.0),
            (225.0, 86.0, 1375.0, 790.0)
        );
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
        assert_eq!(super::store_id_for_url("https://www.ea.com/games"), "ea");
        assert_eq!(
            super::store_id_for_url("https://www.xbox.com/games/browse"),
            "xbox"
        );
        assert_eq!(
            super::store_id_for_url("https://shop.battle.net/"),
            "battlenet"
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
    fn only_the_most_recent_storefronts_stay_warm() {
        let reset = |order: Vec<&str>| {
            if let Ok(mut warm) = super::STORE_WARM_ORDER.lock() {
                *warm = order.into_iter().map(str::to_string).collect();
            }
        };
        reset(vec![
            "store-view-epic",
            "store-view-gog",
            "store-view-steam",
        ]);
        assert!(
            super::prune_store_views().is_empty(),
            "three storefronts fit"
        );

        // Visiting a fourth closes the oldest one (the tail of the list).
        super::touch_store_warm("store-view-ubisoft");
        assert_eq!(super::prune_store_views(), vec!["steam".to_string()]);
        let order = super::STORE_WARM_ORDER
            .lock()
            .map(|o| o.clone())
            .unwrap_or_default();
        assert_eq!(
            order.first().map(String::as_str),
            Some("store-view-ubisoft")
        );

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
