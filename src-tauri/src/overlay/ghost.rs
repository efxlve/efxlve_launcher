//! Ghost mode: the closed panel stays on screen as a click-through HUD.
//!
//! A pinned widget must stay readable over the game while every mouse and
//! keyboard event belongs to the game. The panel keeps its WebView2 renderer;
//! only the Win32 window becomes transparent to input. The achievement toast
//! proved the recipe (`toast.rs`): `WS_EX_LAYERED` makes the pass-through
//! global, `WS_EX_TRANSPARENT` plus a `WM_NCHITTEST -> HTTRANSPARENT` subclass
//! handles the top-level window, and every WebView2 child window gets the same
//! flag or it keeps swallowing clicks.
//!
//! `prepare` runs once, before the panel's first show. Toggling the layered bit
//! on a visible window can drop DWM per-pixel transparency, so it is never
//! removed; only the transparent/no-activate bits move with ghost mode.

#![allow(clashing_extern_declarations)]

use tauri::WebviewWindow;

#[cfg(windows)]
use std::sync::atomic::{AtomicIsize, Ordering};

/// The panel's original window procedure, restored when ghost mode ends.
#[cfg(windows)]
static OLD_PROC: AtomicIsize = AtomicIsize::new(0);

#[cfg(windows)]
const GWL_EXSTYLE: i32 = -20;
#[cfg(windows)]
const GWLP_WNDPROC: i32 = -4;
#[cfg(windows)]
const WS_EX_TRANSPARENT: isize = 0x0000_0020;
#[cfg(windows)]
const WS_EX_LAYERED: isize = 0x0008_0000;
#[cfg(windows)]
const WS_EX_NOACTIVATE: isize = 0x0800_0000;
#[cfg(windows)]
const WM_NCHITTEST: u32 = 0x0084;
#[cfg(windows)]
const HTTRANSPARENT: isize = -1;

/// Adds `WS_EX_LAYERED` before the panel is first shown.
///
/// The overlay page is per-pixel transparent through DWM. Ghost mode needs the
/// layered style for pass-through that reaches other processes, but adding it
/// to an already visible window can repaint the page as an opaque sheet. The
/// safe order is: build hidden, prepare, then show.
#[cfg(windows)]
pub fn prepare(win: &WebviewWindow) {
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as isize;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ex & WS_EX_LAYERED == 0 {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_LAYERED);
        }
    }
}

#[cfg(not(windows))]
pub fn prepare(_win: &WebviewWindow) {}

/// Turns the panel's mouse/keyboard pass-through on or off.
///
/// On: the window and all of its WebView2 children ignore the mouse, and the
/// window stops taking activation. Off: every flag and the original window
/// procedure come back, so the next Shift+Tab focuses a normal panel.
#[cfg(windows)]
pub fn set_click_through(win: &WebviewWindow, on: bool) {
    let Ok(hwnd) = win.hwnd() else {
        return;
    };
    let hwnd = hwnd.0 as isize;
    unsafe {
        let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let next = if on {
            ex | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_NOACTIVATE
        } else {
            // Layered stays: removing it after the first show can drop the
            // per-pixel alpha the whole panel is built on.
            (ex & !(WS_EX_TRANSPARENT | WS_EX_NOACTIVATE)) | WS_EX_LAYERED
        };
        if next != ex {
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
        }

        if on {
            let proc = ghost_proc as *const () as isize;
            let current = GetWindowLongPtrW(hwnd, GWLP_WNDPROC);
            if current != proc {
                OLD_PROC.store(current, Ordering::Relaxed);
                SetWindowLongPtrW(hwnd, GWLP_WNDPROC, proc);
            }
            EnumChildWindows(hwnd, Some(mark_child), 0);
        } else {
            // The call is idempotent: `show`/`hide_now` always run it so a
            // close that raced another close cannot leave stale input flags.
            let had_flags = ex & (WS_EX_TRANSPARENT | WS_EX_NOACTIVATE) != 0;
            let old = OLD_PROC.swap(0, Ordering::Relaxed);
            if old != 0
                && GetWindowLongPtrW(hwnd, GWLP_WNDPROC) == ghost_proc as *const () as isize
            {
                SetWindowLongPtrW(hwnd, GWLP_WNDPROC, old);
            }
            if had_flags || old != 0 {
                EnumChildWindows(hwnd, Some(unmark_child), 0);
            }
        }
    }
}

#[cfg(not(windows))]
pub fn set_click_through(_win: &WebviewWindow, _on: bool) {}

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
unsafe extern "system" fn ghost_proc(hwnd: isize, msg: u32, wparam: usize, lparam: isize) -> isize {
    if msg == WM_NCHITTEST {
        // Let the click reach the game below the pinned card.
        return HTTRANSPARENT;
    }
    let old = OLD_PROC.load(Ordering::Relaxed);
    if old != 0 {
        CallWindowProcW(old, hwnd, msg, wparam, lparam)
    } else {
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(windows)]
unsafe extern "system" fn mark_child(hwnd: isize, _param: isize) -> i32 {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex | WS_EX_TRANSPARENT);
    1
}

#[cfg(windows)]
unsafe extern "system" fn unmark_child(hwnd: isize, _param: isize) -> i32 {
    let ex = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex & !WS_EX_TRANSPARENT);
    1
}
