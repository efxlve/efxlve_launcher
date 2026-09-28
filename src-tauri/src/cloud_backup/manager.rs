//! High-level Cloud Backup Manager for orchestrating local archives and remote cloud providers.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};
use reqwest::Client;
use tauri::{AppHandle, Emitter};

use crate::cloud_backup::archive::{pack_backup_dir, unpack_backup_tar_gz};
use crate::cloud_backup::gdrive;
use crate::cloud_backup::models::{CloudBackupEntry, CloudBackupProvider, CloudBackupSettings, CloudSyncStatus};
use crate::cloud_backup::webdav;
use crate::legendary::backup::{app_backup_dir, create_backup, list_backups, restore_backup};
use crate::legendary::skip::default_config_dir;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

fn get_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .timeout(std::time::Duration::from_secs(60))
            .build()
            .unwrap_or_default()
    })
}

fn settings_file_path() -> PathBuf {
    default_config_dir().join("cloud_backup_settings.json")
}

/// Loads cloud backup settings from disk.
pub fn load_settings() -> CloudBackupSettings {
    let path = settings_file_path();
    if let Ok(data) = std::fs::read_to_string(&path) {
        if let Ok(settings) = serde_json::from_str::<CloudBackupSettings>(&data) {
            return settings;
        }
    }
    CloudBackupSettings::default()
}

