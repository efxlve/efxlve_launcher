// Prevents an extra console window from opening on Windows.
#![windows_subsystem = "windows"]

mod cloud_backup;
mod comet;
mod custom_games;
mod compat;
mod companion;
mod controller;
mod controller_bridge;
mod discord_host;
#[cfg_attr(not(debug_assertions), allow(dead_code))]
mod discord_rpc;
mod discord_sdk;
mod eos;
mod egl_removal;
mod epic_shim;
mod feedback;
mod gogdl;
mod launchers;
mod legendary;
mod nile;
mod notes;
mod net_diag;
mod igdb;
mod image_cache;
mod perf;
mod task_manager;
mod game_running;
mod presence;
mod shared_library;
mod steam;
mod steam_art;
mod steam_auth;
mod taskbar_badge;
mod steam_running;
mod steam_session;
mod steam_watch;
mod storage_usage;
mod notif_overlay;
mod overlay;
mod spotify;
mod spotify_host;
mod store_host;
mod store_theme;
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

/// Path of the current-run marker, plus whether the previous run left one.
pub struct RunMarker {
    pub path: Option<std::path::PathBuf>,
    pub recovery: bool,
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
    /// Games the user turned screenshot capture off for (F12 does nothing).
    #[serde(default)]
    pub screenshot_disabled_games: Vec<String>,
    /// When false the gallery skips the automatic store folders; the chosen
    /// folder and the user-added folders are still read.
    #[serde(default = "default_true")]
    pub screenshot_scan_all: bool,
    /// User-added folders the gallery should also read.
    #[serde(default)]
    pub screenshot_extra_roots: Vec<String>,
    /// Automatic folders (`Videos\Captures`, Steam userdata, …) the user
    /// removed from the gallery's read list.
    #[serde(default)]
    pub screenshot_hidden_roots: Vec<String>,
    /// Run Comet (the GOG Communication Service) while a GOG game plays so
    /// in-game achievements unlock without the Galaxy client. On by default.
    #[serde(default)]
    pub gog_comet_enabled: Option<bool>,
    /// Base folder for Amazon Games installs (empty = Nile's default).
    #[serde(default)]
    pub amazon_install_dir: Option<String>,
    /// Linux/macOS compatibility manager: the runner used for new launches.
    #[serde(default)]
    pub compat_runner: Option<String>,
    /// Specific installed runner tag (empty = newest installed).
    #[serde(default)]
    pub compat_runner_tag: Option<String>,
    /// A runner outside the launcher's folder (Steam compatibilitytools.d,
    /// Lutris, a system Wine build). Empty = use the managed copy.
    #[serde(default)]
    pub compat_runner_path: Option<String>,
    /// False is the explicit "start like Windows" choice. `None` means the
    /// setting was never touched, so the first installed runner may be used.
    #[serde(default)]
    pub compat_runner_enabled: Option<bool>,
    /// Translation layers copied into a game's prefix before launch.
    /// Empty by default: enabling this changes how games render.
    #[serde(default)]
    pub compat_layers: Vec<String>,
    /// Root for per-game Wine/Proton prefixes.
    #[serde(default)]
    pub compat_prefix_dir: Option<String>,
    /// Prefer umu-launcher when it is installed (Linux).
    #[serde(default)]
    pub compat_umu_enabled: Option<bool>,
    #[serde(default = "default_true")]
    pub auto_desktop_shortcut: bool,
    /// Achievement notification preferences (`None` = on).
    #[serde(default)]
    pub achievement_notifications_enabled: Option<bool>,
    #[serde(default)]
    pub achievement_notifications_sound: Option<bool>,
    #[serde(default)]
    pub achievement_notifications_overlay: Option<bool>,
    /// Custom notification sound copied into the app data folder.
    #[serde(default)]
    pub achievement_notifications_sound_path: Option<String>,
    /// Original file name shown in Settings.
    #[serde(default)]
    pub achievement_notifications_sound_name: Option<String>,
    /// 0-100; applied to the custom sound in the launcher webview.
    #[serde(default)]
    pub achievement_notifications_volume: Option<u8>,
    /// How long the in-game notification card stays visible.
    #[serde(default)]
    pub achievement_notifications_duration_ms: Option<u64>,
    /// top-right, top-left, bottom-right, or bottom-left.
    #[serde(default)]
    pub achievement_notifications_position: Option<String>,
    pub achievement_notifications_size: Option<String>,
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
    open_in_file_manager(&p)?;
    Ok("@t:win.folderOpened".to_string())
}

