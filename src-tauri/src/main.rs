// Prevents an extra console window from opening on Windows.
#![windows_subsystem = "windows"]

mod cloud_backup;
mod comet;
mod companion;
mod controller;
mod controller_bridge;
mod eos;
mod egl_removal;
mod gogdl;
mod launchers;
mod legendary;
mod nile;
mod net_diag;
mod game_running;
mod presence;
mod shared_library;
mod steam;
mod steam_art;
mod steam_auth;
mod steam_running;
mod steam_session;
mod steam_watch;
mod storage_usage;
mod notif_overlay;
mod store_host;
mod vault_id;
mod winreg;

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

pub struct AppState {
    pub epic_dl: Mutex<legendary::transfers::EpicDlState>,
}

/// Game requested on the command line (`--launch <app>`), consumed once by the UI.
pub struct PendingLaunch(pub Mutex<Option<String>>);

/// Reads `--launch <app>` / `--launch=<app>` from the process arguments.
fn parse_launch_arg(args: impl Iterator<Item = String>) -> Option<String> {
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        if arg == "--launch" {
            return args.next().filter(|v| !v.trim().is_empty());
        }
        if let Some(value) = arg.strip_prefix("--launch=") {
            let value = value.trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Returns the pending `--launch` game once, then clears it.
#[tauri::command]
fn epic_take_pending_launch(state: tauri::State<'_, PendingLaunch>) -> Option<String> {
    state.0.lock().ok().and_then(|mut guard| guard.take())
}

#[cfg(test)]
mod launch_arg_tests {
    use super::parse_launch_arg;

    fn parse(args: &[&str]) -> Option<String> {
        parse_launch_arg(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn reads_launch_argument_in_both_forms() {
        assert_eq!(parse(&["--launch", "Sugar"]), Some("Sugar".into()));
        assert_eq!(parse(&["--launch=Sugar"]), Some("Sugar".into()));
        assert_eq!(parse(&["--launch=\"Sugar\""]), Some("Sugar".into()));
        assert_eq!(
            parse(&["--other", "--launch", "Sugar", "--x"]),
            Some("Sugar".into())
        );
    }

    #[test]
    fn ignores_missing_or_empty_values() {
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&["--launch"]), None);
        assert_eq!(parse(&["--launch", "  "]), None);
        assert_eq!(parse(&["--launch="]), None);
        assert_eq!(parse(&["--launcher", "x"]), None);
    }
}

/// When set, closing the window hides it to the system tray instead of quitting
/// so downloads keep running in the background.
#[derive(Default)]
pub struct TrayPref {
    pub minimize_to_tray: std::sync::atomic::AtomicBool,
}

#[tauri::command]
fn app_set_minimize_to_tray(enabled: bool, state: tauri::State<'_, TrayPref>) {
    state
        .minimize_to_tray
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
}

/// Epic/Legendary settings (`<app_data>/settings.json`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EpicSettings {
    #[serde(default)]
    pub install_dir: Option<String>,
    /// Default folder for GOG installs (empty = `%USERPROFILE%\Games\GOG`).
    #[serde(default)]
    pub gog_install_dir: Option<String>,
    #[serde(default)]
    pub network_profile: Option<String>,
    #[serde(default)]
    pub offline_mode: Option<bool>,
    #[serde(default)]
    pub steamgrid_api_key: Option<String>,
    /// Steam Web API key (opt-in): unlocks achievement reading for Steam games.
    #[serde(default)]
    pub steam_api_key: Option<String>,
    #[serde(default)]
    pub presence_enabled: Option<bool>,
    #[serde(default)]
    pub presence_client_id: Option<String>,
    /// Preferred Epic CDN hostname for downloads (`--preferred-cdn`).
    #[serde(default)]
    pub preferred_cdn: Option<String>,
    /// Root folder for in-game screenshots (`None` = Pictures\Efxlve Screenshots).
    #[serde(default)]
    pub screenshot_dir: Option<String>,
    /// Run Comet (the GOG Communication Service) while a GOG game plays so
    /// in-game achievements unlock without the Galaxy client. On by default.
    #[serde(default)]
    pub gog_comet_enabled: Option<bool>,
    /// Base folder for Amazon Games installs (empty = Nile's default).
    #[serde(default)]
    pub amazon_install_dir: Option<String>,
    #[serde(default = "default_true")]
    pub auto_desktop_shortcut: bool,
}

fn default_true() -> bool {
    true
}

/// Concurrent download workers for a network profile. Epic passes the count to
/// legendary, GOG to gogdl, so both stores share one meaning.
pub fn profile_workers(profile: Option<&str>) -> Option<&'static str> {
    match profile {
        Some("max") => Some("32"),
        Some("low") => Some("2"),
        Some("balanced") => Some("8"),
        _ => None,
    }
}

