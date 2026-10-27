//! Native always-on mini HUD (FPS / CPU / GPU plate), the game-start
//! notification card, and small window helpers.
//!
//! A WebView2 window cannot be per-pixel transparent and click-through at the
//! same time on Windows, so both surfaces are plain GDI on one layered,
//! topmost, never-activating window: a dark strip for the HUD, and a rounded
//! card (icon disc, bold title, muted body) for notifications. It never takes
//! input.
//!
//! Some Win32 functions are declared with different handle types in other
//! modules of this crate; the ABI is identical, so the clash warning is noise.
#![allow(clashing_extern_declarations)]

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, AtomicU8, Ordering};
use std::sync::Mutex;

static STARTED: AtomicBool = AtomicBool::new(false);
static HWND: AtomicIsize = AtomicIsize::new(0);
static FONT: AtomicIsize = AtomicIsize::new(0);
static TAG_FONT: AtomicIsize = AtomicIsize::new(0);
static TITLE_FONT: AtomicIsize = AtomicIsize::new(0);
static BODY_FONT: AtomicIsize = AtomicIsize::new(0);
static ICON_FONT: AtomicIsize = AtomicIsize::new(0);
/// 0 compact, 1 normal (default), 2 large, 3 huge.
static NOTIF_SIZE: AtomicU8 = AtomicU8::new(1);
static SIZE_TAG_FONTS: [AtomicIsize; 4] = [AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0)];
static SIZE_TITLE_FONTS: [AtomicIsize; 4] = [AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0)];
static SIZE_BODY_FONTS: [AtomicIsize; 4] = [AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0)];
static SIZE_ICON_FONTS: [AtomicIsize; 4] = [AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0), AtomicIsize::new(0)];
static TEXT: Mutex<Vec<u16>> = Mutex::new(Vec::new());
/// A notification card owns the plate while this is true.
static NOTIF_ON: AtomicBool = AtomicBool::new(false);
static NOTIF_TAG: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static NOTIF_TITLE: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static NOTIF_BODY: Mutex<Vec<u16>> = Mutex::new(Vec::new());
/// The achievement's own picture, when the download already landed: the card
/// paints it inside the medallion instead of the trophy glyph.
static NOTIF_ICON: Mutex<Option<Vec<u16>>> = Mutex::new(None);
/// The card stays until this epoch-ms timestamp.
static NOTIF_UNTIL: AtomicU64 = AtomicU64::new(0);
/// Bumped per card; a stale animation thread must not hide a newer one.
static NOTIF_GEN: AtomicU64 = AtomicU64::new(0);

/// console-like notification card: icon disc, bold title, muted body line.
const NOTIF_HEIGHT: i32 = 116;
const NOTIF_MARGIN: i32 = 24;
const NOTIF_RADIUS: i32 = 12;
const NOTIF_ALPHA: u8 = 242;
static NOTIF_HOLD_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(5200);
/// 0 top-right, 1 top-left, 2 bottom-right, 3 bottom-left, 4 center-top,
/// 5 center-bottom.
static NOTIF_POSITION: AtomicU8 = AtomicU8::new(0);

/// Palette the achievement card paints with, in Windows `COLORREF` order
/// (`0x00BBGGRR`). The frontend supplies the launcher-theme values because the
/// CSS tokens live there; gold is the built-in default.
#[derive(Clone, Copy)]
pub struct AchievementCardColors {
    pub background: u32,
    pub accent: u32,
    pub border: u32,
    pub icon: u32,
    pub title: u32,
    pub body: u32,
}

pub const GOLD_ACHIEVEMENT_CARD: AchievementCardColors = AchievementCardColors {
    background: 0x00140F0D,
    accent: 0x000B9EF5,
    border: 0x00185078,
    icon: 0x0024BFFB,
    title: 0x00FFFFFF,
    body: 0x00B8B2AC,
};

/// The palette of the card currently on screen; a fresh card sets it before it
/// is shown, so the animation thread paints the right one.
static NOTIF_COLORS: Mutex<AchievementCardColors> = Mutex::new(GOLD_ACHIEVEMENT_CARD);

/// A darker tint of `color` for the medallion's inner disc.
#[cfg(windows)]
fn shade(color: u32, percent: u32) -> u32 {
    let channel = |value: u32| ((value & 0xFF) * percent / 100) & 0xFF;
    channel(color) | (channel(color >> 8) << 8) | (channel(color >> 16) << 16)
}

fn notification_is_left(position: u8) -> bool {
    position == 1 || position == 3
}

fn notification_is_center(position: u8) -> bool {
    position == 4 || position == 5
}

fn notification_is_bottom(position: u8) -> bool {
    position == 2 || position == 3 || position == 5
}

/// Card rect in the requested monitor corner. Pure math, unit-tested.
fn notif_rect(
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    mon_h: u32,
    position: u8,
    title_px: i32,
    body_px: i32,
) -> (i32, i32, i32, i32) {
    let size_code = NOTIF_SIZE.load(Ordering::Relaxed).min(2);
    let m = size_metrics(size_code);
    let card_height = m.height;
    let max_width = (mon_w as i32 - 2 * NOTIF_MARGIN).max(m.min_width);
    let text_width = title_px.max(body_px).max(1);
    let width = (m.text_left + m.text_right + text_width).clamp(m.min_width, max_width);
    let x = if notification_is_left(position) {
        mon_x + NOTIF_MARGIN
    } else if notification_is_center(position) {
        mon_x + (mon_w as i32 - width) / 2
    } else {
        mon_x + mon_w as i32 - width - NOTIF_MARGIN
    };
    let y = if notification_is_bottom(position) {
        mon_y + mon_h as i32 - card_height - NOTIF_MARGIN
    } else {
        mon_y + NOTIF_MARGIN
    };
    (x, y, width, card_height)
}