/// Spawns the platform file manager for an existing folder. Shared by the
/// generic command and the Cloud settings "open folder" button.
pub(crate) fn open_in_file_manager(path: &std::path::Path) -> Result<(), String> {
    #[cfg(windows)]
    let res = std::process::Command::new("explorer").arg(path).spawn();
    #[cfg(target_os = "macos")]
    let res = std::process::Command::new("open").arg(path).spawn();
    #[cfg(all(not(windows), not(target_os = "macos")))]
    let res = std::process::Command::new("xdg-open").arg(path).spawn();
    res.map(|_| ())
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

#[cfg(windows)]
fn set_fullscreen_native(window: &tauri::Window, enabled: bool) {
    let Ok(raw_hwnd) = window.hwnd() else {
        return;
    };
    let hwnd = raw_hwnd.0;
    let hwnd_isize = hwnd as isize;

    #[repr(C)]
    struct RECT {
        left: i32,
        top: i32,
        right: i32,
        bottom: i32,
    }
    #[repr(C)]
    struct MONITORINFO {
        cb_size: u32,
        rc_monitor: RECT,
        rc_work: RECT,
        flags: u32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn MonitorFromWindow(hwnd: isize, flags: u32) -> isize;
        fn GetMonitorInfoW(monitor: isize, info: *mut MONITORINFO) -> i32;
        fn SetWindowPos(
            hwnd: *mut core::ffi::c_void,
            insert_after: *mut core::ffi::c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }

    const MONITOR_DEFAULTTONEAREST: u32 = 2;
    const HWND_TOPMOST: *mut core::ffi::c_void = -1isize as *mut core::ffi::c_void;
    const HWND_NOTOPMOST: *mut core::ffi::c_void = -2isize as *mut core::ffi::c_void;
    const SWP_NOSIZE: u32 = 0x0001;
    const SWP_NOMOVE: u32 = 0x0002;
    const SWP_FRAMECHANGED: u32 = 0x0020;
    const SWP_SHOWWINDOW: u32 = 0x0040;

    unsafe {
        if enabled {
            let hmon = MonitorFromWindow(hwnd_isize, MONITOR_DEFAULTTONEAREST);
            if hmon != 0 {
                let mut mi = MONITORINFO {
                    cb_size: std::mem::size_of::<MONITORINFO>() as u32,
                    rc_monitor: RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    rc_work: RECT {
                        left: 0,
                        top: 0,
                        right: 0,
                        bottom: 0,
                    },
                    flags: 0,
                };
                if GetMonitorInfoW(hmon, &mut mi) != 0 {
                    let x = mi.rc_monitor.left;
                    let y = mi.rc_monitor.top;
                    let w = mi.rc_monitor.right - mi.rc_monitor.left;
                    let h = mi.rc_monitor.bottom - mi.rc_monitor.top;
                    let _ = SetWindowPos(
                        hwnd,
                        HWND_TOPMOST,
                        x,
                        y,
                        w,
                        h,
                        SWP_FRAMECHANGED | SWP_SHOWWINDOW,
                    );
                }
            }
        } else {
            let _ = SetWindowPos(
                hwnd,
                HWND_NOTOPMOST,
                0,
                0,
                0,
                0,
                SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
            );
        }
    }
}

#[cfg(not(windows))]
fn set_fullscreen_native(_window: &tauri::Window, _enabled: bool) {}

#[tauri::command]
fn app_set_fullscreen(app: AppHandle, enabled: bool) -> Result<bool, String> {
    // Controller auto-fullscreen calls this soon after boot. A panic here used
    // to unwind through Tauri's IPC callback and abort the whole process, which
    // looked like the launcher closing by itself. Keep the failure local.
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        set_fullscreen_mode(&app, enabled)
    }))
    .unwrap_or_else(|_| Err("fullscreen failed".to_string()))
}

fn set_fullscreen_mode(app: &AppHandle, enabled: bool) -> Result<bool, String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;

    if enabled {
        window.set_fullscreen(true).map_err(|e| e.to_string())?;
        hide_accent_border(&window);
        set_fullscreen_native(&window, true);
        let win = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            set_fullscreen_native(&win, true);
        });
    } else {
        set_fullscreen_native(&window, false);
        window.set_fullscreen(false).map_err(|e| e.to_string())?;
        hide_accent_border(&window);
        let win = window.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            set_fullscreen_native(&win, false);
        });
    }

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
    pub overlay: tauri::menu::MenuItem<tauri::Wry>,
    pub quit: tauri::menu::MenuItem<tauri::Wry>,
}

/// Sets the tray menu labels from the frontend (translated strings).
#[tauri::command]
fn app_set_tray_labels(
    show: String,
    overlay: String,
    quit: String,
    items: tauri::State<'_, TrayItems>,
) -> Result<(), String> {
    items.show.set_text(show).map_err(|e| e.to_string())?;
    items.overlay.set_text(overlay).map_err(|e| e.to_string())?;
    items.quit.set_text(quit).map_err(|e| e.to_string())?;
    Ok(())
}

