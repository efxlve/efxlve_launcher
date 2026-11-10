//! High-level Cloud Backup Manager for orchestrating local archives and remote cloud providers.

use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::cloud_backup::archive::{pack_backup_dir, read_archive_summary, unpack_backup_tar_gz};
use crate::cloud_backup::folder;
use crate::cloud_backup::gdrive;
use crate::cloud_backup::models::{CloudBackupEntry, CloudBackupProvider, CloudBackupSettings};
use crate::cloud_backup::rclone;
use crate::cloud_backup::secret_store;
use crate::cloud_backup::webdav;
use crate::legendary::backup::{
    app_backup_dir, backup_key, create_backup, create_backup_if_changed, list_backups,
    resolve_save_path, restore_backup,
    tree_content_hash,
};
use crate::legendary::skip::default_config_dir;

static HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

/// A WebDAV client; the self-signed opt-in is per provider, not global.
fn webdav_client(settings: &CloudBackupSettings) -> Result<Client, String> {
    Client::builder()
        .danger_accept_invalid_certs(settings.webdav_allow_invalid_cert)
        .connect_timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("Could not create the WebDAV client: {error}"))
}

fn get_client() -> &'static Client {
    HTTP_CLIENT.get_or_init(|| {
        Client::builder()
            .connect_timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_default()
    })
}

fn settings_file_path() -> PathBuf {
    default_config_dir().join("cloud_backup_settings.json")
}

fn write_settings_file(settings: &CloudBackupSettings) -> Result<(), String> {
    let path = settings_file_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())?;
    Ok(())
}

fn hydrate_string(value: &mut String, key: &str, dirty: &mut bool) {
    if value.is_empty() {
        if let Some(secret) = secret_store::get(key) {
            *value = secret;
        }
    } else if secret_store::set(key, value).is_ok() {
        value.clear();
        *dirty = true;
    }
}

fn hydrate_option(value: &mut Option<String>, key: &str, dirty: &mut bool) {
    match value.take() {
        Some(secret) if !secret.is_empty() => {
            if secret_store::set(key, &secret).is_ok() {
                *dirty = true;
            } else {
                *value = Some(secret);
            }
        }
        Some(_) => {
            *dirty = true;
        }
        None => {
            if let Some(secret) = secret_store::get(key) {
                *value = Some(secret);
            }
        }
    }
}

/// Moves plain-text secrets into the OS store and reads stored secrets back.
fn hydrate_settings(settings: &mut CloudBackupSettings, dirty: &mut bool) {
    hydrate_string(&mut settings.webdav_password, "webdav_password", dirty);
    hydrate_option(
        &mut settings.gdrive_refresh_token,
        "gdrive_refresh_token",
        dirty,
    );
    hydrate_option(
        &mut settings.gdrive_client_secret,
        "gdrive_client_secret",
        dirty,
    );
}

/// Loads cloud backup settings from disk and fills stored secrets.
pub fn load_settings() -> CloudBackupSettings {
    let mut settings = std::fs::read_to_string(settings_file_path())
        .ok()
        .and_then(|data| serde_json::from_str::<CloudBackupSettings>(&data).ok())
        .unwrap_or_default();
    let mut dirty = false;
    // Tests read the developer's real settings file; never migrate it there.
    if !cfg!(test) {
        hydrate_settings(&mut settings, &mut dirty);
        if dirty {
            // Rewrite the JSON without the migrated plain-text secrets.
            let _ = write_settings_file(&settings);
        }
    }
    settings
}

fn stash_string(value: &mut String, key: &str) {
    if !value.is_empty() && secret_store::set(key, value).is_ok() {
        value.clear();
    }
}

fn stash_option(value: &mut Option<String>, key: &str) {
    if let Some(secret) = value.clone() {
        if secret.is_empty() {
            *value = None;
        } else if secret_store::set(key, &secret).is_ok() {
            *value = None;
        }
    }
}

