//! Watch a Steam game launched from Efxlve, then quit the Steam client.
//!
//! Steamworks DRM needs `steam.exe` while the game is open. This module hides
//! the Steam window once the game process appears, waits until it exits, gives
//! Steam a short window to flush cloud saves, then runs `steam.exe -shutdown`.

use std::path::PathBuf;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::legendary::transfers::{discover_game_executables, is_game_process_running};
use crate::steam::{installed_games, steam_install_path};

static WATCHED: Mutex<Option<String>> = Mutex::new(None);

fn still_watching(app_id: &str) -> bool {
    WATCHED.lock().ok().and_then(|slot| slot.clone()) == Some(app_id.to_string())
}

fn set_watched(app_id: Option<String>) {
    if let Ok(mut slot) = WATCHED.lock() {
        *slot = app_id;
    }
}

#[cfg(windows)]
fn hide_steam_window() {
    type HWND = *mut std::ffi::c_void;
    type BOOL = i32;
    const SW_HIDE: i32 = 0;

    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(lp_class_name: *const u16, lp_window_name: *const u16) -> HWND;
        fn ShowWindow(h_wnd: HWND, n_cmd_show: i32) -> BOOL;
    }

    let title: Vec<u16> = "Steam".encode_utf16().chain(std::iter::once(0)).collect();
    unsafe {
        let hwnd = FindWindowW(std::ptr::null(), title.as_ptr());
        if !hwnd.is_null() {
            ShowWindow(hwnd, SW_HIDE);
        }
    }
}

#[cfg(not(windows))]
fn hide_steam_window() {}

fn shutdown_steam() {
    let Some(steam) = steam_install_path() else {
        return;
    };
    let mut command = std::process::Command::new(steam.join("steam.exe"));
    command.arg("-shutdown");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    let _ = command.spawn();
}

fn install_path_for(app_id: &str) -> Option<PathBuf> {
    let steam = steam_install_path()?;
    let game = installed_games(&steam)
        .into_iter()
        .find(|g| g.app_id == app_id)?;
    if game.install_dir.is_empty() {
        return None;
    }
    Some(
        PathBuf::from(game.library)
            .join("common")
            .join(game.install_dir),
    )
}

fn emit_status(app: &AppHandle, app_id: &str, running: bool) {
    let _ = app.emit(
        "game-status",
        serde_json::json!({
            "id": format!("steam::{app_id}"),
            "running": running,
        }),
    );
}

fn watch_thread(app: AppHandle, app_id: String) {
    let Some(install) = install_path_for(&app_id) else {
        return;
    };
    let exes = discover_game_executables(&install, None);
    let tick = Duration::from_millis(1500);

    let mut seen = false;
    for _ in 0..80 {
        if !still_watching(&app_id) {
            return;
        }
        if is_game_process_running(Some(&install), &exes) {
            seen = true;
            hide_steam_window();
            emit_status(&app, &app_id, true);
            break;
        }
        thread::sleep(tick);
    }
    if !seen {
        return;
    }

    let mut misses = 0;
    loop {
        if !still_watching(&app_id) {
            return;
        }
        if is_game_process_running(Some(&install), &exes) {
            misses = 0;
        } else {
            misses += 1;
            if misses >= 3 {
                break;
            }
        }
        thread::sleep(tick);
    }

    // Steam Cloud writes remotecache.vdf just after the game exits.
    thread::sleep(Duration::from_secs(4));
    if !still_watching(&app_id) {
        return;
    }
    shutdown_steam();
    emit_status(&app, &app_id, false);
    set_watched(None);
}

/// Starts (or replaces) a session watch after Efxlve handed a launch to Steam.
#[tauri::command]
pub fn steam_watch_session(app: AppHandle, app_id: String) -> Result<(), String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    set_watched(Some(app_id.clone()));
    thread::Builder::new()
        .name("steam-session".into())
        .spawn(move || watch_thread(app, app_id))
        .map_err(|e| e.to_string())?;
    Ok(())
}
