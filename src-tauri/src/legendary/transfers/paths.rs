//! Where Epic games are installed, and where `legendary.exe` lives.
//!
//! The install root comes from settings, then `<home>/Games`.

use std::path::PathBuf;

use tauri::AppHandle;

use crate::legendary::{cmd_error, paths};
use crate::load_settings;

/// Default install root: `<home>/Games` (same as legendary).
pub fn default_install_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    home.join("Games")
}

pub(super) fn resolve_base(app: &AppHandle, override_dir: Option<String>) -> PathBuf {
    if let Some(p) = override_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return PathBuf::from(p);
    }
    load_settings(app)
        .install_dir
        .map(PathBuf::from)
        .unwrap_or_else(default_install_dir)
}

pub(super) fn resolve_bin(app: &AppHandle) -> Result<PathBuf, String> {
    paths::resolve_binary(app).map_err(cmd_error)
}

#[tauri::command]
pub fn epic_default_install_dir() -> String {
    default_install_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn epic_set_install_dir(
    app: AppHandle,
    path: Option<String>,
) -> Result<crate::EpicSettings, String> {
    let mut s = load_settings(&app);
    s.install_dir = path.and_then(|p| {
        let t = p.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    crate::save_settings(&app, &s);
    Ok(s)
}