/// Persists cloud backup settings; secrets go to the OS store when available.
pub fn save_settings(settings: &CloudBackupSettings) -> Result<(), String> {
    let mut stored = settings.clone();
    stash_string(&mut stored.webdav_password, "webdav_password");
    stash_option(&mut stored.gdrive_refresh_token, "gdrive_refresh_token");
    stash_option(&mut stored.gdrive_client_secret, "gdrive_client_secret");
    write_settings_file(&stored)
}

/// Resolves Google Drive OAuth client credentials from user settings or fallback default.
pub fn gdrive_credentials(settings: &CloudBackupSettings) -> Result<(&str, Option<&str>), String> {
    let client_id = settings
        .gdrive_client_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(gdrive::GDRIVE_DEFAULT_CLIENT_ID);

    if client_id.is_empty() {
        return Err(
            "Google Drive Client ID is missing. Please configure it in Settings.".to_string(),
        );
    }

    let client_secret = settings
        .gdrive_client_secret
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            let def = gdrive::GDRIVE_DEFAULT_CLIENT_SECRET.trim();
            if !def.is_empty() {
                Some(def)
            } else {
                None
            }
        });

    Ok((client_id, client_secret))
}

/// Tests connection for the currently selected provider.
pub async fn test_connection(settings: &CloudBackupSettings) -> Result<String, String> {
    let client = get_client();
    match settings.provider {
        CloudBackupProvider::None => Err("No cloud provider selected.".to_string()),
        CloudBackupProvider::Folder => folder::test_folder(&settings.folder_path),
        CloudBackupProvider::Webdav => {
            let webdav = webdav_client(&settings)?;
            let client = &webdav;
            if settings.webdav_url.trim().is_empty() {
                return Err("WebDAV URL cannot be empty.".to_string());
            }
            webdav::test_webdav_connection(
                client,
                &settings.webdav_url,
                &settings.webdav_username,
                &settings.webdav_password,
            )
            .await
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            let (client_id, client_secret) = gdrive_credentials(settings)?;
            if refresh.is_empty() {
                return gdrive::check_oauth_client(client, client_id, client_secret.unwrap_or_default()).await;
            }
            let access =
                gdrive::refresh_access_token(client, client_id, client_secret, refresh).await?;
            let email = gdrive::fetch_user_email(client, &access)
                .await
                .unwrap_or_else(|_| "connected".to_string());
            Ok(format!("Google Drive connection verified ({email})."))
        }
        CloudBackupProvider::Rclone => rclone::test_rclone(&settings.rclone_remote).await,
    }
}

/// The last archive this game uploaded, and the save-tree hash it carried.
/// Kept beside the local backups (which `list_backups` ignores because it only
/// reads directories). A matching hash lets the next automatic upload skip the
/// archive and the network entirely.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct UploadMarker {
    backup_id: String,
    content_hash: String,
}

fn upload_marker_path(app_name: &str) -> PathBuf {
    app_backup_dir(app_name).join(".last-upload.json")
}

