//! Tauri IPC commands for Cloud Save Backup.

use tauri::{command, AppHandle};

use crate::cloud_backup::gdrive;
use crate::cloud_backup::manager;
use crate::cloud_backup::models::{CloudBackupEntry, CloudBackupProvider, CloudBackupSettings};
use crate::cloud_backup::profile_sync::{self, ProfileRestoreResult};

#[command]
pub fn cloud_backup_get_settings() -> Result<CloudBackupSettings, String> {
    Ok(manager::load_settings())
}

#[command]
pub fn cloud_backup_save_settings(settings: CloudBackupSettings) -> Result<(), String> {
    manager::save_settings(&settings)
}

#[command]
pub async fn cloud_backup_test_connection(settings: CloudBackupSettings) -> Result<String, String> {
    manager::test_connection(&settings).await
}

#[command]
pub async fn cloud_backup_start_gdrive_auth(_app: AppHandle) -> Result<String, String> {
    let settings = manager::load_settings();
    let (client_id, client_secret) = manager::gdrive_credentials(&settings)?;

    let (code_verifier, code_challenge) = gdrive::generate_pkce();
    let auth_url = gdrive::generate_auth_url(client_id, &code_challenge);

    // Open user's default browser with auth URL
    let _ = tauri_plugin_opener::open_url(&auth_url, None::<&str>);

    // Listen on local port for callback
    let code = gdrive::listen_for_auth_code().await?;

    // Exchange code for tokens
    let client = reqwest::Client::new();
    let (_access, refresh, email) = gdrive::exchange_code_for_tokens(
        &client,
        client_id,
        client_secret,
        &code,
        Some(&code_verifier),
    )
    .await?;

    let mut settings = manager::load_settings();
    settings.gdrive_refresh_token = Some(refresh);
    settings.gdrive_user_email = email.clone();
    manager::save_settings(&settings)?;

    Ok(email.unwrap_or_else(|| "Connected to Google Drive".to_string()))
}

#[command]
pub fn cloud_backup_disconnect_gdrive() -> Result<(), String> {
    let _ = crate::cloud_backup::secret_store::delete("gdrive_refresh_token");
    let mut settings = manager::load_settings();
    settings.gdrive_refresh_token = None;
    settings.gdrive_user_email = None;
    manager::save_settings(&settings)
}

#[command]
pub async fn cloud_backup_upload_game(
    app_name: String,
    backup_id: Option<String>,
) -> Result<CloudBackupEntry, String> {
    manager::upload_backup(&app_name, backup_id.as_deref()).await
}

#[command]
pub async fn cloud_backup_list_game(app_name: String) -> Result<Vec<CloudBackupEntry>, String> {
    manager::list_cloud_backups(&app_name).await
}

#[command]
pub async fn cloud_backup_download_game(
    app_name: String,
    remote_id: String,
    backup_id: String,
) -> Result<String, String> {
    manager::download_and_restore(&app_name, &remote_id, &backup_id).await
}

#[command]
pub async fn cloud_backup_delete_remote(remote_id: String) -> Result<(), String> {
    manager::delete_remote_backup(&remote_id).await
}

#[command]
pub fn profile_export(
    app: AppHandle,
    folder: String,
    local_storage: serde_json::Value,
) -> Result<String, String> {
    profile_sync::export_to_file(&app, &folder, &local_storage)
}

#[command]
pub fn profile_import(app: AppHandle, path: String) -> Result<ProfileRestoreResult, String> {
    profile_sync::import_file(&app, &path)
}

#[command]
pub async fn profile_cloud_upload(
    app: AppHandle,
    local_storage: serde_json::Value,
) -> Result<CloudBackupEntry, String> {
    profile_sync::upload_to_cloud(&app, &local_storage).await
}

#[command]
pub async fn profile_cloud_list() -> Result<Vec<CloudBackupEntry>, String> {
    manager::list_profile_archives().await
}

#[command]
pub async fn cloud_backup_remote_hash(
    remote_id: String,
    backup_id: String,
) -> Result<Option<String>, String> {
    let archive = manager::download_cloud_archive(&remote_id, &backup_id).await?;
    let result = crate::cloud_backup::archive::read_backup_content_hash(&archive);
    let _ = std::fs::remove_file(&archive);
    result
}

#[command]
pub async fn profile_cloud_restore(
    app: AppHandle,
    remote_id: String,
    backup_id: String,
) -> Result<ProfileRestoreResult, String> {
    profile_sync::restore_from_cloud(&app, &remote_id, &backup_id).await
}

#[command]
pub async fn cloud_backup_rclone_remotes() -> Result<Vec<String>, String> {
    crate::cloud_backup::rclone::list_remotes().await
}

/// Opens the Folder provider root in the system file manager, creating it when
/// the first backup has not run yet.
#[command]
pub fn cloud_backup_open_folder() -> Result<(), String> {
    let settings = manager::load_settings();
    if settings.provider != CloudBackupProvider::Folder {
        return Err("The folder provider is not selected.".to_string());
    }
    let base = settings.folder_path.trim();
    if base.is_empty() {
        return Err("Choose a backup folder first.".to_string());
    }
    let root = std::path::Path::new(base).join("efxlve_saves");
    std::fs::create_dir_all(&root).map_err(|error| format!("Folder is not writable: {error}"))?;
    crate::open_in_file_manager(&root)
}
