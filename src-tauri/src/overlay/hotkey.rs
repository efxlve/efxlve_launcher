//! Shift+Tab listener for the overlay panel.
//!
//! Same no-hook model as the screenshot hotkey: poll `GetAsyncKeyState` while a
//! game runs, and only while the game (or the panel itself) is in front.

use std::time::Duration;
use tauri::AppHandle;

use super::{hide, show, STATE};

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

pub(crate) fn start(app: AppHandle) {
    std::thread::spawn(move || {
        // Ticks where the game watch says stopped AND the game window is gone.
        // Window recreation (fullscreen switches) must not close the panel.
        let mut gone_ticks: u32 = 0;
        loop {
            let game = crate::legendary::screenshots::get_active_running_game();
            let (mut visible, mut game_hwnd) = STATE
                .lock()
                .map(|s| (s.visible, s.game_hwnd))
                .unwrap_or((false, 0));

            if visible {
                // A window handle can go stale while the watch still knows the
                // game (fullscreen switches recreate windows). Re-find it by pid.
                if !super::hud::window_alive(game_hwnd) && game.is_some() {
                    let pids = crate::legendary::screenshots::active_game_pids();
                    let found = super::hud::find_game_window(&pids);
                    if found != 0 && found != game_hwnd {
                        game_hwnd = found;
                        if let Ok(mut s) = STATE.lock() {
                            s.game_hwnd = found;
                        }
                    }
                }
                // Only a known, dead game window closes the panel automatically.
                // Without a handle the user closes it; guessing would shut it
                // under games whose process detection is unreliable.
                let gone = game.is_none()
                    && game_hwnd != 0
                    && !super::hud::window_alive(game_hwnd);
                gone_ticks = if gone { gone_ticks.saturating_add(1) } else { 0 };
                if gone_ticks >= 75 {
                    gone_ticks = 0;
                    hide(&app);
                    visible = false;
                    if let Ok(mut s) = STATE.lock() {
                        s.game_app.clear();
                        s.game_title.clear();
                        s.game_hwnd = 0;
                    }
                }
            } else {
                gone_ticks = 0;
                if game.is_none() {
                    if let Ok(mut s) = STATE.lock() {
                        s.game_app.clear();
                        s.game_title.clear();
                        s.game_hwnd = 0;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                // Panel closed: the hotkey only works in front of the game.
                #[cfg(windows)]
                if !crate::legendary::screenshots::game_window_is_foreground() {
                    std::thread::sleep(Duration::from_millis(120));
                    continue;
                }
            }

            #[cfg(windows)]
            {
                std::thread::sleep(Duration::from_millis(20));

                let enabled = STATE.lock().map(|s| s.enabled).unwrap_or(false);
                let shift = (unsafe { GetAsyncKeyState(0x10) } as u16 & 0x8000) != 0; // VK_SHIFT
                let tab = (unsafe { GetAsyncKeyState(0x09) } as u16 & 0x8000) != 0; // VK_TAB
                let down = (shift && tab) || is_controller_hotkey_down();

                if down != hotkey_down() {
                    set_hotkey_down(down);
                    if down && enabled {
                        if visible {
                            hide(&app);
                        } else {
                            // Capture the game window: the foreground window is
                            // normally it; the pid search covers wrappers.
                            let mut hwnd = super::hud::foreground_window();
                            if !super::hud::window_alive(hwnd) {
                                let pids = crate::legendary::screenshots::active_game_pids();
                                let found = super::hud::find_game_window(&pids);
                                if found != 0 {
                                    hwnd = found;
                                }
                            }
                            if let Ok(mut s) = STATE.lock() {
                                s.game_hwnd = hwnd;
                                if let Some((app_name, title)) = &game {
                                    s.game_app = app_name.clone();
                                    s.game_title = title.clone();
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