fn read_upload_marker(app_name: &str) -> Option<UploadMarker> {
    std::fs::read_to_string(upload_marker_path(app_name))
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

fn write_upload_marker(app_name: &str, backup_id: &str, content_hash: &str) {
    let path = upload_marker_path(app_name);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let marker = UploadMarker {
        backup_id: backup_id.to_string(),
        content_hash: content_hash.to_string(),
    };
    if let Ok(data) = serde_json::to_string(&marker) {
        let _ = std::fs::write(path, data);
    }
}

/// Returns the existing cloud entry when the saves have not changed since the
/// last successful upload. A failed listing falls through to a real upload, so
/// deduplication never hides a cloud copy that disappeared.
async fn unchanged_cloud_entry(app_name: &str) -> Option<CloudBackupEntry> {
    let marker = read_upload_marker(app_name)?;
    let save_path = resolve_save_path(app_name, None).ok()?;
    let source = Path::new(&save_path);
    if !source.is_dir() {
        return None;
    }
    let current = tree_content_hash(source)?;
    if current != marker.content_hash {
        return None;
    }
    let remote = list_cloud_backups(app_name).await.ok()?;
    remote
        .into_iter()
        .find(|entry| entry.backup_id == marker.backup_id)
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

    // An automatic upload (no explicit local id) first asks whether the save
    // tree is byte-identical to the last uploaded one. If it is, and the cloud
    // still lists that archive, there is nothing to package or transfer.
    if backup_id_opt.is_none() {
        if let Some(existing) = unchanged_cloud_entry(app_name).await {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            settings.last_sync_time = Some(now);
            let _ = save_settings(&settings);
            return Ok(existing);
        }
    }

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
            // First attempt to create a fresh backup of current saves.
            // If creation fails (e.g. game not installed locally), fall back to most recent existing backup.
            let info = match create_backup(app_name, None) {
                Ok(fresh) => fresh,
                Err(err) => {
                    let existing = list_backups(app_name);
                    if let Some(latest) = existing.into_iter().max_by_key(|b| b.timestamp) {
                        latest
                    } else {
                        return Err(err);
                    }
                }
            };
            let dir = app_backup_dir(app_name).join(&info.id);
            let bid = info.id.clone();
            (dir, bid, info)
        }
    };

    // 2. Pack to temporary .tar.gz
    let temp_archive =
        std::env::temp_dir().join(format!("efxlve_upload_{app_name}_{backup_id}.tar.gz"));
    let (size_bytes, sha256) = pack_backup_dir(&target_backup_dir, &temp_archive)?;

    // 3. Upload according to active provider
    let entry = match settings.provider {
        CloudBackupProvider::Webdav => {
            let webdav = webdav_client(&settings)?;
            let client = &webdav;
            let base_url = settings.webdav_url.trim_end_matches('/');
            let root_dir = format!("{base_url}/efxlve_saves/");
            let app_dir = format!("{base_url}/efxlve_saves/{}/", backup_key(app_name));
            let target_file_url = format!("{app_dir}{backup_id}.tar.gz");

            let _ = webdav::ensure_remote_collection(
                client,
                &root_dir,
                &settings.webdav_username,
                &settings.webdav_password,
            )
            .await;
            let _ = webdav::ensure_remote_collection(
                client,
                &app_dir,
                &settings.webdav_username,
                &settings.webdav_password,
            )
            .await;

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
        CloudBackupProvider::Folder => {
            let remote_id = folder::upload_backup_folder(
                &settings.folder_path,
                app_name,
                &backup_id,
                &temp_archive,
            )?;
            CloudBackupEntry {
                backup_id: backup_id.clone(),
                app_name: app_name.to_string(),
                timestamp: local_info.timestamp,
                formatted_date: local_info.formatted_date.clone(),
                size_bytes,
                file_count: local_info.file_count,
                sha256,
                provider: "folder".to_string(),
                remote_id,
            }
        }
        CloudBackupProvider::Rclone => {
            let remote_id = rclone::upload_backup_rclone(
                &settings.rclone_remote,
                app_name,
                &backup_id,
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
                provider: "rclone".to_string(),
                remote_id,
            }
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            if refresh.is_empty() {
                let _ = std::fs::remove_file(&temp_archive);
                return Err("Google Drive is not logged in.".to_string());
            }

            let (client_id, client_secret) = match gdrive_credentials(&settings) {
                Ok(creds) => creds,
                Err(err) => {
                    let _ = std::fs::remove_file(&temp_archive);
                    return Err(err);
                }
            };
            let access =
                match gdrive::refresh_access_token(client, client_id, client_secret, refresh).await
                {
                    Ok(acc) => acc,
                    Err(err) => {
                        let _ = std::fs::remove_file(&temp_archive);
                        return Err(err);
                    }
                };
            let file_id = match gdrive::upload_backup_gdrive(
                client,
                &access,
                app_name,
                &backup_id,
                &temp_archive,
            )
            .await
            {
                Ok(fid) => fid,
                Err(err) => {
                    let _ = std::fs::remove_file(&temp_archive);
                    return Err(err);
                }
            };

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

    // Remember what was uploaded so an unchanged save tree skips the next one.
    if let Some(hash) = local_info.content_hash.as_deref() {
        write_upload_marker(app_name, &entry.backup_id, hash);
    }

    // Cleanup temp file
    let _ = std::fs::remove_file(&temp_archive);

    // Update last sync time
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    settings.last_sync_time = Some(now);
    let _ = save_settings(&settings);

    // Retention is best effort: a failed prune must not turn a successful
    // upload into an error, and the newest archive is always kept. A per-game
    // limit wins over the shared Cloud setting.
    let per_game = crate::legendary::commands::load_all_game_custom_configs()
        .get(app_name)
        .and_then(|cfg| cfg.backup_retention);
    let keep = per_game.unwrap_or(settings.retention_count);
    if keep > 0 {
        prune_remote_backups(app_name, keep).await;
    }

    Ok(entry)
}

/// Deletes the oldest cloud archives for one game, keeping the newest entries.
async fn prune_remote_backups(app_name: &str, keep: u32) {
    if keep == 0 {
        return;
    }
    let Ok(list) = list_cloud_backups(app_name).await else {
        return;
    };
    for entry in list.into_iter().skip(keep as usize) {
        let _ = delete_remote_backup(&entry.remote_id).await;
    }
}

/// Lists all save backup archives from the active cloud provider for a game.
pub async fn list_cloud_backups(app_name: &str) -> Result<Vec<CloudBackupEntry>, String> {
    let settings = load_settings();
    if !settings.enabled || settings.provider == CloudBackupProvider::None {
        return Ok(Vec::new());
    }

    let client = get_client();
    match settings.provider {
        CloudBackupProvider::Folder => folder::list_backups_folder(&settings.folder_path, app_name),
        CloudBackupProvider::Rclone => {
            rclone::list_backups_rclone(&settings.rclone_remote, app_name).await
        }
        CloudBackupProvider::Webdav => {
            let webdav = webdav_client(&settings)?;
            let client = &webdav;
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
            let (client_id, client_secret) = gdrive_credentials(&settings)?;
            let access =
                gdrive::refresh_access_token(client, client_id, client_secret, refresh).await?;
            gdrive::list_gdrive_backups(client, &access, app_name).await
        }
        CloudBackupProvider::None => Ok(Vec::new()),
    }
}

/// Downloads a remote backup, stores it into local backup store, and restores it to the game.
/// One file in the restore preview. Paths are relative to the game save tree.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreviewFile {
    pub path: String,
    pub size: u64,
}

/// What the user sees before a cloud save replaces the local one.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestorePreview {
    pub token: String,
    pub app_name: String,
    pub backup_id: String,
    pub timestamp: u64,
    pub formatted_date: String,
    pub total_bytes: u64,
    pub file_count: usize,
    pub files: Vec<RestorePreviewFile>,
    pub truncated: bool,
    /// Resolved local save folder, empty when the launcher has no path yet.
    pub save_path: String,
    /// Save-tree hash when the preview opened. Empty when there were no saves.
    pub current_hash: String,
    pub expires_at: u64,
}

