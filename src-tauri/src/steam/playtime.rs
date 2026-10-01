//! Playtime recorded by the Steam client in `localconfig.vdf`.
//!
//! Minutes in the file are converted to seconds. No network.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::runtime::steam_install_path;
use super::vdf::{parse_vdf, Vdf};

/// Playtime from the Steam client's own local config, in seconds.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamPlaytime {
    pub seconds: i64,
    /// Unix seconds of the last session, when Steam recorded one.
    pub last_played: Option<i64>,
}

/// Reads `userdata/<id>/config/localconfig.vdf` for the most recently used
/// Steam account and maps `<appid>` to playtime (minutes in the file).
pub fn read_playtimes(steam: &Path) -> std::collections::HashMap<String, SteamPlaytime> {
    let mut result = std::collections::HashMap::new();
    let userdata = steam.join("userdata");
    let Ok(entries) = std::fs::read_dir(&userdata) else {
        return result;
    };
    let mut newest: Option<(std::time::SystemTime, PathBuf)> = None;
    for entry in entries.flatten() {
        let config = entry.path().join("config").join("localconfig.vdf");
        let Ok(meta) = std::fs::metadata(&config) else {
            continue;
        };
        let modified = meta.modified().unwrap_or(std::time::SystemTime::UNIX_EPOCH);
        if newest.as_ref().map(|(t, _)| modified > *t).unwrap_or(true) {
            newest = Some((modified, config));
        }
    }
    let Some((_, path)) = newest else {
        return result;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return result;
    };
    let root = parse_vdf(&text);
    let apps = root
        .get("UserLocalConfigStore")
        .and_then(|n| n.get("Software"))
        .and_then(|n| n.get("Valve"))
        .and_then(|n| n.get("Steam"))
        .and_then(|n| n.get("apps"));
    let Some(apps) = apps else { return result };
    for (app_id, node) in apps.entries() {
        if !app_id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let minutes = node
            .get("Playtime")
            .and_then(Vdf::as_str)
            .and_then(|v| v.parse::<i64>().ok())
            .unwrap_or(0);
        if minutes <= 0 {
            continue;
        }
        let last_played = node
            .get("LastPlayed")
            .and_then(Vdf::as_str)
            .and_then(|v| v.parse::<i64>().ok())
            .filter(|v| *v > 0);
        result.insert(
            app_id.clone(),
            SteamPlaytime {
                seconds: minutes * 60,
                last_played,
            },
        );
    }
    result
}

#[tauri::command]
pub fn steam_sync_playtime() -> std::collections::HashMap<String, SteamPlaytime> {
    steam_install_path()
        .map(|p| read_playtimes(&p))
        .unwrap_or_default()
}
