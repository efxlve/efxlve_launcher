//! Screenshots the Steam client already saved for one app.
//!
//! Read-only. Files stay where Steam wrote them; this module only lists them.

use super::achievements::steam_account_id;
use super::runtime::steam_install_path;

use crate::legendary::screenshots::{
    file_to_data_url, format_bytes, get_file_local_datetime_str, GameScreenshotItem,
};

/// Screenshots taken by the Steam client for one app
/// (`userdata/<account>/760/remote/<app>/screenshots`).
///
/// Read-only: the files belong to the Steam client, so the gallery shows its
/// thumbnails and opens the originals, but never edits or deletes them.
#[tauri::command]
pub fn steam_get_game_screenshots(app_id: String) -> Vec<GameScreenshotItem> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Vec::new();
    }
    let Some(steam) = steam_install_path() else {
        return Vec::new();
    };
    let Some(account) = steam_account_id(&steam) else {
        return Vec::new();
    };
    let root = steam
        .join("userdata")
        .join(account.to_string())
        .join("760")
        .join("remote")
        .join(&app_id)
        .join("screenshots");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };

    let mut items = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_string)
        else {
            continue;
        };
        let lower = file_name.to_lowercase();
        if !(lower.ends_with(".jpg") || lower.ends_with(".jpeg") || lower.ends_with(".png")) {
            continue;
        }
        let Ok(metadata) = std::fs::metadata(&path) else {
            continue;
        };
        let timestamp = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let date_str = get_file_local_datetime_str(&path, &metadata, timestamp);
        // The gallery stays light with the client's thumbnail; the lightbox and
        // clipboard use the original.
        let thumb = root.join("thumbnails").join(&file_name);
        let preview = if thumb.is_file() { thumb } else { path.clone() };
        let Some(data_url) = file_to_data_url(&preview) else {
            continue;
        };
        let full_data_url = if preview == path {
            String::new()
        } else {
            file_to_data_url(&path).unwrap_or_default()
        };
        let size_bytes = metadata.len();
        items.push(GameScreenshotItem {
            id: format!("{file_name}_{timestamp}"),
            file_path: path.to_string_lossy().to_string(),
            file_name,
            date_str,
            timestamp,
            size_bytes,
            size_str: format_bytes(size_bytes),
            data_url,
            full_data_url,
        });
    }
    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    items
}
