//! Are We Anti-Cheat Yet? status for one Steam or Epic app.
//!
//! The project publishes one `games.json` for the whole catalogue, so the first
//! game page downloads it and the day-long cache serves every later page. Only
//! the store ids, status, anti-cheat names and slug are kept — the notes and
//! update history belong on the website, not in the launcher.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const CACHE_SCHEMA: u32 = 1;
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const SOURCE: &str =
    "https://raw.githubusercontent.com/AreWeAntiCheatYet/AreWeAntiCheatYet/master/games.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntiCheatStatus {
    pub status: String,
    pub anticheats: Vec<String>,
    pub slug: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AwacyGame {
    #[serde(default)]
    status: String,
    #[serde(default)]
    anticheats: Vec<String>,
    #[serde(default)]
    slug: String,
    #[serde(default, rename = "storeIds")]
    store_ids: Option<AwacyStoreIds>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AwacyStoreIds {
    #[serde(default)]
    steam: Option<serde_json::Value>,
    #[serde(default)]
    epic: Option<AwacyEpicStore>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AwacyEpicStore {
    #[serde(default)]
    namespace: Option<String>,
    #[serde(default)]
    slug: Option<String>,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    schema: u32,
    fetched_at: u64,
    games: Vec<AwacyGame>,
}

fn valid_app_id(app_id: &str) -> bool {
    !app_id.is_empty() && app_id.len() <= 12 && app_id.bytes().all(|byte| byte.is_ascii_digit())
}

/// Epic catalog namespaces are either short names (`fn`) or 32 hex characters.
fn valid_epic_namespace(namespace: &str) -> bool {
    !namespace.is_empty()
        && namespace.len() <= 64
        && namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn cache_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam")
        .join("awacy")
        .join("games.json")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0)
}

fn cache_is_fresh(fetched_at: u64, now: u64) -> bool {
    now.saturating_sub(fetched_at) < CACHE_TTL_SECS
}

fn read_cache(path: &Path) -> Option<CacheFile> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_cache(path: &Path, games: &[AwacyGame]) {
    let Some(parent) = path.parent() else {
        return;
    };
    let _ = std::fs::create_dir_all(parent);
    let cache = CacheFile {
        schema: CACHE_SCHEMA,
        fetched_at: now_secs(),
        games: games.to_vec(),
    };
    let Ok(text) = serde_json::to_string(&cache) else {
        return;
    };
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, text).is_err() {
        return;
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::rename(&tmp, path);
    }
}

fn steam_id(value: &serde_json::Value) -> Option<String> {
    let id = match value {
        serde_json::Value::String(text) => text.trim().to_string(),
        serde_json::Value::Number(number) => number.to_string(),
        _ => return None,
    };
    valid_app_id(&id).then_some(id)
}

fn game_status(game: &AwacyGame) -> Option<(String, AntiCheatStatus)> {
    let steam = game
        .store_ids
        .as_ref()
        .and_then(|ids| ids.steam.as_ref())
        .and_then(steam_id)?;
    if game.status.trim().is_empty() {
        return None;
    }
    Some((
        steam,
        AntiCheatStatus {
            status: game.status.clone(),
            anticheats: game.anticheats.clone(),
            slug: game.slug.clone(),
        },
    ))
}

fn find_in(games: &[AwacyGame], app_id: &str) -> Option<AntiCheatStatus> {
    games.iter().find_map(|game| {
        let (steam, status) = game_status(game)?;
        (steam == app_id).then_some(status)
    })
}

fn game_epic_status(game: &AwacyGame) -> Option<(String, AntiCheatStatus)> {
    let epic = game.store_ids.as_ref()?.epic.as_ref()?;
    let namespace = epic.namespace.as_deref()?.trim();
    if !valid_epic_namespace(namespace) || game.status.trim().is_empty() {
        return None;
    }
    let slug = if game.slug.trim().is_empty() {
        epic.slug.clone().unwrap_or_default()
    } else {
        game.slug.clone()
    };
    Some((
        namespace.to_string(),
        AntiCheatStatus {
            status: game.status.clone(),
            anticheats: game.anticheats.clone(),
            slug,
        },
    ))
}

