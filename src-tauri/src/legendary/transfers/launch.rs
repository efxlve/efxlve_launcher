//! Start and stop an installed Epic game.
//!
//! The game process is detached. Stopping it kills only processes whose image
//! sits inside that game's install folder.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::{AppHandle, Emitter, Manager};

use super::parse::short_error;
use super::paths::resolve_bin;
use crate::legendary::cmd_error;
use crate::load_settings;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Launches the game: online first (with an ownership ticket), then, if the game
/// can run offline, retries with `--offline`.
/// The game process is spawned detached (it keeps running after the handle drops).
/// Returns an error if it crashes in the first seconds, otherwise counts it as "launched".
#[tauri::command]
pub async fn epic_launch_game(app: AppHandle, app_name: String) -> Result<String, String> {
    let bin = resolve_bin(&app)?;
    let installed: Vec<crate::legendary::models::InstalledGame> =
        crate::legendary::client::run_json(&bin, &["list-installed", "--json"])
            .await
            .map_err(cmd_error)?;
    if let Some(entry) = installed.iter().find(|g| g.app_name == app_name) {
        let title = if entry.title.is_empty() {
            app_name.clone()
        } else {
            entry.title.clone()
        };
        let mut custom_args: Vec<String> = entry
            .launch_parameters
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        let settings_path = crate::legendary::skip::default_config_dir()
            .join("game_settings")
            .join(format!("{app_name}.json"));
        if let Ok(st_text) = std::fs::read_to_string(&settings_path) {
            if let Ok(st_val) = serde_json::from_str::<serde_json::Value>(&st_text) {
                if let Some(lp) = st_val.get("launchParameters").and_then(|v| v.as_str()) {
                    for arg in lp.split_whitespace() {
                        if !custom_args.iter().any(|a| a == arg) {
                            custom_args.push(arg.to_string());
                        }
                    }
                }
            }
        }
        let custom_refs: Vec<&str> = custom_args.iter().map(|s| s.as_str()).collect();
        let settings = load_settings(&app);
        let is_offline = settings.offline_mode.unwrap_or(false);

        if is_offline && entry.can_run_offline {
            let mut offline_args = vec!["--offline"];
            offline_args.extend(custom_refs.iter().copied());
            return spawn_launched(&app, &bin, &app_name, &offline_args)
                .await
                .map(|_| format!("@t:dl.launchedOffline\u{1f}{title}"));
        }

        match spawn_launched(&app, &bin, &app_name, &custom_refs).await {
            Ok(()) => Ok(format!("@t:dl.launched\u{1f}{title}")),
            Err(first) => {
                // A missing companion launcher is not an offline problem: the
                // start never reached the game, so the retry would only repeat
                // the same message.
                if first.starts_with("@t:dl.needsEpicLauncher") {
                    return Err(first);
                }
                if entry.can_run_offline {
                    let mut offline_args = vec!["--offline"];
                    offline_args.extend(custom_refs.iter().copied());
                    spawn_launched(&app, &bin, &app_name, &offline_args)
                        .await
                        .map(|_| format!("@t:dl.launchedOffline\u{1f}{title}"))
                        .map_err(|e| format!("{first}\n{e}"))
                } else {
                    Err(first)
                }
            }
        }
    } else {
        // Not installed: check for a third-party launcher (EA App / Origin or Ubisoft)
        let config = crate::legendary::skip::default_config_dir();
        let meta_path = config.join("metadata").join(format!("{app_name}.json"));
        if let Ok(text) = std::fs::read_to_string(&meta_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                let title = json
                    .get("app_title")
                    .and_then(|t| t.as_str())
                    .unwrap_or(&app_name)
                    .to_string();
                let lower = text.to_lowercase();
                if lower.contains("origin")
                    || lower.contains("the ea app")
                    || lower.contains("ea games")
                    || lower.contains("respawn")
                {
                    return spawn_launched(&app, &bin, &app_name, &["--origin"])
                        .await
                        .map(|_| format!("@t:dl.launchedEa\u{1f}{title}"));
                } else if lower.contains("ubisoftconnect") || lower.contains("ubisoft") {
                    return spawn_launched(&app, &bin, &app_name, &["--ubisoft"])
                        .await
                        .map(|_| format!("@t:dl.launchedUbisoft\u{1f}{title}"));
                }
            }
        }
        Err("@t:dl.notInstalled".to_string())
    }
}

