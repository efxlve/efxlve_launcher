//! Valve's Steam Deck compatibility category for one Steam app.
//!
//! The store's own compatibility report is public and carries
//! `resolved_category`: 1 unsupported, 2 playable, 3 verified. The answer is
//! cached per app for a day; an unknown app or a network failure with no cache
//! leaves the row out of the game page.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const CACHE_SCHEMA: u32 = 2;
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeckStatus {
    /// 1 unsupported, 2 playable, 3 verified.
    pub category: u8,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    schema: u32,
    fetched_at: u64,
    /// `None` is a stored "Valve has not rated this app", answered from the disk
    /// like a hit instead of asking the store again on every open.
    #[serde(default)]
    category: Option<u8>,
}

#[derive(Deserialize)]
struct DeckResponse {
    #[serde(default)]
    success: u8,
    #[serde(default)]
    results: Option<DeckResults>,
}

#[derive(Deserialize)]
struct DeckResults {
    #[serde(default, rename = "resolved_category")]
    resolved_category: Option<u8>,
}

fn valid_app_id(app_id: &str) -> bool {
    !app_id.is_empty() && app_id.len() <= 12 && app_id.bytes().all(|byte| byte.is_ascii_digit())
}

fn cache_path(app: &AppHandle, app_id: &str) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam")
        .join("deck")
        .join(format!("{app_id}.json"))
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

fn valid_category(category: u8) -> bool {
    matches!(category, 1..=3)
}

fn read_cache(path: &Path) -> Option<CacheFile> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_cache(path: &Path, category: Option<u8>) {
    let Some(parent) = path.parent() else {
        return;
    };
    let _ = std::fs::create_dir_all(parent);
    let cache = CacheFile {
        schema: CACHE_SCHEMA,
        fetched_at: now_secs(),
        category,
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

fn parse_category(body: &[u8]) -> Option<u8> {
    let response: DeckResponse = serde_json::from_slice(body).ok()?;
    if response.success == 0 {
        return None;
    }
    response
        .results
        .and_then(|results| results.resolved_category)
        .filter(|category| valid_category(*category))
}

/// The report's category and whether Valve answered: a miss is only stored when
/// the store actually replied, so an offline page does not pin "unrated".
async fn fetch_category(app_id: &str) -> (bool, Option<u8>) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("efxlve-launcher")
        .build()
    else {
        return (false, None);
    };
    let Ok(response) = client
        .get("https://store.steampowered.com/saleaction/ajaxgetdeckappcompatibilityreport")
        .query(&[("nAppID", app_id)])
        .send()
        .await
    else {
        return (false, None);
    };
    if !response.status().is_success() {
        return (true, None);
    }
    let Ok(body) = response.bytes().await else {
        return (false, None);
    };
    (true, parse_category(&body))
}

/// Valve's Steam Deck category for one Steam app. `None` means the app has no
/// report or the source could not be reached and no stored copy exists.
///
/// A stored answer is served at once; an entry older than a day is refreshed
/// behind the page, so the row never holds the game page open.
#[tauri::command]
pub async fn steam_deck_status(
    app: AppHandle,
    app_id: String,
    offline: Option<bool>,
) -> Option<DeckStatus> {
    if !valid_app_id(&app_id) {
        return None;
    }
    let offline = offline.unwrap_or(false);
    let path = cache_path(&app, &app_id);
    let cached = read_cache(&path).filter(|cache| cache.schema == CACHE_SCHEMA);
    if let Some(cache) = cached {
        if !offline && !cache_is_fresh(cache.fetched_at, now_secs()) {
            let refresh = app.clone();
            let refresh_id = app_id.clone();
            tauri::async_runtime::spawn(async move {
                let (reached, category) = fetch_category(&refresh_id).await;
                if reached {
                    write_cache(&cache_path(&refresh, &refresh_id), category);
                }
            });
        }
        return cache
            .category
            .filter(|category| valid_category(*category))
            .map(|category| DeckStatus { category });
    }
    if offline {
        return None;
    }

    let (reached, category) = fetch_category(&app_id).await;
    if reached {
        write_cache(&path, category);
    }
    category
        .filter(|category| valid_category(*category))
        .map(|category| DeckStatus { category })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_steam_app_ids_are_accepted() {
        assert!(valid_app_id("1091500"));
        assert!(!valid_app_id(""));
        assert!(!valid_app_id("https://x"));
        assert!(!valid_app_id("../1091500"));
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
    fn the_report_categories_are_read_and_bounded() {
        assert_eq!(
            parse_category(br#"{"success":1,"results":{"resolved_category":3}}"#),
            Some(3)
        );
        assert_eq!(
            parse_category(br#"{"success":1,"results":{"resolved_category":1}}"#),
            Some(1)
        );
        assert_eq!(
            parse_category(br#"{"success":0,"results":{"resolved_category":3}}"#),
            None
        );
        assert_eq!(
            parse_category(br#"{"success":1,"results":{"resolved_category":9}}"#),
            None
        );
    }
}
