//! Native always-on mini HUD strip and small Win32 window helpers.
//!
//! The metrics plate is plain GDI on one layered, topmost, never-activating
//! window. Achievement cards are no longer painted here: the in-game toast is a
//! transparent, click-through WebView2 window (`overlay/toast.rs`) that renders
//! the same component as the Settings preview.

#![allow(clashing_extern_declarations)]

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, AtomicIsize, Ordering};
use std::sync::{Mutex, OnceLock};

static STARTED: AtomicBool = AtomicBool::new(false);
static HWND: AtomicIsize = AtomicIsize::new(0);
static FONT: AtomicIsize = AtomicIsize::new(0);
static TEXT: Mutex<Vec<u16>> = Mutex::new(Vec::new());

/// Appearance of the native always-on strip. The metrics worker reads `mode`
/// when it builds the line; the window thread reads `corner` and `color`.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HudConfig {
    /// "minimal", "compact" or "full".
    pub mode: String,
    /// "top-left", "top-right", "bottom-left" or "bottom-right".
    pub corner: String,
    /// "#rrggbb".
    pub color: String,
}

impl Default for HudConfig {
    fn default() -> Self {
        Self {
            mode: "compact".to_string(),
            corner: "top-left".to_string(),
            color: "#f2f2f2".to_string(),
        }
    }
}

static CONFIG: OnceLock<Mutex<HudConfig>> = OnceLock::new();

fn config_state() -> &'static Mutex<HudConfig> {
    CONFIG.get_or_init(|| Mutex::new(HudConfig::default()))
}

/// Stores the strip's mode, corner and text color. The next metrics tick moves
/// and repaints it; a color change also invalidates the current plate.
pub fn configure(config: HudConfig) {
    let config = sanitize(config);
    if let Ok(mut slot) = config_state().lock() {
        *slot = config;
    }
    #[cfg(windows)]
    {
        let hwnd = HWND.load(Ordering::Relaxed);
        if hwnd != 0 {
            unsafe {
                InvalidateRect(hwnd, std::ptr::null(), 0);
            }
        }
    }
}

/// The line layout the metrics worker should build.
pub fn mode() -> String {
    config_state()
        .lock()
        .map(|config| config.mode.clone())
        .unwrap_or_else(|_| "compact".to_string())
}

#[tauri::command]
pub fn overlay_set_hud_config(config: HudConfig) {
    configure(config);
}

fn sanitize(mut config: HudConfig) -> HudConfig {
    config.mode = match config.mode.as_str() {
        "minimal" | "compact" | "full" => config.mode,
        _ => "compact".to_string(),
    };
    config.corner = match config.corner.as_str() {
        "top-left" | "top-right" | "bottom-left" | "bottom-right" => config.corner,
        _ => "top-left".to_string(),
    };
    let hex = config.color.trim().trim_start_matches('#');
    config.color = if hex.len() == 6 && hex.chars().all(|ch| ch.is_ascii_hexdigit()) {
        format!("#{}", hex.to_ascii_lowercase())
    } else {
        "#f2f2f2".to_string()
    };
    config
}

/// COLORREF is 0x00BBGGRR, not the #rrggbb the frontend stores.
fn colorref(value: &str) -> u32 {
    let hex = value.trim_start_matches('#');
    if hex.len() == 6 {
        let red = u8::from_str_radix(&hex[0..2], 16).unwrap_or(242) as u32;
        let green = u8::from_str_radix(&hex[2..4], 16).unwrap_or(242) as u32;
        let blue = u8::from_str_radix(&hex[4..6], 16).unwrap_or(242) as u32;
        (blue << 16) | (green << 8) | red
    } else {
        0x00F2F2F2
    }
}

