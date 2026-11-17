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

#![allow(clashing_extern_declarations)]

use base64::Engine;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const TOAST_LABEL: &str = "toast";

/// How long a hidden toast window may keep its renderer alive.
const IDLE_RELEASE_MS: u64 = 60_000;

/// How many cards may wait behind the one on screen. A burst is already
/// coalesced at its source; this is the safety net for several separate bursts
/// and system hints in a short window.
const MAX_QUEUE: usize = 8;

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
    /// Filled in by [`show`]; a card from an earlier game session is dropped
    /// instead of surfacing over the next game.
    #[serde(skip)]
    pub session: u64,
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
    /// Play the unlock chime when the card reaches the screen, not when it is
    /// queued. Skipped in the page payload.
    #[serde(skip)]
    pub sound: bool,
    #[serde(skip)]
    pub sound_tier: u8,
    /// The achievement picture, when it landed before the card was emitted.
    #[serde(default)]
    pub icon: Option<String>,
    /// Greater than one when this card stands for a burst of unlocks (a save
    /// load can unlock twenty at once). The page then paints the localized
    /// "N achievements unlocked" title and `batch_names` as the body, so one
    /// card does not bury the others.
    #[serde(default)]
    pub batch: u32,
    #[serde(default)]
    pub batch_names: Vec<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ToastIconPayload {
    generation: u64,
    src: String,
}

static GENERATION: AtomicU64 = AtomicU64::new(0);
/// Bumped when a game session ends or the overlay service stops. A payload
/// keeps the session it was created in, so a card still sitting in the queue
/// cannot surface over the next game (or over a protected title).
static SESSION: AtomicU64 = AtomicU64::new(1);
static READY: AtomicBool = AtomicBool::new(false);
/// A running game keeps the toast page warm so the first card is instant.
static PINNED: AtomicBool = AtomicBool::new(false);
static PENDING: Mutex<Option<ToastPayload>> = Mutex::new(None);
/// Cards wait their turn instead of overwriting the one on screen. A burst that
/// arrives while a card plays is shown afterwards, in order.
static QUEUE: Mutex<Option<std::collections::VecDeque<ToastPayload>>> = Mutex::new(None);
static DRAINING: AtomicBool = AtomicBool::new(false);
/// The card on screen; `toast_done` and late icons compare against this.
static CURRENT: AtomicU64 = AtomicU64::new(0);
static QUEUED_ICONS: Mutex<Option<std::collections::HashMap<u64, String>>> = Mutex::new(None);
/// Serializes window creation: two unlocks can race before the label exists.
static CREATE_LOCK: Mutex<()> = Mutex::new(());

fn emit_card(app: &AppHandle, payload: &ToastPayload) {
    let _ = app.emit_to(TOAST_LABEL, "ach-toast", payload.clone());
}

/// The chime belongs to the card, not to the queue push: a card that waits
/// behind another must not ring early. The settings are read again at display
/// time, so a volume or style change applies to a card already queued.
fn play_card_sound(app: &AppHandle, payload: &ToastPayload) {
    if payload.sound {
        crate::steam::play_achievement_card_sound(app, payload.sound_tier);
    }
}

fn take_queued_icon(generation: u64) -> Option<String> {
    QUEUED_ICONS
        .lock()
        .ok()
        .and_then(|mut map| map.as_mut().and_then(|map| map.remove(&generation)))
}