/// Persists cloud backup settings to disk.
pub fn save_settings(settings: &CloudBackupSettings) -> Result<(), String> {
    let path = settings_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

/// Tests connection for the currently selected provider.
pub async fn test_connection(settings: &CloudBackupSettings) -> Result<String, String> {
    let client = get_client();
    match settings.provider {
        CloudBackupProvider::None => Err("No cloud provider selected.".to_string()),
        CloudBackupProvider::Webdav => {
            if settings.webdav_url.trim().is_empty() {
                return Err("WebDAV URL cannot be empty.".to_string());
            }
            webdav::test_webdav_connection(client, &settings.webdav_url, &settings.webdav_username, &settings.webdav_password).await
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            if refresh.is_empty() {
                return Err("Google Drive is not connected. Please log in first.".to_string());
            }
            let access = gdrive::refresh_access_token(client, gdrive::GDRIVE_DEFAULT_CLIENT_ID, refresh).await?;
            let email = gdrive::fetch_user_email(client, &access).await.unwrap_or_else(|_| "connected".to_string());
            Ok(format!("Google Drive connection verified ({email})."))
        }
    }
}

/// Packs and uploads a save backup to the active cloud provider.
pub async fn upload_backup(
    app_name: &str,
    backup_id_opt: Option<&str>,
) -> Result<CloudBackupEntry, String> {
    let mut settings = load_settings();
    if !settings.enabled || settings.provider == CloudBackupProvider::None {
        return Err("Cloud backup is not enabled.".to_string());
    }

    let client = get_client();

    // 1. Determine local backup to pack
    let (target_backup_dir, backup_id, local_info) = match backup_id_opt {
        Some(bid) => {
            let dir = app_backup_dir(app_name).join(bid);
            if !dir.is_dir() {
                return Err(format!("Local backup {bid} not found"));
            }
            let info = list_backups(app_name)
                .into_iter()
                .find(|b| b.id == bid)
                .ok_or_else(|| "Backup metadata not found".to_string())?;
            (dir, bid.to_string(), info)
        }
        None => {
            // Pick most recent local backup or create one if none exists
            let existing = list_backups(app_name);
            let info = if let Some(latest) = existing.into_iter().max_by_key(|b| b.timestamp) {
                latest
            } else {
                create_backup(app_name, None)?
            };
            let dir = app_backup_dir(app_name).join(&info.id);
            let bid = info.id.clone();
            (dir, bid, info)
        }
    };

    // 2. Pack to temporary .tar.gz
    let temp_archive = std::env::temp_dir().join(format!("efxlve_upload_{app_name}_{backup_id}.tar.gz"));
    let (size_bytes, sha256) = pack_backup_dir(&target_backup_dir, &temp_archive)?;

    // 3. Upload according to active provider
    let entry = match settings.provider {
        CloudBackupProvider::Webdav => {
            let base_url = settings.webdav_url.trim_end_matches('/');
            let root_dir = format!("{base_url}/efxlve_saves/");
            let app_dir = format!("{base_url}/efxlve_saves/{app_name}/");
            let target_file_url = format!("{app_dir}{backup_id}.tar.gz");

            let _ = webdav::ensure_remote_collection(client, &root_dir, &settings.webdav_username, &settings.webdav_password).await;
            let _ = webdav::ensure_remote_collection(client, &app_dir, &settings.webdav_username, &settings.webdav_password).await;

            webdav::upload_file_webdav(
                client,
                &target_file_url,
                &settings.webdav_username,
                &settings.webdav_password,
                &temp_archive,
            )
            .await?;

            CloudBackupEntry {
                backup_id: backup_id.clone(),
                app_name: app_name.to_string(),
                timestamp: local_info.timestamp,
                formatted_date: local_info.formatted_date.clone(),
                size_bytes,
                file_count: local_info.file_count,
                sha256,
                provider: "webdav".to_string(),
                remote_id: target_file_url,
            }
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            if refresh.is_empty() {
                let _ = std::fs::remove_file(&temp_archive);
                return Err("Google Drive is not logged in.".to_string());
            }

            let access = gdrive::refresh_access_token(client, gdrive::GDRIVE_DEFAULT_CLIENT_ID, refresh).await?;
            let file_id = gdrive::upload_backup_gdrive(client, &access, app_name, &backup_id, &temp_archive).await?;

            CloudBackupEntry {
                backup_id: backup_id.clone(),
                app_name: app_name.to_string(),
                timestamp: local_info.timestamp,
                formatted_date: local_info.formatted_date.clone(),
                size_bytes,
                file_count: local_info.file_count,
                sha256,
                provider: "google_drive".to_string(),
                remote_id: file_id,
            }
        }
        CloudBackupProvider::None => unreachable!(),
    };

    // Cleanup temp file
    let _ = std::fs::remove_file(&temp_archive);

    // Update last sync time
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    settings.last_sync_time = Some(now);
    let _ = save_settings(&settings);

    Ok(entry)
}

/// Lists all save backup archives from the active cloud provider for a game.
pub async fn list_cloud_backups(app_name: &str) -> Result<Vec<CloudBackupEntry>, String> {
    let settings = load_settings();
    if !settings.enabled || settings.provider == CloudBackupProvider::None {
        return Ok(Vec::new());
    }

    let client = get_client();
    match settings.provider {
        CloudBackupProvider::Webdav => {
            webdav::list_webdav_backups(
                client,
                &settings.webdav_url,
                &settings.webdav_username,
                &settings.webdav_password,
                app_name,
            )
            .await
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            if refresh.is_empty() {
                return Ok(Vec::new());
            }
            let access = gdrive::refresh_access_token(client, gdrive::GDRIVE_DEFAULT_CLIENT_ID, refresh).await?;
            gdrive::list_gdrive_backups(client, &access, app_name).await
        }
        CloudBackupProvider::None => Ok(Vec::new()),
    }
}

/// Downloads a remote backup, stores it into local backup store, and restores it to the game.
pub async fn download_and_restore(
    app_name: &str,
    remote_id: &str,
    backup_id: &str,
) -> Result<String, String> {
    let settings = load_settings();
    let client = get_client();

    let temp_archive = std::env::temp_dir().join(format!("efxlve_download_{app_name}_{backup_id}.tar.gz"));

    // 1. Download
    match settings.provider {
        CloudBackupProvider::Webdav => {
            webdav::download_file_webdav(
                client,
                remote_id,
                &settings.webdav_username,
                &settings.webdav_password,
                &temp_archive,
            )
            .await?;
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            let access = gdrive::refresh_access_token(client, gdrive::GDRIVE_DEFAULT_CLIENT_ID, refresh).await?;
            gdrive::download_backup_gdrive(client, &access, remote_id, &temp_archive).await?;
        }
        CloudBackupProvider::None => return Err("No active cloud provider.".to_string()),
    }

    // 2. Unpack into local backup storage
    let local_dest = app_backup_dir(app_name).join(backup_id);
    let unpack_res = unpack_backup_tar_gz(&temp_archive, &local_dest);
    let _ = std::fs::remove_file(&temp_archive);
    unpack_res?;

    // 3. Restore to game's save folder
    restore_backup(app_name, backup_id)
}

/// Deletes a remote backup from the cloud provider.
pub async fn delete_remote_backup(remote_id: &str) -> Result<(), String> {
    let settings = load_settings();
    let client = get_client();

    match settings.provider {
        CloudBackupProvider::Webdav => {
            webdav::delete_file_webdav(client, remote_id, &settings.webdav_username, &settings.webdav_password).await
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            let access = gdrive::refresh_access_token(client, gdrive::GDRIVE_DEFAULT_CLIENT_ID, refresh).await?;
            gdrive::delete_backup_gdrive(client, &access, remote_id).await
        }
        CloudBackupProvider::None => Ok(()),
    }
}

/// Compares local and cloud backup timestamps to determine synchronization status.
pub async fn get_sync_status(app_name: &str) -> Result<CloudSyncStatus, String> {
    let local_backups = list_backups(app_name);
    let latest_local = local_backups.into_iter().max_by_key(|b| b.timestamp);

    let cloud_backups = list_cloud_backups(app_name).await.unwrap_or_default();
    let latest_cloud = cloud_backups.into_iter().max_by_key(|b| b.timestamp);

    let local_ts = latest_local.as_ref().map(|b| b.timestamp);
    let cloud_ts = latest_cloud.as_ref().map(|b| b.timestamp);

    let (is_in_sync, newer_side) = match (local_ts, cloud_ts) {
        (Some(l), Some(c)) => {
            if l == c {
                (true, "equal".to_string())
            } else if l > c {
                (false, "local".to_string())
            } else {
                (false, "cloud".to_string())
            }
        }
        (Some(_), None) => (false, "local".to_string()),
        (None, Some(_)) => (false, "cloud".to_string()),
        (None, None) => (true, "none".to_string()),
    };

    Ok(CloudSyncStatus {
        app_name: app_name.to_string(),
        local_backup_id: latest_local.map(|b| b.id),
        local_timestamp: local_ts,
        cloud_backup_id: latest_cloud.map(|b| b.backup_id),
        cloud_timestamp: cloud_ts,
        is_in_sync,
        newer_side,
    })
}

/// Hook called automatically when a game process exits.
/// If cloud backup is enabled with auto_sync_on_game_exit = true,
/// this creates a local backup and uploads it silently in the background.
pub fn trigger_auto_sync_on_exit(app: AppHandle, app_name: String) {
    let settings = load_settings();
    if !settings.enabled || !settings.auto_sync_on_game_exit || settings.provider == CloudBackupProvider::None {
        return;
    }

    tauri::async_runtime::spawn(async move {
        // Create the local backup first, then upload it. Failures must reach the
        // UI: `cloud-sync-complete` is the channel the frontend already listens to.
        let local_res = tauri::async_runtime::spawn_blocking({
            let name = app_name.clone();
            move || create_backup(&name, None)
        })
        .await;

        match local_res {
            Ok(Ok(info)) => match upload_backup(&app_name, Some(&info.id)).await {
                Ok(_) => {
                    let _ = app.emit(
                        "cloud-sync-complete",
                        serde_json::json!({
                            "id": app_name,
                            "success": true,
                            "message": ""
                        }),
                    );
                }
                Err(err) => {
                    let _ = app.emit(
                        "cloud-sync-complete",
                        serde_json::json!({
                            "id": app_name,
                            "success": false,
                            "message": err
                        }),
                    );
                }
            },
            Ok(Err(err)) => {
                let _ = app.emit(
                    "cloud-sync-complete",
                    serde_json::json!({
                        "id": app_name,
                        "success": false,
                        "message": err
                    }),
                );
            }
            Err(_) => {}
        }
    });
}