fn settings_file(app: &AppHandle) -> std::path::PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("settings.json")
}

pub fn load_settings(app: &AppHandle) -> EpicSettings {
    std::fs::read_to_string(settings_file(app))
        .ok()
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

pub fn save_settings(app: &AppHandle, s: &EpicSettings) {
    let path = settings_file(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let Ok(data) = serde_json::to_string_pretty(s) else {
        return;
    };
    // Write aside, then replace, so a crash mid-write cannot leave a truncated file.
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, &data).is_err() {
        return;
    }
    if path.exists() {
        let _ = std::fs::remove_file(&path);
    }
    if std::fs::rename(&tmp, &path).is_err() {
        let _ = std::fs::write(&path, data);
        let _ = std::fs::remove_file(&tmp);
    }
}

#[tauri::command]
fn library_dir(app: AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "unknown".into())
}

/// Opens a folder in the file manager.
/// Note: Rust is used directly instead of the opener plugin, so no capability
/// scope issues occur and every drive is supported.
#[tauri::command]
fn open_folder(path: String) -> Result<String, String> {
    let p = std::path::PathBuf::from(path.trim());
    if !p.is_dir() {
        return Err("@t:win.folderNotFound".to_string());
    }
    #[cfg(windows)]
    let res = std::process::Command::new("explorer").arg(&p).spawn();
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(&p).spawn();
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open").arg(&p).spawn();
    res.map(|_| "@t:win.folderOpened".to_string())
        .map_err(|e| format!("@t:win.folderOpenFailed\u{1f}{e}"))
}

/// Best-effort scan of a game's install directory for the EOS SDK runtime.
/// Only called when a game detail view opens; the frontend caches the result.
/// Runs on a blocking thread so a slow HDD walk never stalls the UI.
#[tauri::command]
async fn epic_detect_eos(install_path: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || detect_eos_blocking(&install_path))
        .await
        .unwrap_or(false)
}

fn detect_eos_blocking(install_path: &str) -> bool {
    fn scan(dir: &std::path::Path, depth: u32, budget: &mut u32) -> bool {
        if depth == 0 || *budget == 0 {
            return false;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return false;
        };
        let mut subdirs = Vec::new();
        for entry in entries.flatten() {
            *budget = budget.saturating_sub(1);
            if *budget == 0 {
                return false;
            }
            let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_dir() {
                if name == "epiconlineservices" {
                    return true;
                }
                subdirs.push(entry.path());
            } else if name.starts_with("eossdk") && name.ends_with(".dll") {
                return true;
            }
        }
        for d in subdirs {
            if scan(&d, depth - 1, budget) {
                return true;
            }
        }
        false
    }

    let root = std::path::Path::new(install_path.trim());
    if !root.is_dir() {
        return false;
    }
    // Fast path for the common Unreal layouts before the bounded walk.
    for rel in [
        "Engine/Binaries/ThirdParty/EOSSDK/Win64/EOSSDK-Win64-Shipping.dll",
        "Engine/Binaries/ThirdParty/EOSSDK/Win32/EOSSDK-Win32-Shipping.dll",
    ] {
        if root.join(rel).is_file() {
            return true;
        }
    }
    let mut budget = 6000u32;
    scan(root, 5, &mut budget)
}

#[tauri::command]
fn app_minimize(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window.minimize().map_err(|e| e.to_string())
}

/// HKCU Run entry that opens the launcher at sign-in.
const AUTOSTART_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_VALUE: &str = "EfxlveLauncher";

#[tauri::command]
fn app_get_autostart() -> bool {
    winreg::query(AUTOSTART_KEY, Some(AUTOSTART_VALUE)).is_some()
}