/// Appends a card, merging a full queue into the newest achievement card.
///
/// A source-side burst is already one card; this catches several separate
/// bursts and hints close together. A hint never displaces an achievement
/// card, and merged cards keep the rarest tier, the latest counts and the
/// stronger sound.
fn enqueue(queue: &mut std::collections::VecDeque<ToastPayload>, payload: ToastPayload) {
    if payload.tagless {
        if queue.len() < MAX_QUEUE {
            queue.push_back(payload);
        } else if queue.iter().all(|item| item.tagless) {
            queue.pop_front();
            queue.push_back(payload);
        }
        return;
    }
    if queue.len() < MAX_QUEUE {
        queue.push_back(payload);
        return;
    }
    if let Some(last) = queue.iter_mut().rev().find(|item| !item.tagless) {
        let incoming_count = payload.batch.max(1);
        let mut incoming_names = if payload.batch > 1 {
            payload.batch_names.clone()
        } else {
            vec![payload.title.clone()]
        };
        if last.batch == 0 {
            last.batch = 1;
        }
        if last.batch_names.is_empty() {
            last.batch_names.push(last.title.clone());
        }
        last.batch = last.batch.saturating_add(incoming_count);
        last.batch_names.append(&mut incoming_names);
        last.tier = last.tier.max(payload.tier);
        last.unlocked = last.unlocked.max(payload.unlocked);
        last.total = last.total.max(payload.total);
        last.rarity_percent = match (last.rarity_percent, payload.rarity_percent) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (Some(a), None) => Some(a),
            (None, Some(b)) => Some(b),
            (None, None) => None,
        };
        last.sound |= payload.sound;
        last.sound_tier = last.sound_tier.max(payload.sound_tier);
        return;
    }
    // Every slot is a hint: keep the newest card instead of growing the queue.
    queue.pop_front();
    queue.push_back(payload);
}

/// Shows one card. Returns the generation a late icon download must match.
pub fn show(app: &AppHandle, mut payload: ToastPayload) -> u64 {
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    payload.generation = generation;
    payload.session = SESSION.load(Ordering::SeqCst);
    if let Ok(mut queue) = QUEUE.lock() {
        enqueue(
            queue.get_or_insert_with(std::collections::VecDeque::new),
            payload,
        );
    }
    start_drain(app.clone());
    generation
}

/// One worker shows the queue in order, leaving each card its own hold time.
fn start_drain(app: AppHandle) {
    if DRAINING.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(move || {
        loop {
            let next = QUEUE.lock().ok().and_then(|mut queue| {
                queue.as_mut().and_then(|queue| queue.pop_front())
            });
            let Some(payload) = next else {
                break;
            };
            let hold = payload.hold_ms.saturating_add(1_400);
            // A card dropped for a dead session or a hidden panel costs no
            // hold time; only a card that reached the screen keeps the queue.
            if show_now(&app, payload) {
                std::thread::sleep(std::time::Duration::from_millis(hold));
            }
        }
        DRAINING.store(false, Ordering::SeqCst);
        // A push can land between the empty check and the flag reset; restart
        // once so the card is never stranded in the queue.
        let pending = QUEUE
            .lock()
            .ok()
            .and_then(|queue| queue.as_ref().map(|queue| !queue.is_empty()))
            .unwrap_or(false);
        if pending {
            start_drain(app.clone());
        }
    });
}

