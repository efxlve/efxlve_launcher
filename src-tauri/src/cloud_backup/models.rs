//! Data models for Cloud Save Backup (WebDAV and Google Drive).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum CloudBackupProvider {
    #[default]
    None,
    Webdav,
    GoogleDrive,
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
    #[serde(default)]
    pub webdav_url: String,
    #[serde(default)]
    pub webdav_username: String,
    #[serde(default)]
    pub webdav_password: String,
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
            webdav_url: String::new(),
            webdav_username: String::new(),
            webdav_password: String::new(),
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