struct PendingRestore {
    preview: RestorePreview,
    archive: PathBuf,
    local_hash: Option<String>,
}

/// A preview is valid for five minutes and one apply. Tokens live only in this
/// process; the archive is a temporary file, never the cloud original.
const PREVIEW_TTL_SECS: u64 = 300;
const PREVIEW_FILE_LIMIT: usize = 200;

static PENDING_RESTORES: OnceLock<Mutex<HashMap<String, PendingRestore>>> = OnceLock::new();

fn pending_restores() -> &'static Mutex<HashMap<String, PendingRestore>> {
    PENDING_RESTORES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn new_preview_token() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn remove_pending_archive(pending: &PendingRestore) {
    let _ = std::fs::remove_file(&pending.archive);
}

/// Drops expired previews and their temporary archives. Called before every
/// new preview so a user who closes the dialog does not leave files behind.
fn prune_expired_previews() {
    let now = now_secs();
    let Ok(mut map) = pending_restores().lock() else {
        return;
    };
    let expired: Vec<String> = map
        .iter()
        .filter(|(_, pending)| pending.preview.expires_at <= now)
        .map(|(token, _)| token.clone())
        .collect();
    for token in expired {
        if let Some(pending) = map.remove(&token) {
            remove_pending_archive(&pending);
        }
    }
    drop(map);

    // A previous launcher process can leave its downloaded archive behind.
    // Only files this module names are touched, and only after an hour.
    let Ok(entries) = std::fs::read_dir(std::env::temp_dir()) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !name.starts_with("efxlve_restore_") || !name.ends_with(".tar.gz") {
            continue;
        }
        let old = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| modified.elapsed().ok())
            .is_some_and(|age| age.as_secs() > 3600);
        if old {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}

