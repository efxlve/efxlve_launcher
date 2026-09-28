//! Cross-store "all accounts" library index (Steam family-sharing style).
//!
//! Every saved account keeps a library snapshot on disk — Epic under
//! `<legendary config>/accounts/<id>/efxlve_library_snapshot.json` and GOG under
//! `<app data>/gog/accounts/<user id>/efxlve_gog_library_snapshot.json` — so the
//! union of all accounts' games can be built **without any network access**.
//!
//! Games owned by the currently signed-in account are excluded here: the frontend
//! already has those with full details and only needs the extra ones plus their
//! owner, which is what the detail page shows before switching accounts.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::gogdl;
use crate::legendary;

/// Portrait cover priority, mirrors the frontend's `epicPortrait`.
const EPIC_PORTRAIT_TYPES: [&str; 3] = ["DieselGameBoxTall", "OfferImageTall", "DieselStoreFrontTall"];
/// Wide cover priority, mirrors the frontend's `epicCover`.
const EPIC_COVER_TYPES: [&str; 6] = [
    "DieselGameBox",
    "OfferImageWide",
    "DieselGameBoxTall",
    "OfferImageTall",
    "DieselStoreFrontTall",
    "DieselGameBoxLogo",
];

/// One game that belongs to another saved account.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedGame {
    /// Library key: the Epic app name or `gog::<id>`.
    pub key: String,
    pub title: String,
    pub cover: Option<String>,
    pub store: String,
    /// `epic:<accountId>` / `gog:<userId>`.
    pub owner_key: String,
    pub owner_name: String,
}

/// A saved account that contributes games to the shared index.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedAccount {
    pub owner_key: String,
    pub owner_name: String,
    pub store: String,
    pub game_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SharedLibraryIndex {
    pub accounts: Vec<SharedAccount>,
    pub games: Vec<SharedGame>,
}

/// Reads a portrait URL from Epic catalog metadata (same priority as the UI).
fn epic_portrait(metadata: &std::collections::HashMap<String, serde_json::Value>) -> Option<String> {
    let images = metadata.get("keyImages")?.as_array()?;
    let url_of = |t: &str| -> Option<String> {
        images
            .iter()
            .find(|i| i.get("type").and_then(|v| v.as_str()) == Some(t))
            .and_then(|i| i.get("url"))
            .and_then(|v| v.as_str())
            .map(str::to_string)
    };
    for t in EPIC_PORTRAIT_TYPES {
        if let Some(url) = url_of(t) {
            return Some(url);
        }
    }
    for t in EPIC_COVER_TYPES {
        if let Some(url) = url_of(t) {
            return Some(url);
        }
    }
    images
        .iter()
        .find_map(|i| i.get("url").and_then(|v| v.as_str()).map(str::to_string))
}

fn epic_display_name(account_dir: &Path) -> String {
    let Ok(text) = std::fs::read_to_string(account_dir.join("user.json")) else {
        return String::new();
    };
    serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| v.get("displayName").and_then(|n| n.as_str()).map(str::to_string))
        .unwrap_or_default()
}

