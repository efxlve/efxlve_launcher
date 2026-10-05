//! Amazon manage actions: verify, move, desktop shortcut and per-game settings.
//!
//! These reuse the shared launcher machinery where it exists (the move engine,
//! verify progress payloads, the local save/cloud backup config), so the
//! Amazon manage screen supports what the Epic one does.

use std::path::{Path, PathBuf};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{AppHandle, Emitter};

use crate::legendary::commands::{load_all_game_custom_configs, GameLocalSettings};
use crate::legendary::commands::{VerifyCompletePayload, VerifyProgressPayload};
use crate::legendary::move_game::{move_game_folder_record, MoveGameResult, MoveRecord};

use super::cli;
use super::library;
use super::transfers::{parse_progress_line, parse_speed_line};

/// Progress emitter for `nile verify` (stderr lines, same format as installs).
fn verify_emitter(app: AppHandle, event_id: String) -> impl FnMut(&str) + Send + 'static {
    let mut last_download = 0.0f64;
    move |line: &str| {
        if let Some(rate) = parse_speed_line(line) {
            if !rate.disk {
                last_download = rate.mib_per_sec;
            }
            return;
        }
        if let Some(progress) = parse_progress_line(line) {
            let speed = if last_download > 0.0 {
                format!("{:.1} MiB/s", last_download)
            } else {
                String::new()
            };
            let _ = app.emit(
                "verify-progress",
                VerifyProgressPayload {
                    id: event_id.clone(),
                    current: progress.downloaded,
                    total: progress.total,
                    percent: progress.percent,
                    speed,
                    detail: String::new(),
                },
            );
        }
    }
}

/// Verifies (and repairs) one installed Amazon game through Nile.
#[tauri::command]
pub async fn nile_verify(app: AppHandle, id: String) -> Result<(), String> {
    if library::installed_game(&app, &id).is_none() {
        return Err("@t:dl.notInstalled".to_string());
    }
    let event_id = format!("amazon::{id}");
    let emitter = verify_emitter(app.clone(), event_id.clone());
    // The verify runs for as long as hashing the game takes; stream it in the
    // background so the manage dialog stays responsive and the completion
    // arrives as the shared `verify-complete` event.
    tokio::spawn(async move {
        let args = vec!["verify".to_string(), id];
        let outcome = cli::run_streaming(&app, &args, 6 * 3600, emitter).await;
        let (success, message) = match outcome {
            Ok(out) if out.status.success() => (true, "@t:verify.success".to_string()),
            Ok(out) => (false, cli::failure_message(&out)),
            Err(e) => (false, e),
        };
        let _ = app.emit(
            "verify-complete",
            VerifyCompletePayload {
                id: event_id,
                success,
                message,
            },
        );
    });
    Ok(())
}

/// Imports an Amazon game installed outside Nile (an older client's folder).
#[tauri::command]
pub async fn nile_import(app: AppHandle, id: String, path: String) -> Result<(), String> {
    if library::installed_game(&app, &id).is_some() {
        return Err("@t:amazon.alreadyInstalled".to_string());
    }
    let out = cli::run(&app, &["import", &id, "--path", &path], 6 * 3600).await?;
    if !out.status.success() {
        return Err(cli::failure_message(&out));
    }
    // Nile exits zero when it refuses the import; the record is the postcondition.
    if library::installed_game(&app, &id).is_none() {
        return Err("@t:amazon.importFailed".to_string());
    }
    Ok(())
}

/// Moves one installed Amazon game and repoints Nile's install record.
#[tauri::command]
pub async fn nile_move_game(
    app: AppHandle,
    app_name: String,
    target_base_path: String,
) -> Result<MoveGameResult, String> {
    if !app_name.starts_with("amazon::") {
        return Err(format!("@t:move.noInstallRecord\u{1f}{app_name}"));
    }
    let config = cli::config_dir(&app);
    move_game_folder_record(app, &config, app_name, target_base_path, MoveRecord::Amazon).await
}

/// First `.exe` under an install folder, for the shortcut icon. Top level
/// wins; subfolders are searched a couple of levels deep for unusual layouts.
fn find_exe(dir: &Path, depth: u8) -> Option<PathBuf> {
    let mut fallback: Option<PathBuf> = None;
    for entry in std::fs::read_dir(dir).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if fallback.is_none() && depth > 0 {
                fallback = find_exe(&path, depth - 1);
            }
            continue;
        }
        if path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("exe"))
            != Some(true)
        {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default()
            .to_ascii_lowercase();
        if name.contains("unins") || name.contains("vcredist") || name.contains("crashreport") {
            continue;
        }
        return Some(path);
    }
    fallback
}

