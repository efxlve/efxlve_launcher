//! Disk caching for GOG authentication tokens and library metadata.

use std::fs;
use tauri::AppHandle;

use super::models::{GogAuthTokens, GogCachedLibrary, GogGameSummary};
use super::paths::{auth_json_path, library_snapshot_path};
use super::GogError;

/// Read saved GOG OAuth2 tokens from disk.
pub fn load_auth_tokens(app: &AppHandle) -> Option<GogAuthTokens> {
    let path = auth_json_path(app);
    let bytes = fs::read(&path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

/// Persist GOG OAuth2 tokens to disk.
pub fn save_auth_tokens(app: &AppHandle, tokens: &GogAuthTokens) -> Result<(), GogError> {
    let path = auth_json_path(app);
    let json = serde_json::to_vec_pretty(tokens)?;
    fs::write(&path, json).map_err(|e| GogError::Io(e.to_string()))
}

/// Remove saved GOG OAuth2 tokens from disk (logout).
pub fn clear_auth_tokens(app: &AppHandle) {
    let path = auth_json_path(app);
    let _ = fs::remove_file(path);
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