#[tauri::command]
fn app_set_autostart(enabled: bool) -> Result<(), String> {
    if !enabled {
        let _ = winreg::delete_value(AUTOSTART_KEY, AUTOSTART_VALUE);
        return Ok(());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    // Quoted so a path with spaces stays one argument for Windows.
    let data = format!("\"{}\"", exe.to_string_lossy());
    if winreg::set_string(AUTOSTART_KEY, AUTOSTART_VALUE, &data) {
        Ok(())
    } else {
        Err("@t:settings.autostartFailed".into())
    }
}

#[tauri::command]
fn app_toggle_maximize(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let is_max = window.is_maximized().unwrap_or(false);
    if is_max {
        window.unmaximize().map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        window.maximize().map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
fn app_is_maximized(app: AppHandle) -> Result<bool, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window.is_maximized().map_err(|e| e.to_string())
}

/// Windows 11 draws an accent-colored border on borderless windows. On the
/// pure-black TV shell that border shows up as a light blue line along the
/// bottom edge. Paint it black so it disappears into the background.
#[cfg(windows)]
fn hide_accent_border(window: &tauri::Window) {
    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    #[link(name = "dwmapi")]
    extern "system" {
        fn DwmSetWindowAttribute(
            hwnd: *mut core::ffi::c_void,
            dw_attribute: u32,
            pv_attribute: *const core::ffi::c_void,
            cb_attribute: u32,
        ) -> i32;
    }
    const DWMWA_BORDER_COLOR: u32 = 34;
    // COLORREF black (0x00BBGGRR).
    let color: u32 = 0;
    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd.0,
            DWMWA_BORDER_COLOR,
            &color as *const u32 as *const core::ffi::c_void,
            std::mem::size_of::<u32>() as u32,
        );
    }
}

#[cfg(not(windows))]
fn hide_accent_border(_window: &tauri::Window) {}

#[tauri::command]
fn app_set_fullscreen(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window.set_fullscreen(enabled).map_err(|e| e.to_string())?;
    hide_accent_border(&window);
    Ok(enabled)
}

#[tauri::command]
fn app_close(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window.close().map_err(|e| e.to_string())
}

fn has_active_download(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .epic_dl
        .lock()
        .map(|state| state.active.is_some())
        .unwrap_or(false)
}

/// True while a game session started from this launcher is running. Closing the
/// window must not kill the monitor, or that playtime is never recorded.
fn has_running_game() -> bool {
    legendary::screenshots::get_active_running_game().is_some()
}

#[tauri::command]
fn app_set_decorations(app: AppHandle, decorations: bool) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    window
        .set_decorations(decorations)
        .map_err(|e| e.to_string())
}

/// Tray menu item handles so the frontend can localize their labels.
pub struct TrayItems {
    pub show: tauri::menu::MenuItem<tauri::Wry>,
    pub quit: tauri::menu::MenuItem<tauri::Wry>,
}

/// Sets the tray menu labels from the frontend (translated strings).
#[tauri::command]
fn app_set_tray_labels(
    show: String,
    quit: String,
    items: tauri::State<'_, TrayItems>,
) -> Result<(), String> {
    items.show.set_text(show).map_err(|e| e.to_string())?;
    items.quit.set_text(quit).map_err(|e| e.to_string())?;
    Ok(())
}

/// Builds the system tray icon with a Show / Quit menu. Left click restores the
/// window; the tray keeps the app (and its downloads) alive while hidden.
fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    app.manage(TrayItems {
        show: show.clone(),
        quit: quit.clone(),
    });

    TrayIconBuilder::new()
        .icon(app.default_window_icon().cloned().ok_or("no window icon")?)
        .tooltip("Efxlve Launcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                if has_active_download(app) || has_running_game() {
                    // Keep the backend monitor, downloads and playtime tracking
                    // alive while hidden.
                    if let Some(w) = app.get_window("main") {
                        let _ = w.hide();
                    }
                } else {
                    app.exit(0);
                }
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}