/// Builds the system tray icon with a Show / Quit menu. Left click restores the
/// window; the tray keeps the app (and its downloads) alive while hidden.
fn build_tray(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let show = MenuItem::with_id(app, "show", "Show", true, None::<&str>)?;
    let overlay = MenuItem::with_id(app, "overlay", "Overlay", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &overlay, &quit])?;
    app.manage(TrayItems {
        show: show.clone(),
        overlay: overlay.clone(),
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
            "overlay" => crate::overlay::overlay_show(app.clone()),
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

/// Set once the app starts shutting down, so a deliberate close during the first
/// seconds is not mistaken for a failed webview.
static EXITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
/// First instance's show-request event, so a second launch can reveal it even
/// when the window title lookup fails.
#[cfg(windows)]
static SHOW_EVENT: std::sync::OnceLock<usize> = std::sync::OnceLock::new();

/// Creates one window declared in `tauri.conf.json`.
///
/// The config windows are built here rather than by the framework so a webview
/// that cannot start has somewhere to be reported; the manifest marks them
/// `"create": false` for that.
fn create_config_window(app: &tauri::App, label: &str) -> Result<(), String> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == label)
        .ok_or_else(|| format!("no `{label}` window in tauri.conf.json"))?
        .clone();
    tauri::WebviewWindowBuilder::from_config(app.handle(), &config)
        .map_err(|error| error.to_string())?
        .build()
        .map(|_| ())
        .map_err(|error| error.to_string())
}

/// Moves the launcher's WebView2 profile aside so the retry starts clean.
///
/// A profile the runtime cannot open is the usual reason a window never shows
/// up, and keeping the folder makes the failure permanent. The old profile is
/// renamed, not deleted, so a user can put it back.
fn quarantine_webview_profile(app: &tauri::App) -> Option<std::path::PathBuf> {
    let dir = app.path().app_local_data_dir().ok()?.join("EBWebView");
    if !dir.is_dir() {
        return None;
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() % 86_400)
        .map(|secs| format!("{:02}{:02}{:02}", secs / 3600, (secs / 60) % 60, secs % 60))
        .unwrap_or_else(|_| "old".into());
    let target = dir.with_file_name(format!("EBWebView.bak-{stamp}"));
    std::fs::rename(&dir, &target).ok().map(|_| target)
}

/// Counts consecutive runs that never reached a clean exit. Two in a row is
/// treated as a broken WebView2 profile: the profile is moved aside and the
/// next boot runs with software rendering, which recovers the common cases
/// without the user deleting anything by hand.
fn boot_state_path(app: &tauri::App) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("boot_recovery.txt"))
}

fn read_crash_streak(app: &tauri::App) -> u32 {
    boot_state_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

fn write_crash_streak(app: &tauri::App, streak: u32) {
    if let Some(path) = boot_state_path(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, streak.to_string());
    }
}

fn reset_crash_streak(app: &tauri::AppHandle) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::write(dir.join("boot_recovery.txt"), "0");
    }
}

fn recover_broken_webview(app: &tauri::App, recovery: bool, early_crash: bool) {
    let mut streak = read_crash_streak(app);
    if recovery {
        streak = streak.saturating_add(1);
    } else {
        streak = 0;
    }
    // A crash in the first seconds is the WebView2 profile/GPU failure this
    // recovery exists for; reset on the very next launch instead of making the
    // user relaunch three times. A force-kill after a long session only counts
    // toward the slower two-strike path.
    if early_crash || streak >= 2 {
        let moved = quarantine_webview_profile(app)
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "no profile folder".into());
        // A GPU driver crash also survives a profile reset; software rendering
        // is slower but gets the user back into the launcher.
        if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--disable-gpu");
        }
        perf::write_line_global(&format!(
            "boot: repeated crash; webview profile {moved}; software rendering enabled"
        ));
        streak = 0;
    }
    write_crash_streak(app, streak);
}

/// Builds the main window, retrying once without the previous webview profile.
fn create_main_window(app: &tauri::App) -> Result<(), String> {
    match create_config_window(app, "main") {
        Ok(()) => Ok(()),
        Err(first) => {
            let moved = quarantine_webview_profile(app)
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "nothing to move".into());
            perf::write_line_global(&format!(
                "boot: main window failed: {first}; profile: {moved}"
            ));
            create_config_window(app, "main").map_err(|second| format!("{first} / retry: {second}"))
        }
    }
}

/// A launcher without a webview must not keep running: the tray icon stays, the
/// taskbar entry goes, and the user is left with a process that does nothing.
/// Say what happened, log it, and exit so the next start can try again.
fn report_boot_failure(app: &tauri::AppHandle, detail: &str) -> ! {
    perf::write_line_global(&format!("boot: failed: {detail}"));
    if let Some(marker) = app.try_state::<RunMarker>() {
        if let Some(path) = &marker.path {
            let _ = std::fs::remove_file(path);
        }
    }
    let log = app
        .path()
        .app_data_dir()
        .map(|dir| dir.join("perf.log").display().to_string())
        .unwrap_or_else(|_| "perf.log".into());
    let message = format!(
        "Efxlve Launcher web görünümünü başlatamadı.\r\n\
         Microsoft Edge WebView2 Runtime'ı onarın ve antivirüsünüzün uygulamayı engellemediğinden emin olun.\r\n\r\n\
         The launcher could not start its web view. Repair the Microsoft Edge WebView2 Runtime, \
         or check that antivirus software is not blocking the app.\r\n\r\n\
         {detail}\r\n\r\n{log}"
    );
    show_boot_error(&message);
    std::process::exit(1);
}

