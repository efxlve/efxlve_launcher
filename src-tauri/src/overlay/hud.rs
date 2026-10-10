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

use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicU64, Ordering};
use std::sync::Mutex;

static STARTED: AtomicBool = AtomicBool::new(false);
static HWND: AtomicIsize = AtomicIsize::new(0);
static FONT: AtomicIsize = AtomicIsize::new(0);
static TITLE_FONT: AtomicIsize = AtomicIsize::new(0);
static BODY_FONT: AtomicIsize = AtomicIsize::new(0);
static ICON_FONT: AtomicIsize = AtomicIsize::new(0);
static TEXT: Mutex<Vec<u16>> = Mutex::new(Vec::new());
/// A notification card owns the plate while this is true.
static NOTIF_ON: AtomicBool = AtomicBool::new(false);
static NOTIF_TITLE: Mutex<Vec<u16>> = Mutex::new(Vec::new());
static NOTIF_BODY: Mutex<Vec<u16>> = Mutex::new(Vec::new());
/// The card stays until this epoch-ms timestamp.
static NOTIF_UNTIL: AtomicU64 = AtomicU64::new(0);
/// Bumped per card; a stale animation thread must not hide a newer one.
static NOTIF_GEN: AtomicU64 = AtomicU64::new(0);

/// PS5-like notification card: icon disc, bold title, muted body line.
const NOTIF_HEIGHT: i32 = 68;
const NOTIF_MARGIN: i32 = 24;
const NOTIF_MIN_WIDTH: i32 = 360;
const NOTIF_RADIUS: i32 = 12;
const NOTIF_TITLE_PX: i32 = 15;
const NOTIF_BODY_PX: i32 = 13;
const NOTIF_ALPHA: u8 = 242;
const NOTIF_HOLD_MS: u64 = 5200;
/// Text column: 16px pad + 32px icon disc + 14px gap.
const NOTIF_TEXT_LEFT: i32 = 62;
const NOTIF_TEXT_RIGHT: i32 = 18;

/// Top-right card rect on the given monitor. Pure math, unit-tested.
fn notif_rect(
    mon_x: i32,
    mon_y: i32,
    mon_w: u32,
    title_px: i32,
    body_px: i32,
) -> (i32, i32, i32, i32) {
    let max_width = (mon_w as i32 - 2 * NOTIF_MARGIN).max(NOTIF_MIN_WIDTH);
    let text_width = title_px.max(body_px).max(1);
    let width = (NOTIF_TEXT_LEFT + NOTIF_TEXT_RIGHT + text_width).clamp(NOTIF_MIN_WIDTH, max_width);
    let x = mon_x + mon_w as i32 - width - NOTIF_MARGIN;
    (x, mon_y + NOTIF_MARGIN, width, NOTIF_HEIGHT)
}

/// Rough pixel advance of a UTF-16 line: CJK ideographs take a full em, Latin
/// and the rest about half. Pure math, unit-tested.
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

