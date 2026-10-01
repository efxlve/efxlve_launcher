//! Uninstall one Epic game and delete the install folder when asked.
//!
//! The folder delete goes through `guard` first.

use std::path::PathBuf;
use std::process::Stdio;

use tauri::AppHandle;

use super::guard::{force_remove_dir_all, is_safe_game_dir};
use super::launch::epic_stop_game;
use super::parse::short_error;
use super::paths::{default_install_dir, resolve_bin};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
pub async fn epic_uninstall_game(
    app: AppHandle,
    app_name: String,
    keep_files: bool,
) -> Result<String, String> {
    let bin = resolve_bin(&app)?;
    let config = crate::legendary::skip::default_config_dir();

    // Terminate any running process for this game before uninstalling
    let _ = epic_stop_game(app.clone(), app_name.clone()).await;

    // 1. Gather title and install path while installed.json or EGL manifests still have them
    let mut resolved_title = app_name.clone();
    let mut resolved_install_path: Option<PathBuf> = None;

    let installed_list = crate::legendary::cache::read_installed(&config);
    if let Some(entry) = installed_list
        .iter()
        .find(|g| g.app_name.eq_ignore_ascii_case(&app_name))
    {
        if !entry.title.trim().is_empty() {
            resolved_title = entry.title.clone();
        }
        if !entry.install_path.trim().is_empty() {
            resolved_install_path = Some(PathBuf::from(entry.install_path.trim()));
        }
    }

    if resolved_install_path.is_none() {
        let egl_games = crate::legendary::cache::read_egl_installed_games();
        if let Some(egl) = egl_games
            .iter()
            .find(|g| g.app_name.eq_ignore_ascii_case(&app_name))
        {
            if !egl.title.trim().is_empty() {
                resolved_title = egl.title.clone();
            }
            if !egl.install_path.trim().is_empty() {
                resolved_install_path = Some(PathBuf::from(egl.install_path.trim()));
            }
        }
    }

    // Read the title while installed.json still has it, then drop the matching .lnk.
    crate::legendary::commands::remove_desktop_shortcut(&app_name).await;

    // 2. Run legendary uninstall
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("-y").arg("uninstall");
    if keep_files {
        cmd.arg("--keep-files");
    }
    cmd.arg(&app_name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().await.map_err(|e| e.to_string())?;

    // 3. Remove all EGL .item manifests in ProgramData for this game (and any of its DLCs).
    // Critical: If the .item manifest remains, official Epic Games Store displays
    // "Repair" instead of returning to the uninstalled state, and our launcher
    // re-detects the game on refresh.
    crate::legendary::cache::remove_egl_manifests_for_game(&app_name);

    // 4. When not keeping files, completely remove remaining game files and directories
    if !keep_files {
        if let Some(ref path) = resolved_install_path {
            let def_dir = default_install_dir();
            if path.is_dir() && is_safe_game_dir(path, &def_dir) {
                let _ = force_remove_dir_all(path);
            }
        }
    }

    // 5. Ensure the game is pruned from installed.json and manifests
    crate::legendary::cache::remove_game_from_installed_json(&config, &app_name);
    crate::legendary::cache::remove_game_manifests(&config, &app_name);

    if out.status.success() {
        Ok(format!("@t:dl.uninstalled\u{1f}{resolved_title}"))
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        let low = err.to_lowercase();
        // If legendary reported it wasn't installed in its own database, but our
        // cleanup completed (e.g. for EGL-imported games), treat it as uninstalled.
        if low.contains("not installed")
            || resolved_install_path
                .as_ref()
                .map(|p| !p.exists())
                .unwrap_or(false)
        {
            Ok(format!("@t:dl.uninstalled\u{1f}{resolved_title}"))
        } else {
            Err(short_error(&err))
        }
    }
}