fn find_epic_in(games: &[AwacyGame], namespace: &str) -> Option<AntiCheatStatus> {
    games.iter().find_map(|game| {
        let (epic, status) = game_epic_status(game)?;
        (epic == namespace).then_some(status)
    })
}

async fn fetch_games() -> Option<Vec<AwacyGame>> {
    let client = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("efxlve-launcher")
        .build()
        .ok()?;
    let response = client.get(SOURCE).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.json::<Vec<AwacyGame>>().await.ok()
}

async fn load_games(app: &AppHandle) -> Option<Vec<AwacyGame>> {
    let path = cache_path(app);
    let cached = read_cache(&path);
    if let Some(cache) = cached.as_ref() {
        if cache.schema == CACHE_SCHEMA && cache_is_fresh(cache.fetched_at, now_secs()) {
            return Some(cache.games.clone());
        }
    }

    if let Some(games) = fetch_games().await {
        write_cache(&path, &games);
        return Some(games);
    }

    cached
        .filter(|cache| cache.schema == CACHE_SCHEMA)
        .map(|cache| cache.games)
}

/// The cached Are We Anti-Cheat Yet? row for one Steam app. `None` means the
/// app is not in the list or the source could not be reached and no stale copy
/// exists; the page then leaves the row out.
#[tauri::command]
pub async fn steam_anticheat_status(app: AppHandle, app_id: String) -> Option<AntiCheatStatus> {
    if !valid_app_id(&app_id) {
        return None;
    }
    find_in(&load_games(&app).await?, &app_id)
}

/// The same row for an Epic catalog namespace (the app name Legendary uses).
#[tauri::command]
pub async fn epic_anticheat_status(app: AppHandle, namespace: String) -> Option<AntiCheatStatus> {
    let namespace = namespace.trim();
    if !valid_epic_namespace(namespace) {
        return None;
    }
    find_epic_in(&load_games(&app).await?, namespace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_steam_app_ids_are_accepted() {
        assert!(valid_app_id("976730"));
        assert!(!valid_app_id(""));
        assert!(!valid_app_id("../976730"));
        assert!(!valid_app_id("https://x"));
        assert!(!valid_app_id("1234567890123"));
    }

    #[test]
    fn the_cache_is_fresh_for_one_day() {
        let now = 1_700_000_000;
        assert!(cache_is_fresh(now, now));
        assert!(cache_is_fresh(now - CACHE_TTL_SECS + 1, now));
        assert!(!cache_is_fresh(now - CACHE_TTL_SECS, now));
    }

    #[test]
    fn epic_namespaces_are_safe_and_findable() {
        assert!(valid_epic_namespace("fn"));
        assert!(valid_epic_namespace("52f57f57120c440fad9bfa0e6c279317"));
        assert!(!valid_epic_namespace("../fn"));
        assert!(!valid_epic_namespace(""));
        let games: Vec<AwacyGame> = serde_json::from_str(
            r#"[{"status":"Denied","anticheats":["BattlEye"],"slug":"fortnite","storeIds":{"epic":{"namespace":"fn","slug":"fortnite"}}}]"#,
        )
        .expect("games");
        let found = find_epic_in(&games, "fn").expect("fortnite");
        assert_eq!(found.status, "Denied");
        assert_eq!(found.slug, "fortnite");
        assert!(find_epic_in(&games, "other").is_none());
    }

    #[test]
    fn the_steam_index_reads_string_and_number_ids() {
        let games: Vec<AwacyGame> = serde_json::from_str(
            r#"[
              {"name":"Halo","status":"Supported","anticheats":["Easy Anti-Cheat"],"slug":"halo","storeIds":{"steam":"976730"}},
              {"name":"Other","status":"Broken","anticheats":["BattlEye"],"storeIds":{"steam":12345}}
            ]"#,
        )
        .expect("games");
        let first = find_in(&games, "976730").expect("halo");
        assert_eq!(first.status, "Supported");
        assert_eq!(first.anticheats, vec!["Easy Anti-Cheat"]);
        assert_eq!(first.slug, "halo");
        assert_eq!(find_in(&games, "12345").expect("other").status, "Broken");
    }
}
