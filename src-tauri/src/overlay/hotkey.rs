//! Overlay hotkey listener.
//!
//! Same no-hook model as the screenshot hotkey: poll `GetAsyncKeyState` while a
//! game runs, and also while the launcher itself is in front — the panel has a
//! launcher mode, so the overlay is usable from the moment the app opens.
//!
//! The listener idles instead of polling whenever the overlay is switched off or
//! the running game opted out. That is deliberate: no key polling and no overlay
//! window for a multiplayer title the user does not want the overlay near.
//!
//! Linux/macOS have no listener: there is no global key polling there, and the
//! panel opens from the launcher header and the tray menu instead.

#[cfg(windows)]
use std::time::Duration;
use tauri::AppHandle;

#[cfg(windows)]
use super::{crosshair, hide, hide_now, show, STATE};

/// Linux/macOS: the overlay has no global hotkey, so there is no thread to run.
#[cfg(not(windows))]
pub(crate) fn start(_app: AppHandle) {}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn GetAsyncKeyState(v_key: i32) -> i16;
}

#[cfg(windows)]
const VK_SHIFT: i32 = 0x10;
#[cfg(windows)]
const VK_CONTROL: i32 = 0x11;
#[cfg(windows)]
const VK_ALT: i32 = 0x12;
#[cfg(windows)]
const VK_TAB: i32 = 0x09;
#[cfg(windows)]
const VK_X: i32 = 0x58;

