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
    std::thread::spawn(move || loop {
        let game = crate::legendary::screenshots::get_active_running_game();
        let visible = STATE.lock().map(|s| s.visible).unwrap_or(false);

        // A game that exited takes the panel with it.
        if game.is_none() {
            if visible {
                hide(&app);
            }
            if let Ok(mut s) = STATE.lock() {
                s.game_app.clear();
                s.game_title.clear();
                s.game_hwnd = 0;
            }
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }

        #[cfg(windows)]
        {
            // Not in front of the game and the panel is closed: nothing to do.
            if !visible && !crate::legendary::screenshots::game_window_is_foreground() {
                std::thread::sleep(Duration::from_millis(120));
                continue;
            }
            std::thread::sleep(Duration::from_millis(20));

            let enabled = STATE.lock().map(|s| s.enabled).unwrap_or(false);
            let shift = (unsafe { GetAsyncKeyState(0x10) } as u16 & 0x8000) != 0; // VK_SHIFT
            let tab = (unsafe { GetAsyncKeyState(0x09) } as u16 & 0x8000) != 0; // VK_TAB
            let down = shift && tab;

            if down != hotkey_down() {
                set_hotkey_down(down);
                if down && enabled {
                    if visible {
                        hide(&app);
                    } else {
                        let hwnd = super::hud::foreground_window();
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