fn show_now(app: &AppHandle, mut payload: ToastPayload) -> bool {
    // A game switch, a service stop or an anti-cheat title can invalidate a
    // card that was already queued. Dropping it here is the last line of
    // defence: the session check also covers a card that left the queue just
    // before `release`/`shutdown` cleared it.
    if payload.session != SESSION.load(Ordering::SeqCst) {
        return false;
    }
    // The interactive panel is the surface the player is using; a card over it
    // would cover the very UI that opened. The unlock still reaches the bell,
    // and the chime still plays as the audio half of the notification.
    if super::panel_visible() {
        play_card_sound(app, &payload);
        return false;
    }
    if !payload.tagless && super::achievement_notifications_blocked() {
        return false;
    }
    // The icon download can land while the card is still queued.
    if let Some(icon) = take_queued_icon(payload.generation) {
        payload.icon = Some(icon);
    }
    let win = match ensure_window(app) {
        Ok(win) => win,
        Err(error) => {
            crate::perf::write_line_global(&format!("toast: {error}"));
            play_card_sound(app, &payload);
            return false;
        }
    };
    // Window creation can take long enough for the panel to open or a game to
    // switch underneath us. Re-check before the card gets a chance to paint.
    if payload.session != SESSION.load(Ordering::SeqCst)
        || (!payload.tagless && super::achievement_notifications_blocked())
    {
        let _ = win.hide();
        return false;
    }
    if super::panel_visible() {
        play_card_sound(app, &payload);
        let _ = win.hide();
        return false;
    }
    CURRENT.store(payload.generation, Ordering::SeqCst);
    // Check readiness after the window exists: a rebuild flips READY to false,
    // and a checkpoint taken before it would be lost with the old renderer.
    let mut deferred = false;
    if !READY.load(Ordering::SeqCst) {
        if let Ok(mut slot) = PENDING.lock() {
            *slot = Some(payload.clone());
            deferred = true;
        }
    }
    place_on_active_monitor(&win);
    let _ = win.set_always_on_top(true);
    // A panel open can land between the check above and the show here. Drop
    // the card instead of painting it under the panel's topbar; the chime is
    // still the audio half of the notification.
    let panel_took_over = super::panel_visible();
    if payload.session != SESSION.load(Ordering::SeqCst)
        || panel_took_over
        || (!payload.tagless && super::achievement_notifications_blocked())
    {
        if let Ok(mut slot) = PENDING.lock() {
            if slot
                .as_ref()
                .is_some_and(|pending| pending.generation == payload.generation)
            {
                *slot = None;
            }
        }
        CURRENT.store(0, Ordering::SeqCst);
        let _ = win.hide();
        if panel_took_over {
            play_card_sound(app, &payload);
        }
        return false;
    }
    let _ = win.show();
    make_click_through(&win);
    #[cfg(windows)]
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
                make_click_through(&win);
                #[cfg(windows)]
                if let Ok(hwnd) = win.hwnd() {
                    crate::overlay::hud::raise_topmost(hwnd.0 as isize);
                }
            }
        }
    });
    // The window may be fresh (its page is still booting) or warm. A deferred
    // payload is replayed by `toast_ready`; emitting it here as well would show
    // the same card twice when readiness lands between the two checks.
    if READY.load(Ordering::SeqCst) && !deferred {
        emit_card(app, &payload);
        play_card_sound(app, &payload);
        if let Ok(mut slot) = PENDING.lock() {
            *slot = None;
        }
    }
    schedule_watchdog(app.clone(), payload.generation, payload.hold_ms);
    true
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

/// Drops every card that belongs to the session that just ended.
///
/// The queue is cleared before the session is bumped: a card enqueued by the
/// new game after the bump survives, while a card that read the old session
/// before it is rejected by its own check in `show_now`.
fn clear_session() {
    if let Ok(mut queue) = QUEUE.lock() {
        if let Some(queue) = queue.as_mut() {
            queue.clear();
        }
    }
    SESSION.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut slot) = PENDING.lock() {
        *slot = None;
    }
    if let Ok(mut map) = QUEUED_ICONS.lock() {
        if let Some(map) = map.as_mut() {
            map.clear();
        }
    }
    CURRENT.store(0, Ordering::SeqCst);
}

/// The game session ended: the next game must not inherit this one's cards.
/// The window is hidden now, then collected by the usual idle release.
pub fn release(app: &AppHandle) {
    PINNED.store(false, Ordering::SeqCst);
    clear_session();
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    if let Some(win) = app.get_webview_window(TOAST_LABEL) {
        let _ = win.hide();
    }
    schedule_idle_release(app.clone(), generation);
}

/// Hides the card without ending the session or clearing the queue. The panel
/// takes the screen on open; the queue is left alone and `show_now` drops any
/// card that comes due while the panel stays visible.
pub(crate) fn hide_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window(TOAST_LABEL) {
        let _ = win.hide();
    }
}

/// The overlay service stopped: drop queued cards and destroy the toast host
/// and its renderer now, instead of leaving a pre-warmed transparent window
/// parked for a game that may never end.
pub fn shutdown(app: &AppHandle) {
    PINNED.store(false, Ordering::SeqCst);
    clear_session();
    GENERATION.fetch_add(1, Ordering::SeqCst);
    READY.store(false, Ordering::SeqCst);
    let handle = app.clone();
    std::thread::spawn(move || {
        if let Some(win) = handle.get_webview_window(TOAST_LABEL) {
            let _ = win.destroy();
        }
    });
}

