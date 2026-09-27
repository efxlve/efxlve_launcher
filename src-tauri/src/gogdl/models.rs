//! Data models for GOG.COM integration (OAuth2, Galaxy REST API, and gogdl CLI).

use serde::{Deserialize, Serialize};

/// Tokens persisted in `auth.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GogAuthTokens {
    pub access_token: String,
    pub refresh_token: String,
    #[serde(default)]
    pub expires_in: u64,
    #[serde(default)]
    pub user_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default, rename = "loginTime")]
    pub login_time: Option<f64>,
}

/// GOG user profile details retrieved from users.gog.com.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GogUserProfile {
    pub user_id: String,
    pub username: String,
    #[serde(default)]
    pub avatar_url: Option<String>,
}

/// A release entry returned by galaxy-library.gog.com.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct GogReleaseItem {
    pub release_key: String,
    #[serde(default)]
    pub external_id: String,
    #[serde(default)]
    pub platform_id: String,
    #[serde(default)]
    pub certificate: Option<String>,
}

/// Release listing wrapper with pagination tokens.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct GogReleasesResponse {
    #[serde(default)]
    pub releases: Vec<GogReleaseItem>,
    #[serde(default)]
    pub next_page_token: Option<String>,
}

/// Presentation and store summary for a GOG game.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GogGameSummary {
    pub game_id: String,
    pub title: String,
    #[serde(default)]
    pub developer: Option<String>,
    #[serde(default)]
    pub publisher: Option<String>,
    pub is_installed: bool,
    #[serde(default)]
    pub install_path: Option<String>,
    #[serde(default)]
    pub install_size: u64,
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub cover_url: Option<String>,
    #[serde(default)]
    pub hero_url: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub cloud_saves_supported: bool,
    #[serde(default)]
    pub dlc_count: usize,
}

/// Authentication status queried by the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GogAuthStatus {
    pub logged_in: bool,
    pub user_id: Option<String>,
    pub username: Option<String>,
}

/// gogdl binary presence status.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GogSetupStatus {
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub needs_download: bool,
}

/// Disk cached library snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GogCachedLibrary {
    pub account: Option<String>,
    pub account_id: Option<String>,
    pub games: Vec<GogGameSummary>,
}

/// Local game installation metadata parsed from `goggame-*.info`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[allow(dead_code)]
pub struct GogInstalledInfo {
    pub game_id: String,
    pub title: String,
    pub install_path: String,
    pub version: String,
    pub install_size: u64,
    pub executable: Option<String>,
}