/// Ends the running game the way Steam's Stop does: kill the processes that
/// belong to this install, then tell the UI the session is over.
#[tauri::command]
pub async fn epic_stop_game(app: AppHandle, app_name: String) -> Result<String, String> {
    let config = crate::legendary::skip::default_config_dir();
    let installed_games = crate::legendary::cache::read_installed(&config);
    let installed_entry = installed_games.iter().find(|g| g.app_name == app_name);
    let install_path = installed_entry
        .map(|g| std::path::PathBuf::from(&g.install_path))
        .filter(|p| p.exists());
    let main_executable = installed_entry.map(|g| g.executable.as_str());
    let candidate_exes = if let Some(ref ip) = install_path {
        discover_game_executables(ip, main_executable)
    } else {
        Vec::new()
    };
    let pids = game_process_pids(install_path.as_deref(), &candidate_exes);
    if pids.is_empty() {
        crate::legendary::screenshots::clear_active_running_game(&app_name);
        let _ = app.emit(
            "game-status",
            serde_json::json!({ "id": app_name, "running": false }),
        );
        return Err("@t:dl.notRunning".to_string());
    }
    for pid in &pids {
        #[cfg(windows)]
        {
            let mut cmd = tokio::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output().await;
        }
        #[cfg(not(windows))]
        {
            let _ = tokio::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output()
                .await;
        }
    }
    crate::legendary::screenshots::clear_active_running_game(&app_name);
    wake_main_window(&app);
    let _ = app.emit(
        "game-status",
        serde_json::json!({ "id": app_name, "running": false }),
    );
    Ok("@t:dl.stopped".to_string())
}

/// Detects executable (.exe) files in the game directory.
/// Shared-library and crash-reporter binaries are filtered out.
pub fn discover_game_executables(
    install_path: &Path,
    main_executable: Option<&str>,
) -> Vec<String> {
    let mut exes = Vec::new();
    if let Some(main) = main_executable {
        let name = Path::new(main)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(main);
        if !name.is_empty() {
            exes.push(name.to_lowercase());
        }
    }

    if install_path.is_dir() {
        let ignored_keywords = [
            "vc_redist",
            "vcredist",
            "dxsetup",
            "crashreportclient",
            "epicgameslauncher",
            "legendary",
            "unrealcefsubprocess",
            "unitycrashhandler",
        ];
        scan_dir_for_exes(install_path, 0, 4, &ignored_keywords, &mut exes);
    }

    exes.sort();
    exes.dedup();
    exes
}

pub(super) fn scan_dir_for_exes(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    ignored: &[&str],
    out: &mut Vec<String>,
) {
    if depth > max_depth {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if ext.eq_ignore_ascii_case("exe") {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            let lower = name.to_lowercase();
                            let is_ignored = ignored.iter().any(|ign| lower.contains(ign));
                            if !is_ignored && !out.contains(&lower) {
                                out.push(lower);
                            }
                        }
                    }
                }
            } else if path.is_dir() {
                if let Some(dname) = path.file_name().and_then(|n| n.to_str()) {
                    if !dname.starts_with('.') && !dname.starts_with('$') {
                        scan_dir_for_exes(&path, depth + 1, max_depth, ignored, out);
                    }
                }
            }
        }
    }
}

/// True when `image` is the install directory itself or a file inside it.
/// A drive root (`C:\`) is rejected so a bad path cannot match every process.
pub fn image_inside_install(image: &str, install: &str) -> bool {
    let image = image
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    let install = install
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase();
    if install.len() < 4 || !install.contains('\\') {
        return false;
    }
    image == install || image.starts_with(&(install + "\\"))
}

/// Host processes that must never be stopped just because a game folder
/// happens to contain a file with the same name.
pub(super) fn shared_host_exe(name: &str) -> bool {
    matches!(
        name,
        "msedgewebview2.exe"
            | "msedge.exe"
            | "chrome.exe"
            | "conhost.exe"
            | "cmd.exe"
            | "powershell.exe"
            | "pwsh.exe"
            | "runtimebroker.exe"
            | "dllhost.exe"
            | "svchost.exe"
            | "explorer.exe"
            | "efxlve-launcher.exe"
            | "legendary.exe"
            | "crashpad_handler.exe"
            | "wwahost.exe"
    )
}