/// Downloads one remote archive to a unique temp file. The filename never
/// contains the provider's remote id or the game key.
async fn download_to_temp(settings: &CloudBackupSettings, remote_id: &str) -> Result<PathBuf, String> {
    let client = get_client();
    let temp_archive = std::env::temp_dir().join(format!(
        "efxlve_restore_{}_{}.tar.gz",
        std::process::id(),
        new_preview_token()
    ));

    let download = match settings.provider {
        CloudBackupProvider::Folder => {
            folder::download_backup_folder(&settings.folder_path, remote_id, &temp_archive)
        }
        CloudBackupProvider::Rclone => {
            rclone::download_backup_rclone(&settings.rclone_remote, remote_id, &temp_archive).await
        }
        CloudBackupProvider::Webdav => {
            let webdav = webdav_client(settings)?;
            webdav::download_file_webdav(
                &webdav,
                remote_id,
                &settings.webdav_username,
                &settings.webdav_password,
                &temp_archive,
            )
            .await
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            let (client_id, client_secret) = gdrive_credentials(settings)?;
            let access =
                gdrive::refresh_access_token(client, client_id, client_secret, refresh).await?;
            gdrive::download_backup_gdrive(client, &access, remote_id, &temp_archive).await
        }
        CloudBackupProvider::None => return Err("No active cloud provider.".to_string()),
    };
    if let Err(error) = download {
        let _ = std::fs::remove_file(&temp_archive);
        return Err(error);
    }
    Ok(temp_archive)
}

/// Downloads the archive and describes it without touching the save folder.
pub async fn preview_restore(
    app_name: &str,
    remote_id: &str,
    backup_id: &str,
) -> Result<RestorePreview, String> {
    prune_expired_previews();
    let settings = load_settings();
    if !settings.enabled || settings.provider == CloudBackupProvider::None {
        return Err("Cloud backup is not enabled.".to_string());
    }
    let archive = download_to_temp(&settings, remote_id).await?;
    let summary = match read_archive_summary(&archive, PREVIEW_FILE_LIMIT) {
        Ok(summary) => summary,
        Err(error) => {
            let _ = std::fs::remove_file(&archive);
            return Err(error);
        }
    };
    let Some(info) = summary.info else {
        let _ = std::fs::remove_file(&archive);
        return Err("@t:backup.infoNotFound".to_string());
    };

    let resolved = resolve_save_path(app_name, None).ok();
    let local_hash = resolved
        .as_deref()
        .and_then(|path| tree_content_hash(Path::new(path)));
    let token = new_preview_token();
    let expires_at = now_secs().saturating_add(PREVIEW_TTL_SECS);
    let files: Vec<RestorePreviewFile> = summary
        .files
        .into_iter()
        .map(|(path, size)| RestorePreviewFile { path, size })
        .collect();
    let total_bytes = if info.size_bytes > 0 {
        info.size_bytes
    } else {
        files.iter().map(|file| file.size).sum()
    };
    let preview = RestorePreview {
        token: token.clone(),
        app_name: app_name.to_string(),
        backup_id: backup_id.to_string(),
        timestamp: info.timestamp,
        formatted_date: info.formatted_date.clone(),
        total_bytes,
        file_count: if info.file_count > 0 {
            info.file_count
        } else {
            files.len()
        },
        files,
        truncated: summary.truncated,
        save_path: resolved.clone().unwrap_or(info.save_path.clone()),
        current_hash: local_hash.clone().unwrap_or_default(),
        expires_at,
    };

    let mut map = pending_restores()
        .lock()
        .map_err(|_| "The restore queue is unavailable.".to_string())?;
    map.insert(
        token,
        PendingRestore {
            preview: preview.clone(),
            archive,
            local_hash,
        },
    );
    Ok(preview)
}

