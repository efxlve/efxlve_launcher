//! Uninstall one Epic game and delete the install folder when asked.
//!
//! A copy the launcher did not install (an EA App game under `Program Files`)
//! is removed by that client's own cleanup tool; every other folder delete goes
//! through `guard` first.

use std::path::{Path, PathBuf};
use std::process::Stdio;

use tauri::AppHandle;

use super::guard::{force_remove_dir_all, is_safe_game_dir};
use super::launch::epic_stop_game;
use super::parse::short_error;
use super::paths::resolve_bin;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

#[tauri::command]
pub async fn epic_uninstall_game(
    app: AppHandle,
    app_name: String,
    keep_files: bool,
) -> Result<String, String> {
    if super::queue::any_download_in_flight(&app) {
        return Err("@t:dl.anotherActive".into());
    }
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

    let err = String::from_utf8_lossy(&out.stderr);
    let low = err.to_lowercase();
    // If legendary reported it wasn't installed in its own database, but the
    // folder is gone (e.g. for EGL-imported games), treat it as uninstalled.
    let uninstalled = out.status.success()
        || low.contains("not installed")
        || resolved_install_path
            .as_ref()
            .map(|p| !p.exists())
            .unwrap_or(false);
    if !uninstalled {
        return Err(short_error(&err));
    }

    // 3. Remove the install folder before any record. A copy whose files
    // survived was not uninstalled, and the record has to stay so the next
    // attempt — an elevated run, once the user allows it — still finds it.
    // Third-party copies (an EA App install under `Program Files`) land here:
    // they have a folder but no legendary record, so legendary exits 0. Their
    // own client removes them, because deleting the folder here would leave the
    // client listing a game it can only "repair".
    if !keep_files {
        let leftover = |path: &Path| format!("@t:dl.uninstallLeftFiles\u{1f}{}", path.display());
        if let Some(path) = resolved_install_path.as_deref().filter(|path| path.is_dir()) {
            if crate::companion::has_foreign_uninstaller(path) {
                let _ = crate::companion::uninstall_foreign_copy(path).await;
                if path.exists() {
                    return Err(leftover(path));
                }
            } else {
                // A Fortnite-sized folder can take minutes to delete; keep the
                // async runtime free while the file walk runs.
                let owned = path.to_path_buf();
                let install_root = super::paths::resolve_base(&app, None);
                let removed = tauri::async_runtime::spawn_blocking(move || {
                    remove_install_folder(&owned, &install_root)
                })
                .await
                .ok()
                .flatten();
                if let Some(left) = removed {
                    return Err(leftover(&left));
                }
            }
        }
    }

    // 4. Remove all EGL .item manifests in ProgramData for this game (and any of its DLCs).
    // Critical: If the .item manifest remains, official Epic Games Store displays
    // "Repair" instead of returning to the uninstalled state, and our launcher
    // re-detects the game on refresh.
    crate::legendary::cache::remove_egl_manifests_for_game(&app_name);

    // 5. Ensure the game is pruned from installed.json and manifests
    crate::legendary::cache::remove_game_from_installed_json(&config, &app_name);
    crate::legendary::cache::remove_game_manifests(&config, &app_name);

    // A paused or crashed transfer leaves a resume record and a queue
    // snapshot; deleting the game must not resurrect them on restart.
    super::queue::forget_pending(&app_name);
    crate::legendary::download_resume::remove_resume(
        &crate::legendary::download_resume::resumes_path(),
        &app_name,
    );
    Ok(format!("@t:dl.uninstalled\u{1f}{resolved_title}"))
}

/// Removes one recorded install folder and answers with the folder that is
/// still on disk, if any.
///
/// A path that is already gone has nothing left to delete. A folder the guard
/// refuses is reported as leftover instead of being skipped: the caller must not
/// claim an uninstall whose files are still there.
///
/// Shared with the Amazon and Ubisoft uninstalls, so every launcher-owned store
/// treats a folder that survives the same way.
pub(crate) fn remove_install_folder(path: &Path, install_root: &Path) -> Option<PathBuf> {
    if !path.is_dir() {
        return None;
    }
    if !is_safe_game_dir(path, install_root) {
        return Some(path.to_path_buf());
    }
    match force_remove_dir_all(path) {
        Ok(()) if !path.exists() => None,
        _ => Some(path.to_path_buf()),
    }
}