/// WebView2 goes blank after a fullscreen game is killed. Nudging the window
/// size forces the surface to composite again.
pub fn wake_main_window(app: &AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if window.is_fullscreen().unwrap_or(false) || window.is_maximized().unwrap_or(false) {
        return;
    }
    let Ok(size) = window.inner_size() else {
        return;
    };
    let nudged = tauri::PhysicalSize {
        width: size.width,
        height: size.height.saturating_sub(1).max(1),
    };
    let _ = window.set_size(tauri::Size::Physical(nudged));
    let _ = window.set_size(tauri::Size::Physical(size));
}

#[cfg(target_os = "windows")]
mod win_process {
    use std::path::Path;

    type HANDLE = *mut std::ffi::c_void;
    type BOOL = i32;
    type DWORD = u32;
    type WCHAR = u16;

    const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
    const TH32CS_SNAPPROCESS: DWORD = 0x00000002;
    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: DWORD,
        cnt_usage: DWORD,
        th32_process_id: DWORD,
        th32_default_heap_id: usize,
        th32_module_id: DWORD,
        cnt_threads: DWORD,
        th32_parent_process_id: DWORD,
        pc_pri_class_base: i32,
        dw_flags: DWORD,
        sz_exe_file: [WCHAR; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: DWORD, th32ProcessID: DWORD) -> HANDLE;
        fn Process32FirstW(hSnapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
        fn Process32NextW(hSnapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
        fn CloseHandle(hObject: HANDLE) -> BOOL;
        fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
        fn QueryFullProcessImageNameW(
            hProcess: HANDLE,
            dwFlags: DWORD,
            lpExeName: *mut WCHAR,
            lpdwSize: *mut DWORD,
        ) -> BOOL;
    }

    pub fn is_game_process_running(install_path: Option<&Path>, candidate_exes: &[String]) -> bool {
        !game_process_pids(install_path, candidate_exes).is_empty()
    }

    /// One snapshot of the process list, cached for a second.
    ///
    /// Every session watcher (Epic 1.5 s, GOG 1 s, companion 5 s) and the
    /// screenshot hotkey call `game_process_pids`, and each call used to open
    /// every process to read its image path: hundreds of handles a second. The
    /// list does not change meaningfully inside a second, so one snapshot
    /// serves them all. Rows are `(pid, exe name, image path)`; the path is
    /// `None` when the process refuses to open.
    fn process_snapshot() -> std::sync::Arc<Vec<(u32, String, Option<String>)>> {
        use std::sync::{Arc, Mutex, OnceLock};
        use std::time::{Duration, Instant};

        static CACHE: OnceLock<Mutex<Option<(Instant, Arc<Vec<(u32, String, Option<String>)>>)>>> =
            OnceLock::new();
        const TTL: Duration = Duration::from_secs(1);

        let cache = CACHE.get_or_init(|| Mutex::new(None));
        if let Ok(guard) = cache.lock() {
            if let Some((at, list)) = guard.as_ref() {
                if at.elapsed() < TTL {
                    return list.clone();
                }
            }
        }

        let list = Arc::new(walk_processes());
        if let Ok(mut guard) = cache.lock() {
            *guard = Some((Instant::now(), list.clone()));
        }
        list
    }

    /// Reads the process list once, path included.
    fn walk_processes() -> Vec<(u32, String, Option<String>)> {
        let mut rows = Vec::new();
        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return rows;
            }

            let mut entry = std::mem::zeroed::<PROCESSENTRY32W>();
            entry.dw_size = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;

            if Process32FirstW(snapshot, &mut entry) == 0 {
                CloseHandle(snapshot);
                return rows;
            }

            loop {
                let len = entry
                    .sz_exe_file
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.sz_exe_file.len());
                let exe_name = String::from_utf16_lossy(&entry.sz_exe_file[..len]).to_lowercase();
                let mut full_path: Option<String> = None;
                let h_proc =
                    OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32_process_id);
                if !h_proc.is_null() {
                    let mut buf = [0u16; 1024];
                    let mut size = buf.len() as DWORD;
                    if QueryFullProcessImageNameW(h_proc, 0, buf.as_mut_ptr(), &mut size) != 0 {
                        full_path = Some(
                            String::from_utf16_lossy(&buf[..size as usize])
                                .replace('/', "\\")
                                .to_lowercase(),
                        );
                    }
                    CloseHandle(h_proc);
                }
                rows.push((entry.th32_process_id, exe_name, full_path));

                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }

            CloseHandle(snapshot);
        }
        rows
    }

    /// PIDs whose image name matches a candidate exe, or whose full path sits
    /// inside the install folder. Used both to detect a running game and to
    /// stop it (Steam-style) without killing unrelated processes.
    pub fn game_process_pids(install_path: Option<&Path>, candidate_exes: &[String]) -> Vec<u32> {
        if candidate_exes.is_empty() && install_path.is_none() {
            return Vec::new();
        }

        let norm_install_path = install_path.map(|p| {
            p.to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase()
        });

        let self_pid = std::process::id();
        let self_exe = std::env::current_exe().ok().and_then(|p| {
            p.to_str()
                .map(|s| s.replace('/', "\\").trim_end_matches('\\').to_lowercase())
        });

        let mut pids = Vec::new();
        for (pid, exe_name, full_path) in process_snapshot().iter() {
            let is_self = *pid == self_pid
                || full_path.as_ref().is_some_and(|p| self_exe.as_ref() == Some(p));
            let inside = full_path.as_deref().is_some_and(|p| {
                norm_install_path
                    .as_deref()
                    .is_some_and(|inst| super::image_inside_install(p, inst))
            });
            let ignored = full_path.as_deref().is_some_and(|p| {
                p.contains("crashreportclient")
                    || p.contains("vc_redist")
                    || p.contains("vcredist")
                    || p.contains("dxsetup")
                    || p.contains("unrealcefsubprocess")
                    || p.contains("msedgewebview2.exe")
            });
            let name_hit =
                !candidate_exes.is_empty() && candidate_exes.iter().any(|c| c == exe_name);
            // A readable path outside the install folder is never the game.
            // Matching on the file name alone used to kill WebView2 (and blank
            // this window) when the game shipped a helper with the same name.
            let matched = !is_self
                && if norm_install_path.is_some() && full_path.is_some() {
                    inside && !ignored
                } else {
                    name_hit && !super::shared_host_exe(exe_name)
                };

            if matched {
                pids.push(*pid);
            }
        }
        pids
    }
}