#[cfg(windows)]
fn show_boot_error(message: &str) {
    #[link(name = "user32")]
    extern "system" {
        fn MessageBoxW(
            hwnd: *mut core::ffi::c_void,
            text: *const u16,
            caption: *const u16,
            kind: u32,
        ) -> i32;
    }
    const MB_ICONERROR: u32 = 0x0000_0010;
    const MB_SETFOREGROUND: u32 = 0x0001_0000;
    const MB_TOPMOST: u32 = 0x0004_0000;

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    let text = wide(message);
    let caption = wide("Efxlve Launcher");
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            caption.as_ptr(),
            MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST,
        );
    }
}

#[cfg(not(windows))]
fn show_boot_error(_message: &str) {}

/// A webview can also die a moment after its window is built: WebView2 kills the
/// browser process, the window goes with it, and the event loop keeps running
/// with nothing to draw. Check once the boot work is done so that state is
/// reported instead of leaving a silent process behind.
fn watch_boot_window(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        if EXITING.load(std::sync::atomic::Ordering::Relaxed) {
            return;
        }
        let Some(window) = app.get_window("main") else {
            report_boot_failure(&app, "the main window disappeared during boot");
            return;
        };
        match window.is_visible() {
            Ok(true) => {}
            Ok(false) => {
                // A hidden main window is the "process alive, no taskbar" bug:
                // show it instead of leaving the user with an invisible app.
                perf::write_line_global("boot: main window was hidden; showing it");
                let _ = window.set_skip_taskbar(false);
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
            Err(error) => {
                report_boot_failure(&app, &format!("main window visibility check failed: {error}"));
                return;
            }
        }
        if window.is_minimized().unwrap_or(false) {
            perf::write_line_global("boot: main window was minimized; restoring it");
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        if matches!(window.current_monitor(), Ok(None)) {
            perf::write_line_global("boot: main window is off-screen; centering it");
            let _ = window.center();
        }
        if let Ok(position) = window.outer_position() {
            perf::write_line_global(&format!(
                "boot: window position {},{} visible={:?} minimized={:?}",
                position.x,
                position.y,
                window.is_visible(),
                window.is_minimized()
            ));
        }
    });
}

/// Waits for a second launch and reveals the existing window. The old path
/// relied on FindWindowW with the exact title, which can miss a borderless or
/// hidden window; this event works for every window state.
#[cfg(windows)]
fn listen_for_show_requests(app: tauri::AppHandle) {
    use std::sync::atomic::Ordering;
    let Some(&event) = SHOW_EVENT.get() else {
        return;
    };
    std::thread::Builder::new()
        .name("show-request".into())
        .spawn(move || loop {
            #[link(name = "kernel32")]
            extern "system" {
                fn WaitForSingleObject(handle: *mut core::ffi::c_void, millis: u32) -> u32;
            }
            let result = unsafe { WaitForSingleObject(event as *mut core::ffi::c_void, u32::MAX) };
            if result != 0 || EXITING.load(Ordering::Relaxed) {
                return;
            }
            if let Some(window) = app.get_window("main") {
                let _ = window.set_skip_taskbar(false);
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        })
        .ok();
}

#[cfg(not(windows))]
fn listen_for_show_requests(_app: tauri::AppHandle) {}

/// A panic in a release build leaves no trace: the window simply disappears and
/// the user has nothing to send. This writes the message, the location and a
/// backtrace next to the other logs, so a crash report is actionable.
///
/// It cannot catch a hard fault (an access violation ends the process without
/// unwinding); for those the Windows Event Log is the only source.
fn install_crash_logger(app: &tauri::App) {
    use std::io::Write;
    use tauri::Manager;

    let dir = app.path().app_data_dir().ok().map(|dir| dir.join("logs"));
    std::panic::set_hook(Box::new(move |info| {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let text = format!(
            "[{stamp}] panic: {info}\nbacktrace:\n{}\n\n",
            std::backtrace::Backtrace::force_capture()
        );
        if let Some(dir) = dir.as_ref() {
            let _ = std::fs::create_dir_all(dir);
            if let Ok(mut file) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(dir.join("crash.log"))
            {
                let _ = file.write_all(text.as_bytes());
            }
        }
        eprintln!("{text}");
    }));
}

/// `tauri dev` rebuilds by killing the `cargo run` process. On Windows that
/// does not stop this process, so `efxlve-launcher.exe` stays locked, the next
/// link fails, and the dev session exits. Leave as soon as that cargo parent
/// dies so the new build can replace the exe and start again.
///
/// A release install is started by `explorer.exe`, so this returns immediately:
/// only a direct `cargo.exe` parent starts the watch. (Checked when a user
/// reported the window closing by itself; it was not this.)
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
        fn CreateEventW(
            lpEventAttributes: *mut core::ffi::c_void,
            bManualReset: i32,
            bInitialState: i32,
            lpName: *const u16,
        ) -> *mut core::ffi::c_void;
        fn OpenEventW(
            dwDesiredAccess: u32,
            bInheritHandle: i32,
            lpName: *const u16,
        ) -> *mut core::ffi::c_void;
        fn SetEvent(handle: *mut core::ffi::c_void) -> i32;
        fn CloseHandle(handle: *mut core::ffi::c_void) -> i32;
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
    const EVENT_MODIFY_STATE: u32 = 0x0002;

    let mutex_name: Vec<u16> = "Local\\EfxlveLauncherSingleInstanceMutex\0"
        .encode_utf16()
        .collect();
    let event_name: Vec<u16> = "Local\\EfxlveLauncherShowEvent\0"
        .encode_utf16()
        .collect();
    let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 1, mutex_name.as_ptr()) };
    if handle.is_null() {
        return None;
    }
    if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS {
        // Ask the running instance to reveal its window. This works even when
        // the window is hidden, minimized or has a non-matching title.
        let event = unsafe { OpenEventW(EVENT_MODIFY_STATE, 0, event_name.as_ptr()) };
        if !event.is_null() {
            unsafe {
                SetEvent(event);
                CloseHandle(event);
            }
        }
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
    let event = unsafe { CreateEventW(std::ptr::null_mut(), 0, 0, event_name.as_ptr()) };
    if !event.is_null() {
        let _ = SHOW_EVENT.set(event as usize);
    }
    Some(handle)
}