fn text_px(units: &[u16], size: i32) -> i32 {
    units
        .iter()
        .map(|&unit| if unit >= 0x2E80 { size } else { size * 11 / 20 })
        .sum()
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// True while the notification card owns the plate; the metrics HUD must not
/// overwrite it.
pub fn hint_active() -> bool {
    NOTIF_ON.load(Ordering::Relaxed)
}

/// How long the next notification card stays on screen.
pub fn set_notification_hold(ms: u64) {
    NOTIF_HOLD_MS.store(ms.clamp(2000, 15_000), Ordering::Relaxed);
}

/// Which corner the next notification card uses.

pub struct NotifSizeMetrics {
    pub height: i32,
    pub min_width: i32,
    pub bar_width: i32,
    pub medallion_r: i32,
    pub left_pad: i32,
    pub text_left: i32,
    pub text_right: i32,
    pub tag_px: i32,
    pub title_px: i32,
    pub body_px: i32,
    pub tag_top: i32,
    pub tag_bottom: i32,
    pub title_top: i32,
    pub title_bottom: i32,
    pub body_top: i32,
    pub body_bottom: i32,
    pub icon_size: i32,
}

pub fn size_metrics(code: u8) -> NotifSizeMetrics {
    match code {
        0 => NotifSizeMetrics { // Küçük (Old "Büyük")
            height: 94,
            min_width: 460,
            bar_width: 5,
            medallion_r: 22,
            left_pad: 18,
            text_left: 78,
            text_right: 20,
            tag_px: 11,
            title_px: 18,
            body_px: 13,
            tag_top: 13,
            tag_bottom: 29,
            title_top: 30,
            title_bottom: 58,
            body_top: 59,
            body_bottom: 84,
            icon_size: 20,
        },
        2 => NotifSizeMetrics { // Büyük (Brand new extra-large tier)
            height: 144,
            min_width: 640,
            bar_width: 8,
            medallion_r: 33,
            left_pad: 26,
            text_left: 112,
            text_right: 28,
            tag_px: 15,
            title_px: 27,
            body_px: 18,
            tag_top: 17,
            tag_bottom: 41,
            title_top: 43,
            title_bottom: 84,
            body_top: 86,
            body_bottom: 126,
            icon_size: 30,
        },
        _ => NotifSizeMetrics { // 1 = Normal (Standard, Old "Devasa")
            height: NOTIF_HEIGHT,
            min_width: 540,
            bar_width: 6,
            medallion_r: 27,
            left_pad: 22,
            text_left: 92,
            text_right: 24,
            tag_px: 13,
            title_px: 22,
            body_px: 15,
            tag_top: 15,
            tag_bottom: 35,
            title_top: 36,
            title_bottom: 69,
            body_top: 70,
            body_bottom: 101,
            icon_size: 24,
        },
    }
}

pub fn set_notification_size(size: &str) {
    let code = match size {
        "small" | "compact" => 0,
        "large" => 2,
        _ => 1,
    };
    NOTIF_SIZE.store(code, Ordering::Relaxed);
}

pub fn set_notification_position(position: &str) {
    let code = match position {
        "top-left" => 1,
        "bottom-right" => 2,
        "bottom-left" => 3,
        "center-top" => 4,
        "center-bottom" => 5,
        _ => 0,
    };
    NOTIF_POSITION.store(code, Ordering::Relaxed);
}

/// Shows a console-like system notification over the game (game start: the overlay
/// hint). Reuses the HUD window: a Windows toast is invisible for many setups,
/// this card is not. `title` is the bold line, `body` the muted one.
pub fn notify(title: &str, body: &str) {
    if let Some((tag, rest)) = title.split_once(": ") {
        notify_ext(&tag.to_uppercase(), rest, body);
    } else if let Some(stripped) = title.strip_prefix("🏆 ") {
        notify_ext("BAŞARIM KAZANILDI", stripped, body);
    } else {
        notify_ext("", title, body);
    }
}

/// Explicit notification showing tag line (accent uppercase), title (bold), and body (muted).
pub fn notify_ext(tag: &str, title: &str, body: &str) {
    notify_card(tag, title, body, GOLD_ACHIEVEMENT_CARD);
}

/// Achievement cards can follow the launcher theme instead of the gold card;
/// the palette is passed in so a later hint keeps its own colours. The returned
/// generation lets a late icon fetch paint the card that is still on screen.
pub fn notify_achievement(
    tag: &str,
    title: &str,
    body: &str,
    colors: AchievementCardColors,
) -> u64 {
    notify_card(tag, title, body, colors)
}

/// Puts a downloaded achievement icon on the card `generation` named. A stale
/// generation (a newer card is already up) is ignored.
pub fn set_notification_icon(generation: u64, path: &std::path::Path) {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        if generation == 0
            || NOTIF_GEN.load(Ordering::Relaxed) != generation
            || !NOTIF_ON.load(Ordering::Relaxed)
        {
            return;
        }
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        if let Ok(mut slot) = NOTIF_ICON.lock() {
            *slot = Some(wide);
        }
        let hwnd = HWND.load(Ordering::SeqCst);
        if hwnd != 0 {
            unsafe {
                InvalidateRect(hwnd, std::ptr::null(), 0);
            }
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (generation, path);
    }
}

fn notify_card(tag: &str, title: &str, body: &str, colors: AchievementCardColors) -> u64 {
    #[cfg(windows)]
    {
        if let Ok(mut slot) = NOTIF_COLORS.lock() {
            *slot = colors;
        }
        // A new card never inherits the previous achievement's picture.
        if let Ok(mut slot) = NOTIF_ICON.lock() {
            *slot = None;
        }
        ensure_window();
        {
            let mut wide_tag = tag.encode_utf16().collect::<Vec<u16>>();
            wide_tag.push(0);
            if let Ok(mut slot) = NOTIF_TAG.lock() {
                *slot = wide_tag;
            }
            let mut wide_title = title.encode_utf16().collect::<Vec<u16>>();
            wide_title.push(0);
            if let Ok(mut slot) = NOTIF_TITLE.lock() {
                *slot = wide_title;
            }
            let mut wide_body = body.encode_utf16().collect::<Vec<u16>>();
            wide_body.push(0);
            if let Ok(mut slot) = NOTIF_BODY.lock() {
                *slot = wide_body;
            }
        }
        NOTIF_ON.store(true, Ordering::SeqCst);
        NOTIF_UNTIL.store(
            now_ms() + NOTIF_HOLD_MS.load(Ordering::Relaxed),
            Ordering::Relaxed,
        );
        let generation = NOTIF_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        let hwnd = HWND.load(Ordering::SeqCst);
        if hwnd == 0 {
            return generation;
        }

        let (mon_x, mon_y, mon_w, mon_h) =
            monitor_rect_for(foreground_window()).unwrap_or((0, 0, 1920, 1080));
        let position = NOTIF_POSITION.load(Ordering::Relaxed);
        let size_code = NOTIF_SIZE.load(Ordering::Relaxed).min(2);
        let m = size_metrics(size_code);
        let tag_px = if tag.is_empty() { 0 } else { text_px(&tag.encode_utf16().collect::<Vec<u16>>(), m.tag_px) };
        let title_px = text_px(&title.encode_utf16().collect::<Vec<u16>>(), m.title_px).max(tag_px);
        let body_px = text_px(&body.encode_utf16().collect::<Vec<u16>>(), m.body_px);
        let (x, y, w, h) = notif_rect(mon_x, mon_y, mon_w, mon_h, position, title_px, body_px);
        let start_x = if notification_is_center(position) {
            x
        } else if notification_is_left(position) {
            mon_x - w - 8
        } else {
            mon_x + mon_w as i32 + 8
        };

        unsafe {
            shape_notification(hwnd, w, h);
            MoveWindow(hwnd, start_x, y, w, h, 1);
            set_alpha(hwnd, 0);
            ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
            InvalidateRect(hwnd, std::ptr::null(), 0);
        }

        std::thread::spawn(move || {
            slide_in(hwnd, generation, start_x, x, y, w, h);
            while NOTIF_GEN.load(Ordering::Relaxed) == generation
                && NOTIF_ON.load(Ordering::Relaxed)
                && now_ms() < NOTIF_UNTIL.load(Ordering::Relaxed)
            {
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            if NOTIF_GEN.load(Ordering::Relaxed) != generation {
                return;
            }
            slide_out(hwnd, generation, x, y, w, h, notification_is_left(position));
            if NOTIF_GEN.load(Ordering::Relaxed) == generation {
                NOTIF_ON.store(false, Ordering::SeqCst);
                hide_window();
            }
        });
        generation
    }
    #[cfg(not(windows))]
    {
        let _ = (tag, title, body, colors);
        0
    }
}

/// Cuts the current HUD line into a UTF-16 buffer for GDI.
#[cfg(windows)]
pub fn update(text: &str) {
    // A notification owns the plate; the metrics tick restores the HUD after it.
    if hint_active() {
        return;
    }
    ensure_window();
    {
        let mut wide = text.encode_utf16().collect::<Vec<u16>>();
        wide.push(0);
        if let Ok(mut slot) = TEXT.lock() {
            *slot = wide;
        }
    }
    let hwnd = HWND.load(Ordering::Relaxed);
    if hwnd == 0 {
        return;
    }
    let (top_x, top_y) = monitor_top_left();
    let w = ((text.chars().count() as i32) * 8 + 28).max(240);
    unsafe {
        reset_shape(hwnd);
        MoveWindow(hwnd, top_x + 16, top_y + 16, w, 30, 1);
        set_alpha(hwnd, 215);
        ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
        InvalidateRect(hwnd, std::ptr::null(), 0);
    }
}

#[cfg(not(windows))]
pub fn update(_text: &str) {}

pub fn hide() {
    // The notification keeps the plate until its slide-out finishes.
    if hint_active() {
        return;
    }
    hide_window();
}

fn hide_window() {
    #[cfg(windows)]
    {
        let hwnd = HWND.load(Ordering::Relaxed);
        if hwnd != 0 {
            unsafe {
                ShowWindow(hwnd, 0); // SW_HIDE
            }
        }
    }
}

/// Layers the window into the rounded card shape; the OS owns the region after.
#[cfg(windows)]
unsafe fn shape_notification(hwnd: isize, width: i32, height: i32) {
    let diameter = NOTIF_RADIUS * 2;
    let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
    if region != 0 {
        SetWindowRgn(hwnd, region, 1);
    }
}

/// Back to a plain rectangle for the HUD strip.
#[cfg(windows)]
unsafe fn reset_shape(hwnd: isize) {
    SetWindowRgn(hwnd, 0, 1);
}

#[cfg(windows)]
unsafe fn set_alpha(hwnd: isize, alpha: u8) {
    SetLayeredWindowAttributes(hwnd, 0, alpha, 0x0000_0002 /* LWA_ALPHA */);
}

/// Slides the card in from the monitor's right edge with a short ease-out.
#[cfg(windows)]
fn slide_in(hwnd: isize, generation: u64, start_x: i32, x: i32, y: i32, w: i32, h: i32) {
    const STEPS: i32 = 16;
    for step in 0..=STEPS {
        if NOTIF_GEN.load(Ordering::Relaxed) != generation || !hint_active() {
            return;
        }
        let t = step as f32 / STEPS as f32;
        let eased = 1.0 - (1.0 - t) * (1.0 - t) * (1.0 - t);
        let cx = start_x + ((x - start_x) as f32 * eased) as i32;
        let alpha = (NOTIF_ALPHA as f32 * (t * 1.6).min(1.0)) as u8;
        unsafe {
            MoveWindow(hwnd, cx, y, w, h, 1);
            set_alpha(hwnd, alpha);
        }
        std::thread::sleep(std::time::Duration::from_millis(12));
    }
}

/// Slides the card back out while it fades; the caller then hides the window.
#[cfg(windows)]
fn slide_out(hwnd: isize, generation: u64, x: i32, y: i32, w: i32, h: i32, to_left: bool) {
    const STEPS: i32 = 12;
    let end_x = if to_left { x - w - 40 } else { x + w + 40 };
    for step in 0..=STEPS {
        if NOTIF_GEN.load(Ordering::Relaxed) != generation {
            return;
        }
        let t = step as f32 / STEPS as f32;
        let eased = t * t;
        let cx = x + ((end_x - x) as f32 * eased) as i32;
        let alpha = (NOTIF_ALPHA as f32 * (1.0 - t)) as u8;
        unsafe {
            MoveWindow(hwnd, cx, y, w, h, 1);
            set_alpha(hwnd, alpha);
        }
        std::thread::sleep(std::time::Duration::from_millis(14));
    }
}

/* ---------- Window helpers (used by the overlay panel too) ---------- */

/// The window in front of everything right now.
pub fn foreground_window() -> isize {
    #[cfg(windows)]
    unsafe {
        return GetForegroundWindow();
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Brings a window back to the front (focus restore when the panel closes).
pub fn focus_window(hwnd: isize) {
    #[cfg(windows)]
    if hwnd != 0 {
        unsafe {
            SetForegroundWindow(hwnd as *mut core::ffi::c_void);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
    }
}

/// True while `hwnd` still names a live, visible window. The overlay panel
/// follows its game window with this: the running-game watch can flap for
/// titles the launcher did not start, and that must not close the panel.
pub fn window_alive(hwnd: isize) -> bool {
    #[cfg(windows)]
    unsafe {
        if hwnd == 0 {
            return false;
        }
        IsWindow(hwnd) != 0 && IsWindowVisible(hwnd) != 0
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        false
    }
}

/// Retrieves the visible window title text (for detecting games run outside the launcher).
pub fn window_title(hwnd: isize) -> String {
    #[cfg(windows)]
    if hwnd != 0 {
        let mut buf = [0u16; 512];
        let len = unsafe { GetWindowTextW(hwnd, buf.as_mut_ptr(), 512) };
        if len > 0 {
            return String::from_utf16_lossy(&buf[..len as usize]);
        }
    }
    #[cfg(not(windows))]
    let _ = hwnd;
    String::new()
}

/// Largest visible top-level window that belongs to one of `pids` (0 = none).
/// Used to (re)find the game window when a fullscreen switch recreates it.
pub fn find_game_window(pids: &[u32]) -> isize {
    #[cfg(windows)]
    unsafe {
        struct Find<'a> {
            pids: &'a [u32],
            best: isize,
            best_area: i64,
        }
        unsafe extern "system" fn callback(hwnd: isize, lparam: isize) -> i32 {
            let state = &mut *(lparam as *mut Find);
            if IsWindowVisible(hwnd) == 0 {
                return 1;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, &mut pid);
            if !state.pids.contains(&pid) {
                return 1;
            }
            let mut rect = RECT::default();
            if GetWindowRect(hwnd, &mut rect) == 0 {
                return 1;
            }
            let area =
                (rect.right - rect.left).max(0) as i64 * (rect.bottom - rect.top).max(0) as i64;
            if area > state.best_area {
                state.best_area = area;
                state.best = hwnd;
            }
            1
        }
        if pids.is_empty() {
            return 0;
        }
        let mut state = Find {
            pids,
            best: 0,
            best_area: 0,
        };
        let _ = EnumWindows(Some(callback), &mut state as *mut Find as isize);
        state.best
    }
    #[cfg(not(windows))]
    {
        let _ = pids;
        0
    }
}

/// Full monitor rectangle (x, y, width, height) that hosts `hwnd`, or the
/// monitor under the cursor when no window is known.
pub fn monitor_rect_for(hwnd: isize) -> Option<(i32, i32, u32, u32)> {
    #[cfg(windows)]
    {
        unsafe {
            let monitor = if hwnd != 0 {
                MonitorFromWindow(hwnd, 2) // MONITOR_DEFAULTTONEAREST
            } else {
                MonitorFromPoint(POINT { x: 0, y: 0 }, 2)
            };
            if monitor == 0 {
                return None;
            }
            let mut info = MONITORINFO {
                cb_size: std::mem::size_of::<MONITORINFO>() as u32,
                rc_monitor: RECT::default(),
                rc_work: RECT::default(),
                flags: 0,
            };
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return None;
            }
            let r = info.rc_monitor;
            return Some((
                r.left,
                r.top,
                (r.right - r.left).max(320) as u32,
                (r.bottom - r.top).max(240) as u32,
            ));
        }
    }
    #[cfg(not(windows))]
    {
        let _ = hwnd;
        None
    }
}

#[cfg(windows)]
fn monitor_top_left() -> (i32, i32) {
    monitor_rect_for(foreground_window())
        .map(|(x, y, _, _)| (x, y))
        .unwrap_or((0, 0))
}

/* ---------- Win32 plumbing ---------- */

#[cfg(windows)]
#[repr(C)]
#[derive(Default, Clone, Copy)]
struct RECT {
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
}

#[cfg(windows)]
#[repr(C)]
#[derive(Default)]
struct MONITORINFO {
    cb_size: u32,
    rc_monitor: RECT,
    rc_work: RECT,
    flags: u32,
}

#[cfg(windows)]
#[repr(C)]
struct POINT {
    x: i32,
    y: i32,
}

#[cfg(windows)]
#[repr(C)]
struct WNDCLASSW {
    style: u32,
    lpfn_wnd_proc: Option<unsafe extern "system" fn(isize, u32, usize, isize) -> isize>,
    cb_cls_extra: i32,
    cb_wnd_extra: i32,
    h_instance: isize,
    h_icon: isize,
    h_cursor: isize,
    hbr_background: isize,
    lpsz_menu_name: *const u16,
    lpsz_class_name: *const u16,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetForegroundWindow() -> isize;
    // Same signature as the declaration in main.rs so the two agree.
    fn SetForegroundWindow(hwnd: *mut core::ffi::c_void) -> i32;
    pub fn SetWindowPos(
        hwnd: *mut core::ffi::c_void,
        hwnd_insert_after: *mut core::ffi::c_void,
        x: i32,
        y: i32,
        cx: i32,
        cy: i32,
        flags: u32,
    ) -> i32;
    pub fn GetWindowTextW(hwnd: isize, lp_string: *mut u16, n_max_count: i32) -> i32;
    fn IsWindow(hwnd: isize) -> i32;
    fn IsWindowVisible(hwnd: isize) -> i32;
    fn EnumWindows(
        callback: Option<unsafe extern "system" fn(isize, isize) -> i32>,
        lparam: isize,
    ) -> i32;
    fn GetWindowThreadProcessId(hwnd: isize, pid: *mut u32) -> u32;
    fn GetWindowRect(hwnd: isize, rect: *mut RECT) -> i32;
    fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
    fn MonitorFromPoint(pt: POINT, flags: u32) -> isize;
    fn GetMonitorInfoW(monitor: isize, info: *mut MONITORINFO) -> i32;
    fn RegisterClassW(class: *const WNDCLASSW) -> u16;
    /// Rounds the layered window; the OS takes ownership of the region.
    fn SetWindowRgn(hwnd: isize, region: isize, redraw: i32) -> i32;
    fn CreateWindowExW(
        ex_style: u32,
        class_name: *const u16,
        window_name: *const u16,
        style: u32,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        parent: isize,
        menu: isize,
        instance: isize,
        param: isize,
    ) -> isize;
    fn DefWindowProcW(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize;
    fn ShowWindow(hwnd: isize, cmd: i32) -> i32;
    fn MoveWindow(hwnd: isize, x: i32, y: i32, width: i32, height: i32, repaint: i32) -> i32;
    fn InvalidateRect(hwnd: isize, rect: *const RECT, erase: i32) -> i32;
    fn GetClientRect(hwnd: isize, rect: *mut RECT) -> i32;
    fn BeginPaint(hwnd: isize, paint: *mut u8) -> isize;
    fn EndPaint(hwnd: isize, paint: *const u8) -> i32;
    fn GetMessageW(msg: *mut u8, hwnd: isize, min: u32, max: u32) -> i32;
    fn TranslateMessage(msg: *const u8) -> i32;
    fn DispatchMessageW(msg: *const u8) -> isize;
    fn PostQuitMessage(code: i32);
    fn FillRect(hdc: isize, rect: *const RECT, brush: isize);
    fn DrawTextW(hdc: isize, text: *const u16, count: i32, rect: *mut RECT, format: u32) -> i32;
    fn SetBkMode(hdc: isize, mode: i32) -> i32;
    fn SetTextColor(hdc: isize, color: u32) -> u32;
    fn SelectObject(hdc: isize, object: isize) -> isize;
}

#[cfg(windows)]
#[link(name = "gdi32")]
extern "system" {
    fn CreateSolidBrush(color: u32) -> isize;
    fn DeleteObject(object: isize) -> i32;
    /// Region for the rounded notification card (`x2`/`y2` are exclusive).
    fn CreateRoundRectRgn(
        x1: i32,
        y1: i32,
        x2: i32,
        y2: i32,
        ellipse_w: i32,
        ellipse_h: i32,
    ) -> isize;
    fn FrameRgn(hdc: isize, region: isize, brush: isize, width: i32, height: i32) -> i32;
    fn Ellipse(hdc: isize, left: i32, top: i32, right: i32, bottom: i32) -> i32;
    fn CreateEllipticRgn(left: i32, top: i32, right: i32, bottom: i32) -> isize;
    fn RoundRect(hdc: isize, left: i32, top: i32, right: i32, bottom: i32, width: i32, height: i32) -> i32;
    fn CreateFontW(
        height: i32,
        width: i32,
        escapement: i32,
        orientation: i32,
        weight: i32,
        italic: u32,
        underline: u32,
        strike_out: u32,
        charset: u32,
        out_precision: u32,
        clip_precision: u32,
        quality: u32,
        pitch_and_family: u32,
        face: *const u16,
    ) -> isize;
}

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetModuleHandleW(name: *const u16) -> isize;
}

#[cfg(windows)]
#[repr(C)]
struct GdiplusStartupInput {
    gdiplus_version: u32,
    debug_event_callback: usize,
    suppress_background_thread: i32,
    suppress_external_codecs: i32,
}

#[cfg(windows)]
#[link(name = "gdiplus")]
extern "system" {
    fn GdiplusStartup(
        token: *mut usize,
        input: *const GdiplusStartupInput,
        output: *mut core::ffi::c_void,
    ) -> i32;
    fn GdipCreateFromHDC(hdc: isize, graphics: *mut *mut core::ffi::c_void) -> i32;
    fn GdipLoadImageFromFile(
        filename: *const u16,
        image: *mut *mut core::ffi::c_void,
    ) -> i32;
    fn GdipDrawImageRectI(
        graphics: *mut core::ffi::c_void,
        image: *mut core::ffi::c_void,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
    ) -> i32;
    fn GdipSetClipHrgn(
        graphics: *mut core::ffi::c_void,
        region: isize,
        combine_mode: i32,
    ) -> i32;
    fn GdipResetClip(graphics: *mut core::ffi::c_void) -> i32;
    fn GdipDeleteGraphics(graphics: *mut core::ffi::c_void) -> i32;
    fn GdipDisposeImage(image: *mut core::ffi::c_void) -> i32;
}

/// GDI+ is started once for the process; the codec providers stay loaded. The
/// screenshot module does the same for its encoder, and neither ever shuts it
/// down because the app is long-lived.
#[cfg(windows)]
static GDIPLUS_READY: std::sync::OnceLock<bool> = std::sync::OnceLock::new();

#[cfg(windows)]
fn ensure_gdiplus() -> bool {
    *GDIPLUS_READY.get_or_init(|| unsafe {
        let input = GdiplusStartupInput {
            gdiplus_version: 1,
            debug_event_callback: 0,
            suppress_background_thread: 0,
            suppress_external_codecs: 0,
        };
        let mut token: usize = 0;
        GdiplusStartup(&mut token, &input, std::ptr::null_mut()) == 0
    })
}

#[cfg(windows)]
const WS_POPUP: u32 = 0x8000_0000;
#[cfg(windows)]
const WS_EX_TOPMOST: u32 = 0x0000_0008;
#[cfg(windows)]
const WS_EX_TRANSPARENT: u32 = 0x0000_0020;
#[cfg(windows)]
const WS_EX_TOOLWINDOW: u32 = 0x0000_0080;
#[cfg(windows)]
const WS_EX_LAYERED: u32 = 0x0008_0000;
#[cfg(windows)]
const WS_EX_NOACTIVATE: u32 = 0x0800_0000;
#[cfg(windows)]
const WM_PAINT: u32 = 0x000F;
#[cfg(windows)]
const WM_ERASEBKGND: u32 = 0x0014;
#[cfg(windows)]
const WM_NCHITTEST: u32 = 0x0084;
#[cfg(windows)]
const WM_DESTROY: u32 = 0x0002;
#[cfg(windows)]
const HTTRANSPARENT: isize = -1;
#[cfg(windows)]
const DT_LEFT: u32 = 0x0000;
#[cfg(windows)]
const DT_CENTER: u32 = 0x0001;
#[cfg(windows)]
const DT_VCENTER: u32 = 0x0004;
#[cfg(windows)]
const DT_SINGLELINE: u32 = 0x0020;
#[cfg(windows)]
const DT_NOPREFIX: u32 = 0x0800;
#[cfg(windows)]
const DT_END_ELLIPSIS: u32 = 0x8000;
#[cfg(windows)]
const TRANSPARENT_BK: i32 = 1;

/// Notification title/body: one line, no mnemonic parsing, ellipsis on overflow.
#[cfg(windows)]
const NOTIF_TEXT_FORMAT: u32 = DT_LEFT | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX | DT_END_ELLIPSIS;

#[cfg(windows)]
unsafe extern "system" fn hud_wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    match msg {
        WM_PAINT => {
            let mut paint = [0u8; 128];
            let hdc = BeginPaint(hwnd, paint.as_mut_ptr());
            let mut rect = RECT::default();
            GetClientRect(hwnd, &mut rect);
            if hint_active() {
                paint_notification(hdc, &rect);
            } else {
                paint_hud(hdc, &rect);
            }
            EndPaint(hwnd, paint.as_ptr());
            0
        }
        WM_ERASEBKGND => 1,
        WM_NCHITTEST => HTTRANSPARENT,
        WM_DESTROY => {
            PostQuitMessage(0);
            0
        }
        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

/// The always-on metrics strip: one line on a dark plate.
#[cfg(windows)]
unsafe fn paint_hud(hdc: isize, rect: &RECT) {
    let brush = CreateSolidBrush(0x000E0E12); // COLORREF 0x00BBGGRR
    FillRect(hdc, rect, brush);
    let _ = DeleteObject(brush);
    let font = FONT.load(Ordering::Relaxed);
    if font != 0 {
        SelectObject(hdc, font);
    }
    SetBkMode(hdc, TRANSPARENT_BK);
    SetTextColor(hdc, 0x00F2F2F2);
    if let Ok(text) = TEXT.lock() {
        if text.len() > 1 {
            let mut text_rect = RECT {
                left: 12,
                top: 0,
                right: rect.right - 12,
                bottom: rect.bottom,
            };
            DrawTextW(
                hdc,
                text.as_ptr(),
                (text.len() - 1) as i32,
                &mut text_rect,
                DT_LEFT | DT_VCENTER | DT_SINGLELINE,
            );
        }
    }
}

/// Draws the achievement's own picture inside the medallion, clipped to the
/// disc. False when no picture landed yet, so the card keeps the trophy glyph.
#[cfg(windows)]
unsafe fn paint_medallion_picture(
    hdc: isize,
    center_x: i32,
    center_y: i32,
    radius: i32,
) -> bool {
    let file = match NOTIF_ICON.lock() {
        Ok(slot) => slot.clone(),
        Err(_) => None,
    };
    let Some(file) = file else {
        return false;
    };
    if !ensure_gdiplus() {
        return false;
    }
    let mut graphics: *mut core::ffi::c_void = std::ptr::null_mut();
    if GdipCreateFromHDC(hdc, &mut graphics) != 0 || graphics.is_null() {
        return false;
    }
    let region = CreateEllipticRgn(
        center_x - radius,
        center_y - radius,
        center_x + radius + 1,
        center_y + radius + 1,
    );
    if region == 0 {
        GdipDeleteGraphics(graphics);
        return false;
    }
    // A square picture over a round medallion would break the card's shape, so
    // the draw is skipped when the round clip cannot be installed.
    let clipped = GdipSetClipHrgn(graphics, region, 0) == 0;
    let mut image: *mut core::ffi::c_void = std::ptr::null_mut();
    let mut painted = false;
    if clipped && GdipLoadImageFromFile(file.as_ptr(), &mut image) == 0 && !image.is_null() {
        painted = GdipDrawImageRectI(
            graphics,
            image,
            center_x - radius,
            center_y - radius,
            radius * 2,
            radius * 2,
        ) == 0;
        GdipDisposeImage(image);
    }
    GdipResetClip(graphics);
    let _ = DeleteObject(region);
    GdipDeleteGraphics(graphics);
    painted
}

/// The console-like card: rounded plate, icon disc, bold title, muted body.
#[cfg(windows)]
unsafe fn paint_notification(hdc: isize, rect: &RECT) {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;
    let size_code = NOTIF_SIZE.load(Ordering::Relaxed).min(2) as usize;
    let m = size_metrics(size_code as u8);
    let colors = NOTIF_COLORS
        .lock()
        .map(|colors| *colors)
        .unwrap_or(GOLD_ACHIEVEMENT_CARD);

    // 1. Smoked plate, themed to the launcher surface when the user wants it
    let plate = CreateSolidBrush(colors.background);
    FillRect(hdc, rect, plate);
    let _ = DeleteObject(plate);

    // 2. Accent indicator bar on left edge
    let bar_rect = RECT {
        left: rect.left,
        top: rect.top,
        right: rect.left + m.bar_width,
        bottom: rect.bottom,
    };
    let bar_brush = CreateSolidBrush(colors.accent);
    FillRect(hdc, &bar_rect, bar_brush);
    let _ = DeleteObject(bar_brush);

    // 3. Hairline border
    let diameter = NOTIF_RADIUS * 2;
    let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
    if region != 0 {
        let edge = CreateSolidBrush(colors.border);
        FrameRgn(hdc, region, edge, 1, 1);
        let _ = DeleteObject(edge);
        let _ = DeleteObject(region);
    }

    // 4. Trophy medallion emblem
    let center_x = rect.left + m.left_pad + m.medallion_r;
    let center_y = (rect.top + rect.bottom) / 2;

    // Outer rim
    let rim = CreateSolidBrush(colors.accent);
    let prev_rim = SelectObject(hdc, rim);
    Ellipse(hdc, center_x - m.medallion_r, center_y - m.medallion_r, center_x + m.medallion_r, center_y + m.medallion_r);
    SelectObject(hdc, prev_rim);
    let _ = DeleteObject(rim);

    // Inner velvet medallion plate
    let inner_disc = CreateSolidBrush(shade(colors.background, 62));
    let prev_inner = SelectObject(hdc, inner_disc);
    let inner_r = m.medallion_r - 2;
    Ellipse(hdc, center_x - inner_r, center_y - inner_r, center_x + inner_r, center_y + inner_r);
    SelectObject(hdc, prev_inner);
    let _ = DeleteObject(inner_disc);

    // The achievement's own icon once it has downloaded; the trophy until then.
    if !paint_medallion_picture(hdc, center_x, center_y, inner_r) {
        let icon_font = SIZE_ICON_FONTS[size_code].load(Ordering::Relaxed);
        if icon_font != 0 {
            SetBkMode(hdc, TRANSPARENT_BK);
            SetTextColor(hdc, colors.icon);
            SelectObject(hdc, icon_font);
            let glyph: [u16; 2] = [0xE8D6, 0]; // Segoe MDL2 Trophy
            let half_icon = m.icon_size;
            let mut icon_rect = RECT {
                left: center_x - half_icon,
                top: center_y - half_icon,
                right: center_x + half_icon,
                bottom: center_y + half_icon,
            };
            DrawTextW(
                hdc,
                glyph.as_ptr(),
                1,
                &mut icon_rect,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
            );
        } else {
            let mark = CreateSolidBrush(colors.icon);
            let prev = SelectObject(hdc, mark);
            let bw = m.medallion_r * 2 / 5;
            RoundRect(hdc, center_x - bw, center_y - bw, center_x + bw, center_y + 1, 4, 4);
            RoundRect(hdc, center_x - 2, center_y + 1, center_x + 2, center_y + bw, 2, 2);
            RoundRect(hdc, center_x - bw * 3 / 4, center_y + bw, center_x + bw * 3 / 4, center_y + bw + 3, 2, 2);
            SelectObject(hdc, prev);
            let _ = DeleteObject(mark);
        }
    }

    // Text column: 3-tier layout (Tag, Title, Body)
    SetBkMode(hdc, TRANSPARENT_BK);
    let text_left = rect.left + m.text_left;
    let text_right = rect.right - m.text_right;

    let has_tag = NOTIF_TAG.lock().map(|t| t.len() > 1).unwrap_or(false);

    if has_tag {
        let tag_font = SIZE_TAG_FONTS[size_code].load(Ordering::Relaxed);
        if let Ok(tag) = NOTIF_TAG.lock() {
            if tag.len() > 1 {
                if tag_font != 0 {
                    SelectObject(hdc, tag_font);
                }
                SetTextColor(hdc, colors.accent);
                let mut tag_rect = RECT {
                    left: text_left,
                    top: rect.top + m.tag_top,
                    right: text_right,
                    bottom: rect.top + m.tag_bottom,
                };
                DrawTextW(
                    hdc,
                    tag.as_ptr(),
                    (tag.len() - 1) as i32,
                    &mut tag_rect,
                    NOTIF_TEXT_FORMAT,
                );
            }
        }

        let title_font = SIZE_TITLE_FONTS[size_code].load(Ordering::Relaxed);
        if let Ok(title) = NOTIF_TITLE.lock() {
            if title.len() > 1 {
                if title_font != 0 {
                    SelectObject(hdc, title_font);
                }
                SetTextColor(hdc, colors.title);
                let mut title_rect = RECT {
                    left: text_left,
                    top: rect.top + m.title_top,
                    right: text_right,
                    bottom: rect.top + m.title_bottom,
                };
                DrawTextW(
                    hdc,
                    title.as_ptr(),
                    (title.len() - 1) as i32,
                    &mut title_rect,
                    NOTIF_TEXT_FORMAT,
                );
            }
        }

        let body_font = SIZE_BODY_FONTS[size_code].load(Ordering::Relaxed);
        if let Ok(body) = NOTIF_BODY.lock() {
            if body.len() > 1 {
                if body_font != 0 {
                    SelectObject(hdc, body_font);
                }
                SetTextColor(hdc, colors.body);
                let mut body_rect = RECT {
                    left: text_left,
                    top: rect.top + m.body_top,
                    right: text_right,
                    bottom: rect.top + m.body_bottom,
                };
                DrawTextW(
                    hdc,
                    body.as_ptr(),
                    (body.len() - 1) as i32,
                    &mut body_rect,
                    NOTIF_TEXT_FORMAT,
                );
            }
        }
    } else {
        let title_font = SIZE_TITLE_FONTS[size_code].load(Ordering::Relaxed);
        if let Ok(title) = NOTIF_TITLE.lock() {
            if title.len() > 1 {
                if title_font != 0 {
                    SelectObject(hdc, title_font);
                }
                SetTextColor(hdc, colors.title);
                let mut text_rect = RECT {
                    left: text_left,
                    top: rect.top + m.title_top - 6,
                    right: text_right,
                    bottom: rect.top + m.title_bottom + 6,
                };
                DrawTextW(
                    hdc,
                    title.as_ptr(),
                    (title.len() - 1) as i32,
                    &mut text_rect,
                    NOTIF_TEXT_FORMAT,
                );
            }
        }
        let body_font = SIZE_BODY_FONTS[size_code].load(Ordering::Relaxed);
        if let Ok(body) = NOTIF_BODY.lock() {
            if body.len() > 1 {
                if body_font != 0 {
                    SelectObject(hdc, body_font);
                }
                SetTextColor(hdc, colors.body);
                let mut text_rect = RECT {
                    left: text_left,
                    top: rect.top + m.body_top,
                    right: text_right,
                    bottom: rect.top + m.body_bottom + 6,
                };
                DrawTextW(
                    hdc,
                    body.as_ptr(),
                    (body.len() - 1) as i32,
                    &mut text_rect,
                    NOTIF_TEXT_FORMAT,
                );
            }
        }
    }
}

/// Creates the HUD window on its own thread and pumps its message loop.
#[cfg(windows)]
fn ensure_window() {
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    std::thread::spawn(|| unsafe {
        let class_name: Vec<u16> = "EfxlveOverlayHud\0".encode_utf16().collect();
        let class = WNDCLASSW {
            style: 0,
            lpfn_wnd_proc: Some(hud_wnd_proc),
            cb_cls_extra: 0,
            cb_wnd_extra: 0,
            h_instance: GetModuleHandleW(std::ptr::null()),
            h_icon: 0,
            h_cursor: 0,
            hbr_background: 0,
            lpsz_menu_name: std::ptr::null(),
            lpsz_class_name: class_name.as_ptr(),
        };
        RegisterClassW(&class);
        let face: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
        let font = CreateFontW(-14, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
        FONT.store(font, Ordering::Relaxed);
        let has_glyph = std::path::Path::new(r"C:\Windows\Fonts\segmdl2.ttf").exists();
        let glyph_face: Vec<u16> = if has_glyph {
            "Segoe MDL2 Assets\0".encode_utf16().collect()
        } else {
            Vec::new()
        };

        for i in 0..4 {
            let m = size_metrics(i as u8);
            let tag_f = CreateFontW(-m.tag_px, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
            SIZE_TAG_FONTS[i].store(tag_f, Ordering::Relaxed);
            let title_f = CreateFontW(-m.title_px, 0, 0, 0, 700, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
            SIZE_TITLE_FONTS[i].store(title_f, Ordering::Relaxed);
            let body_f = CreateFontW(-m.body_px, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
            SIZE_BODY_FONTS[i].store(body_f, Ordering::Relaxed);
            if has_glyph {
                let icon_f = CreateFontW(-m.icon_size, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, glyph_face.as_ptr());
                SIZE_ICON_FONTS[i].store(icon_f, Ordering::Relaxed);
            }
        }
        TAG_FONT.store(SIZE_TAG_FONTS[1].load(Ordering::Relaxed), Ordering::Relaxed);
        TITLE_FONT.store(SIZE_TITLE_FONTS[1].load(Ordering::Relaxed), Ordering::Relaxed);
        BODY_FONT.store(SIZE_BODY_FONTS[1].load(Ordering::Relaxed), Ordering::Relaxed);
        ICON_FONT.store(SIZE_ICON_FONTS[1].load(Ordering::Relaxed), Ordering::Relaxed);

        let hwnd = CreateWindowExW(
            WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
            class_name.as_ptr(),
            std::ptr::null(),
            WS_POPUP,
            16,
            16,
            320,
            30,
            0,
            0,
            GetModuleHandleW(std::ptr::null()),
            0,
        );
        if hwnd == 0 {
            return;
        }
        // Alpha-blended dark plate; the window itself is click-through.
        SetLayeredWindowAttributes(hwnd, 0, 215, 0x0000_0002 /* LWA_ALPHA */);
        HWND.store(hwnd, Ordering::SeqCst);

        let mut msg = [0u8; 128];
        while GetMessageW(msg.as_mut_ptr(), 0, 0, 0) > 0 {
            TranslateMessage(msg.as_ptr());
            DispatchMessageW(msg.as_ptr());
        }
    });
    // First caller waits briefly for the window: a one-shot hint must not be
    // lost to the creation race (the metrics HUD retries every second).
    for _ in 0..50 {
        if HWND.load(Ordering::SeqCst) != 0 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn SetLayeredWindowAttributes(hwnd: isize, key: u32, alpha: u8, flags: u32) -> i32;
}

#[cfg(test)]
mod tests {
    use super::{notif_rect, text_px, NOTIF_HEIGHT, NOTIF_MARGIN};

    #[test]
    fn notification_card_sits_at_the_top_right() {
        let (x, y, width, height) = notif_rect(0, 0, 1920, 1080, 0, 200, 400);
        assert_eq!(height, NOTIF_HEIGHT);
        assert_eq!(y, NOTIF_MARGIN);
        // The card hugs the right edge and never leaves a bigger gap.
        assert!(width >= 360);
        assert_eq!(x + width + NOTIF_MARGIN, 1920);
    }

    #[test]
    fn notification_card_fits_an_offset_monitor() {
        let (x, y, width, _) = notif_rect(1920, 100, 1280, 720, 0, 800, 1200);
        assert!(x >= 1920);
        assert!(x + width <= 1920 + 1280 - NOTIF_MARGIN);
        assert_eq!(y, 100 + NOTIF_MARGIN);
    }

    #[test]
    fn notification_card_clamps_to_a_narrow_monitor() {
        let (_, _, width, _) = notif_rect(0, 0, 800, 1080, 0, 2000, 2000);
        assert_eq!(width, 800 - 2 * NOTIF_MARGIN);
    }

    #[test]
    fn a_longer_line_makes_a_wider_card() {
        let (_, _, narrow, _) = notif_rect(0, 0, 1920, 1080, 0, text_px(&[b'a' as u16; 10], 15), 0);
        let (_, _, wide, _) = notif_rect(0, 0, 1920, 1080, 0, text_px(&[b'a' as u16; 80], 15), 0);
        assert!(wide > narrow);
    }

    #[test]
    fn notification_card_can_sit_at_the_bottom_left() {
        let (x, y, width, height) = notif_rect(100, 50, 1920, 1080, 3, 200, 400);
        assert_eq!(x, 100 + NOTIF_MARGIN);
        assert_eq!(y + height + NOTIF_MARGIN, 50 + 1080);
        assert!(width >= 360);
    }

    #[test]
    fn notification_card_can_sit_centered() {
        let (x, y, width, _) = notif_rect(0, 0, 1920, 1080, 4, 200, 400);
        assert_eq!(x, (1920 - width) / 2);
        assert_eq!(y, NOTIF_MARGIN);
        let (_, bottom_y, _, height) = notif_rect(0, 0, 1920, 1080, 5, 200, 400);
        assert_eq!(bottom_y + height + NOTIF_MARGIN, 1080);
    }

    #[test]
    fn cjk_glyphs_measure_a_full_em() {
        let cjk = text_px(&[0x65E5, 0x672C], 15);
        let latin = text_px(&[b'a' as u16, b'b' as u16], 15);
        assert_eq!(cjk, 30);
        assert!(latin < cjk);
    }

    /// The medallion draws the achievement's picture through GDI+; a broken
    /// declaration or a missing codec must not silently paint nothing.
    #[test]
    #[cfg(windows)]
    fn a_downloaded_icon_paints_inside_the_medallion() {
        use std::os::windows::ffi::OsStrExt;

        #[link(name = "user32")]
        extern "system" {
            fn GetDC(hwnd: isize) -> isize;
            fn ReleaseDC(hwnd: isize, hdc: isize) -> i32;
        }
        #[link(name = "gdi32")]
        extern "system" {
            fn CreateCompatibleDC(hdc: isize) -> isize;
            fn CreateCompatibleBitmap(hdc: isize, width: i32, height: i32) -> isize;
            fn DeleteDC(hdc: isize) -> i32;
        }

        // A one-pixel PNG: enough for the decoder to answer with a bitmap.
        let bytes: Vec<u8> = vec![
            0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48,
            0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
            0x00, 0x1F, 0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0A, 0x49, 0x44, 0x41, 0x54, 0x78,
            0x9C, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00,
            0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
        ];
        let path = std::env::temp_dir().join(format!(
            "efxlve-achievement-icon-{}.png",
            std::process::id()
        ));
        std::fs::write(&path, &bytes).expect("write the test picture");
        let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
        wide.push(0);
        *super::NOTIF_ICON.lock().expect("icon slot") = Some(wide);

        unsafe {
            let screen = GetDC(0);
            let dc = CreateCompatibleDC(screen);
            let bitmap = CreateCompatibleBitmap(screen, 64, 64);
            let previous = super::SelectObject(dc, bitmap);
            assert!(
                super::paint_medallion_picture(dc, 32, 32, 24),
                "the icon decodes and draws"
            );
            super::SelectObject(dc, previous);
            super::DeleteObject(bitmap);
            DeleteDC(dc);
            ReleaseDC(0, screen);
        }
        *super::NOTIF_ICON.lock().expect("icon slot") = None;
        let _ = std::fs::remove_file(&path);
    }
}