/// Cuts the current HUD line into a UTF-16 buffer for GDI.
#[cfg(windows)]
pub fn update(text: &str) {
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
    let config = config_state()
        .lock()
        .map(|config| config.clone())
        .unwrap_or_default();
    let (left, top, monitor_w, monitor_h) =
        monitor_rect_for(foreground_window()).unwrap_or((0, 0, 1920, 1080));
    let width = ((text.chars().count() as i32) * 8 + 28).max(160);
    let height = 30;
    let margin = 16;
    let (x, y) = match config.corner.as_str() {
        "top-right" => (
            left + monitor_w as i32 - width - margin,
            top + margin,
        ),
        "bottom-left" => (
            left + margin,
            top + monitor_h as i32 - height - margin,
        ),
        "bottom-right" => (
            left + monitor_w as i32 - width - margin,
            top + monitor_h as i32 - height - margin,
        ),
        _ => (left + margin, top + margin),
    };
    unsafe {
        MoveWindow(hwnd, x, y, width, height, 1);
        set_alpha(hwnd, 215);
        ShowWindow(hwnd, 4); // SW_SHOWNOACTIVATE
        InvalidateRect(hwnd, std::ptr::null(), 0);
    }
}

#[cfg(not(windows))]
pub fn update(_text: &str) {}

pub fn hide() {
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

/* ---------- Window helpers (used by the overlay panel and the toast) ---------- */

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

/// Re-asserts the topmost band without moving, sizing or activating the window.
/// A game can raise its own window above a topmost toast; this puts the card
/// back on top right after it appears (and again a moment later).
pub fn raise_topmost(hwnd: isize) {
    #[cfg(windows)]
    if hwnd != 0 {
        unsafe {
            SetWindowPos(
                hwnd as *mut core::ffi::c_void,
                -1isize as *mut core::ffi::c_void, // HWND_TOPMOST
                0,
                0,
                0,
                0,
                0x0001 | 0x0002 | 0x0010 | 0x0040, // NOSIZE | NOMOVE | NOACTIVATE | SHOWWINDOW
            );
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
    fn SetLayeredWindowAttributes(hwnd: isize, key: u32, alpha: u8, flags: u32) -> i32;
}

#[cfg(windows)]
#[link(name = "gdi32")]
extern "system" {
    fn CreateSolidBrush(color: u32) -> isize;
    fn DeleteObject(object: isize) -> i32;
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
const DT_VCENTER: u32 = 0x0004;
#[cfg(windows)]
const DT_SINGLELINE: u32 = 0x0020;
#[cfg(windows)]
const TRANSPARENT_BK: i32 = 1;

#[cfg(windows)]
unsafe extern "system" fn hud_wnd_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    match msg {
        WM_PAINT => {
            let mut paint = [0u8; 128];
            let hdc = BeginPaint(hwnd, paint.as_mut_ptr());
            let mut rect = RECT::default();
            GetClientRect(hwnd, &mut rect);
            paint_hud(hdc, &rect);
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
    let color = config_state()
        .lock()
        .map(|config| colorref(&config.color))
        .unwrap_or(0x00F2F2F2);
    SetTextColor(hdc, color);
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

/// Creates the HUD strip font.
#[cfg(windows)]
fn create_hud_font() {
    if FONT.load(Ordering::Relaxed) != 0 {
        return;
    }
    unsafe {
        let face: Vec<u16> = "Segoe UI\0".encode_utf16().collect();
        let font = CreateFontW(-14, 0, 0, 0, 600, 0, 0, 0, 1, 0, 0, 0, 0, face.as_ptr());
        FONT.store(font, Ordering::Relaxed);
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
        create_hud_font();

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
unsafe fn set_alpha(hwnd: isize, alpha: u8) {
    SetLayeredWindowAttributes(hwnd, 0, alpha, 0x0000_0002 /* LWA_ALPHA */);
}

#[cfg(test)]
mod tests {
    use super::{colorref, sanitize, HudConfig};

    #[test]
    fn colorref_is_bgr() {
        assert_eq!(colorref("#112233"), 0x00332211);
        assert_eq!(colorref("nope"), 0x00F2F2F2);
    }

    #[test]
    fn hud_config_is_clamped() {
        let config = sanitize(HudConfig {
            mode: "huge".to_string(),
            corner: "middle".to_string(),
            color: "#12345".to_string(),
        });
        assert_eq!(config.mode, "compact");
        assert_eq!(config.corner, "top-left");
        assert_eq!(config.color, "#f2f2f2");
    }
}
