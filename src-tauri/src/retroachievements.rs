//! RetroAchievements: the official web API, one game at a time.
//!
//! The store CLIs and the local Steam files know nothing about retro emulation.
//! RetroAchievements publishes the same facts over JSON with the user's own web
//! API key (Settings → Integrations): the game's achievement set, each unlock
//! (casual and hardcore), points, badges and the player's completion.
//!
//! A launcher game is mapped to an RA game id by hand on the game page. An RA
//! mapping wins over the store answer for that page, exactly like a local set;
//! clearing the id returns to the store. Nothing here writes to RA.

use serde::{Deserialize, Serialize};

use crate::legendary::models::{
    AchievementItem, AchievementRarity, GameAchievementsResponse,
};

const API_ROOT: &str = "https://retroachievements.org/API";
const MEDIA_ROOT: &str = "https://media.retroachievements.org/Badge";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RaStatus {
    pub configured: bool,
    /// The username is not a secret; the API key never leaves Rust.
    pub username: String,
}

fn credentials(app: &tauri::AppHandle) -> Option<(String, String)> {
    let settings = crate::load_settings(app);
    let username = settings.ra_username.as_deref()?.trim().to_string();
    let key = settings.ra_api_key.as_deref()?.trim().to_string();
    if username.is_empty() || key.is_empty() {
        return None;
    }
    Some((username, key))
}

fn status_for(app: &tauri::AppHandle) -> RaStatus {
    match credentials(app) {
        Some((username, _)) => RaStatus {
            configured: true,
            username,
        },
        None => RaStatus {
            configured: false,
            username: String::new(),
        },
    }
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|error| format!("RetroAchievements: {error}"))
}

/// Reads a field from either the legacy PascalCase answer or the camelCase one
/// the client libraries normalize to.
fn field<'a>(value: &'a serde_json::Value, names: &[&str]) -> Option<&'a serde_json::Value> {
    for name in names {
        if let Some(found) = value.get(*name) {
            if !found.is_null() {
                return Some(found);
            }
        }
    }
    None
}

fn text(value: &serde_json::Value, names: &[&str]) -> String {
    field(value, names)
        .and_then(|entry| entry.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn number(value: &serde_json::Value, names: &[&str]) -> f64 {
    field(value, names)
        .and_then(|entry| {
            entry
                .as_f64()
                .or_else(|| entry.as_str().and_then(|raw| raw.trim().parse().ok()))
        })
        .unwrap_or(0.0)
}

/// Achievement ids come back as a JSON number under the legacy keys.
fn id_text(value: &serde_json::Value, names: &[&str]) -> String {
    match field(value, names) {
        Some(serde_json::Value::String(text)) => text.trim().to_string(),
        Some(serde_json::Value::Number(number)) => number.to_string(),
        _ => String::new(),
    }
}

/// `2016-03-12 17:47:29` → `2016-03-12`; the page formats a civil date.
fn civil_date(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.len() < 10 {
        return None;
    }
    let date = &trimmed[..10];
    if date.as_bytes().get(4) == Some(&b'-') && date.as_bytes().get(7) == Some(&b'-') {
        Some(date.to_string())
    } else {
        None
    }
}

fn badge_url(name: &str) -> String {
    if name.trim().is_empty() {
        String::new()
    } else {
        format!("{MEDIA_ROOT}/{}.png", name.trim())
    }
}

#[tauri::command]
pub fn ra_status(app: tauri::AppHandle) -> RaStatus {
    status_for(&app)
}

/// Stores the username and key; an empty pair clears both. A missing key keeps
/// the stored one, so the write-only field can update just the username. The key
/// stays in the settings file and is never returned to the frontend.
#[tauri::command]
pub fn ra_set_credentials(
    app: tauri::AppHandle,
    username: String,
    api_key: String,
) -> Result<RaStatus, String> {
    let mut settings = crate::load_settings(&app);
    let username = username.trim().to_string();
    let key = api_key.trim().to_string();
    if username.is_empty() && key.is_empty() {
        settings.ra_username = None;
        settings.ra_api_key = None;
    } else {
        let next_username = if username.is_empty() {
            settings.ra_username.clone().unwrap_or_default()
        } else {
            username
        };
        let next_key = if key.is_empty() {
            settings.ra_api_key.clone().unwrap_or_default()
        } else {
            key
        };
        if next_username.is_empty() || next_key.is_empty() {
            return Err(
                "RetroAchievements: username and web API key are both required".into(),
            );
        }
        settings.ra_username = Some(next_username);
        settings.ra_api_key = Some(next_key);
    }
    crate::save_settings(&app, &settings);
    Ok(status_for(&app))
}

/// Verifies the stored pair against the user profile endpoint.
#[tauri::command]
pub async fn ra_test(app: tauri::AppHandle) -> Result<String, String> {
    let Some((username, key)) = credentials(&app) else {
        return Err("RetroAchievements: add your username and web API key first".into());
    };
    let client = http()?;
    let response = client
        .get(format!("{API_ROOT}/API_GetUserProfile.php"))
        .query(&[("u", username.as_str()), ("y", key.as_str())])
        .send()
        .await
        .map_err(|error| format!("RetroAchievements: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "RetroAchievements: check the username and API key (HTTP {})",
            response.status().as_u16()
        ));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("RetroAchievements: {error}"))?;
    let user = text(&payload, &["User", "user"]);
    if user.is_empty() {
        return Err("RetroAchievements: the profile answer was empty".into());
    }
    Ok(user)
}

/// One game's set plus the player's casual/hardcore unlocks.
#[tauri::command]
pub async fn ra_game_progress(
    app: tauri::AppHandle,
    game_id: String,
) -> Result<GameAchievementsResponse, String> {
    let Some((username, key)) = credentials(&app) else {
        return Err("RetroAchievements: no credentials".into());
    };
    let game_id = game_id.trim().to_string();
    if game_id.is_empty() || !game_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("RetroAchievements: invalid game id".into());
    }
    let client = http()?;
    let response = client
        .get(format!("{API_ROOT}/API_GetGameInfoAndUserProgress.php"))
        .query(&[
            ("g", game_id.as_str()),
            ("u", username.as_str()),
            ("y", key.as_str()),
        ])
        .send()
        .await
        .map_err(|error| format!("RetroAchievements: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "RetroAchievements: game #{game_id} could not be read (HTTP {})",
            response.status().as_u16()
        ));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("RetroAchievements: {error}"))?;
    Ok(map_game_progress(&payload))
}