#[cfg(not(windows))]
fn acquire_single_instance_mutex() -> Option<*mut core::ffi::c_void> {
    None
}

/// A Windows zip with `portable.txt` next to the exe keeps the launcher's
/// roaming/local data and legendary config inside `portable-data`. Everything
/// else (game installs, saves, Steam library) stays where it normally lives.
#[cfg(windows)]
fn init_portable_mode() {
    let Ok(exe) = std::env::current_exe() else {
        return;
    };
    let Some(dir) = exe.parent() else {
        return;
    };
    if !dir.join("portable.txt").is_file() {
        return;
    }
    let root = dir.join("portable-data");
    let roaming = root.join("Roaming");
    let local = root.join("Local");
    let config = root.join("config").join("legendary");
    for path in [&roaming, &local, &config] {
        let _ = std::fs::create_dir_all(path);
    }
    std::env::set_var("APPDATA", &roaming);
    std::env::set_var("LOCALAPPDATA", &local);
    std::env::set_var("EFXLVE_CONFIG_DIR", &config);
}

#[cfg(not(windows))]
fn init_portable_mode() {}

/// Unpackaged (dev) builds show the launching shell's name in Windows toasts
/// ("Windows PowerShell"); the packaged build takes the launcher's name from
/// its Start-menu shortcut. An explicit app id here would make Windows drop
/// the toasts entirely, because that id has no shortcut to resolve against.
fn main() {
    init_portable_mode();
    // Rockstar's launcher only continues when a process named
    // `EpicGamesLauncher.exe` is in its ancestor chain. This binary runs as
    // that relay copy when `legendary launch --wrapper` starts it, so Rockstar
    // titles work without the Epic Games Launcher. It has to run before the
    // single-instance lock: the launcher itself is already running by design.
    if let Some(args) = epic_shim::relay_arguments() {
        std::process::exit(epic_shim::relay(&args));
    }
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
            // Boot timing: capture the log path before anything slow runs, so
            // every module can write a line without an AppHandle.
            if let Ok(dir) = app.path().app_data_dir() {
                perf::init(dir);
            }
            let marker_path = app
                .path()
                .app_data_dir()
                .ok()
                .map(|dir| dir.join("run.marker"));
            let recovery = marker_path
                .as_ref()
                .map(|path| path.is_file())
                .unwrap_or(false);
            let previous_started = marker_path
                .as_ref()
                .and_then(|path| std::fs::read_to_string(path).ok())
                .and_then(|text| text.trim().parse::<u64>().ok());
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|elapsed| elapsed.as_secs())
                .unwrap_or(0);
            let early_crash = recovery
                && previous_started
                    .map(|started| now.saturating_sub(started) < 20)
                    .unwrap_or(true);
            recover_broken_webview(app, recovery, early_crash);
            if let Some(path) = marker_path.as_ref() {
                if let Some(parent) = path.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(path, now.to_string());
            }
            app.manage(RunMarker {
                path: marker_path,
                recovery,
            });
            // A window whose webview cannot start used to die silently and take
            // the whole interface with it; create both here instead.
            if let Err(error) = create_main_window(app) {
                report_boot_failure(app.handle(), &error);
            }
            if let Err(error) = create_config_window(app, "overlay") {
                perf::write_line_global(&format!("boot: overlay window failed: {error}"));
            }
            if let Some(win) = app.get_window("main") {
                let _ = win.set_decorations(false);
                hide_accent_border(&win);
                // A borderless window must still be a taskbar window. Some
                // Windows/driver combinations start it hidden or minimized;
                // force the declared state before the user sees a missing UI.
                let _ = win.set_skip_taskbar(false);
                let _ = win.unminimize();
                let _ = win.show();
                let _ = win.set_focus();
                if let Ok(position) = win.outer_position() {
                    perf::write_line_global(&format!(
                        "boot: main window created at {},{} visible={:?} minimized={:?}",
                        position.x,
                        position.y,
                        win.is_visible(),
                        win.is_minimized()
                    ));
                }
            }
            // A marker left behind by a killed/restarted launcher becomes real
            // playtime before anything else reads the store.
            legendary::playtime_session::recover_stale();
            // The hotkey listener must already know the configured folder.
            let screenshot_settings = load_settings(app.handle());
            legendary::screenshots::set_screenshot_root(screenshot_settings.screenshot_dir);
            legendary::screenshots::set_screenshot_scan_all(
                screenshot_settings.screenshot_scan_all,
            );
            legendary::screenshots::set_screenshot_extra_roots(
                screenshot_settings.screenshot_extra_roots,
            );
            legendary::screenshots::set_screenshot_hidden_roots(
                screenshot_settings.screenshot_hidden_roots,
            );
            legendary::screenshots::set_disabled_games(
                screenshot_settings.screenshot_disabled_games,
            );
            legendary::screenshots::start_f12_listener(app.handle().clone());
            // Shift+Tab overlay panel over the running game.
            overlay::start(app.handle().clone());
            // Keeps the GOG account visible as online while the launcher runs.
            gogdl::presence::spawn(app.handle().clone());
            // A linked GOG account needs gogdl for installs and launches.
            // Prepare it in the background instead of making the first GOG
            // transfer wait for a 12 MB download.
            if gogdl::cache::load_auth_tokens(app.handle()).is_some() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let _ = gogdl::paths::ensure_binary(&handle).await;
                });
            }
            // Refreshes linked companion accounts (today: Ubisoft) on a timer.
            companion::start_ubi_sync(app.handle().clone());
            // Linux desktops without a tray host (a bare GNOME session) fail to
            // build the indicator; the launcher still has the header controls,
            // so a missing tray must not abort boot.
            #[cfg(windows)]
            build_tray(app)?;
            #[cfg(not(windows))]
            if let Err(error) = build_tray(app) {
                perf::write_line_global(&format!("boot: tray icon unavailable: {error}"));
            }
            listen_for_show_requests(app.handle().clone());
            watch_boot_window(app.handle().clone());
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
            if let tauri::WindowEvent::Focused(focused) = event {
                #[cfg(windows)]
                if let Ok(is_fs) = window.is_fullscreen() {
                    if is_fs {
                        if let Ok(raw_hwnd) = window.hwnd() {
                            let hwnd = raw_hwnd.0;
                            #[link(name = "user32")]
                            extern "system" {
                                fn SetWindowPos(
                                    hwnd: *mut core::ffi::c_void,
                                    insert_after: *mut core::ffi::c_void,
                                    x: i32,
                                    y: i32,
                                    cx: i32,
                                    cy: i32,
                                    flags: u32,
                                ) -> i32;
                            }
                            const HWND_TOPMOST: *mut core::ffi::c_void =
                                -1isize as *mut core::ffi::c_void;
                            const HWND_NOTOPMOST: *mut core::ffi::c_void =
                                -2isize as *mut core::ffi::c_void;
                            const SWP_NOSIZE: u32 = 0x0001;
                            const SWP_NOMOVE: u32 = 0x0002;
                            const SWP_FRAMECHANGED: u32 = 0x0020;
                            const SWP_SHOWWINDOW: u32 = 0x0040;

                            let target_z = if *focused { HWND_TOPMOST } else { HWND_NOTOPMOST };
                            unsafe {
                                let _ = SetWindowPos(
                                    hwnd,
                                    target_z,
                                    0,
                                    0,
                                    0,
                                    0,
                                    SWP_NOMOVE | SWP_NOSIZE | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
                                );
                            }
                        }
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            library_dir,
            steam::steam_news,
            image_cache::cache_images,
            image_cache::image_cache_size,
            image_cache::clear_image_cache,
            app_minimize,
            app_get_autostart,
            perf::perf_mark,
            app_set_autostart,
            launchers::launchers_status,
            app_toggle_maximize,
            app_is_maximized,
            app_set_fullscreen,
            app_close,
            app_set_decorations,
            app_set_minimize_to_tray,
            app_set_tray_labels,
            feedback::feedback_create_report,
            feedback::feedback_has_crash,
            feedback::feedback_recovery_pending,
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
            legendary::transfers::epic_launch_support,
            legendary::transfers::epic_stop_game,
            store_host::show_store_view,
            store_host::resize_store_view,
            store_host::hide_store_view,
            store_host::set_store_palette_hold,
            store_host::destroy_store_view,
            store_host::set_store_warm_limit,
            store_host::prewarm_store_view,
            store_host::get_store_extensions_state,
            store_host::download_store_extension,
            store_host::set_store_extension_enabled,
            store_host::uninstall_store_extension,
            discord_host::discord_view_show,
            discord_host::discord_view_hide,
            discord_host::discord_view_reload,
            discord_host::discord_view_destroy,
            discord_host::discord_open_devtools,
            discord_host::discord_web_voice_state,
            discord_host::discord_open_conversation,
            discord_host::discord_view_prewarm,
            taskbar_badge::app_set_taskbar_badge,
            discord_sdk::discord_sdk_start,
            discord_sdk::discord_sdk_state,
            discord_sdk::discord_sdk_friends,
            discord_sdk::discord_sdk_send_dm,
            discord_sdk::discord_sdk_delete_dm,
            discord_sdk::discord_sdk_edit_dm,
            discord_sdk::discord_sdk_friend_request,
            discord_sdk::discord_sdk_history,
            discord_sdk::discord_sdk_search_users,
            discord_sdk::discord_sdk_add_friend,
            discord_sdk::discord_sdk_channels,
            discord_sdk::discord_sdk_set_status,
            discord_sdk::discord_sdk_call,
            discord_sdk::discord_sdk_hangup,
            discord_sdk::discord_sdk_call_mute,
            discord_rpc::discord_voice_watch_start,
            discord_rpc::discord_voice_watch_stop,
            discord_rpc::discord_relationships_probe,
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
            steam::steam_protondb_summary,
            steam::steam_anticheat_status,
            steam::epic_anticheat_status,
            steam::steam_deck_status,
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
            steam::steam_get_achievement_source,
            steam::steam_set_achievement_source,
            steam::steam_detect_achievement_path,
            steam::steam_get_emulator_achievements,
            steam::achievement_get_notification_options,
            steam::achievement_set_notification_options,
            steam::achievement_pick_custom_sound,
            steam::achievement_clear_custom_sound,
            steam::achievement_test_notification,
            steam::steam_start_emulator_watcher,
            steam::steam_start_achievement_watcher,
            steam::steam_stop_achievement_watcher,
            custom_games::custom_games_list,
            custom_games::custom_games_add,
            custom_games::custom_games_edit,
            custom_games::custom_games_remove,
            custom_games::custom_games_launch,
            custom_games::custom_games_stop,
            custom_games::custom_games_import_folder,
            custom_games::custom_games_pick_folder,
            custom_games::custom_games_pick_file,
            custom_games::custom_games_search_steam,
            custom_games::custom_games_steam_details,
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
            steam_auth::steam_family_shared_apps,
            epic_detect_eos,
            legendary::steamgrid::epic_get_steamgrid_key,
            legendary::steamgrid::epic_set_steamgrid_key,
            legendary::steamgrid::epic_test_steamgrid_key,
            legendary::steamgrid::epic_search_steamgrid,
            legendary::steamgrid::epic_get_steamgrid_covers,
            legendary::commands::epic_get_player_profile,
            legendary::screenshots::epic_get_game_screenshots,
            legendary::screenshots::epic_get_all_screenshots,
            legendary::screenshots::epic_get_screenshot_full_data,
            legendary::screenshots::epic_save_screenshot_preview,
            legendary::screenshots::epic_delete_game_screenshot,
            legendary::screenshots::epic_save_edited_screenshot,
            legendary::screenshots::screenshot_share_discord,
            legendary::screenshots::screenshot_webhook_info,
            legendary::screenshots::screenshot_scan_roots,
            legendary::screenshots::epic_add_screenshot_root,
            legendary::screenshots::epic_remove_screenshot_root,
            legendary::clip_recorder::clip_status,
            legendary::clip_recorder::clip_start,
            legendary::clip_recorder::clip_stop,
            legendary::clip_recorder::clip_set_options,
            legendary::clip_recorder::clip_set_hotkey,
            legendary::clip_recorder::clip_list,
            legendary::clip_recorder::clip_thumbnail,
            legendary::clip_recorder::clip_frame,
            legendary::clip_recorder::clip_trim,
            legendary::clip_recorder::clip_join,
            legendary::clip_recorder::clip_share_discord,
            legendary::clip_recorder::clip_folder_path,
            legendary::clip_recorder::clip_delete,
            legendary::screenshots::epic_open_game_screenshots_folder,
            legendary::screenshots::epic_set_screenshot_hotkey,
            legendary::screenshots::epic_get_screenshot_dir,
            legendary::screenshots::epic_set_screenshot_dir,
            legendary::screenshots::epic_get_screenshot_move_info,
            legendary::screenshots::epic_open_screenshot_dir,
            legendary::screenshots::epic_replace_screenshot_with_compressed,
            legendary::screenshots::epic_set_screenshot_disabled_games,
            legendary::screenshots::epic_get_screenshot_disabled_games,
            legendary::screenshots::epic_set_screenshot_scan_all,
            legendary::screenshots::epic_get_screenshot_scan_all,
            overlay::overlay_get_state,
            overlay::overlay_set_enabled,
            overlay::overlay_set_hotkey,
            overlay::overlay_set_hud,
            overlay::overlay_flash_hint,
            overlay::overlay_enable_fps,
            overlay::overlay_set_active_game,
            overlay::overlay_clear_active_game,
            overlay::overlay_hide,
            overlay::overlay_show,
            overlay::overlay_show_launcher,
            overlay::overlay_raise,
            overlay::browser::overlay_browser_open,
            overlay::browser::overlay_browser_is_open,
            overlay::browser::overlay_browser_show,
            overlay::browser::overlay_browser_tabs,
            overlay::browser::overlay_browser_navigate,
            overlay::browser::overlay_browser_action,
            overlay::browser::overlay_browser_new_tab,
            overlay::browser::overlay_browser_close_tab,
            overlay::browser::overlay_browser_activate_tab,
            overlay::browser::overlay_browser_close,
            overlay::browser::overlay_browser_set_position,
            overlay::browser::overlay_browser_raise,
            spotify::playback::spotify_playback_status,
            spotify::playback::spotify_playback_start,
            spotify::playback::spotify_playback_now,
            spotify_host::spotify_page_control,
            spotify_host::spotify_page_now,
            spotify::playback::spotify_playback_control,
            spotify::playback::spotify_playback_playlists,
            spotify::playback::spotify_playback_playlist_tracks,
            spotify::playback::spotify_playback_play,
            spotify_host::spotify_player_show,
            spotify_host::spotify_player_hide,
            spotify_host::spotify_player_reload,
            spotify_host::spotify_player_back,
            spotify_host::spotify_signed_in,
            spotify_host::spotify_open_in_launcher,
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
            compat::install::compat_catalog,
            compat::install::compat_install,
            compat::install::compat_remove,
            compat::install::compat_cancel,
            compat::install::compat_tools_dir,
            compat::install::compat_disk_usage,
            compat::install::compat_clear_partials,
            compat::games::compat_get_game_config,
            compat::games::compat_set_game_config,
            compat::launch::compat_get_launch_config,
            compat::launch::compat_set_launch_config,
            compat::launch::compat_prepare_prefix,
            compat::launch::compat_open_prefix_root,
            compat::launch::compat_open_game_prefix,
            compat::launch::compat_game_prefix_state,
            compat::launch::compat_game_diagnostics,
            compat::launch::compat_diagnostics,
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
            cloud_backup::commands::cloud_backup_open_folder,
            cloud_backup::commands::cloud_backup_rclone_remotes,
            cloud_backup::commands::cloud_backup_remote_hash,
            cloud_backup::commands::profile_export,
            cloud_backup::commands::profile_import,
            cloud_backup::commands::profile_cloud_upload,
            cloud_backup::commands::profile_cloud_list,
            cloud_backup::commands::profile_cloud_restore,
            notes::notes_list,
            notes::notes_save,
            notes::notes_delete,
            notes::notes_import,
            notes::notes_import_text,
            notes::notes_export,
            task_manager::task_manager_snapshot,
            task_manager::task_manager_stop,
            spotify_host::spotify_player_destroy,
            igdb::igdb_status,
            igdb::igdb_set_credentials,
            igdb::igdb_set_proxy_url,
            igdb::igdb_clear_credentials,
            igdb::igdb_test,
            igdb::igdb_probe_proxy,
            igdb::igdb_search,
            igdb::igdb_game,
            igdb::igdb_covers,
            igdb::igdb_enrich,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri application failed to build");

    install_crash_logger(&app);
    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            EXITING.store(true, std::sync::atomic::Ordering::Relaxed);
        }
        if let tauri::RunEvent::Exit = event {
            // A clean exit means the next boot should not show the recovery
            // feedback prompt.
            if let Some(marker) = app_handle.try_state::<RunMarker>() {
                if let Some(path) = &marker.path {
                    let _ = std::fs::remove_file(path);
                }
            }
            reset_crash_streak(app_handle);
            // Best effort: drop the GOG presence before the process ends.
            tauri::async_runtime::block_on(gogdl::presence::go_offline(app_handle));
            // Best effort: close the Spotify Connect receiver cleanly.
            spotify::playback::stop();
        }
    });
}
