use std::collections::HashMap;
use std::fs;
use tauri::AppHandle;

use super::models::{GogAuthTokens, GogCachedLibrary, GogGameSummary, GogInstalledInfo};
use super::paths::{auth_json_path, installed_json_path, library_snapshot_path};
use super::GogError;

pub const GOG_CLIENT_ID: &str = "46899977096215655";

/// Read saved GOG OAuth2 tokens from disk.
/// Supports both the gogdl dictionary format `{"46899977096215655": {...}}` and direct format.
pub fn load_auth_tokens(app: &AppHandle) -> Option<GogAuthTokens> {
    let path = auth_json_path(app);
    let bytes = fs::read(&path).ok()?;
    if let Ok(map) = serde_json::from_slice::<HashMap<String, GogAuthTokens>>(&bytes) {
        if let Some(tokens) = map.get(GOG_CLIENT_ID) {
            return Some(tokens.clone());
        }
    }
    serde_json::from_slice(&bytes).ok()
}

/// Persist GOG OAuth2 tokens to disk in gogdl-compatible dictionary format.
pub fn save_auth_tokens(app: &AppHandle, tokens: &GogAuthTokens) -> Result<(), GogError> {
    let path = auth_json_path(app);
    let mut map = HashMap::new();
    let mut t = tokens.clone();
    if t.login_time.is_none() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        t.login_time = Some(now);
    }
    map.insert(GOG_CLIENT_ID.to_string(), t);
    let json = serde_json::to_vec_pretty(&map)?;
    fs::write(&path, json).map_err(|e| GogError::Io(e.to_string()))
}

/// Remove saved GOG OAuth2 tokens from disk (logout).
pub fn clear_auth_tokens(app: &AppHandle) {
    let path = auth_json_path(app);
    let _ = fs::remove_file(path);
}

/// Load registered GOG game installations from disk.
pub fn load_installed_games(app: &AppHandle) -> HashMap<String, GogInstalledInfo> {
    let path = installed_json_path(app);
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(map) = serde_json::from_slice::<HashMap<String, GogInstalledInfo>>(&bytes) {
            return map;
        }
    }
    HashMap::new()
}

/// Save registered GOG game installations to disk.
pub fn save_installed_games(
    app: &AppHandle,
    games: &HashMap<String, GogInstalledInfo>,
) -> Result<(), GogError> {
    let path = installed_json_path(app);
    let json = serde_json::to_vec_pretty(games)?;
    fs::write(&path, json).map_err(|e| GogError::Io(e.to_string()))
}

/// Load cached GOG library snapshot for instant hydration on boot.
pub fn load_cached_library(app: &AppHandle) -> GogCachedLibrary {
    let path = library_snapshot_path(app);
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(cached) = serde_json::from_slice::<GogCachedLibrary>(&bytes) {
            return cached;
        }
    }
    GogCachedLibrary {
        account: None,
        account_id: None,
        games: Vec::new(),
    }
}

/// Write updated GOG library snapshot to disk in a single sequential I/O operation.
pub fn save_cached_library(
    app: &AppHandle,
    account: Option<&str>,
    account_id: Option<&str>,
    games: &[GogGameSummary],
) -> Result<(), GogError> {
    let path = library_snapshot_path(app);
    let snapshot = GogCachedLibrary {
        account: account.map(String::from),
        account_id: account_id.map(String::from),
        games: games.to_vec(),
    };
    let json = serde_json::to_vec_pretty(&snapshot)?;
    fs::write(&path, json).map_err(|e| GogError::Io(e.to_string()))
}
