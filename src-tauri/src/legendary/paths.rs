//! legendary binary resolution and download URLs.
//!
//! Resolution order: alternative path from settings -> binary downloaded into app_data
//! -> not-found error (then auto-download kicks in).

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use super::LegendaryError;

pub const RELEASES_LATEST_URL: &str =
    "https://github.com/legendary-gl/legendary/releases/latest";
pub const WINDOWS_ASSET_NAME: &str = "legendary_windows_x64.exe";

/// `<app_data>/bin` — oto-indirilen binary buraya konur.
pub fn bin_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
}

/// `<app_data>/bin/legendary.exe`
pub fn downloaded_binary(app: &AppHandle) -> PathBuf {
    bin_dir(app).join("legendary.exe")
}

pub fn resolve_binary(
    app: &AppHandle,
    override_path: Option<&str>,
) -> Result<PathBuf, LegendaryError> {
    if let Some(p) = override_path {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            return Ok(pb);
        }
    }
    let dl = downloaded_binary(app);
    if dl.is_file() {
        return Ok(dl);
    }
    Err(LegendaryError::BinaryMissing)
}

/// `https://github.com/legendary-gl/legendary/releases/download/<tag>/legendary_windows_x64.exe`
pub fn download_url_for_tag(tag: &str) -> String {
    format!(
        "https://github.com/legendary-gl/legendary/releases/download/{tag}/{WINDOWS_ASSET_NAME}"
    )
}