/// The page is listening: replay whatever arrived while it booted.
#[tauri::command]
pub fn toast_ready(app: AppHandle) {
    READY.store(true, Ordering::SeqCst);
    let session = SESSION.load(Ordering::SeqCst);
    let pending = PENDING.lock().ok().and_then(|mut slot| slot.take());
    if let Some(payload) = pending {
        let panel_visible = super::panel_visible();
        if payload.session == session && !panel_visible {
            emit_card(&app, &payload);
            play_card_sound(&app, &payload);
        } else if let Some(win) = app.get_webview_window(TOAST_LABEL) {
            // The card became stale (game switch, service stop) or the panel
            // took the screen while the page was booting. Do not leave an
            // empty topmost window behind; the chime still marks the unlock
            // when the panel was the reason for dropping the card.
            if payload.session == session && panel_visible {
                play_card_sound(&app, &payload);
            }
            let _ = win.hide();
        }
    }
}

/// The card finished its exit animation: hide now, destroy later if idle.
#[tauri::command]
pub fn toast_done(app: AppHandle, generation: u64) {
    if CURRENT.load(Ordering::SeqCst) != generation {
        return;
    }
    if let Some(win) = app.get_webview_window(TOAST_LABEL) {
        let _ = win.hide();
    }
    schedule_idle_release(app, generation);
}

/// Puts the downloaded achievement picture on the card that is still playing.
pub fn set_icon(app: &AppHandle, generation: u64, path: &Path) {
    if generation == 0 {
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
    if CURRENT.load(Ordering::SeqCst) == generation {
        let _ = app.emit_to(
            TOAST_LABEL,
            "ach-toast-icon",
            ToastIconPayload { generation, src },
        );
    } else {
        // Store the picture only while its card is still queued. A card that
        // was dropped (game switch, panel open) must not leave an orphan in
        // the map for the rest of the process.
        let queued = QUEUE
            .lock()
            .ok()
            .and_then(|queue| {
                queue
                    .as_ref()
                    .map(|queue| queue.iter().any(|payload| payload.generation == generation))
            })
            .unwrap_or(false);
        if queued {
            if let Ok(mut map) = QUEUED_ICONS.lock() {
                // The card is still queued; `show_now` picks the picture up.
                map.get_or_insert_with(std::collections::HashMap::new)
                    .insert(generation, src);
            }
        }
    }
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
    make_click_through(&win);
    Ok(win)
}

/// Makes the toast click-through.
///
/// `WS_EX_TRANSPARENT` alone only hands the mouse to windows of the same
/// thread, so the WebView2 child kept swallowing every click. `WS_EX_LAYERED`
/// makes the pass-through global, and DWM per-pixel transparency is unchanged.
/// The hit-test subclass below stays as a guard for WebView2 child windows.
#[cfg(windows)]
fn make_click_through(win: &WebviewWindow) {
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as isize;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = ex | WS_EX_TRANSPARENT | WS_EX_LAYERED;
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        let proc = toast_click_through_proc as *const () as isize;
        if GetWindowLongPtrW(hwnd, GWLP_WNDPROC) != proc {
            let old = SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc);
            if old != 0 {
                TOAST_OLD_PROC.store(old, Ordering::Relaxed);
            }
        }
        // The WebView2 host and renderer are child windows; they must inherit
        // the pass-through or a click on the card still reaches the toast.
        EnumChildWindows(hwnd, Some(mark_child_transparent), 0);
    }
}

#[cfg(not(windows))]
fn make_click_through(_win: &WebviewWindow) {}

#[cfg(windows)]
static TOAST_OLD_PROC: AtomicIsize = AtomicIsize::new(0);