#[cfg(not(target_os = "windows"))]
mod win_process {
    use std::path::Path;
    pub fn is_game_process_running(
        _install_path: Option<&Path>,
        _candidate_exes: &[String],
    ) -> bool {
        false
    }

    pub fn game_process_pids(_install_path: Option<&Path>, _candidate_exes: &[String]) -> Vec<u32> {
        Vec::new()
    }
}

pub use win_process::{game_process_pids, is_game_process_running};

/// Epic ships some titles behind a small `PlayTitle.exe`. Rockstar then
/// refuses to start unless Epic Games Launcher is the parent process, so
/// these titles are handed to Epic instead of the raw game binary
/// (`PlayRDR2.exe` next to `RDR2.exe`).
pub(super) fn direct_game_exe(install_path: &Path, executable: &str) -> Option<String> {
    let file_name = Path::new(executable).file_name()?.to_str()?;
    if file_name.len() <= 8 || !file_name[file_name.len() - 4..].eq_ignore_ascii_case(".exe") {
        return None;
    }
    let stem = &file_name[..file_name.len() - 4];
    if !stem[..4].eq_ignore_ascii_case("play") {
        return None;
    }
    let real_name = format!("{}.exe", &stem[4..]);
    let stub = install_path.join(file_name);
    let real = install_path.join(&real_name);
    if !real.is_file() {
        return None;
    }
    let stub_len = std::fs::metadata(&stub).ok()?.len();
    let real_len = std::fs::metadata(&real).ok()?.len();
    if stub_len < 8 * 1024 * 1024 && real_len > stub_len {
        Some(real_name)
    } else {
        None
    }
}

