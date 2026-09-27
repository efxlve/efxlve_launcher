//! GOG binary and file system paths.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::GogError;

#[allow(dead_code)]
pub const GOGDL_RELEASES_URL: &str =
    "https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/latest";
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

/// `<app_data>/gog/efxlve_gog_library_snapshot.json`
pub fn library_snapshot_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("efxlve_gog_library_snapshot.json")
}
