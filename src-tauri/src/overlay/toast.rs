//! The achievement toast: a transparent, click-through WebView2 window that
//! renders the same card component as the Settings preview.
//!
//! The launcher and the Shift+Tab panel are webviews, so the toast is one too.
//! A second GDI painting of the card drifts from the preview by construction
//! (font metrics, easing, DPI), which is exactly what the preview must not do.
//!
//! Lifecycle: the window is built on the first card, kept warm for a minute
//! after the last one, then destroyed so its renderer memory returns. It never
//! takes focus and never receives the mouse.

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const TOAST_LABEL: &str = "toast";

/// How long a hidden toast window may keep its renderer alive.
const IDLE_RELEASE_MS: u64 = 60_000;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToastPalette {
    pub background: String,
    pub accent: String,
    pub border: String,
    pub icon: String,
    pub title: String,
    pub body: String,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ToastPayload {
    /// Filled in by [`show`]; the page echoes it back when the exit finishes.
    #[serde(default)]
    pub generation: u64,
    pub title: String,
    pub body: String,
    pub tier: u8,
    pub unlocked: u32,
    pub total: u32,
    pub rarity_percent: Option<f64>,
    pub theme: String,
    pub size: String,
    pub position: String,
    pub style: String,
    pub exit_style: String,
    pub hold_ms: u64,
    pub palette: ToastPalette,
    /// System hints ("Shift+Tab opens the overlay") have no rarity line.
    #[serde(default)]
    pub tagless: bool,
    /// The achievement picture, when it landed before the card was emitted.
    #[serde(default)]
    pub icon: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToastIconPayload {
    generation: u64,
    src: String,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);
static READY: AtomicBool = AtomicBool::new(false);
/// A running game keeps the toast page warm so the first card is instant.
static PINNED: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<Option<ToastPayload>> = Mutex::new(None);
/// Serializes window creation: two unlocks can race before the label exists.
static CREATE_LOCK: Mutex<()> = Mutex::new(());

fn emit_card(app: &AppHandle, payload: &ToastPayload) {
    let _ = app.emit_to(TOAST_LABEL, "ach-toast", payload.clone());
}

/// Shows one card. Returns the generation a late icon download must match.
pub fn show(app: &AppHandle, mut payload: ToastPayload) -> u64 {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    payload.generation = generation;
    if let Ok(mut slot) = PENDING.lock() {
        *slot = Some(payload.clone());
    }
    // Building a webview waits for the event loop. Doing that on the command
    // thread leaves the window half-built (hidden, default size), so the card
    // is placed and shown from a worker, the same path the startup probe used.
    let handle = app.clone();
    std::thread::spawn(move || show_now(&handle, payload));
    generation
}

fn show_now(app: &AppHandle, payload: ToastPayload) {
    let win = match ensure_window(app) {
        Ok(win) => win,
        Err(error) => {
            crate::perf::write_line_global(&format!("toast: {error}"));
            return;
        }
    };
    place_on_active_monitor(&win);
    let _ = win.set_always_on_top(true);
    let _ = win.show();
    if let Ok(hwnd) = win.hwnd() {
        crate::overlay::hud::raise_topmost(hwnd.0 as isize);
    }
    // Some games raise themselves right after losing/regaining fullscreen.
    // Nudge the card back into the topmost band a couple of times.
    let handle = app.clone();
    let generation = payload.generation;
    std::thread::spawn(move || {
        for delay in [500u64, 1200] {
            std::thread::sleep(std::time::Duration::from_millis(delay));
            if GENERATION.load(Ordering::SeqCst) != generation {
                return;
            }
            if let Some(win) = handle.get_webview_window(TOAST_LABEL) {
                if let Ok(hwnd) = win.hwnd() {
                    crate::overlay::hud::raise_topmost(hwnd.0 as isize);
                }
            }
        }
    });
    // The window may be fresh (its page is still booting) or warm.
    if READY.load(Ordering::SeqCst) {
        emit_card(app, &payload);
        if let Ok(mut slot) = PENDING.lock() {
            *slot = None;
        }
    }
    schedule_watchdog(app.clone(), payload.generation, payload.hold_ms);
}

/// Keeps the toast page loaded while a game runs, so the first card arrives
/// without waiting for a WebView2 boot.
pub fn prewarm(app: &AppHandle) {
    PINNED.store(true, Ordering::SeqCst);
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = ensure_window(&handle) {
            crate::perf::write_line_global(&format!("toast prewarm: {error}"));
        }
    });
}