/// Epic's Rockstar stubs (`PlayGTA3.exe`, `PlayRDR2.exe`): a small launcher that
/// only continues when the Epic Games Launcher is the parent process. The real
/// binary is not always a sibling of the stub (GTA III ships `PlayGTA3.exe`
/// above `Engine/`), so the known stub names are matched explicitly.
const ROCKSTAR_STUBS: [&str; 5] = [
    "playgta3.exe",
    "playgtavc.exe",
    "playgtasa.exe",
    "playgtav.exe",
    "playrdr2.exe",
];

pub(super) fn is_rockstar_stub(install_path: &Path, executable: &str) -> bool {
    let Some(name) = Path::new(executable).file_name().and_then(|f| f.to_str()) else {
        return false;
    };
    if !ROCKSTAR_STUBS.contains(&name.to_ascii_lowercase().as_str()) {
        return false;
    }
    std::fs::metadata(install_path.join(name))
        .map(|meta| meta.len() < 8 * 1024 * 1024)
        .unwrap_or(false)
}

pub(super) async fn spawn_launched(
    app: &AppHandle,
    bin: &PathBuf,
    app_name: &str,
    extra_args: &[&str],
) -> Result<(), String> {
    let config = crate::legendary::skip::default_config_dir();
    let installed_games = crate::legendary::cache::read_installed(&config);
    let installed_entry = installed_games.iter().find(|g| g.app_name == app_name);

    let meta_path = config.join("metadata").join(format!("{app_name}.json"));
    let game_title = installed_entry
        .map(|g| g.title.clone())
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string(&meta_path)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| {
                    v.get("app_title")
                        .and_then(|t| t.as_str())
                        .map(|s| s.to_string())
                })
        })
        .unwrap_or_else(|| app_name.to_string());

    // Rockstar closes the game when its parent is not Epic. Ask the Epic Games
    // Launcher to start the existing install instead of the raw game binary.
    // Without it the chain cannot finish — Rockstar then shows a "please try
    // reinstalling" error — so say what is actually missing.
    let needs_epic = installed_entry.is_some_and(|entry| {
        let install = Path::new(&entry.install_path);
        direct_game_exe(install, &entry.executable).is_some()
            || is_rockstar_stub(install, &entry.executable)
    });
    let epic_handoff = if needs_epic {
        match crate::legendary::import_installed::epic_launcher_executable() {
            Some(exe) => Some(exe),
            None => return Err(format!("@t:dl.needsEpicLauncher\u{1f}{game_title}")),
        }
    } else {
        None
    };

    if let Some(epic_exe) = epic_handoff.as_ref() {
        if let Some(entry) = installed_entry {
            crate::legendary::import_installed::bind_existing_install(
                app_name,
                Path::new(&entry.install_path),
            );
        }
        let uri = format!("com.epicgames.launcher://apps/{app_name}?action=launch&silent=true");
        let _ = tokio::process::Command::new(epic_exe).arg(uri).spawn();
    }

    let mut cmd = if epic_handoff.is_some() {
        // Epic stays open after the game exits, so it is not the process we wait on.
        let mut cmd = tokio::process::Command::new("cmd");
        cmd.args(["/C", "exit", "0"]);
        cmd
    } else {
        let mut cmd = tokio::process::Command::new(bin);
        cmd.arg("launch").arg(app_name);
        cmd
    };

    // Per-game wrapper + environment variables (applied to legendary so the
    // launched game inherits them).
    let cfgs = crate::legendary::commands::load_all_game_custom_configs();
    if epic_handoff.is_none() {
        if let Some(cfg) = cfgs.get(app_name) {
            if let Some(wrapper) = cfg
                .wrapper
                .as_deref()
                .map(str::trim)
                .filter(|w| !w.is_empty())
            {
                cmd.arg("--wrapper").arg(wrapper);
            }
            if let Some(envs) = cfg.env_vars.as_ref() {
                for (key, value) in envs {
                    if !key.trim().is_empty() {
                        cmd.env(key.trim(), value);
                    }
                }
            }
        }

        for arg in extra_args {
            cmd.arg(arg);
        }
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let install_path: Option<PathBuf> = installed_entry
        .map(|g| PathBuf::from(&g.install_path))
        .filter(|p| p.exists());

    let main_executable = installed_entry.map(|g| g.executable.as_str());

    let candidate_exes = if let Some(ref ip) = install_path {
        discover_game_executables(ip, main_executable)
    } else {
        let mut v = Vec::new();
        if let Some(me) = main_executable {
            let name = Path::new(me)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(me);
            if !name.is_empty() {
                v.push(name.to_lowercase());
            }
        }
        v
    };

    crate::legendary::screenshots::set_active_running_game(
        app_name,
        &game_title,
        install_path.clone(),
        candidate_exes.clone(),
    );

    // Early-crash check in the first 2.5 seconds (only errors on a non-zero exit with no running process)
    let early_failure =
        match tokio::time::timeout(std::time::Duration::from_millis(2500), child.wait()).await {
            Ok(Ok(st)) if !st.success() => {
                if !is_game_process_running(install_path.as_deref(), &candidate_exes) {
                    Some(format!("@t:dl.launchFailedCode\u{1f}{:?}", st.code()))
                } else {
                    None
                }
            }
            Ok(Err(e)) => {
                if !is_game_process_running(install_path.as_deref(), &candidate_exes) {
                    Some(e.to_string())
                } else {
                    None
                }
            }
            _ => None,
        };

    if let Some(err) = early_failure {
        crate::legendary::screenshots::clear_active_running_game(app_name);
        let _ = app.emit(
            "game-status",
            serde_json::json!({
                "id": app_name,
                "running": false,
            }),
        );
        return Err(err);
    }

    // Game launched! Move the UI into the "Playing..." state
    let _ = app.emit(
        "game-status",
        serde_json::json!({
            "id": app_name,
            "running": true,
        }),
    );

    let app_bg = app.clone();
    let app_name_bg = app_name.to_string();
    let bin_bg = bin.clone();
    let install_path_bg = install_path;
    let candidate_exes_bg = candidate_exes;
    let start_time = std::time::Instant::now();
    let start_system_time = std::time::SystemTime::now();

    tokio::spawn(async move {
        let mut child = child;
        let mut child_finished = false;
        let mut game_detected = false;
        let mut consecutive_not_found = 0;
        let mut last_heartbeat = std::time::Instant::now();

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

            if !child_finished {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        child_finished = true;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        child_finished = true;
                    }
                }
            }

            let proc_running =
                is_game_process_running(install_path_bg.as_deref(), &candidate_exes_bg);

            if proc_running || (!child_finished) {
                if !game_detected {
                    // Crash-safe session: keep a marker so a launcher restart
                    // can still recover this playtime.
                    crate::legendary::playtime_session::begin(&app_name_bg);
                }
                game_detected = true;
                if last_heartbeat.elapsed() >= std::time::Duration::from_secs(15) {
                    crate::legendary::playtime_session::heartbeat();
                    last_heartbeat = std::time::Instant::now();
                }
                consecutive_not_found = 0;
                continue;
            }

            // Neither the child nor the game process is visible
            if !game_detected {
                // Grace period: allow 20s for the EAC/splash screen or engine loading at startup
                if start_time.elapsed() < std::time::Duration::from_secs(20) {
                    continue;
                }
                // No process was caught within 20s and the child has exited
                break;
            } else {
                // The game was active before; to avoid false alarms during transitions,
                // wait for 3 consecutive checks (~4.5s) with no process found
                consecutive_not_found += 1;
                if consecutive_not_found >= 3 {
                    break;
                }
            }
        }

        // --- OYUN SONLANDI ---
        crate::legendary::screenshots::clear_active_running_game(&app_name_bg);
        let elapsed = start_time.elapsed().as_secs();
        let rec = if game_detected && elapsed >= 5 {
            match crate::legendary::playtime::record_session(&app_name_bg, elapsed) {
                Ok(record) => {
                    // The marker is only dropped once the live record exists;
                    // on a write failure the next start recovers the session.
                    crate::legendary::playtime_session::finish();
                    record
                }
                Err(_) => crate::legendary::playtime::get_game_playtime(&app_name_bg),
            }
        } else {
            crate::legendary::playtime::get_game_playtime(&app_name_bg)
        };

        // Automatically scan and organize new screenshots taken during play
        let clean_t = crate::legendary::screenshots::clean_folder_name(&app_name_bg);
        let new_shots =
            crate::legendary::screenshots::scan_new_captures_for_game(&clean_t, start_system_time);
        if !new_shots.is_empty() {
            let _ = app_bg.emit(
                "screenshots-updated",
                serde_json::json!({
                    "id": app_name_bg,
                    "count": new_shots.len(),
                }),
            );
        }

        wake_main_window(&app_bg);
        let _ = app_bg.emit(
            "game-status",
            serde_json::json!({
                "id": app_name_bg,
                "running": false,
                "sessionSeconds": elapsed,
                "totalSeconds": rec.total_seconds,
                "sessionCount": rec.session_count,
                "lastPlayed": rec.last_played,
                "lastPlayedTimestamp": rec.last_played_timestamp,
            }),
        );

        // Auto Cloud Backup (WebDAV/Google Drive) if enabled in settings
        crate::cloud_backup::manager::trigger_auto_sync_on_exit(
            app_bg.clone(),
            app_name_bg.clone(),
        );

        // Cloud sync defaults on. The toggle lives in efxlve_game_settings.json
        // (camelCase). An older path looked at a file that was never written, so
        // legendary sync-saves never ran.
        let should_sync = crate::legendary::commands::load_all_game_custom_configs()
            .get(&app_name_bg)
            .and_then(|c| c.cloud_saves_enabled)
            .unwrap_or(true);

        if should_sync {
            let save_path = crate::legendary::commands::resolve_save_path(&app_name_bg);
            let (success, message) = match crate::legendary::commands::run_cloud_sync(
                &bin_bg,
                &app_bg,
                &app_name_bg,
                save_path.as_deref(),
            )
            .await
            {
                // The helper already folds the silent `-y` skip into `false`.
                Ok((true, _)) => (true, String::new()),
                Ok((false, text)) if crate::legendary::commands::sync_skipped(&text) => {
                    (false, "@t:manage.syncNoSavePath".to_string())
                }
                Ok((false, text)) => (false, short_error(&text)),
                Err(e) => (false, e),
            };
            // The manual button records the time; without the same record here the
            // Manage panel keeps an old "Last synced" and the automatic upload
            // looks like it never ran.
            let synced_at = if success {
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis().to_string())
                    .unwrap_or_default();
                crate::legendary::commands::update_game_last_cloud_sync(&app_name_bg, &now);
                now
            } else {
                String::new()
            };
            let _ = app_bg.emit(
                "cloud-sync-complete",
                serde_json::json!({
                    "id": app_name_bg,
                    "success": success,
                    "message": message,
                    "syncedAt": synced_at
                }),
            );
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stub_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("efxlve-launch-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn rockstar_stubs_are_recognised_by_name_and_size() {
        let dir = stub_dir("rockstar");
        std::fs::write(dir.join("PlayGTA3.exe"), vec![0u8; 64]).expect("stub");
        assert!(is_rockstar_stub(&dir, "PlayGTA3.exe"));
        assert!(is_rockstar_stub(&dir, "playgta3.exe"));
        // The real binary, a stub that is not on disk, and huge files are not stubs.
        assert!(!is_rockstar_stub(&dir, "GTA3.exe"));
        assert!(!is_rockstar_stub(&dir, "PlayGTAV.exe"));
        let big = std::fs::File::create(dir.join("PlayGTASA.exe")).expect("big file");
        big.set_len(16 * 1024 * 1024).expect("sparse file");
        assert!(!is_rockstar_stub(&dir, "PlayGTASA.exe"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_sibling_stub_check_still_finds_the_real_binary() {
        let dir = stub_dir("sibling");
        std::fs::write(dir.join("PlayRDR2.exe"), vec![0u8; 64]).expect("stub");
        std::fs::write(dir.join("RDR2.exe"), vec![0u8; 4096]).expect("real");
        assert_eq!(
            direct_game_exe(&dir, "PlayRDR2.exe"),
            Some("RDR2.exe".to_string())
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