#[cfg(windows)]
const GWL_EXSTYLE: i32 = -20;
#[cfg(windows)]
const GWLP_WNDPROC: i32 = -4;
#[cfg(windows)]
const WS_EX_TRANSPARENT: isize = 0x0000_0020;
#[cfg(windows)]
const WS_EX_LAYERED: isize = 0x0008_0000;

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetWindowLongPtrW(hwnd: isize, index: i32) -> isize;
    fn SetWindowLongPtrW(hwnd: isize, index: i32, value: isize) -> isize;
    fn CallWindowProcW(prev: isize, hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn EnumChildWindows(
        parent: isize,
        callback: Option<unsafe extern "system" fn(isize, isize) -> i32>,
        param: isize,
    ) -> i32;
}

#[cfg(windows)]
unsafe extern "system" fn toast_click_through_proc(
    hwnd: isize,
    msg: u32,
    wparam: usize,
    lparam: isize,
) -> isize {
    if msg == 0x0084 {
        // WM_NCHITTEST: let the click reach the game below the card.
        return -1;
    }
    let old = TOAST_OLD_PROC.load(Ordering::Relaxed);
    if old != 0 {
        CallWindowProcW(old, hwnd, msg, wparam, lparam)
    } else {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(windows)]
unsafe extern "system" fn mark_child_transparent(hwnd: isize, _param: isize) -> i32 {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TRANSPARENT);
    1
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
        // The window is about to die with its page: an old READY would make the
        // next card skip the PENDING checkpoint and be dropped.
        READY.store(false, Ordering::SeqCst);
        let _ = win.destroy();
    });
}

#[cfg(test)]
mod tests {
    use super::{enqueue, ToastPalette, ToastPayload, MAX_QUEUE};
    use std::collections::VecDeque;

    fn card(title: &str, tagless: bool) -> ToastPayload {
        ToastPayload {
            generation: 0,
            session: 0,
            title: title.to_string(),
            body: String::new(),
            tier: 0,
            unlocked: 0,
            total: 0,
            rarity_percent: None,
            theme: "rarity".into(),
            size: "normal".into(),
            position: "top-right".into(),
            style: "prism".into(),
            exit_style: "auto".into(),
            hold_ms: 5_000,
            palette: ToastPalette {
                background: "#000000".into(),
                accent: "#f59e0b".into(),
                border: "#785018".into(),
                icon: "#fbbf24".into(),
                title: "#ffffff".into(),
                body: "#acb2b8".into(),
            },
            tagless,
            sound: false,
            sound_tier: 0,
            icon: None,
            batch: 0,
            batch_names: Vec::new(),
        }
    }

    fn full(tagless: bool) -> VecDeque<ToastPayload> {
        (0..MAX_QUEUE)
            .map(|index| card(&format!("item-{index}"), tagless))
            .collect()
    }

    #[test]
    fn a_full_queue_merges_achievement_cards() {
        let mut queue = full(false);
        enqueue(&mut queue, card("new", false));
        assert_eq!(queue.len(), MAX_QUEUE);
        let last = queue.back().expect("the queue keeps its last card");
        assert_eq!(last.batch, 2);
        assert_eq!(
            last.batch_names,
            vec![format!("item-{}", MAX_QUEUE - 1), "new".to_string()]
        );
    }

    #[test]
    fn a_hint_never_displaces_an_achievement_card() {
        let mut queue = full(false);
        enqueue(&mut queue, card("tip", true));
        assert_eq!(queue.len(), MAX_QUEUE);
        assert!(queue.iter().all(|item| !item.tagless));
    }

    #[test]
    fn an_achievement_card_replaces_a_hint_when_every_slot_is_a_hint() {
        let mut queue = full(true);
        enqueue(&mut queue, card("unlock", false));
        assert_eq!(queue.len(), MAX_QUEUE);
        assert_eq!(queue.front().unwrap().title, "item-1");
        assert_eq!(queue.back().unwrap().title, "unlock");
        assert!(!queue.back().unwrap().tagless);
    }
}