/// `tauri dev` rebuilds by killing the `cargo run` process. On Windows that
/// does not stop this process, so `efxlve-launcher.exe` stays locked, the next
/// link fails, and the dev session exits. Leave as soon as that cargo parent
/// dies so the new build can replace the exe and start again.
#[cfg(windows)]
fn exit_when_cargo_parent_dies() {
    use std::mem::size_of;

    type Handle = *mut core::ffi::c_void;
    type Dword = u32;

    const INVALID_HANDLE: Handle = -1isize as Handle;
    const SNAPPROCESS: Dword = 0x00000002;
    const SYNCHRONIZE: Dword = 0x00100000;

    #[repr(C)]
    struct ProcessEntry {
        size: Dword,
        cnt_usage: Dword,
        pid: Dword,
        heap: usize,
        module: Dword,
        threads: Dword,
        parent_pid: Dword,
        pri: i32,
        flags: Dword,
        exe: [u16; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn GetCurrentProcessId() -> Dword;
        fn CreateToolhelp32Snapshot(flags: Dword, pid: Dword) -> Handle;
        fn Process32FirstW(snap: Handle, entry: *mut ProcessEntry) -> i32;
        fn Process32NextW(snap: Handle, entry: *mut ProcessEntry) -> i32;
        fn OpenProcess(access: Dword, inherit: i32, pid: Dword) -> Handle;
        fn WaitForSingleObject(handle: Handle, millis: Dword) -> Dword;
        fn CloseHandle(handle: Handle) -> i32;
    }

    fn exe_name(wide: &[u16]) -> String {
        let end = wide.iter().position(|c| *c == 0).unwrap_or(wide.len());
        String::from_utf16_lossy(&wide[..end])
            .rsplit(['\\', '/'])
            .next()
            .unwrap_or("")
            .to_ascii_lowercase()
    }

    struct Parent {
        pid: Dword,
        exe: String,
    }

    let parent = unsafe {
        let snap = CreateToolhelp32Snapshot(SNAPPROCESS, 0);
        if snap.is_null() || snap == INVALID_HANDLE {
            return;
        }
        let mut entry = std::mem::zeroed::<ProcessEntry>();
        entry.size = size_of::<ProcessEntry>() as Dword;
        let mut self_parent: Option<Dword> = None;
        let mut names: Vec<(Dword, String)> = Vec::new();
        if Process32FirstW(snap, &mut entry) != 0 {
            let self_pid = GetCurrentProcessId();
            loop {
                if entry.pid == self_pid {
                    self_parent = Some(entry.parent_pid);
                }
                names.push((entry.pid, exe_name(&entry.exe)));
                if Process32NextW(snap, &mut entry) == 0 {
                    break;
                }
            }
        }
        CloseHandle(snap);
        let Some(pid) = self_parent else {
            return;
        };
        let Some(exe) = names.into_iter().find_map(|(id, name)| (id == pid).then_some(name)) else {
            return;
        };
        Parent { pid, exe }
    };
    if parent.exe != "cargo.exe" {
        return;
    }

    let handle = unsafe { OpenProcess(SYNCHRONIZE, 0, parent.pid) };
    if handle.is_null() {
        return;
    }
    // Raw handles are not Send. The watch thread is the only remaining user.
    let handle = handle as usize;
    std::thread::Builder::new()
        .name("dev-parent-watch".into())
        .spawn(move || {
            let handle = handle as Handle;
            // 0 is WAIT_OBJECT_0: the parent process handle was signaled.
            let signaled = unsafe { WaitForSingleObject(handle, u32::MAX) } == 0;
            unsafe { CloseHandle(handle) };
            if signaled {
                std::process::exit(0);
            }
        })
        .ok();
}

#[cfg(not(windows))]
fn exit_when_cargo_parent_dies() {}

/// Ensures only one instance of the launcher runs at a time. If another instance
/// is already running, it brings that instance's window to foreground and exits.
#[cfg(windows)]
fn acquire_single_instance_mutex() -> Option<*mut core::ffi::c_void> {
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateMutexW(
            lpMutexAttributes: *mut core::ffi::c_void,
            bInitialOwner: i32,
            lpName: *const u16,
        ) -> *mut core::ffi::c_void;
        fn GetLastError() -> u32;
    }
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> *mut core::ffi::c_void;
        fn ShowWindow(hWnd: *mut core::ffi::c_void, nCmdShow: i32) -> i32;
        fn SetForegroundWindow(hWnd: *mut core::ffi::c_void) -> i32;
    }

    const ERROR_ALREADY_EXISTS: u32 = 183;
    const SW_RESTORE: i32 = 9;

    let mutex_name: Vec<u16> = "Local\\EfxlveLauncherSingleInstanceMutex\0"
        .encode_utf16()
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 1, mutex_name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        let title: Vec<u16> = "Efxlve Launcher\0".encode_utf16().collect();
        let hwnd = unsafe { FindWindowW(std::ptr::null(), title.as_ptr()) };
        if !hwnd.is_null() {
            unsafe {
                ShowWindow(hwnd, SW_RESTORE);
                SetForegroundWindow(hwnd);
            }
        }
        std::process::exit(0);
    }
    Some(handle)
}