/// The game session ended: let the usual idle release collect the window.
pub fn release(app: &AppHandle) {
    PINNED.store(false, Ordering::SeqCst);
    let generation = GENERATION.load(Ordering::SeqCst);
    schedule_idle_release(app.clone(), generation);
}

/// The page is listening: replay whatever arrived while it booted.
#[tauri::command]
pub fn toast_ready(app: AppHandle) {
    READY.store(true, Ordering::SeqCst);
    let pending = PENDING.lock().ok().and_then(|mut slot| slot.take());
    if let Some(payload) = pending {
        emit_card(&app, &payload);
    }
}

/// The card finished its exit animation: hide now, destroy later if idle.
#[tauri::command]
pub fn toast_done(app: AppHandle, generation: u64) {
    if GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    if let Some(win) = app.get_webview_window(TOAST_LABEL) {
        let _ = win.hide();
    }
    schedule_idle_release(app, generation);
}

/// Puts the downloaded achievement picture on the card that is still playing.
pub fn set_icon(app: &AppHandle, generation: u64, path: &Path) {
    if generation == 0 || GENERATION.load(Ordering::SeqCst) != generation {
        return;
    }
    let Ok(bytes) = std::fs::read(path) else {
        return;
    };
    if bytes.is_empty() || bytes.len() > 4 * 1024 * 1024 {
        return;
    }
    let mime = match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "image/png",
    };
    let src = format!(
        "data:{mime};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    );
    // A card whose page is still booting gets the picture in the payload; an
    // already-playing card gets it through the event below.
    if let Ok(mut slot) = PENDING.lock() {
        if let Some(pending) = slot.as_mut().filter(|pending| pending.generation == generation) {
            pending.icon = Some(src.clone());
        }
    }
    let _ = app.emit_to(
        TOAST_LABEL,
        "ach-toast-icon",
        ToastIconPayload { generation, src },
    );
}

fn ensure_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    let _guard = CREATE_LOCK.lock().map_err(|_| "toast lock poisoned".to_string())?;
    if let Some(win) = app.get_webview_window(TOAST_LABEL) {
        return Ok(win);
    }
    READY.store(false, Ordering::SeqCst);
    let win = WebviewWindowBuilder::new(app, TOAST_LABEL, WebviewUrl::App("toast.html".into()))
        .title("Efxlve Notification")
        .transparent(true)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .inner_size(720.0, 240.0)
        .build()
        .map_err(|error| error.to_string())?;
    win.set_ignore_cursor_events(true)
        .map_err(|error| error.to_string())?;
    Ok(win)
}

/// Fills the monitor that hosts the game (or the foreground window).
fn place_on_active_monitor(win: &WebviewWindow) {
    let (x, y, width, height) = crate::overlay::hud::monitor_rect_for(
        crate::overlay::hud::foreground_window(),
    )
    .unwrap_or((0, 0, 1920, 1080));
    let _ = win.set_position(PhysicalPosition::new(x, y));
    let _ = win.set_size(PhysicalSize::new(width, height));
}

fn schedule_watchdog(app: AppHandle, generation: u64, hold_ms: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(hold_ms + 6_000));
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if let Some(win) = app.get_webview_window(TOAST_LABEL) {
            let _ = win.hide();
        }
        schedule_idle_release(app, generation);
    });
}

/// Destroys the window once it has been idle, freeing the renderer memory.
fn schedule_idle_release(app: AppHandle, generation: u64) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(IDLE_RELEASE_MS));
        if GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        if PINNED.load(Ordering::SeqCst) {
            return;
        }
        let Some(win) = app.get_webview_window(TOAST_LABEL) else {
            return;
        };
        // A newer card may have arrived while the timer slept.
        if win.is_visible().unwrap_or(false) {
            return;
        }
        let _ = win.destroy();
    });
}