/// Applies a preview after re-checking its age and the local save tree.
pub async fn apply_restore(token: &str) -> Result<String, String> {
    let pending = {
        let Ok(mut map) = pending_restores().lock() else {
            return Err("The restore queue is unavailable.".to_string());
        };
        map.remove(token)
    };
    let Some(pending) = pending else {
        return Err("@t:cloud.previewExpired".to_string());
    };
    // One token, one attempt: a double click cannot restore twice.
    if pending.preview.expires_at <= now_secs() {
        remove_pending_archive(&pending);
        return Err("@t:cloud.previewExpired".to_string());
    }

    // The saves may have changed while the preview was open. Restoring stale
    // data over a fresh session is exactly what the confirmation is for.
    let current_hash = resolve_save_path(&pending.preview.app_name, None)
        .ok()
        .and_then(|path| tree_content_hash(Path::new(&path)));
    if current_hash != pending.local_hash {
        remove_pending_archive(&pending);
        return Err("@t:cloud.previewStale".to_string());
    }

    let local_dest = app_backup_dir(&pending.preview.app_name).join(&pending.preview.backup_id);
    let unpack = unpack_backup_tar_gz(&pending.archive, &local_dest);
    remove_pending_archive(&pending);
    unpack?;
    restore_backup(&pending.preview.app_name, &pending.preview.backup_id)
}

/// Drops one preview and its temporary archive when the user cancels.
pub fn cancel_restore(token: &str) {
    let Ok(mut map) = pending_restores().lock() else {
        return;
    };
    if let Some(pending) = map.remove(token) {
        remove_pending_archive(&pending);
    }
}

/// Compatibility path for bulk restore and older callers: preview, then apply
/// immediately. A failed apply also releases the temporary archive.
pub async fn download_and_restore(
    app_name: &str,
    remote_id: &str,
    backup_id: &str,
) -> Result<String, String> {
    let preview = preview_restore(app_name, remote_id, backup_id).await?;
    let token = preview.token.clone();
    match apply_restore(&token).await {
        Ok(message) => Ok(message),
        Err(error) => {
            cancel_restore(&token);
            Err(error)
        }
    }
}

/// Deletes a remote backup from the cloud provider.
pub async fn delete_remote_backup(remote_id: &str) -> Result<(), String> {
    let settings = load_settings();
    let client = get_client();

    match settings.provider {
        CloudBackupProvider::Folder => {
            folder::delete_backup_folder(&settings.folder_path, remote_id)
        }
        CloudBackupProvider::Rclone => {
            rclone::delete_backup_rclone(&settings.rclone_remote, remote_id).await
        }
        CloudBackupProvider::Webdav => {
            let webdav = webdav_client(&settings)?;
            let client = &webdav;
            webdav::delete_file_webdav(
                client,
                remote_id,
                &settings.webdav_username,
                &settings.webdav_password,
            )
            .await
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            let (client_id, client_secret) = gdrive_credentials(&settings)?;
            let access =
                gdrive::refresh_access_token(client, client_id, client_secret, refresh).await?;
            gdrive::delete_backup_gdrive(client, &access, remote_id).await
        }
        CloudBackupProvider::None => Ok(()),
    }
}