#[cfg(not(windows))]
fn acquire_single_instance_mutex() -> Option<*mut core::ffi::c_void> {
    None
}

fn main() {
    let _instance_mutex = acquire_single_instance_mutex();
    exit_when_cargo_parent_dies();
    // Desktop shortcuts start the launcher with `--launch <app>`; the app name is
    // picked up by the UI after boot and routed through the normal play path.
    let pending_launch = parse_launch_arg(std::env::args().skip(1));

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState {
            epic_dl: Mutex::new(legendary::transfers::EpicDlState::default()),
        })
        .manage(TrayPref::default())
        .manage(PendingLaunch(Mutex::new(pending_launch)))
        .setup(|app| {
            if let Some(win) = app.get_window("main") {
                let _ = win.set_decorations(false);
                hide_accent_border(&win);
            }
            // A marker left behind by a killed/restarted launcher becomes real
            // playtime before anything else reads the store.
            legendary::playtime_session::recover_stale();
            // The hotkey listener must already know the configured folder.
            legendary::screenshots::set_screenshot_root(load_settings(app.handle()).screenshot_dir);
            legendary::screenshots::start_f12_listener(app.handle().clone());
            // Keeps the GOG account visible as online while the launcher runs.
            gogdl::presence::spawn(app.handle().clone());
            // Refreshes linked companion accounts (today: Ubisoft) on a timer.
            companion::start_ubi_sync(app.handle().clone());
            build_tray(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let pref = window.app_handle().state::<TrayPref>();
                if pref
                    .minimize_to_tray
                    .load(std::sync::atomic::Ordering::Relaxed)
                    || has_active_download(&window.app_handle())
                    || has_running_game()
                {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
            if let tauri::WindowEvent::Resized(physical_size) = event {
                store_host::on_main_window_resized(window, *physical_size);
            }
        })
        .invoke_handler(tauri::generate_handler![
            library_dir,
            app_minimize,
            app_get_autostart,
            app_set_autostart,
            launchers::launchers_status,
            app_toggle_maximize,
            app_is_maximized,
            app_set_fullscreen,
            app_close,
            app_set_decorations,
            app_set_minimize_to_tray,
            app_set_tray_labels,
            legendary::commands::epic_setup_status,
            legendary::commands::epic_ensure_binary,
            legendary::commands::epic_list_games,
            legendary::commands::epic_list_installed,
            legendary::commands::epic_list_skipped,
            legendary::commands::epic_cached_library,
            legendary::commands::epic_get_achievements,
            legendary::commands::epic_get_achievements_summary,
            legendary::commands::epic_get_system_requirements,
            legendary::commands::epic_get_hltb,
            legendary::commands::epic_get_critic,
            legendary::wiki::epic_get_wiki_about,
            legendary::commands::epic_detect_egl_games,
            legendary::commands::epic_sync_egl_installed,
            egl_removal::egl_removal_plan,
            egl_removal::egl_launcher_present,
            egl_removal::egl_remove,
            legendary::commands::epic_import_installed_folder,
            legendary::commands::epic_verify_game,
            legendary::commands::epic_get_game_settings,
            legendary::commands::epic_save_game_settings,
            legendary::commands::epic_set_custom_save_path,
            legendary::commands::epic_sync_saves,
            legendary::commands::epic_create_desktop_shortcut,
            legendary::commands::epic_get_game_dlcs,
            legendary::commands::epic_get_install_options,
            legendary::commands::epic_check_updates,
            legendary::commands::epic_get_playtimes,
            legendary::commands::epic_set_playtime,
            legendary::library_playtime::epic_sync_epic_playtimes,
            legendary::commands::epic_get_network_profile,
            legendary::commands::epic_set_network_profile,
            legendary::commands::epic_get_offline_mode,
            legendary::commands::epic_set_offline_mode,
            legendary::commands::epic_get_auto_desktop_shortcut,
            legendary::commands::epic_set_auto_desktop_shortcut,
            legendary::commands::epic_backup_save,
            legendary::commands::epic_list_backups,
            legendary::commands::epic_restore_backup,
            legendary::commands::epic_delete_backup,
            legendary::commands::epic_open_backup_folder,
            legendary::commands::epic_get_collections,
            legendary::commands::epic_save_collection,
            legendary::commands::epic_reorder_collections,
            legendary::commands::epic_delete_collection,
            legendary::commands::epic_set_game_collections,
            legendary::commands::epic_import_egl_collections,
            legendary::commands::epic_login_with_code,
            legendary::commands::epic_import_egl,
            legendary::commands::epic_logout,
            legendary::commands::epic_get_saved_accounts,
            legendary::commands::epic_switch_account,
            legendary::commands::epic_remove_saved_account,
            legendary::commands::epic_get_settings,
            legendary::commands::epic_measure_cdns,
            legendary::commands::epic_set_preferred_cdn,
            legendary::commands::epic_cleanup_cache,
            presence::epic_presence_configure,
            presence::epic_presence_update,
            presence::epic_presence_clear,
            legendary::transfers::epic_install_game,
            legendary::transfers::epic_install_with_options,
            legendary::transfers::epic_resume_pending_download,
            legendary::transfers::epic_pause_download,
            legendary::transfers::epic_resume_download,
            legendary::transfers::epic_reorder_queue,
            legendary::transfers::epic_get_queue,
            legendary::transfers::epic_cancel_download,
            legendary::transfers::epic_uninstall_game,
            legendary::transfers::epic_default_install_dir,
            legendary::transfers::epic_set_install_dir,
            legendary::transfers::epic_launch_game,
            legendary::transfers::epic_stop_game,
            store_host::show_store_view,
            store_host::resize_store_view,
            store_host::hide_store_view,
            store_host::set_store_palette_hold,
            store_host::destroy_store_view,
            notif_overlay::show_notif_overlay,
            notif_overlay::move_notif_overlay,
            notif_overlay::hide_notif_overlay,
            open_folder,
            eos::eos_overlay_status,
            eos::eos_install_redistributable,
            epic_take_pending_launch,
            shared_library::shared_library_index,
            controller::controller_support_status,
            controller_bridge::controller_bridge_start,
            controller_bridge::controller_bridge_stop,
            steam::steam_status,
            steam::steam_open_client,
            steam::steam_open_downloads,
            steam::steam_list_installed,
            steam::steam_app_metadata,
            companion::companion_installed_games,
            companion::companion_library,
            companion::companion_store_status,
            companion::companion_link,
            companion::companion_sync,
            companion::companion_unlink,
            companion::companion_resolve_covers,
            companion::companion_show_login,
            companion::companion_hide_login,
            companion::ea_login_open,
            companion::ea_login_hide,
            companion::xbox_login_open,
            companion::xbox_login_hide,
            companion::companion_open_client,
            companion::companion_launch,
            companion::companion_game_action,
            companion::companion_get_client_settings,
            companion::companion_set_close_after_play,
            companion::companion_playtimes,
            companion::companion_achievements,
            companion::companion_achievements_summary,
            steam::steam_download_live,
            steam_watch::steam_watch_library,
            steam_running::steam_watch_running,
            game_running::game_watch_installed,
            steam::steam_game_action,
            steam_session::steam_watch_session,
            storage_usage::storage_path_size,
            net_diag::net_mtu_probe,
            net_diag::net_mtu_fix,
            steam::steam_sync_playtime,
            steam::steam_cloud_status,
            steam::steam_get_game_details,
            steam::steam_find_store_app,
            steam::steam_get_api_key,
            steam::steam_set_api_key,
            steam::steam_import_collections,
            steam_art::steam_library_art,
            steam::steam_get_achievements,
            steam::steam_get_achievements_summary,
            steam::steam_get_game_screenshots,
            steam::steam_get_screenshot_full_data,
            steam_auth::steam_login_begin,
            steam_auth::steam_login_qr_begin,
            steam_auth::steam_login_code,
            steam_auth::steam_login_status,
            steam_auth::steam_logout,
            steam_auth::steam_get_saved_accounts,
            steam_auth::steam_switch_account,
            steam_auth::steam_remove_saved_account,
            steam_auth::steam_owned_games,
            epic_detect_eos,
            legendary::steamgrid::epic_get_steamgrid_key,
            legendary::steamgrid::epic_set_steamgrid_key,
            legendary::steamgrid::epic_test_steamgrid_key,
            legendary::steamgrid::epic_search_steamgrid,
            legendary::steamgrid::epic_get_steamgrid_covers,
            legendary::commands::epic_get_player_profile,
            legendary::screenshots::epic_get_game_screenshots,
            legendary::screenshots::epic_get_screenshot_full_data,
            legendary::screenshots::epic_save_screenshot_preview,
            legendary::screenshots::epic_delete_game_screenshot,
            legendary::screenshots::epic_open_game_screenshots_folder,
            legendary::screenshots::epic_set_screenshot_hotkey,
            legendary::screenshots::epic_get_screenshot_dir,
            legendary::screenshots::epic_set_screenshot_dir,
            legendary::screenshots::epic_get_screenshot_move_info,
            legendary::screenshots::epic_open_screenshot_dir,
            legendary::screenshots::epic_replace_screenshot_with_compressed,
            legendary::commands::epic_get_system_drives,
            legendary::commands::epic_select_folder_dialog,
            legendary::commands::epic_move_game,
            legendary::commands::epic_cancel_move_game,
            gogdl::commands::gog_auth_status,
            gogdl::commands::gog_auth_code,
            gogdl::commands::gog_logout,
            gogdl::commands::gog_cached_library,
            gogdl::commands::gog_list_games,
            gogdl::commands::gog_get_game_details,
            gogdl::commands::gog_get_achievements,
            gogdl::commands::gog_get_achievements_summary,
            gogdl::commands::gog_sync_achievements,
            gogdl::commands::gog_get_system_requirements,
            gogdl::transfers::gog_install_game,
            gogdl::transfers::gog_cancel_download,
            gogdl::transfers::gog_pause_download,
            gogdl::transfers::gog_resume_download,
            gogdl::transfers::gog_uninstall_game,
            gogdl::transfers::gog_import_game,
            gogdl::transfers::gog_verify_game,
            gogdl::launcher::gog_launch_game,
            gogdl::launcher::gog_stop_game,
            gogdl::commands::gog_get_saved_accounts,
            gogdl::commands::gog_switch_account,
            gogdl::commands::gog_remove_saved_account,
            gogdl::commands::gog_detect_galaxy_games,
            gogdl::commands::gog_sync_galaxy_installed,
            gogdl::commands::gog_check_updates,
            gogdl::commands::gog_sync_playtime,
            gogdl::commands::gog_get_install_dir,
            gogdl::commands::gog_set_install_dir,
            gogdl::commands::gog_default_install_dir,
            gogdl::commands::gog_import_galaxy_tags,
            comet::epic_set_gog_comet,
            comet::comet_prepare,
            nile::auth::nile_auth_status,
            nile::auth::nile_login_begin,
            nile::auth::nile_login_finish,
            nile::auth::nile_logout,
            nile::accounts::amazon_saved_accounts,
            nile::accounts::amazon_switch_account,
            nile::accounts::amazon_remove_saved_account,
            nile::library::nile_library,
            nile::transfers::nile_install,
            nile::transfers::nile_install_info,
            nile::transfers::nile_uninstall,
            nile::transfers::nile_launch,
            nile::transfers::nile_stop,
            nile::transfers::nile_check_updates,
            nile::manage::nile_verify,
            nile::manage::nile_move_game,
            nile::manage::nile_import,
            nile::manage::nile_create_desktop_shortcut,
            nile::manage::nile_game_settings,
            nile::amazon_get_install_dir,
            nile::amazon_set_install_dir,
            nile::amazon_default_install_dir,
            cloud_backup::commands::cloud_backup_get_settings,
            cloud_backup::commands::cloud_backup_save_settings,
            cloud_backup::commands::cloud_backup_test_connection,
            cloud_backup::commands::cloud_backup_start_gdrive_auth,
            cloud_backup::commands::cloud_backup_disconnect_gdrive,
            cloud_backup::commands::cloud_backup_upload_game,
            cloud_backup::commands::cloud_backup_list_game,
            cloud_backup::commands::cloud_backup_download_game,
            cloud_backup::commands::cloud_backup_delete_remote,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri application failed to build");

    app.run(|app_handle, event| {
        if let tauri::RunEvent::Exit = event {
            // Best effort: drop the GOG presence before the process ends.
            tauri::async_runtime::block_on(gogdl::presence::go_offline(app_handle));
        }
    });
}
