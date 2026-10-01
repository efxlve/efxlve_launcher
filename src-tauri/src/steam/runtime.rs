//! Steam install location and "is the client running" probe.
//!
//! Owns the registry lookup, `steam.pid`, and the path-key used to compare
//! library folders. Does not parse manifests or talk to the network.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use crate::winreg;

/// Steam install directory from the registry (`SteamPath` / `InstallPath`).
pub fn steam_install_path() -> Option<PathBuf> {
    let hkcu = winreg::query(r"HKCU\Software\Valve\Steam", Some("SteamPath"));
    let hklm = winreg::query(
        r"HKLM\SOFTWARE\WOW6432Node\Valve\Steam",
        Some("InstallPath"),
    );
    let raw = hkcu
        .as_deref()
        .map(winreg::parse_reg_sz)
        .filter(|p| !p.is_empty())
        .or_else(|| {
            hklm.as_deref()
                .map(winreg::parse_reg_sz)
                .filter(|p| !p.is_empty())
        })?;
    let path = PathBuf::from(raw);
    if path.is_dir() {
        Some(path)
    } else {
        None
    }
}

/// PID written by the Steam client into `steam.pid`. Zero / junk is ignored.
pub(super) fn parse_steam_pid(raw: &str) -> Option<u32> {
    let pid = raw.trim().parse::<u32>().ok()?;
    (pid != 0).then_some(pid)
}

/// Last process probe. `installed_games` runs on every manifest write; a missing
/// `steam.pid` (Steam is open but never wrote the file) must not snapshot every
/// process on the machine each time.
pub(super) static STEAM_RUNNING_CACHE: Mutex<Option<(Instant, bool)>> = Mutex::new(None);

/// True while the Steam client process from `steam.pid` is still alive.
///
/// ACF `StateFlags` and leftover `downloading/` folders survive after Steam
/// exits, so live-download UI must not trust those files unless the client is
/// actually running.
pub(super) fn steam_client_running(steam: &Path) -> bool {
    if let Ok(slot) = STEAM_RUNNING_CACHE.lock() {
        if let Some((at, running)) = *slot {
            if at.elapsed() < Duration::from_secs(2) {
                return running;
            }
        }
    }
    let running = steam_client_running_now(steam);
    if let Ok(mut slot) = STEAM_RUNNING_CACHE.lock() {
        *slot = Some((Instant::now(), running));
    }
    running
}

pub(super) fn steam_client_running_now(steam: &Path) -> bool {
    if let Ok(raw) = std::fs::read_to_string(steam.join("steam.pid")) {
        if let Some(pid) = parse_steam_pid(&raw) {
            if pid_is_alive(pid) {
                return true;
            }
        }
    }
    #[cfg(windows)]
    {
        crate::legendary::transfers::is_game_process_running(None, &["steam.exe".to_string()])
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
mod win_pid {
    type HANDLE = *mut std::ffi::c_void;
    type BOOL = i32;
    type DWORD = u32;
    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;
    const STILL_ACTIVE: DWORD = 259;

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
        fn GetExitCodeProcess(hProcess: HANDLE, lpExitCode: *mut DWORD) -> BOOL;
        fn CloseHandle(hObject: HANDLE) -> BOOL;
    }

    pub fn is_alive(pid: u32) -> bool {
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return false;
            }
            let mut code: DWORD = 0;
            let ok = GetExitCodeProcess(handle, &mut code) != 0;
            CloseHandle(handle);
            ok && code == STILL_ACTIVE
        }
    }
}

#[cfg(windows)]
pub(super) fn pid_is_alive(pid: u32) -> bool {
    win_pid::is_alive(pid)
}

#[cfg(not(windows))]
pub(super) fn pid_is_alive(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).is_dir()
}

/// Normalized path key for case-insensitive Windows comparisons.
pub(super) fn path_key(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}
