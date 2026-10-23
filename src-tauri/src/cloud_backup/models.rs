//! Data models for Cloud Save Backup (Folder, WebDAV, Google Drive, rclone).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CloudBackupProvider {
    #[default]
    None,
    Folder,
    Webdav,
    GoogleDrive,
    Rclone,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBackupSettings {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub provider: CloudBackupProvider,
    #[serde(default)]
    pub auto_sync_on_game_exit: bool,
    /// Cloud archives kept per game; 0 keeps every archive.
    #[serde(default)]
    pub retention_count: u32,
    /// Creates one local backup per installed game at most once a day.
    #[serde(default)]
    pub local_backup_daily: bool,
    #[serde(default)]
    pub last_local_backup: Option<u64>,
    /// Uploads the launcher profile at most once a day while the app is open.
    #[serde(default)]
    pub profile_daily_upload: bool,
    #[serde(default)]
    pub last_profile_upload: Option<u64>,
    #[serde(default)]
    pub folder_path: String,
    #[serde(default)]
    pub webdav_url: String,
    #[serde(default)]
    pub webdav_username: String,
    #[serde(default)]
    pub webdav_password: String,
    /// Accept a self-signed WebDAV certificate (explicit opt-in).
    #[serde(default)]
    pub webdav_allow_invalid_cert: bool,
    /// `<remote>:<path>` as configured in `rclone config`.
    #[serde(default)]
    pub rclone_remote: String,
    #[serde(default)]
    pub gdrive_client_id: Option<String>,
    #[serde(default)]
    pub gdrive_client_secret: Option<String>,
    #[serde(default)]
    pub gdrive_folder_id: Option<String>,
    #[serde(default)]
    pub gdrive_user_email: Option<String>,
    #[serde(default)]
    pub gdrive_refresh_token: Option<String>,
    #[serde(default)]
    pub last_sync_time: Option<u64>,
}

impl Default for CloudBackupSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            provider: CloudBackupProvider::None,
            auto_sync_on_game_exit: false,
            retention_count: 0,
            local_backup_daily: false,
            last_local_backup: None,
            profile_daily_upload: false,
            last_profile_upload: None,
            folder_path: String::new(),
            webdav_url: String::new(),
            webdav_username: String::new(),
            webdav_password: String::new(),
            webdav_allow_invalid_cert: false,
            rclone_remote: String::new(),
            gdrive_client_id: None,
            gdrive_client_secret: None,
            gdrive_folder_id: None,
            gdrive_user_email: None,
            gdrive_refresh_token: None,
            last_sync_time: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudBackupEntry {
    pub backup_id: String,
    pub app_name: String,
    pub timestamp: u64,
    pub formatted_date: String,
    pub size_bytes: u64,
    pub file_count: usize,
    pub sha256: String,
    pub provider: String,
    pub remote_id: String,
}