/// Shows a PS5-like system notification over the game (game start: the overlay
/// hint). Reuses the HUD window: a Windows toast is invisible for many setups,
/// this card is not. `title` is the bold line, `body` the muted one.
pub fn notify(title: &str, body: &str) {
    #[cfg(windows)]
    {
        ensure_window();
        {
            let mut wide = title.encode_utf16().collect::<Vec<u16>>();
            wide.push(0);
            if let Ok(mut slot) = NOTIF_TITLE.lock() {
                *slot = wide;
            }
            let mut wide = body.encode_utf16().collect::<Vec<u16>>();
            wide.push(0);
            if let Ok(mut slot) = NOTIF_BODY.lock() {
                *slot = wide;
            }
        }
        NOTIF_ON.store(true, Ordering::SeqCst);
        NOTIF_UNTIL.store(now_ms() + NOTIF_HOLD_MS, Ordering::Relaxed);
        let generation = NOTIF_GEN.fetch_add(1, Ordering::Relaxed) + 1;
        let hwnd = HWND.load(Ordering::SeqCst);
        if hwnd == 0 {
            return;
        }

        let (mon_x, mon_y, mon_w, _) =
            monitor_rect_for(foreground_window()).unwrap_or((0, 0, 1920, 1080));
        let title_px = text_px(&title.encode_utf16().collect::<Vec<u16>>(), NOTIF_TITLE_PX);
        let body_px = text_px(&body.encode_utf16().collect::<Vec<u16>>(), NOTIF_BODY_PX);
        let (x, y, w, h) = notif_rect(mon_x, mon_y, mon_w, title_px, body_px);
        let start_x = mon_x + mon_w as i32 + 8;

        unsafe {
            shape_notification(hwnd, w, h);
            // Park the card past the right edge; the paint lands as it slides in.
            MoveWindow(hwnd, start_x, y, w, h, 1);
            set_alpha(hwnd, 0);
            ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
            InvalidateRect(hwnd, std::ptr::null(), 0);
        }

        std::thread::spawn(move || {
            slide_in(hwnd, generation, start_x, x, y, w, h);
            // Hold the card until its deadline unless a newer one supersedes it.
            while NOTIF_GEN.load(Ordering::Relaxed) == generation
                && NOTIF_ON.load(Ordering::Relaxed)
                && now_ms() < NOTIF_UNTIL.load(Ordering::Relaxed)
            {
                std::thread::sleep(std::time::Duration::from_millis(40));
            }
            if NOTIF_GEN.load(Ordering::Relaxed) != generation {
                return;
            }
            slide_out(hwnd, generation, x, y, w, h);
            if NOTIF_GEN.load(Ordering::Relaxed) == generation {
                NOTIF_ON.store(false, Ordering::SeqCst);
                hide_window();
            }
        });
    }
    #[cfg(not(windows))]
    {
        let _ = (title, body);
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
fn slide_out(hwnd: isize, generation: u64, x: i32, y: i32, w: i32, h: i32) {
    const STEPS: i32 = 12;
    let end_x = x + w + 40;
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

/// The PS5-like card: rounded plate, icon disc, bold title, muted body.
#[cfg(windows)]
unsafe fn paint_notification(hdc: isize, rect: &RECT) {
    let width = rect.right - rect.left;
    let height = rect.bottom - rect.top;

    let plate = CreateSolidBrush(0x001E1E1E); // Launcher surface-3 (#1e1e1e)
    FillRect(hdc, rect, plate);
    let _ = DeleteObject(plate);

    // Hairline border; the region keeps it rounded.
    let diameter = NOTIF_RADIUS * 2;
    let region = CreateRoundRectRgn(0, 0, width + 1, height + 1, diameter, diameter);
    if region != 0 {
        let edge = CreateSolidBrush(0x003C3A3C); // COLORREF is 0x00BBGGRR
        FrameRgn(hdc, region, edge, 1, 1);
        let _ = DeleteObject(edge);
        let _ = DeleteObject(region);
    }

    // Icon: a white disc with the launcher's game mark, like the primary button.
    let center_x = rect.left + 16 + 16;
    let center_y = (rect.top + rect.bottom) / 2;
    let disc = CreateSolidBrush(0x00FFFFFF);
    let previous = SelectObject(hdc, disc);
    Ellipse(hdc, center_x - 16, center_y - 16, center_x + 16, center_y + 16);
    SelectObject(hdc, previous);
    let _ = DeleteObject(disc);

    let icon_font = ICON_FONT.load(Ordering::Relaxed);
    if icon_font != 0 {
        SetBkMode(hdc, TRANSPARENT_BK);
        SetTextColor(hdc, 0x00000000);
        SelectObject(hdc, icon_font);
        let glyph: [u16; 2] = [0xE7FC, 0]; // Segoe MDL2 "Game"
        let mut icon_rect = RECT {
            left: center_x - 16,
            top: center_y - 16,
            right: center_x + 16,
            bottom: center_y + 16,
        };
        DrawTextW(
            hdc,
            glyph.as_ptr(),
            1,
            &mut icon_rect,
            DT_CENTER | DT_VCENTER | DT_SINGLELINE | DT_NOPREFIX,
        );
    } else {
        // No icon font on this system: a plain mark keeps the disc alive.
        let mark = CreateSolidBrush(0x00000000);
        let previous = SelectObject(hdc, mark);
        RoundRect(hdc, center_x - 9, center_y - 7, center_x + 9, center_y + 7, 6, 6);
        SelectObject(hdc, previous);
        let _ = DeleteObject(mark);
    }

    // Text column: bold title over a muted body line.
    SetBkMode(hdc, TRANSPARENT_BK);
    let text_left = rect.left + NOTIF_TEXT_LEFT;
    let text_right = rect.right - NOTIF_TEXT_RIGHT;
    let title_font = TITLE_FONT.load(Ordering::Relaxed);
    if let Ok(title) = NOTIF_TITLE.lock() {
        if title.len() > 1 {
            if title_font != 0 {
                SelectObject(hdc, title_font);
            }
            SetTextColor(hdc, 0x00FFFFFF);
            let mut text_rect = RECT {
                left: text_left,
                top: rect.top + 13,
                right: text_right,
                bottom: rect.top + 35,
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
    let body_font = BODY_FONT.load(Ordering::Relaxed);
    if let Ok(body) = NOTIF_BODY.lock() {
        if body.len() > 1 {
            if body_font != 0 {
                SelectObject(hdc, body_font);
            }
            SetTextColor(hdc, 0x00A5A5A5);
            let mut text_rect = RECT {
                left: text_left,
                top: rect.top + 35,
                right: text_right,
                bottom: rect.top + 57,
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
        let title_font = CreateFontW(
            -NOTIF_TITLE_PX, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr(),
        );
        TITLE_FONT.store(title_font, Ordering::Relaxed);
        let body_font = CreateFontW(
            -NOTIF_BODY_PX, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr(),
        );
        BODY_FONT.store(body_font, Ordering::Relaxed);
        // The MDL2 glyph font ships with Windows 10+; the disc falls back to a
        // drawn mark when it is missing.
        if std::path::Path::new(r"C:\Windows\Fonts\segmdl2.ttf").exists() {
            let glyph_face: Vec<u16> = "Segoe MDL2 Assets\0".encode_utf16().collect();
            let icon_font = CreateFontW(
                -16, 0, 0, 0, 400, 0, 0, 0, 1, 0, 0, 0, 0, glyph_face.as_ptr(),
            );
            ICON_FONT.store(icon_font, Ordering::Relaxed);
        }

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
        let (x, y, width, height) = notif_rect(0, 0, 1920, 200, 400);
        assert_eq!(height, NOTIF_HEIGHT);
        assert_eq!(y, NOTIF_MARGIN);
        // The card hugs the right edge and never leaves a bigger gap.
        assert!(width >= 360);
        assert_eq!(x + width + NOTIF_MARGIN, 1920);
    }

    #[test]
    fn notification_card_fits_an_offset_monitor() {
        let (x, y, width, _) = notif_rect(1920, 100, 1280, 800, 1200);
        assert!(x >= 1920);
        assert!(x + width <= 1920 + 1280 - NOTIF_MARGIN);
        assert_eq!(y, 100 + NOTIF_MARGIN);
    }

    #[test]
    fn notification_card_clamps_to_a_narrow_monitor() {
        let (_, _, width, _) = notif_rect(0, 0, 800, 2000, 2000);
        assert_eq!(width, 800 - 2 * NOTIF_MARGIN);
    }

    #[test]
    fn a_longer_line_makes_a_wider_card() {
        let (_, _, narrow, _) = notif_rect(0, 0, 1920, text_px(&[b'a' as u16; 10], 15), 0);
        let (_, _, wide, _) = notif_rect(0, 0, 1920, text_px(&[b'a' as u16; 40], 15), 0);
        assert!(wide > narrow);
    }

    #[test]
    fn cjk_glyphs_measure_a_full_em() {
        let cjk = text_px(&[0x65E5, 0x672C], 15);
        let latin = text_px(&[b'a' as u16, b'b' as u16], 15);
        assert_eq!(cjk, 30);
        assert!(latin < cjk);
    }
}
