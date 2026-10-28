//! Updates, playtime, launcher preferences, save backups, collections, profile, and move.

use super::prelude::*;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameUpdateInfo {
    pub app_name: String,
    pub title: String,
    pub installed_version: String,
    pub latest_version: String,
}

/// Epic sometimes stores a build's file name where a version belongs
/// (`DBD_Vanilla_HFL_EGS_Shipping_9_3871532_10.2.0.7`). The list shows the
/// version, and comparing these keeps a rename from looking like an update.
fn display_version(raw: &str) -> String {
    let value = raw.trim();
    if value.is_empty() {
        return String::new();
    }
    if value.chars().all(|c| c.is_ascii_digit() || c == '.') {
        return value.to_string();
    }
    // The trailing number group is the version in every artifact name seen.
    value
        .rsplit('_')
        .next()
        .filter(|tail| tail.chars().all(|c| c.is_ascii_digit() || c == '.'))
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

#[tauri::command]
pub async fn epic_check_updates() -> Result<Vec<GameUpdateInfo>, String> {
    // Reads every installed game's metadata file: keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(check_updates_blocking)
        .await
        .map_err(|e| e.to_string())?
}

fn check_updates_blocking() -> Result<Vec<GameUpdateInfo>, String> {
    let config = skip::default_config_dir();
    let installed_path = config.join("installed.json");
    if !installed_path.is_file() {
        return Ok(Vec::new());
    }

    let installed_raw = std::fs::read_to_string(&installed_path).map_err(|e| e.to_string())?;
    let installed_map: serde_json::Value =
        serde_json::from_str(&installed_raw).map_err(|e| e.to_string())?;

    let meta_dir = config.join("metadata");
    let mut updates = Vec::new();

    if let Some(obj) = installed_map.as_object() {
        for (app_name, val) in obj {
            // Verify the game files actually exist on disk before checking for updates
            let install_path = val
                .get("install_path")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();
            if !install_path.is_empty() {
                let p = std::path::Path::new(install_path);
                if p.is_absolute() {
                    let drive_present = p
                        .components()
                        .next()
                        .map(|c| std::path::Path::new(&c).exists())
                        .unwrap_or(false);
                    if drive_present && !p.exists() {
                        continue;
                    }
                }
                let executable = val
                    .get("executable")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if !executable.is_empty() && !p.join(executable).exists() {
                    continue;
                }
            }

            let installed_ver = display_version(
                val.get("version")
                    .and_then(|v| v.as_str())
                    .unwrap_or(""),
            );
            let title = val
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or(app_name)
                .to_string();

            let meta_path = meta_dir.join(format!("{app_name}.json"));
            if meta_path.is_file() {
                if let Ok(meta_raw) = std::fs::read_to_string(&meta_path) {
                    if let Ok(meta_val) = serde_json::from_str::<serde_json::Value>(&meta_raw) {
                        let latest_ver = display_version(
                            meta_val
                                .pointer("/asset_infos/Windows/build_version")
                                .and_then(|v| v.as_str())
                                .or_else(|| {
                                    meta_val
                                        .pointer("/metadata/customAttributes/BuildVersion/value")
                                        .and_then(|v| v.as_str())
                                })
                                .unwrap_or(""),
                        );

                        if !installed_ver.is_empty()
                            && !latest_ver.is_empty()
                            && installed_ver != latest_ver
                        {
                            updates.push(GameUpdateInfo {
                                app_name: app_name.clone(),
                                title,
                                installed_version: installed_ver,
                                latest_version: latest_ver,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(updates)
}

/// Returns the playtime of all games.
#[tauri::command]
pub fn epic_get_playtimes(
) -> std::collections::HashMap<String, crate::legendary::playtime::PlaytimeRecord> {
    crate::legendary::playtime::get_playtimes()
}

/// Updates/edits a game's playtime and last activity.
#[tauri::command]
pub fn epic_set_playtime(
    app_name: String,
    total_seconds: u64,
    last_played: Option<String>,
) -> Result<crate::legendary::playtime::PlaytimeRecord, String> {
    crate::legendary::playtime::set_game_playtime(&app_name, total_seconds, last_played)
}

/// Returns the download network profile ("max", "balanced", "low").
#[tauri::command]
pub fn epic_get_network_profile(app: AppHandle) -> String {
    let s = crate::load_settings(&app);
    s.network_profile.unwrap_or_else(|| "balanced".to_string())
}

/// Saves the download network profile ("max", "balanced", "low").
#[tauri::command]
pub fn epic_set_network_profile(app: AppHandle, profile: String) -> Result<(), String> {
    let mut s = crate::load_settings(&app);
    s.network_profile = Some(profile);
    crate::save_settings(&app, &s);
    Ok(())
}

/// Returns the offline mode state.
#[tauri::command]
pub fn epic_get_offline_mode(app: AppHandle) -> bool {
    let s = crate::load_settings(&app);
    s.offline_mode.unwrap_or(false)
}

/// Saves the offline mode state.
#[tauri::command]
pub fn epic_set_offline_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = crate::load_settings(&app);
    s.offline_mode = Some(enabled);
    crate::save_settings(&app, &s);
    Ok(())
}

/// Returns the auto-create-desktop-shortcut setting state.
#[tauri::command]
pub fn epic_get_auto_desktop_shortcut(app: AppHandle) -> bool {
    let s = crate::load_settings(&app);
    s.auto_desktop_shortcut
}

/// Saves the auto-create-desktop-shortcut setting state.
#[tauri::command]
pub fn epic_set_auto_desktop_shortcut(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = crate::load_settings(&app);
    s.auto_desktop_shortcut = enabled;
    crate::save_settings(&app, &s);
    Ok(())
}

/// Backs up a game's saves.
#[tauri::command]
pub async fn epic_backup_save(
    app_name: String,
    save_path_override: Option<String>,
) -> Result<crate::legendary::backup::SaveBackupInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::legendary::backup::create_backup(&app_name, save_path_override.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Bir oyunun mevcut yedeklerini listeler.
#[tauri::command]
pub fn epic_list_backups(app_name: String) -> Vec<crate::legendary::backup::SaveBackupInfo> {
    crate::legendary::backup::list_backups(&app_name)
}

/// Restores a backup to the game.
#[tauri::command]
pub async fn epic_restore_backup(app_name: String, backup_id: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        crate::legendary::backup::restore_backup(&app_name, &backup_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Deletes a backup.
#[tauri::command]
pub fn epic_delete_backup(app_name: String, backup_id: String) -> Result<(), String> {
    crate::legendary::backup::delete_backup(&app_name, &backup_id)
}

/// Opens the backup folder in Windows Explorer.
#[tauri::command]
pub fn epic_open_backup_folder(app_name: String) -> Result<String, String> {
    let dir = crate::legendary::backup::app_backup_dir(&app_name);
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("@t:manage.folderOpenFailed\u{1f}{e}"))?;
    Ok("@t:manage.backupFolderOpened".to_string())
}

// -------------------------------------------------------------
// COLLECTION (CATEGORY) MANAGEMENT
// -------------------------------------------------------------

/// Lists all collections
#[tauri::command]
pub fn epic_get_collections() -> Result<Vec<crate::legendary::collections::GameCollection>, String>
{
    crate::legendary::collections::read_collections()
}

/// Creates a new collection or updates an existing one
#[tauri::command]
pub fn epic_save_collection(
    id: Option<String>,
    name: String,
    app_names: Vec<String>,
    emoji: Option<String>,
) -> Result<crate::legendary::collections::GameCollection, String> {
    crate::legendary::collections::save_collection(id, name, app_names, emoji)
}

/// Persists the library tab order. All and Favorites are not collections.
#[tauri::command]
pub fn epic_reorder_collections(
    ids: Vec<String>,
) -> Result<Vec<crate::legendary::collections::GameCollection>, String> {
    crate::legendary::collections::reorder_collections(&ids)
}

/// Koleksiyonu siler
#[tauri::command]
pub fn epic_delete_collection(id: String) -> Result<(), String> {
    crate::legendary::collections::delete_collection(&id)
}

/// Updates the collections a specific game belongs to
#[tauri::command]
pub fn epic_set_game_collections(
    app_name: String,
    collection_ids: Vec<String>,
) -> Result<(), String> {
    crate::legendary::collections::set_game_collections(&app_name, &collection_ids)
}

/// Imports collections from the Epic Games Launcher LevelDB log
#[tauri::command]
pub async fn epic_import_egl_collections(
) -> Result<Vec<crate::legendary::collections::GameCollection>, String> {
    // Reads the Epic Games Launcher manifests: off the UI thread.
    tauri::async_runtime::spawn_blocking(crate::legendary::collections::import_egl_collections)
        .await
        .map_err(|e| e.to_string())?
}

// -------------------------------------------------------------
// PLAYER PROFILE (NATIVE PROFILE VIEW)
// -------------------------------------------------------------

/// Fetches the user profile and achievements from the official Epic Games GraphQL API
#[tauri::command]
pub async fn epic_get_player_profile(
    force_refresh: Option<bool>,
) -> Result<crate::legendary::profile::EpicPlayerProfile, String> {
    let config = skip::default_config_dir();
    crate::legendary::profile::fetch_player_profile(&config, force_refresh.unwrap_or(false)).await
}

// -------------------------------------------------------------
// MOVE GAME FILES
// -------------------------------------------------------------

/// Lists all local disk drives (C:, D:, ...) and their free space
#[tauri::command]
pub async fn epic_get_system_drives() -> Vec<crate::legendary::move_game::SystemDriveInfo> {
    // Queries disk space for every drive letter: off the UI thread.
    tauri::async_runtime::spawn_blocking(crate::legendary::move_game::get_system_drives)
        .await
        .unwrap_or_default()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPathState {
    /// `"ok"`, `"missing"`, `"driveMissing"`, or `"unknown"`.
    pub state: String,
    /// Windows drive letter without the colon, when the path has one.
    pub drive: String,
}

/// Checks whether an installed game's folder is still reachable. A missing
/// drive is kept apart from a deleted folder so the UI can name the drive.
#[tauri::command]
pub async fn check_install_path_state(path: String) -> InstallPathState {
    // A disconnected network share can block on stat: keep it off the UI thread.
    tauri::async_runtime::spawn_blocking(move || install_path_state(&path))
        .await
        .unwrap_or(InstallPathState {
            state: "unknown".to_string(),
            drive: String::new(),
        })
}

fn install_path_state(raw: &str) -> InstallPathState {
    let value = raw.trim();
    if value.is_empty() {
        return InstallPathState {
            state: "unknown".to_string(),
            drive: String::new(),
        };
    }
    let path = Path::new(value);
    let drive = path
        .components()
        .next()
        .and_then(|component| match component {
            std::path::Component::Prefix(prefix) => match prefix.kind() {
                std::path::Prefix::Disk(letter)
                | std::path::Prefix::VerbatimDisk(letter) => {
                    Some((letter as char).to_ascii_uppercase().to_string())
                }
                _ => None,
            },
            _ => None,
        })
        .unwrap_or_default();
    if path.exists() {
        return InstallPathState {
            state: "ok".to_string(),
            drive,
        };
    }
    let root = format!("{drive}:\\");
    let drive_missing = !drive.is_empty() && !Path::new(&root).exists();
    InstallPathState {
        state: if drive_missing {
            "driveMissing".to_string()
        } else {
            "missing".to_string()
        },
        drive,
    }
}

/// Scans a folder for Epic installs (`.egstore`) and registers them.
#[tauri::command]
pub async fn epic_import_installed_folder(
    app: AppHandle,
    path: String,
) -> Result<crate::legendary::import_installed::ImportInstalledResult, String> {
    crate::legendary::import_installed::import_installed_folder(&app, std::path::Path::new(&path))
        .await
}

/// Opens the native Windows folder picker ("Browse")
#[tauri::command]
pub async fn epic_select_folder_dialog(
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    crate::legendary::move_game::select_folder_dialog(default_path, title).await
}

/// Moves a game to another folder/drive
#[tauri::command]
pub async fn epic_move_game(
    app: AppHandle,
    app_name: String,
    target_base_path: String,
) -> Result<crate::legendary::move_game::MoveGameResult, String> {
    let config = skip::default_config_dir();
    crate::legendary::move_game::move_game_folder(app, &config, app_name, target_base_path).await
}

/// Cancels an in-progress game move
#[tauri::command]
pub async fn epic_cancel_move_game(app_name: String) -> bool {
    crate::legendary::move_game::cancel_move_game(&app_name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plain_version_stays_as_it_is() {
        assert_eq!(display_version("10.2.1.2"), "10.2.1.2");
        assert_eq!(display_version(" 1.0.1158.13 "), "1.0.1158.13");
        assert_eq!(display_version(""), "");
    }

    #[test]
    fn an_artifact_name_shows_only_its_version() {
        assert_eq!(
            display_version("DBD_Vanilla_HFL_EGS_Shipping_9_3871532_10.2.0.7"),
            "10.2.0.7"
        );
        assert_eq!(display_version("Some_Game_1.0"), "1.0");
        assert_eq!(display_version("Some_Game_2026"), "2026");
        // Nothing number-like to pull out: the value is shown unchanged.
        assert_eq!(display_version("BuildNightly"), "BuildNightly");
    }

    #[test]
    fn an_existing_install_path_is_ok_and_a_missing_one_is_not() {
        let existing = install_path_state(".");
        assert_eq!(existing.state, "ok");

        let missing = std::env::temp_dir().join("__efxlve_missing_install_path__");
        let state = install_path_state(&missing.to_string_lossy());
        assert_ne!(state.state, "ok");
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_path_reports_its_drive_letter() {
        let state = install_path_state("C:\\");
        assert_eq!(state.drive, "C");
        assert_eq!(state.state, "ok");
    }
}
