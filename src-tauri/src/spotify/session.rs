//! Spotify session persistence.
//!
//! Lives next to the other launcher credentials under the app data dir:
//! `spotify/session.json` (tokens) and `spotify/client.txt` (the user's own
//! Spotify app Client ID). Nothing here leaves the machine.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct Session {
    pub client_id: String,
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: i64,
    pub user: String,
    pub product: String,
}

fn dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("spotify");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Shared Spotify data directory (Web API session, playback tokens, cache).
pub(crate) fn data_dir(app: &AppHandle) -> PathBuf {
    dir(app)
}

fn session_path(app: &AppHandle) -> PathBuf {
    dir(app).join("session.json")
}

fn client_path(app: &AppHandle) -> PathBuf {
    dir(app).join("client.txt")
}

pub fn load(app: &AppHandle) -> Option<Session> {
    let text = std::fs::read_to_string(session_path(app)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save(app: &AppHandle, session: &Session) {
    if let Ok(text) = serde_json::to_string(session) {
        let _ = std::fs::write(session_path(app), text);
    }
}

pub fn clear(app: &AppHandle) {
    let _ = std::fs::remove_file(session_path(app));
}

pub fn load_client_id(app: &AppHandle) -> Option<String> {
    std::fs::read_to_string(client_path(app))
        .ok()
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
}

pub fn save_client_id(app: &AppHandle, client_id: &str) {
    let _ = std::fs::write(client_path(app), client_id);
}
