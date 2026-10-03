//! Screenshots the Steam client already saved for one app.
//!
//! Read-only. Files stay where Steam wrote them; this module only lists them.

use super::achievements::steam_account_id;
use super::runtime::steam_install_path;

use crate::legendary::screenshots::{
    file_to_data_url, file_to_preview_data_url, format_bytes, get_file_local_datetime_str,
    GameScreenshotItem,
};

/// Screenshots taken by the Steam client for one app
/// (`userdata/<account>/760/remote/<app>/screenshots`).
///
/// Read-only: the files belong to the Steam client, so the gallery shows its
/// thumbnails and opens the originals, but never edits or deletes them.
#[tauri::command]
pub fn steam_get_game_screenshots(app_id: String) -> Vec<GameScreenshotItem> {
    let Some(root) = steam_screenshots_root(&app_id) else {
        return Vec::new();
    };
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
        // The gallery stays light with the client's thumbnail; without one the
        // file gets a generated preview, never a full-size data URL. The
        // original is loaded only when the lightbox, share sheet or clipboard
        // asks for it.
        let thumb = root.join("thumbnails").join(&file_name);
        let data_url = if thumb.is_file() {
            file_to_data_url(&thumb)
        } else {
            file_to_preview_data_url(&path)
        };
        let Some(data_url) = data_url else {
            continue;
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
            full_data_url: String::new(),
        });
    }
    items.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    // Same cap as the Epic listing: the newest 300 keep the response bounded.
    items.truncate(300);
    items
}

/// Full-resolution data URL for one Steam screenshot, on demand.
#[tauri::command]
pub fn steam_get_screenshot_full_data(app_id: String, file_path: String) -> Result<String, String> {
    let Some(root) = steam_screenshots_root(&app_id) else {
        return Err("@t:ss.fileNotFound".to_string());
    };
    let path = std::path::PathBuf::from(&file_path);
    // Only the client's own screenshot folder may be read here.
    if !path.starts_with(&root) {
        return Err("@t:ss.fileNotFound".to_string());
    }
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !metadata.is_file() {
        return Err("@t:ss.fileNotFound".to_string());
    }
    file_to_data_url(&path).ok_or_else(|| "@t:ss.fileNotFound".to_string())
}

/// `userdata/<account>/760/remote/<app>/screenshots` for a numeric app id.
fn steam_screenshots_root(app_id: &str) -> Option<std::path::PathBuf> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let steam = steam_install_path()?;
    let account = steam_account_id(&steam)?;
    Some(
        steam
            .join("userdata")
            .join(account.to_string())
            .join("760")
            .join("remote")
            .join(app_id)
            .join("screenshots"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;


    /// Live check for the client's own screenshots.
    /// Run: `cargo test live_steam_screenshots -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_steam_screenshots() {
        for app in ["730", "359550", "381210"] {
            let items = steam_get_game_screenshots(app.to_string());
            println!("{app}: {} screenshots", items.len());
            for item in items.iter().take(3) {
                println!(
                    "  {} | {} | {} | thumb {} | full {}",
                    item.file_name,
                    item.date_str,
                    item.size_str,
                    item.data_url.len(),
                    item.full_data_url.len()
                );
            }
        }
    }
}
