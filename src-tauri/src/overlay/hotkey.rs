//! Shift+Tab listener for the overlay panel.
//!
//! Same no-hook model as the screenshot hotkey: poll `GetAsyncKeyState` while a
//! game runs, and only while the game (or the panel itself) is in front.

use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::{hide, show, STATE};

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

pub(crate) fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut gone_ticks: u32 = 0;
        loop {
            std::thread::sleep(Duration::from_millis(20));

            let (visible, enabled, game_hwnd, cur_app, cur_title) = STATE
                .lock()
                .map(|s| (s.visible, s.enabled, s.game_hwnd, s.game_app.clone(), s.game_title.clone()))
                .unwrap_or((false, true, 0, String::new(), String::new()));

            if visible {
                if game_hwnd != 0 && !super::hud::window_alive(game_hwnd) {
                    // A dead handle can just mean the game recreated its window
                    // (fullscreen switch): re-find it by pid before counting it
                    // gone, so the panel does not close itself mid-session.
                    let mut found = 0isize;
                    if !cur_app.is_empty() {
                        let pids = crate::legendary::screenshots::active_game_pids();
                        found = super::hud::find_game_window(&pids);
                    }
                    if found != 0 {
                        if let Ok(mut s) = STATE.lock() {
                            s.game_hwnd = found;
                        }
                        gone_ticks = 0;
                    } else {
                        gone_ticks = gone_ticks.saturating_add(1);
                        if gone_ticks >= 75 {
                            gone_ticks = 0;
                            hide(&app);
                        }
                    }
                } else {
                    gone_ticks = 0;
                }
            } else {
                gone_ticks = 0;
            }

            #[cfg(windows)]
            {
                let shift = (unsafe { GetAsyncKeyState(0x10) } as i16) < 0; // VK_SHIFT
                let tab = (unsafe { GetAsyncKeyState(0x09) } as i16) < 0; // VK_TAB
                let pad_down = is_controller_hotkey_down();
                let down = (shift && tab) || pad_down;

                if down != hotkey_down() {
                    set_hotkey_down(down);
                    if down && enabled {
                        if visible {
                            hide(&app);
                        } else {
                            let fg = super::hud::foreground_window();
                            let main_hwnd = app
                                .get_webview_window("main")
                                .and_then(|w| w.hwnd().ok())
                                .map(|h| h.0 as isize)
                                .unwrap_or(0);

                            // In launcher: allow Controller Guide to open, but let Shift+Tab do normal web tab navigation
                            if fg != 0 && fg == main_hwnd && !pad_down {
                                continue;
                            }

                            // Capture game window
                            let mut hwnd = fg;
                            if !super::hud::window_alive(hwnd) {
                                let pids = crate::legendary::screenshots::active_game_pids();
                                let found = super::hud::find_game_window(&pids);
                                if found != 0 {
                                    hwnd = found;
                                }
                            }

                            // Determine game identity
                            let mut app_name = cur_app.clone();
                            let mut title = cur_title.clone();

                            if app_name.is_empty() {
                                if let Some((active_app, active_title)) = crate::legendary::screenshots::get_active_running_game() {
                                    app_name = active_app;
                                    title = active_title;
                                } else {
                                    let w_title = super::hud::window_title(hwnd);
                                    if !w_title.is_empty() {
                                        app_name = format!("game::{}", w_title);
                                        title = w_title;
                                    }
                                }
                            }

                            if let Ok(mut s) = STATE.lock() {
                                s.game_hwnd = hwnd;
                                if !app_name.is_empty() {
                                    s.game_app = app_name;
                                    s.game_title = title;
                                }
                            }

                            show(&app);
                        }
                    }
                }
            }

            #[cfg(not(windows))]
            {
                let _ = &app;
                std::thread::sleep(Duration::from_millis(250));
            }
        }
    });
}

#[cfg(windows)]
fn hotkey_down() -> bool {
    HOTKEY_DOWN.load(std::sync::atomic::Ordering::Relaxed)
}

#[cfg(windows)]
fn set_hotkey_down(down: bool) {
    HOTKEY_DOWN.store(down, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(windows)]
static HOTKEY_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(windows)]
#[repr(C)]
struct XInputGamepad {
    w_buttons: u16,
    b_left_trigger: u8,
    b_right_trigger: u8,
    s_thumb_lx: i16,
    s_thumb_ly: i16,
    s_thumb_rx: i16,
    s_thumb_ry: i16,
}

#[cfg(windows)]
#[repr(C)]
struct XInputState {
    dw_packet_number: u32,
    gamepad: XInputGamepad,
}

#[cfg(windows)]
type XInputGetStateFn = unsafe extern "system" fn(u32, *mut XInputState) -> u32;

#[cfg(windows)]
fn get_xinput_fn() -> Option<XInputGetStateFn> {
    use std::sync::OnceLock;
    static FN_PTR: OnceLock<Option<XInputGetStateFn>> = OnceLock::new();
    *FN_PTR.get_or_init(|| unsafe {
        #[link(name = "kernel32")]
        extern "system" {
            fn LoadLibraryA(name: *const u8) -> isize;
            fn GetProcAddress(module: isize, proc_name: *const u8) -> usize;
        }

        let dlls = [
            b"xinput1_4.dll\0".as_ptr(),
            b"xinput1_3.dll\0".as_ptr(),
            b"xinput9_1_0.dll\0".as_ptr(),
        ];
        for dll in dlls {
            let mod_handle = LoadLibraryA(dll);
            if mod_handle != 0 {
                // Ordinal 100 is XInputGetStateEx which exposes the Guide button (0x0400).
                let p100 = GetProcAddress(mod_handle, 100 as *const u8);
                if p100 != 0 {
                    return Some(std::mem::transmute::<usize, XInputGetStateFn>(p100));
                }
                let p_named = GetProcAddress(mod_handle, b"XInputGetState\0".as_ptr());
                if p_named != 0 {
                    return Some(std::mem::transmute::<usize, XInputGetStateFn>(p_named));
                }
            }
        }
        None
    })
}

#[cfg(windows)]
fn is_controller_hotkey_down() -> bool {
    let Some(get_state) = get_xinput_fn() else {
        return false;
    };
    for user_index in 0..4 {
        let mut state = std::mem::MaybeUninit::<XInputState>::uninit();
        if unsafe { get_state(user_index, state.as_mut_ptr()) } == 0 {
            let state = unsafe { state.assume_init() };
            let btns = state.gamepad.w_buttons;
            // 0x0400 = Guide (Xbox) button via XInputGetStateEx
            // 0x0030 = Start (0x0010) + Back (0x0020) universal combo
            if (btns & 0x0400) != 0 || (btns & 0x0030) == 0x0030 {
                return true;
            }
        }
    }
    false
}

#[cfg(not(windows))]
fn is_controller_hotkey_down() -> bool {
    false
}

