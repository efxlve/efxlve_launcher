//! GOG binary and file system paths.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::GogError;

#[allow(dead_code)]
pub const GOGDL_RELEASES_URL: &str =
    "https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/latest";
pub const GOGDL_DOWNLOAD_URL: &str =
    "https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/download/v1.3.0/gogdl_windows_x86_64.exe";
pub const WINDOWS_GOGDL_EXE: &str = "gogdl.exe";

/// `<app_data>/bin` directory for external helper binaries.
pub fn bin_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
}

/// `<app_data>/bin/gogdl.exe`
pub fn downloaded_binary(app: &AppHandle) -> PathBuf {
    bin_dir(app).join(WINDOWS_GOGDL_EXE)
}

/// Resolves the executable path for `gogdl.exe`.
pub fn resolve_binary(
    app: &AppHandle,
    override_path: Option<&str>,
) -> Result<PathBuf, GogError> {
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
    Err(GogError::BinaryMissing)
}

/// Ensures `gogdl.exe` is present on disk, downloading it from GitHub Releases if missing.
pub async fn ensure_binary(app: &AppHandle) -> Result<PathBuf, GogError> {
    if let Ok(p) = resolve_binary(app, None) {
        return Ok(p);
    }
    let target = downloaded_binary(app);
    let dir = bin_dir(app);
    let _ = tokio::fs::create_dir_all(&dir).await;
    let part = dir.join("gogdl.exe.part");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| GogError::Http(e.to_string()))?;

    let resp = client
        .get(GOGDL_DOWNLOAD_URL)
        .send()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(GogError::Http(format!(
            "Failed to download gogdl binary: HTTP {}",
            resp.status()
        )));
    }

    let bytes = resp.bytes().await.map_err(|e| GogError::Http(e.to_string()))?;
    tokio::fs::write(&part, &bytes).await.map_err(|e| GogError::Io(e.to_string()))?;

    tokio::fs::rename(&part, &target)
        .await
        .map_err(|e| GogError::Io(e.to_string()))?;

    Ok(target)
}

/// `<app_data>/gog` configuration and storage directory.
pub fn gog_config_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("gog");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// `<app_data>/gog/auth.json` containing OAuth2 tokens.
pub fn auth_json_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("auth.json")
}

/// `<app_data>/gog/installed.json` containing local installation metadata.
pub fn installed_json_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("installed.json")
}

/// `<app_data>/gog/efxlve_gog_library_snapshot.json`
pub fn library_snapshot_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("efxlve_gog_library_snapshot.json")
}

/// `<app_data>/gog/achievements_cache.json` containing cached achievement summaries.
pub fn achievements_cache_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("achievements_cache.json")
}
