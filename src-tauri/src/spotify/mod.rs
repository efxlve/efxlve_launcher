//! Spotify integration: an in-launcher Connect receiver (librespot) that the
//! overlay controls directly. No Web API session or developer app is involved.

pub mod playback;

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Shared Spotify data directory (playback token, librespot cache).
pub(crate) fn data_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("spotify");
    let _ = std::fs::create_dir_all(&dir);
    dir
}