#[cfg(windows)]
pub(crate) fn start(app: AppHandle) {
    std::thread::spawn(move || {
        let mut gone_ticks: u32 = 0;
        // Pad probe bookkeeping: see the throttle below.
        let mut tick: u32 = 0;
        let mut pad_down = false;
        loop {
            let (visible, ghost, enabled, game_disabled, capturing, combo, game_hwnd, has_game) = STATE
                .lock()
                .map(|s| {
                    (
                        s.visible,
                        s.ghost,
                        s.enabled,
                        s.game_disabled,
                        s.capturing,
                        s.combo,
                        s.game_hwnd,
                        !s.game_app.is_empty(),
                    )
                })
                .unwrap_or((false, false, true, false, false, None, 0, false));
            // Ghost mode is an active overlay without input: the hotkey must
            // still wake it, and the game-window watch must still close it.
            let active = visible || ghost;

            // Switched off, or this game opted out: sleep without touching the
            // keyboard. The window is already gone (the command tore it down).
            if !enabled || game_disabled {
                if active {
                    hide_now(&app);
                }
                gone_ticks = 0;
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }

            // The panel is only useful over the launcher or a running game.
            // While the launcher sits in the tray/minimized and no game is
            // active, a 20 ms keyboard/pad poll would keep waking the machine
            // for a shortcut that has no target.
            if should_idle(active, has_game, launcher_on_screen(&app)) {
                gone_ticks = 0;
                std::thread::sleep(Duration::from_millis(250));
                continue;
            }

            std::thread::sleep(Duration::from_millis(20));

            if active {
                if game_hwnd != 0 && !super::hud::window_alive(game_hwnd) {
                    // A dead handle can just mean the game recreated its window
                    // (fullscreen switch): re-find it by pid before counting it
                    // gone, so the panel does not close itself mid-session.
                    let mut found = 0isize;
                    let (cur_app, _) = game_identity();
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
                            // A dead game ends the ghost HUD, the crosshair and
                            // the corner player; they must not float over the
                            // desktop.
                            crosshair::hide_window();
                            if super::browser::is_pip() {
                                super::browser::hide_window(&app);
                            }
                            hide_now(&app);
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
                // XInput costs four calls per probe; the pad combination is a
                // hold, so probing every fourth tick (80 ms) still catches it.
                tick = tick.wrapping_add(1);
                if tick % 4 == 0 {
                    pad_down = is_controller_hotkey_down();
                }
                // The Settings recorder owns the keyboard while it listens; the
                // old combination must not open the panel over the capture.
                let down = !capturing && (combo_down(combo) || pad_down);

                if down != hotkey_down() {
                    set_hotkey_down(down);
                    if down && enabled {
                        if visible {
                            hide(&app);
                        } else {
                            // The launcher is a valid target now: the panel has a
                            // launcher mode, so Shift+Tab works before any game.
                            let fg = super::hud::foreground_window();
                            let mut hwnd = fg;
                            if !super::hud::window_alive(hwnd) {
                                let pids = crate::legendary::screenshots::active_game_pids();
                                let found = super::hud::find_game_window(&pids);
                                if found != 0 {
                                    hwnd = found;
                                }
                            }

                            // Determine game identity
                            let (mut app_name, mut title) = game_identity();

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

                // Ctrl+Shift+X: the crosshair is an independent surface and
                // works while the panel is open or closed.
                let cross_down = !capturing
                    && key_down(VK_CONTROL)
                    && key_down(VK_SHIFT)
                    && !key_down(VK_ALT)
                    && key_down(VK_X);
                if cross_down != CROSSHAIR_DOWN.load(std::sync::atomic::Ordering::Relaxed) {
                    CROSSHAIR_DOWN.store(cross_down, std::sync::atomic::Ordering::Relaxed);
                    if cross_down {
                        crosshair::toggle();
                    }
                }
                // The game window can move monitors; recentre every ~2 s.
                if tick % 100 == 0 {
                    crosshair::reposition();
                }
            }
        }
    });
}

/// Idles the listener only when neither the launcher nor a running game owns
/// the shortcut. The launcher mode must keep its 20 ms response; a game keeps
/// the panel armed even while another window has focus. A visible but
/// unfocused launcher also stays awake, so an untracked game can still use the
/// global shortcut.
#[cfg(windows)]
fn should_idle(active: bool, has_game: bool, launcher_on_screen: bool) -> bool {
    !active && !has_game && !launcher_on_screen
}

#[cfg(windows)]
fn launcher_on_screen(app: &tauri::AppHandle) -> bool {
    use tauri::Manager;
    let Some(window) = app.get_window("main") else {
        return false;
    };
    window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false)
}

#[cfg(windows)]
/// True while the configured combination is held.
///
/// Modifiers must match exactly: a user who puts the overlay on `ctrl+k` does
/// not expect `ctrl+shift+k` (text selection) to open a panel over the game.
fn combo_down(combo: Option<super::HotkeyCombo>) -> bool {
    let Some(combo) = combo else {
        // Nothing configured yet: Shift+Tab, the historical default.
        return key_down(VK_SHIFT) && !key_down(VK_CONTROL) && !key_down(VK_ALT) && key_down(VK_TAB);
    };
    key_down(combo.vk)
        && key_down(VK_CONTROL) == combo.ctrl
        && key_down(VK_SHIFT) == combo.shift
        && key_down(VK_ALT) == combo.alt
}

#[cfg(windows)]
fn key_down(vk: i32) -> bool {
    (unsafe { GetAsyncKeyState(vk) } as i16) < 0
}

/// The game the panel would attach to, read on demand.
///
/// The tick used to clone both strings every 20 ms for a value only a hotkey
/// edge or a dead game window actually reads.
#[cfg(windows)]
fn game_identity() -> (String, String) {
    STATE
        .lock()
        .map(|s| (s.game_app.clone(), s.game_title.clone()))
        .unwrap_or_default()
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
static CROSSHAIR_DOWN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

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

#[cfg(all(test, windows))]
mod tests {
    use super::should_idle;

    #[test]
    fn idles_only_without_a_target() {
        assert!(should_idle(false, false, false));
        assert!(!should_idle(true, false, false));
        assert!(!should_idle(false, true, false));
        assert!(!should_idle(false, false, true));
    }
}

