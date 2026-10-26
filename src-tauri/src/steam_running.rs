//! Watches Steam's own per-app `Running` flag.
//!
//! Steam writes `HKCU\Software\Valve\Steam\Apps\<appid>\Running` while a game is
//! open, no matter who started it. Polling that flag lets the launcher show the
//! Running badge (and Recently played) for games started from the Steam client
//! or a desktop shortcut, not just the ones Efxlve handed over.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// The registry read is a few microseconds; three seconds keeps the badge
/// responsive without waking the app for long.
const POLL: Duration = Duration::from_secs(3);

#[cfg(windows)]
const APPS_SUBKEY: &str = r"Software\Valve\Steam\Apps";

static STARTED: AtomicBool = AtomicBool::new(false);

/// App ids whose `Running` value is `0x1`.
///
/// One direct registry walk instead of spawning `reg query` every poll: the
/// helper process was visible as a recurring CPU/process spike in the task
/// manager while the launcher sat in the background.
#[cfg(windows)]
fn running_app_ids() -> HashSet<String> {
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{ERROR_NO_MORE_ITEMS, ERROR_SUCCESS};
    use windows::Win32::System::Registry::{
        RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegQueryValueExW, HKEY, HKEY_CURRENT_USER,
        KEY_QUERY_VALUE, KEY_READ, REG_VALUE_TYPE,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let mut out = HashSet::new();
    let apps = wide(APPS_SUBKEY);
    unsafe {
        let mut apps_key = HKEY::default();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(apps.as_ptr()),
            None,
            KEY_READ,
            &mut apps_key,
        ) != ERROR_SUCCESS
        {
            return out;
        }

        let mut index = 0u32;
        loop {
            let mut name = [0u16; 64];
            let mut name_len = name.len() as u32;
            let status = RegEnumKeyExW(
                apps_key,
                index,
                Some(PWSTR(name.as_mut_ptr())),
                &mut name_len,
                None,
                None,
                None,
                None,
            );
            if status == ERROR_NO_MORE_ITEMS {
                break;
            }
            if status != ERROR_SUCCESS {
                break;
            }
            index += 1;
            let app_id = String::from_utf16_lossy(&name[..name_len as usize]);
            if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }

            let subkey = wide(&app_id);
            let mut app_key = HKEY::default();
            if RegOpenKeyExW(
                apps_key,
                PCWSTR(subkey.as_ptr()),
                None,
                KEY_QUERY_VALUE,
                &mut app_key,
            ) != ERROR_SUCCESS
            {
                continue;
            }
            let value_name = wide("Running");
            let mut kind = REG_VALUE_TYPE::default();
            let mut value = 0u32;
            let mut size = std::mem::size_of::<u32>() as u32;
            let status = RegQueryValueExW(
                app_key,
                PCWSTR(value_name.as_ptr()),
                None,
                Some(&mut kind),
                Some(&mut value as *mut u32 as *mut u8),
                Some(&mut size),
            );
            let _ = RegCloseKey(app_key);
            if status == ERROR_SUCCESS && is_running_value(kind.0, value) {
                out.insert(app_id);
            }
        }
        let _ = RegCloseKey(apps_key);
    }
    out
}

#[cfg(not(windows))]
fn running_app_ids() -> HashSet<String> {
    HashSet::new()
}

/// `REG_DWORD` from the Windows registry API.
const REG_DWORD_KIND: u32 = 4;

/// Steam writes `Running` as a DWORD; only `1` means the app is open.
fn is_running_value(kind: u32, value: u32) -> bool {
    kind == REG_DWORD_KIND && value == 1
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

fn watch_loop(app: AppHandle, mut last: HashSet<String>) {
    loop {
        thread::sleep(POLL);
        let now = running_app_ids();
        for id in now.difference(&last) {
            emit_status(&app, id, true);
        }
        for id in last.difference(&now) {
            emit_status(&app, id, false);
        }
        last = now;
    }
}

/// Starts the Steam running watcher once and returns the ids running right now,
/// so the UI can seed its state before the first change event arrives.
#[tauri::command]
pub fn steam_watch_running(app: AppHandle) -> Vec<String> {
    let current = running_app_ids();
    if !STARTED.swap(true, Ordering::SeqCst) {
        let baseline = current.clone();
        let handle = app.clone();
        let _ = thread::Builder::new()
            .name("steam-running".into())
            .spawn(move || watch_loop(handle, baseline));
    }
    let mut ids: Vec<String> = current.into_iter().collect();
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_a_running_dword_is_active() {
        assert!(is_running_value(4, 1));
        assert!(!is_running_value(4, 0));
        assert!(!is_running_value(1, 1));
    }
}