/// Serializes automatic uploads: two games can exit together and only one
/// sync should talk to the provider at a time.
static AUTO_SYNC_QUEUE: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();

fn auto_sync_queue() -> &'static tokio::sync::Mutex<()> {
    AUTO_SYNC_QUEUE.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// Reserved cloud key for launcher profile archives.
pub const PROFILE_KEY: &str = "__efxlve_profile__";

fn provider_label(provider: &CloudBackupProvider) -> &'static str {
    match provider {
        CloudBackupProvider::Folder => "folder",
        CloudBackupProvider::Webdav => "webdav",
        CloudBackupProvider::GoogleDrive => "google_drive",
        CloudBackupProvider::Rclone => "rclone",
        CloudBackupProvider::None => "none",
    }
}

/// Uploads a launcher profile archive through the configured save provider.
pub async fn upload_profile_archive(
    archive: &Path,
    backup_id: &str,
) -> Result<CloudBackupEntry, String> {
    let settings = load_settings();
    if !settings.enabled || settings.provider == CloudBackupProvider::None {
        return Err("Cloud backup is not enabled.".to_string());
    }
    let client = get_client();
    let (size_bytes, sha256) = crate::cloud_backup::archive::compute_file_sha256(archive)?;
    let timestamp = backup_id.parse::<u64>().unwrap_or_else(|_| {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0)
    });

    let remote_id = match settings.provider {
        CloudBackupProvider::Folder => folder::upload_backup_folder(
            &settings.folder_path,
            PROFILE_KEY,
            backup_id,
            archive,
        )?,
        CloudBackupProvider::Webdav => {
            let webdav = webdav_client(&settings)?;
            let client = &webdav;
            webdav::migrate_legacy_collection(
                client,
                &settings.webdav_url,
                &settings.webdav_username,
                &settings.webdav_password,
                PROFILE_KEY,
            )
            .await?;
            let base_url = settings.webdav_url.trim_end_matches('/');
            let root_dir = format!("{base_url}/efxlve_saves/");
            let app_dir = format!("{base_url}/efxlve_saves/{}/", backup_key(PROFILE_KEY));
            let target_file_url = format!("{app_dir}{backup_id}.tar.gz");
            let _ = webdav::ensure_remote_collection(
                client,
                &root_dir,
                &settings.webdav_username,
                &settings.webdav_password,
            )
            .await;
            let _ = webdav::ensure_remote_collection(
                client,
                &app_dir,
                &settings.webdav_username,
                &settings.webdav_password,
            )
            .await;
            webdav::upload_file_webdav(
                client,
                &target_file_url,
                &settings.webdav_username,
                &settings.webdav_password,
                archive,
            )
            .await?;
            target_file_url
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            if refresh.is_empty() {
                return Err("Google Drive is not connected. Please log in first.".to_string());
            }
            let (client_id, client_secret) = gdrive_credentials(&settings)?;
            let access =
                gdrive::refresh_access_token(client, client_id, client_secret, refresh).await?;
            gdrive::upload_backup_gdrive(client, &access, PROFILE_KEY, backup_id, archive).await?
        }
        CloudBackupProvider::Rclone => {
            rclone::upload_backup_rclone(&settings.rclone_remote, PROFILE_KEY, backup_id, archive)
                .await?
        }
        CloudBackupProvider::None => unreachable!(),
    };

    let entry = CloudBackupEntry {
        backup_id: backup_id.to_string(),
        app_name: PROFILE_KEY.to_string(),
        timestamp,
        formatted_date: crate::legendary::backup::format_backup_timestamp(timestamp),
        size_bytes,
        file_count: 0,
        sha256,
        provider: provider_label(&settings.provider).to_string(),
        remote_id,
    };

    // Profiles are small; five versions are plenty and keep the provider tidy.
    if let Ok(list) = list_cloud_backups(PROFILE_KEY).await {
        for old in list.into_iter().skip(5) {
            let _ = delete_remote_backup(&old.remote_id).await;
        }
    }

    Ok(entry)
}