/// The desktop `.lnk` name this module writes and removes.
fn shortcut_file_name(title: &str) -> String {
    let clean = title.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], " ");
    format!("{}.lnk", clean.trim())
}

/// Removes the Amazon desktop shortcut of a game (used on uninstall).
pub(crate) fn remove_shortcut_for_title(title: &str) {
    #[cfg(windows)]
    {
        let file_name = shortcut_file_name(title).replace('\'', "''");
        if file_name == ".lnk" {
            return;
        }
        let ps = format!(
            "$d = [Environment]::GetFolderPath('Desktop'); $lnk = Join-Path $d '{file_name}'; if (Test-Path -LiteralPath $lnk) {{ Remove-Item -LiteralPath $lnk -Force }}"
        );
        let _ = std::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(0x08000000)
            .spawn();
    }
    #[cfg(not(windows))]
    {
        let _ = title;
    }
}

/// Creates a desktop shortcut that launches the game through this launcher.
#[tauri::command]
pub async fn nile_create_desktop_shortcut(app: AppHandle, id: String) -> Result<String, String> {
    let state =
        library::installed_state(&app, &id).ok_or_else(|| "@t:dl.notInstalled".to_string())?;
    let title = library::game_title(&app, &id).unwrap_or_else(|| id.clone());

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let install_path = PathBuf::from(&state.path);
        let icon_exe = find_exe(&install_path, 2).unwrap_or_else(|| install_path.clone());
        let launcher_exe = std::env::current_exe().map_err(|e| e.to_string())?;
        let launcher_dir = launcher_exe
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_default();
        let file_name = shortcut_file_name(&title).replace('\'', "''");
        // Like the Epic shortcut, the target is the launcher: a direct exe link
        // would skip Nile's environment setup.
        let ps = format!(
            "$ws = New-Object -ComObject WScript.Shell; $d = [Environment]::GetFolderPath('Desktop'); $lnk = Join-Path $d '{file_name}'; $s = $ws.CreateShortcut($lnk); $s.TargetPath = '{}'; $s.Arguments = '--launch \"amazon::{id}\"'; $s.WorkingDirectory = '{}'; $s.IconLocation = '{},0'; $s.Save()",
            launcher_exe.to_string_lossy().replace('\'', "''"),
            launcher_dir.to_string_lossy().replace('\'', "''"),
            icon_exe.to_string_lossy().replace('\'', "''"),
        );

        let output = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(format!("@t:manage.shortcutCreated\u{1f}{title}"))
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(format!("@t:manage.shortcutCreateFailed\u{1f}{err}"))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (state, title);
        Err("@t:manage.shortcutWindowsOnly".to_string())
    }
}

/// Per-game manage settings for one Amazon title, in the shared shape so the
/// manage screen, save backups and the cloud upload all keep working.
#[tauri::command]
pub fn nile_game_settings(app: AppHandle, id: String) -> Result<GameLocalSettings, String> {
    let key = format!("amazon::{id}");
    let title = library::game_title(&app, &id).unwrap_or_else(|| id.clone());
    let state = library::installed_state(&app, &id);
    let cfgs = load_all_game_custom_configs();
    let cfg = cfgs.get(&key);
    let install_path = state.as_ref().map(|s| s.path.clone()).unwrap_or_default();
    let detected_save_path = crate::legendary::backup::detect_save_path(
        &key,
        Some(&title),
        if install_path.is_empty() {
            None
        } else {
            Some(&install_path)
        },
    );
    Ok(GameLocalSettings {
        app_name: key,
        title: title.clone(),
        launch_parameters: cfg
            .and_then(|c| c.launch_parameters.clone())
            .unwrap_or_default(),
        auto_update: cfg.and_then(|c| c.auto_update).unwrap_or(true),
        high_priority: cfg.and_then(|c| c.high_priority).unwrap_or(false),
        cloud_saves_enabled: cfg.and_then(|c| c.cloud_saves_enabled).unwrap_or(true),
        last_cloud_sync: cfg.and_then(|c| c.last_cloud_sync.clone()),
        install_size: state.as_ref().map(|s| s.size).unwrap_or(0),
        install_path: install_path.clone(),
        version: state.and_then(|s| s.version).unwrap_or_default(),
        wrapper: cfg.and_then(|c| c.wrapper.clone()).unwrap_or_default(),
        env_vars: cfg.and_then(|c| c.env_vars.clone()).unwrap_or_default(),
        save_path: None,
        custom_save_path: cfg.and_then(|c| c.custom_save_path.clone()),
        detected_save_path,
    })
}
