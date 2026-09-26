// Prevents an extra console window from opening on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod eos;
mod legendary;
mod presence;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub struct AppState {
    pub epic_dl: Mutex<legendary::transfers::EpicDlState>,
}

/// When set, closing the window hides it to the system tray instead of quitting
/// so downloads keep running in the background.
#[derive(Default)]
pub struct TrayPref {
    pub minimize_to_tray: std::sync::atomic::AtomicBool,
}

#[tauri::command]
fn app_set_minimize_to_tray(enabled: bool, state: tauri::State<'_, TrayPref>) {
    state
        .minimize_to_tray
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// Epic/Legendary settings (`<app_data>/settings.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EpicSettings {
    pub alt_legendary_bin: Option<String>,
    #[serde(default)]
    pub install_dir: Option<String>,
    #[serde(default)]
    pub network_profile: Option<String>,
    #[serde(default)]
    pub offline_mode: Option<bool>,
    #[serde(default)]
    pub steamgrid_api_key: Option<String>,
    #[serde(default)]
    pub presence_enabled: Option<bool>,
    #[serde(default)]
    pub presence_client_id: Option<String>,
    /// Preferred Epic CDN hostname for downloads (`--preferred-cdn`).
    #[serde(default)]
    pub preferred_cdn: Option<String>,
    #[serde(default = "default_true")]
    pub auto_desktop_shortcut: bool,
}

fn default_true() -> bool {
    true
}

fn settings_file(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("settings.json")
}