/// Lists launcher profile archives stored by the active provider.
pub async fn list_profile_archives() -> Result<Vec<CloudBackupEntry>, String> {
    list_cloud_backups(PROFILE_KEY).await
}

/// Downloads a launcher profile archive to a temporary path without restoring it.
pub async fn download_cloud_archive(remote_id: &str, backup_id: &str) -> Result<PathBuf, String> {
    let settings = load_settings();
    if !settings.enabled || settings.provider == CloudBackupProvider::None {
        return Err("Cloud backup is not enabled.".to_string());
    }
    let client = get_client();
    let dest = std::env::temp_dir().join(format!("efxlve_profile_download_{backup_id}.tar.gz"));

    match settings.provider {
        CloudBackupProvider::Folder => {
            folder::download_backup_folder(&settings.folder_path, remote_id, &dest)?;
        }
        CloudBackupProvider::Webdav => {
            let webdav = webdav_client(&settings)?;
            let client = &webdav;
            webdav::download_file_webdav(
                client,
                remote_id,
                &settings.webdav_username,
                &settings.webdav_password,
                &dest,
            )
            .await?;
        }
        CloudBackupProvider::GoogleDrive => {
            let refresh = settings.gdrive_refresh_token.as_deref().unwrap_or_default();
            let (client_id, client_secret) = gdrive_credentials(&settings)?;
            let access =
                gdrive::refresh_access_token(client, client_id, client_secret, refresh).await?;
            gdrive::download_backup_gdrive(client, &access, remote_id, &dest).await?;
        }
        CloudBackupProvider::Rclone => {
            rclone::download_backup_rclone(&settings.rclone_remote, remote_id, &dest).await?;
        }
        CloudBackupProvider::None => return Err("No active cloud provider.".to_string()),
    }

    Ok(dest)
}

/// Hook called automatically when a game process exits. A changed save tree is
/// backed up locally; when a provider is configured the same archive is
/// uploaded. The per-game "include in automatic backups" switch opts out.
pub fn trigger_auto_sync_on_exit(app: AppHandle, app_name: String) {
    let settings = load_settings();
    if !settings.auto_sync_on_game_exit {
        return;
    }
    let excluded = crate::legendary::commands::load_all_game_custom_configs()
        .get(&app_name)
        .and_then(|cfg| cfg.backup_excluded)
        .unwrap_or(false);
    if excluded {
        return;
    }
    let upload = settings.enabled && settings.provider != CloudBackupProvider::None;

    tauri::async_runtime::spawn(async move {
        let _queue = auto_sync_queue().lock().await;
        // Create the local backup first, then upload it. Failures must reach the
        // UI: `cloud-sync-complete` is the channel the frontend already listens to.
        let local_res = tauri::async_runtime::spawn_blocking({
            let name = app_name.clone();
            move || create_backup_if_changed(&name)
        })
        .await;

        match local_res {
            Ok(Ok(Some(info))) => {
                if !upload {
                    return;
                }
                match upload_backup(&app_name, Some(&info.id)).await {
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
                }
            }
            // An unchanged save tree needs neither a new local copy nor an upload.
            Ok(Ok(None)) => {}
            Ok(Err(err)) => {
                if upload {
                    let _ = app.emit(
                        "cloud-sync-complete",
                        serde_json::json!({
                            "id": app_name,
                            "success": false,
                            "message": err
                        }),
                    );
                }
            }
            Err(_) => {}
        }
    });
}