fn map_game_progress(payload: &serde_json::Value) -> GameAchievementsResponse {
    let players = number(payload, &["NumDistinctPlayersCasual", "numDistinctPlayersCasual"]);
    let raw_achievements = field(payload, &["Achievements", "achievements"]);
    let mut entries: Vec<&serde_json::Value> = match raw_achievements {
        Some(serde_json::Value::Object(map)) => map.values().collect(),
        Some(serde_json::Value::Array(list)) => list.iter().collect(),
        _ => Vec::new(),
    };
    // Display order is the RA list order; the map key order is not guaranteed.
    entries.sort_by(|a, b| {
        number(a, &["DisplayOrder", "displayOrder"])
            .partial_cmp(&number(b, &["DisplayOrder", "displayOrder"]))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut achievements = Vec::new();
    let mut unlocked_count = 0u32;
    let mut user_xp = 0u32;
    let mut total_xp = 0u32;
    for entry in entries {
        let name = id_text(entry, &["ID", "id"]);
        if name.is_empty() {
            continue;
        }
        let title = text(entry, &["Title", "title"]);
        let description = text(entry, &["Description", "description"]);
        let points = number(entry, &["Points", "points"]).max(0.0) as u32;
        let earned = text(entry, &["DateEarned", "dateEarned"]);
        let earned_hardcore = text(entry, &["DateEarnedHardcore", "dateEarnedHardcore"]);
        let unlocked = !earned.is_empty() || !earned_hardcore.is_empty();
        let date = civil_date(if earned.is_empty() {
            &earned_hardcore
        } else {
            &earned
        });
        let awarded = number(entry, &["NumAwarded", "numAwarded"]);
        let rarity = if players > 0.0 {
            Some((awarded / players * 100.0).clamp(0.0, 100.0))
        } else {
            None
        };
        total_xp = total_xp.saturating_add(points);
        if unlocked {
            unlocked_count += 1;
            user_xp = user_xp.saturating_add(points);
        }
        achievements.push(AchievementItem {
            name: format!("ra-{name}"),
            display_name: if title.is_empty() { name.clone() } else { title },
            description,
            xp: points,
            unlocked,
            progress: if unlocked { 1.0 } else { 0.0 },
            unlock_date: date,
            icon_id: String::new(),
            icon_link: badge_url(&text(entry, &["BadgeName", "badgeName"])),
            tier: None,
            rarity: rarity.map(|percent| AchievementRarity {
                percent: Some(percent),
            }),
            hidden: false,
            is_base: true,
        });
    }

    let total = achievements.len() as u32;
    GameAchievementsResponse {
        achievements,
        user_unlocked: unlocked_count,
        user_xp,
        total_achievements: total,
        total_xp,
        is_platinum: total > 0 && unlocked_count >= total,
        supported: Some(total > 0),
        ..Default::default()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RaRecentGame {
    pub game_id: String,
    pub title: String,
    pub console: String,
}

fn map_recent_games(payload: &serde_json::Value) -> Vec<RaRecentGame> {
    let Some(list) = payload.as_array() else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in list {
        let game_id = id_text(entry, &["GameID", "gameId"]);
        let title = text(entry, &["Title", "title"]);
        if game_id.is_empty() || title.is_empty() {
            continue;
        }
        out.push(RaRecentGame {
            game_id,
            title,
            console: text(entry, &["ConsoleName", "consoleName"]),
        });
        if out.len() >= 12 {
            break;
        }
    }
    out
}

/// The player's most recent RA games: the mapping panel's picker. Finding the
/// numeric game id by hand is the one rough edge of the RA flow.
#[tauri::command]
pub async fn ra_recent_games(app: tauri::AppHandle) -> Result<Vec<RaRecentGame>, String> {
    let Some((username, key)) = credentials(&app) else {
        return Err("RetroAchievements: no credentials".into());
    };
    let client = http()?;
    let response = client
        .get(format!("{API_ROOT}/API_GetUserRecentlyPlayedGames.php"))
        .query(&[
            ("u", username.as_str()),
            ("y", key.as_str()),
            ("c", "12"),
            ("o", "0"),
        ])
        .send()
        .await
        .map_err(|error| format!("RetroAchievements: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "RetroAchievements: recent games could not be read (HTTP {})",
            response.status().as_u16()
        ));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|error| format!("RetroAchievements: {error}"))?;
    Ok(map_recent_games(&payload))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn recent_games_map_ids_titles_and_consoles() {
        let payload = json!([
            {"GameID": 1, "Title": "Sonic the Hedgehog", "ConsoleName": "Mega Drive"},
            {"gameId": "14402", "title": "Dragster", "consoleName": "Atari 2600"},
            {"GameID": 0, "Title": ""}
        ]);
        let games = map_recent_games(&payload);
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].game_id, "1");
        assert_eq!(games[1].title, "Dragster");
        assert_eq!(games[1].console, "Atari 2600");
    }

    #[test]
    fn progress_maps_titles_badges_rarity_and_unlocks() {
        let payload = json!({
            "Title": "Sonic the Hedgehog",
            "ConsoleName": "Mega Drive",
            "NumDistinctPlayersCasual": 1000,
            "NumAchievements": 2,
            "Achievements": {
                "9": {
                    "ID": 9,
                    "Title": "That Was Easy",
                    "Description": "Finish the first act",
                    "Points": 3,
                    "BadgeName": "250336",
                    "DisplayOrder": 1,
                    "NumAwarded": 250,
                    "DateEarned": "2016-03-12 17:47:29"
                },
                "10": {
                    "ID": 10,
                    "Title": "Hard One",
                    "Description": "No damage",
                    "Points": 10,
                    "BadgeName": "250337",
                    "DisplayOrder": 2,
                    "NumAwarded": 10,
                    "DateEarnedHardcore": "2024-04-23 21:28:49"
                }
            }
        });
        let response = map_game_progress(&payload);
        assert_eq!(response.total_achievements, 2);
        assert_eq!(response.user_unlocked, 2);
        assert_eq!(response.total_xp, 13);
        assert_eq!(response.user_xp, 13);
        assert!(response.is_platinum);
        assert_eq!(response.achievements[0].name, "ra-9");
        assert_eq!(response.achievements[0].display_name, "That Was Easy");
        assert_eq!(
            response.achievements[0].icon_link,
            "https://media.retroachievements.org/Badge/250336.png"
        );
        assert_eq!(response.achievements[0].unlock_date.as_deref(), Some("2016-03-12"));
        assert_eq!(
            response.achievements[0]
                .rarity
                .as_ref()
                .and_then(|rarity| rarity.percent),
            Some(25.0)
        );
        assert_eq!(response.achievements[1].unlock_date.as_deref(), Some("2024-04-23"));
    }

    #[test]
    fn a_locked_set_keeps_a_zero_progress_answer() {
        let payload = json!({
            "NumDistinctPlayersCasual": 0,
            "Achievements": [
                {"ID": 1, "Title": "One", "Points": 5, "DisplayOrder": 0}
            ]
        });
        let response = map_game_progress(&payload);
        assert_eq!(response.user_unlocked, 0);
        assert_eq!(response.user_xp, 0);
        assert_eq!(response.total_achievements, 1);
        assert!(!response.is_platinum);
        assert!(response.achievements[0].rarity.is_none());
    }

    #[test]
    fn an_empty_answer_is_not_supported() {
        let response = map_game_progress(&json!({}));
        assert_eq!(response.total_achievements, 0);
        assert_eq!(response.supported, Some(false));
    }
}