fn epic_snapshot(account_dir: &Path) -> Vec<legendary::models::LegendaryGame> {
    let Ok(text) = std::fs::read_to_string(account_dir.join("efxlve_library_snapshot.json")) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn epic_app_names(games: &[legendary::models::LegendaryGame]) -> HashSet<String> {
    games.iter().map(|g| g.app_name.clone()).collect()
}

fn gog_snapshot(account_dir: &Path) -> gogdl::models::GogCachedLibrary {
    let empty = gogdl::models::GogCachedLibrary {
        account: None,
        account_id: None,
        games: Vec::new(),
    };
    let Ok(text) = std::fs::read_to_string(account_dir.join("efxlve_gog_library_snapshot.json")) else {
        return empty;
    };
    serde_json::from_str::<gogdl::models::GogCachedLibrary>(&text).unwrap_or(empty)
}

/// Builds the shared index from every saved account except the active ones.
#[tauri::command]
pub fn shared_library_index(app: AppHandle) -> SharedLibraryIndex {
    let mut accounts = Vec::new();
    let mut games: Vec<SharedGame> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    // ---- Epic ----
    let config = legendary::skip::default_config_dir();
    let active_epic = legendary::accounts::read_active_user(&config).map(|(id, _)| id);
    let active_epic_games = epic_app_names(&epic_snapshot(&config));

    if let Ok(entries) = std::fs::read_dir(config.join("accounts")) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let account_id = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if account_id.is_empty() || Some(&account_id) == active_epic.as_ref() {
                continue;
            }
            let name = epic_display_name(&dir);
            let snapshot = epic_snapshot(&dir);
            let mut count = 0usize;
            for game in &snapshot {
                if game.app_name.is_empty() || active_epic_games.contains(&game.app_name) {
                    continue;
                }
                if !seen.insert(game.app_name.clone()) {
                    continue;
                }
                let title = if game.app_title.is_empty() {
                    game.app_name.clone()
                } else {
                    game.app_title.clone()
                };
                let cover = epic_portrait(&game.metadata);
                games.push(SharedGame {
                    key: game.app_name.clone(),
                    title,
                    cover,
                    store: "epic".into(),
                    owner_key: format!("epic:{account_id}"),
                    owner_name: name.clone(),
                });
                count += 1;
            }
            accounts.push(SharedAccount {
                owner_key: format!("epic:{account_id}"),
                owner_name: name,
                store: "epic".into(),
                game_count: count,
            });
        }
    }

    // ---- GOG ----
    let gog_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("gog");
    let active_gog = gogdl::cache::load_auth_tokens(&app).map(|t| t.user_id);
    let active_gog_games: HashSet<String> = gog_snapshot(&gog_dir)
        .games
        .into_iter()
        .map(|g| g.game_id)
        .collect();

    if let Ok(entries) = std::fs::read_dir(gog_dir.join("accounts")) {
        for entry in entries.flatten() {
            let dir = entry.path();
            if !dir.is_dir() {
                continue;
            }
            let user_id = dir.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            if user_id.is_empty() || Some(&user_id) == active_gog.as_ref() {
                continue;
            }
            let snapshot = gog_snapshot(&dir);
            let name = snapshot
                .account
                .clone()
                .filter(|n| !n.is_empty() && n != "GOG User")
                .unwrap_or_else(|| user_id.clone());
            let mut count = 0usize;
            for game in &snapshot.games {
                if game.game_id.is_empty() || active_gog_games.contains(&game.game_id) {
                    continue;
                }
                let key = format!("gog::{}", game.game_id);
                if !seen.insert(key.clone()) {
                    continue;
                }
                games.push(SharedGame {
                    key,
                    title: game.title.clone(),
                    cover: game.cover_url.clone(),
                    store: "gog".into(),
                    owner_key: format!("gog:{user_id}"),
                    owner_name: name.clone(),
                });
                count += 1;
            }
            accounts.push(SharedAccount {
                owner_key: format!("gog:{user_id}"),
                owner_name: name,
                store: "gog".into(),
                game_count: count,
            });
        }
    }

    SharedLibraryIndex { accounts, games }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portrait_prefers_tall_then_falls_back() {
        let meta = |value: serde_json::Value| -> std::collections::HashMap<String, serde_json::Value> {
            serde_json::from_value(value).unwrap()
        };
        assert_eq!(
            epic_portrait(&meta(serde_json::json!({
                "keyImages": [
                    { "type": "DieselGameBox", "url": "wide.jpg" },
                    { "type": "OfferImageTall", "url": "tall.jpg" }
                ]
            })))
            .as_deref(),
            Some("tall.jpg")
        );
        assert_eq!(
            epic_portrait(&meta(serde_json::json!({
                "keyImages": [{ "type": "DieselGameBox", "url": "wide.jpg" }]
            })))
            .as_deref(),
            Some("wide.jpg")
        );
        assert_eq!(
            epic_portrait(&meta(serde_json::json!({
                "keyImages": [{ "type": "Unknown", "url": "any.jpg" }]
            })))
            .as_deref(),
            Some("any.jpg")
        );
        assert_eq!(epic_portrait(&meta(serde_json::json!({ "keyImages": [] }))), None);
    }
}