pub fn load_settings(app: &AppHandle) -> EpicSettings {
    std::fs::read_to_string(settings_file(app))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, s: &EpicSettings) {
    let path = settings_file(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(s) {
        let _ = std::fs::write(path, data);
    }
}

#[tauri::command]
fn library_dir(app: AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

/// Shows the Epic Store as an embedded webview inside the MAIN window.
/// Reason: Epic sends `X-Frame-Options: SAMEORIGIN`, so it cannot be embedded
/// with an iframe; therefore a native child webview is placed in the content area
/// (using the `add_child` API behind the `unstable` feature).
/// The top bar stays on top as HTML and the tabs keep working.
///
/// NOTE: because the child webview position cannot be changed afterwards, when
/// the window is resized it is rebuilt with `recreate=true`
/// (a label counter prevents collisions; old ones close in the background).
static STORE_VIEW_SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

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
static STORE_PALETTE_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
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
    (left, top, (win_w - left).max(100.0), (win_h - top - bottom).max(100.0))
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

fn store_hold_effect(palette_open: bool, store_visible: bool, hold: bool, restore: bool) -> StoreHoldEffect {
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
    (x.round() as i32, y.round() as i32, width.round() as i32, height.round() as i32)
}

/// Last rect sent to the child. A resize echo of that same rect must not
/// apply bounds again; split position/size updates were collapsing it to 1x1
/// and forcing a second show.
static STORE_APPLIED_BOUNDS: std::sync::Mutex<Option<(i32, i32, i32, i32)>> = std::sync::Mutex::new(None);

fn bounds_already_applied(x: f64, y: f64, width: f64, height: f64) -> bool {
    STORE_APPLIED_BOUNDS.lock().ok().and_then(|slot| *slot) == Some(bounds_key(x, y, width, height))
}

fn remember_applied_bounds(x: f64, y: f64, width: f64, height: f64) {
    if let Ok(mut slot) = STORE_APPLIED_BOUNDS.lock() {
        *slot = Some(bounds_key(x, y, width, height));
    }
}

/// One position+size update. `set_position` then `set_size` reads the parked
/// 1x1 size back and collapses the webview after it has just been shown.
fn move_store_bounds(window: &tauri::Window, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    if bounds_already_applied(x, y, width, height) {
        return Ok(());
    }
    let views = store_views(window);
    if views.is_empty() {
        return Ok(());
    }
    let rect = webview_rect(x, y, width, height);
    for v in &views {
        v.set_bounds(rect).map_err(|e| e.to_string())?;
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
fn show_store_bounds(window: &tauri::Window, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let width = width.max(100.0);
    let height = height.max(100.0);
    let views = store_views(window);
    if views.is_empty() {
        return Ok(());
    }
    if !bounds_already_applied(x, y, width, height) {
        let rect = webview_rect(x, y, width, height);
        for v in &views {
            v.set_bounds(rect).map_err(|e| e.to_string())?;
        }
        remember_applied_bounds(x, y, width, height);
    }
    for v in &views {
        v.show().map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn store_views(window: &tauri::Window) -> Vec<tauri::Webview> {
    window
        .webviews()
        .into_iter()
        .filter(|w| w.label().starts_with("epic-store-view"))
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
    let config_dir = legendary::skip::default_config_dir();
    // Prefer the consolidated snapshot (1 file) over ~900 metadata files.
    let games = match legendary::cache::read_library_snapshot(&config_dir) {
        Some(g) => g,
        None => legendary::cache::read_cached_games(&config_dir),
    };
    let installed = legendary::cache::read_installed(&config_dir);
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
        s = s.replace(/[:\-–—]\s*(standard|deluxe|gold|premium|definitive|enhanced|ultimate|special|complete|anniversary|director'?s cut|remastered|goty|game of the year).*/i, '');
        
        // Remove edition words
        s = s.replace(/\b(standard|deluxe|gold|premium|definitive|enhanced|ultimate|special|complete|anniversary|goty|game of the year)\s*(edition|surum|sürüm)?\b/gi, '');
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
        s = s.replace(/-(standard|deluxe|gold|premium|definitive|enhanced|ultimate|special|complete|anniversary|collectors|goty|game-of-the-year)(-(edition|surum|paketi))?$/i, '');
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
                if (txt.length >= 3 && txt.length <= 60 && !txt.startsWith('₺') && !txt.startsWith('$') && !txt.startsWith('€') && txt !== 'Ana Oyun' && txt !== 'Eklenti' && txt !== 'Temel Oyun') {
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

                        // On discounted cards, definitively hide old discount badges (-95%) and strikethrough prices
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
                            } else if (/\*\s*$/.test(dtxt) && /^[₺$€£]|\d+[,.]\d{2}/.test(dtxt)) {
                                elDesc.style.setProperty('display', 'none', 'important');
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
        debounceTimer = setTimeout(scanAndDecorate, 200);
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

    setInterval(function() {
        scanAndDecorate();
    }, 1500);

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
async fn show_store_view(
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
    eprintln!("[store-view] show url={url} recreate={recreate}");

    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let pos = Position::Logical(LogicalPosition::new(x, y));
    let size = Size::Logical(LogicalSize::new(width.max(100.0), height.max(100.0)));
    remember_store_insets(x, y, bottom.unwrap_or(0.0));
    let epoch = STORE_EPOCH.load(std::sync::atomic::Ordering::SeqCst);
    STORE_VISIBLE.store(true, std::sync::atomic::Ordering::SeqCst);

    let owned_games = get_owned_games_json();
    let owned_label_js = js_string(owned_label.as_deref().unwrap_or(""));

    // If the webview already exists, show it INSTANTLY (0 ms) without waiting for any network request
    if !recreate {
        if let Some(v) = store_views(&window).into_iter().next() {
            // The palette hold parks the webview; do not move it back on screen.
            if STORE_PALETTE_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = park_store_offscreen(&window);
            } else {
                let _ = v.set_position(pos);
                let _ = v.set_size(size);
                v.show().map_err(|e| e.to_string())?;
            }
            if STORE_EPOCH.load(std::sync::atomic::Ordering::SeqCst) != epoch {
                STORE_VISIBLE.store(false, std::sync::atomic::Ordering::SeqCst);
                let _ = park_store_offscreen(&window);
                return Ok("@t:win.focused".into());
            }
            if STORE_PALETTE_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = park_store_offscreen(&window);
            }
            let _ = v.eval(&format!("window.__EFXLVE_OWNED_LABEL = {owned_label_js}; window.__EFXLVE_GAMES = {owned_games}; if(typeof scanAndDecorate==='function') scanAndDecorate();"));
            if let Ok(target) = url.parse::<url::Url>() {
                if let Ok(cur) = v.url() {
                    if cur.as_str() != target.as_str() {
                        let _ = v.navigate(target);
                    }
                }
            }
            if STORE_PALETTE_OPEN.load(std::sync::atomic::Ordering::SeqCst) {
                let _ = park_store_offscreen(&window);
            }
            return Ok("@t:win.focused".into());
        }
    } else {
        for v in store_views(&window) {
            let _ = v.close();
        }
    }

    let parsed: url::Url = url.parse().map_err(|_| "@t:win.invalidUrl".to_string())?;
    match parsed.scheme() {
        "http" | "https" => {}
        _ => return Err("@t:win.onlyHttp".to_string()),
    }

    let init_script = format!(
        "window.__EFXLVE_OWNED_LABEL = {owned_label_js};\nwindow.__EFXLVE_GAMES = {owned_games};\n{STORE_EXTENSION_SCRIPT}"
    );

    let seq = STORE_VIEW_SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let app_nav = app.clone();
    let builder = WebviewBuilder::new(
        format!("epic-store-view-{seq}"),
        WebviewUrl::External(parsed),
    )
    // Native WebView2 background is pure obsidian: white flashes (FOUC) during page transitions are prevented.
    .background_color(tauri::webview::Color(14, 15, 18, 255))
    .initialization_script(&init_script)
    .on_navigation(move |url| {
        if url.scheme() == "https" && url.host_str() == Some("efxlve.local") {
            let query: std::collections::HashMap<_, _> = url.query_pairs().into_owned().collect();
            let app_name = query.get("app").cloned().unwrap_or_default();
            let title = query.get("title").cloned().unwrap_or_default();
            let slug = query.get("slug").cloned().unwrap_or_default();
            use tauri::Emitter;
            let _ = app_nav.emit("efxlve-open-game-from-store", serde_json::json!({
                "appName": app_name,
                "title": title,
                "slug": slug
            }));
            return false;
        }
        if url.path().contains("/download") || url.host_str() == Some("launcher-public-service-prod06.ol.epicgames.com") {
            return false;
        }
        true
    });
    // add_child posts work to the main thread and waits; to avoid locking the UI
    // on a possible hang, it runs on a separate thread with a timeout.
    let handle = tokio::task::spawn_blocking(move || window.add_child(builder, pos, size));
    match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(Ok(_))) => {
            eprintln!("[store-view] child created");
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
fn resize_store_view(app: AppHandle, x: f64, y: f64, width: f64, height: f64, bottom: Option<f64>) -> Result<(), String> {
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
fn hide_store_view(app: AppHandle) -> Result<String, String> {
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
fn set_store_palette_hold(
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
fn destroy_store_view(app: AppHandle) -> Result<String, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    STORE_VISIBLE.store(false, std::sync::atomic::Ordering::Relaxed);
    for v in store_views(&window) {
        let _ = v.close();
    }
    Ok("@t:store.closed".into())
}

/// Opens a folder in the file manager.
/// Note: Rust is used directly instead of the opener plugin, so no capability
/// scope issues occur and every drive is supported.
#[tauri::command]
fn open_folder(path: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err("@t:win.folderNotFound".to_string());
    }
    #[cfg(windows)]
    let res = std::process::Command::new("explorer").arg(&p).spawn();
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(&p).spawn();
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open").arg(&p).spawn();
    res.map(|_| "@t:win.folderOpened".to_string())
        .map_err(|e| format!("@t:win.folderOpenFailed\u{1f}{e}"))
}

/// Best-effort scan of a game's install directory for the EOS SDK runtime.
/// Only called when a game detail view opens; the frontend caches the result.
/// Runs on a blocking thread so a slow HDD walk never stalls the UI.
#[tauri::command]
async fn epic_detect_eos(install_path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || detect_eos_blocking(&install_path))
        .await
        .unwrap_or(false)
}

fn detect_eos_blocking(install_path: &str) -> bool {
    fn scan(dir: &std::path::Path, depth: u32, budget: &mut u32) -> bool {
        if depth == 0 || *budget == 0 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            *budget = budget.saturating_sub(1);
            if *budget == 0 {
                return false;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                if name == "epiconlineservices" {
                    return true;
                }
                subdirs.push(entry.path());
            } else if name.starts_with("eossdk") && name.ends_with(".dll") {
                return true;
            }
        }
        for d in subdirs {
            if scan(&d, depth - 1, budget) {
                return true;
            }
        }
        false
    }

    let root = std::path::Path::new(install_path.trim());
    if !root.is_dir() {
        return false;
    }
    // Fast path for the common Unreal layouts before the bounded walk.
    for rel in [
        "Engine/Binaries/ThirdParty/EOSSDK/Win64/EOSSDK-Win64-Shipping.dll",
        "Engine/Binaries/ThirdParty/EOSSDK/Win32/EOSSDK-Win32-Shipping.dll",
    ] {
        if root.join(rel).is_file() {
            return true;
        }
    }
    let mut budget = 6000u32;
    scan(root, 5, &mut budget)
}

#[tauri::command]
fn app_minimize(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window.minimize().map_err(|e| e.to_string())
}

#[tauri::command]
fn app_toggle_maximize(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let is_max = window.is_maximized().unwrap_or(false);
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn app_is_maximized(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window.is_maximized().map_err(|e| e.to_string())
}

#[tauri::command]
fn app_close(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window.close().map_err(|e| e.to_string())
}

fn has_active_download(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .epic_dl
        .lock()
        .map(|state| state.active.is_some())
        .unwrap_or(false)
}

#[tauri::command]
fn app_set_decorations(app: AppHandle, decorations: bool) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window.set_decorations(decorations).map_err(|e| e.to_string())
}

/// Tray menu item handles so the frontend can localize their labels.
pub struct TrayItems {
    pub show: tauri::menu::MenuItem<tauri::Wry>,
    pub quit: tauri::menu::MenuItem<tauri::Wry>,
}

/// Sets the tray menu labels from the frontend (translated strings).
#[tauri::command]
fn app_set_tray_labels(
    show: String,
    quit: String,
    items: tauri::State<'_, TrayItems>,
) -> Result<(), String> {
    items.show.set_text(show).map_err(|e| e.to_string())?;
    items.quit.set_text(quit).map_err(|e| e.to_string())?;
    Ok(())
}

/// Builds the system tray icon with a Show / Quit menu. Left click restores the
/// window; the tray keeps the app (and its downloads) alive while hidden.
fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    app.manage(TrayItems {
        show: show.clone(),
        quit: quit.clone(),
    });

    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().ok_or("no window icon")?)
        .tooltip("Efxlve Launcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                if has_active_download(app) {
                    // Keep the backend monitor and download process alive while hidden.
                    if let Some(w) = app.get_window("main") {
                        let _ = w.hide();
                    }
                } else {
                    app.exit(0);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            epic_dl: Mutex::new(legendary::transfers::EpicDlState::default()),
        })
        .manage(TrayPref::default())
        .setup(|app| {
            if let Some(win) = app.get_window("main") {
                let _ = win.set_decorations(false);
            }
            legendary::screenshots::start_f12_listener(app.handle().clone());
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let pref = window.app_handle().state::<TrayPref>();
                if pref
                    .minimize_to_tray
                    .load(std::sync::atomic::Ordering::Relaxed)
                    || has_active_download(&window.app_handle())
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::Resized(physical_size) = event {
                use std::sync::atomic::Ordering::{Relaxed, SeqCst};
                let palette_open = STORE_PALETTE_OPEN.load(SeqCst);
                let store_visible = STORE_VISIBLE.load(SeqCst);
                let Ok(scale_factor) = window.scale_factor() else {
                    return;
                };
                let logical_size = physical_size.to_logical::<f64>(scale_factor);
                // `None` (palette open, or store hidden): leave the child where the
                // hold parked it. Parking again hides a restore that just showed it.
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
        })
        .invoke_handler(tauri::generate_handler![
            library_dir,
            app_minimize,
            app_toggle_maximize,
            app_is_maximized,
            app_close,
            app_set_decorations,
            app_set_minimize_to_tray,
            app_set_tray_labels,
            legendary::commands::epic_setup_status,
            legendary::commands::epic_ensure_binary,
            legendary::commands::epic_status,
            legendary::commands::epic_list_games,
            legendary::commands::epic_list_installed,
            legendary::commands::epic_list_skipped,
            legendary::commands::epic_cached_library,
            legendary::commands::epic_get_achievements,
            legendary::commands::epic_get_achievements_summary,
            legendary::commands::epic_get_system_requirements,
            legendary::commands::epic_get_hltb,
            legendary::commands::epic_get_critic,
            legendary::steam_store::epic_get_steam_about,
            legendary::commands::epic_detect_egl_games,
            legendary::commands::epic_sync_egl_installed,
            legendary::commands::epic_import_installed_folder,
            legendary::commands::epic_third_party_launchers,
            legendary::commands::epic_verify_game,
            legendary::commands::epic_get_game_settings,
            legendary::commands::epic_save_game_settings,
            legendary::commands::epic_sync_saves,
            legendary::commands::epic_create_desktop_shortcut,
            legendary::commands::epic_get_game_dlcs,
            legendary::commands::epic_get_install_options,
            legendary::commands::epic_check_updates,
            legendary::commands::epic_get_playtimes,
            legendary::commands::epic_set_playtime,
            legendary::commands::epic_get_network_profile,
            legendary::commands::epic_set_network_profile,
            legendary::commands::epic_get_offline_mode,
            legendary::commands::epic_set_offline_mode,
            legendary::commands::epic_get_auto_desktop_shortcut,
            legendary::commands::epic_set_auto_desktop_shortcut,
            legendary::commands::epic_backup_save,
            legendary::commands::epic_list_backups,
            legendary::commands::epic_restore_backup,
            legendary::commands::epic_delete_backup,
            legendary::commands::epic_open_backup_folder,
            legendary::commands::epic_get_collections,
            legendary::commands::epic_save_collection,
            legendary::commands::epic_reorder_collections,
            legendary::commands::epic_delete_collection,
            legendary::commands::epic_set_game_collections,
            legendary::commands::epic_import_egl_collections,
            legendary::commands::epic_login_with_code,
            legendary::commands::epic_import_egl,
            legendary::commands::epic_logout,
            legendary::commands::epic_get_saved_accounts,
            legendary::commands::epic_switch_account,
            legendary::commands::epic_remove_saved_account,
            legendary::commands::epic_get_settings,
            legendary::commands::epic_set_alt_bin,
            legendary::commands::epic_measure_cdns,
            legendary::commands::epic_set_preferred_cdn,
            legendary::commands::epic_cleanup_cache,
            presence::epic_presence_configure,
            presence::epic_presence_update,
            presence::epic_presence_clear,
            legendary::transfers::epic_install_game,
            legendary::transfers::epic_install_with_options,
            legendary::transfers::epic_resume_pending_download,
            legendary::transfers::epic_pause_download,
            legendary::transfers::epic_resume_download,
            legendary::transfers::epic_reorder_queue,
            legendary::transfers::epic_get_queue,
            legendary::transfers::epic_cancel_download,
            legendary::transfers::epic_uninstall_game,
            legendary::transfers::epic_default_install_dir,
            legendary::transfers::epic_set_install_dir,
            legendary::transfers::epic_launch_game,
            legendary::transfers::epic_stop_game,
            show_store_view,
            resize_store_view,
            hide_store_view,
            set_store_palette_hold,
            destroy_store_view,
            open_folder,
            eos::eos_overlay_status,
            eos::eos_install_redistributable,
            epic_detect_eos,
            legendary::friends::epic_friends,
            legendary::steamgrid::epic_get_steamgrid_key,
            legendary::steamgrid::epic_set_steamgrid_key,
            legendary::steamgrid::epic_test_steamgrid_key,
            legendary::steamgrid::epic_search_steamgrid,
            legendary::steamgrid::epic_get_steamgrid_covers,
            legendary::commands::epic_get_player_profile,
            legendary::screenshots::epic_get_game_screenshots,
            legendary::screenshots::epic_capture_game_screenshot,
            legendary::screenshots::epic_delete_game_screenshot,
            legendary::screenshots::epic_open_game_screenshots_folder,
            legendary::screenshots::epic_set_screenshot_hotkey,
            legendary::screenshots::epic_get_screenshot_hotkey,
            legendary::screenshots::epic_replace_screenshot_with_compressed,
            legendary::commands::epic_get_system_drives,
            legendary::commands::epic_select_folder_dialog,
            legendary::commands::epic_move_game,
            legendary::commands::epic_cancel_move_game
        ])
        .run(tauri::generate_context!())
        .expect("Tauri application failed to run");
}

#[cfg(test)]
mod tests {
    use super::{store_bounds, store_hold_effect, store_resize_bounds, StoreHoldEffect};

    #[test]
    fn store_bounds_fill_content_area_between_header_and_status_bar() {
        assert_eq!(store_bounds(1600.0, 900.0, 225.0, 86.0, 24.0), (225.0, 86.0, 1375.0, 790.0));
    }

    #[test]
    fn store_bounds_clamp_to_minimum_size_and_non_negative_insets() {
        assert_eq!(store_bounds(200.0, 120.0, 232.0, 36.0, 24.0), (232.0, 36.0, 100.0, 100.0));
        assert_eq!(store_bounds(800.0, 600.0, -5.0, -1.0, -3.0), (0.0, 0.0, 800.0, 600.0));
    }

    #[test]
    fn store_stays_offscreen_while_palette_open_including_resize() {
        // Store page is current, but the command palette is open.
        assert_eq!(store_resize_bounds(true, true, 1600.0, 900.0, 225.0, 36.0, 0.0), None);
        // Same window after the palette closes: the content area is restored.
        assert_eq!(
            store_resize_bounds(true, false, 1600.0, 900.0, 225.0, 36.0, 0.0),
            Some((225.0, 36.0, 1375.0, 864.0))
        );
        // Left the store entirely: a resize still must not bring the webview back.
        assert_eq!(store_resize_bounds(false, false, 1600.0, 900.0, 225.0, 36.0, 0.0), None);
        assert_eq!(store_resize_bounds(false, true, 1600.0, 900.0, 225.0, 36.0, 0.0), None);

        // One close shows once. A second release in the same turn does nothing.
        assert_eq!(store_hold_effect(true, true, false, true), StoreHoldEffect::Show);
        assert_eq!(store_hold_effect(false, true, false, true), StoreHoldEffect::Ignore);
        assert_eq!(store_hold_effect(true, true, true, false), StoreHoldEffect::Ignore);
        assert_eq!(store_hold_effect(false, true, true, false), StoreHoldEffect::Park);
        // Left the store while the palette was open: clear the hold, stay hidden.
        assert_eq!(store_hold_effect(true, false, false, true), StoreHoldEffect::ReleaseHidden);
        assert_eq!(store_hold_effect(true, true, false, false), StoreHoldEffect::ReleaseHidden);
    }
}
