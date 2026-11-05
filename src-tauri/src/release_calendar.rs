//! Upcoming PC release calendar backed by IGDB.
//!
//! One paged request covers the next 400 days and the answer is cached for six
//! hours. IGDB's human date decides the precision: only a full date becomes a
//! day in the calendar, a month stays in its month, and a quarter or a year goes
//! to the "date not confirmed" list. No day is ever invented.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::igdb::{igdb_upcoming_releases, IgdbUpcomingRelease};

const CACHE_TTL_SECS: u64 = 6 * 60 * 60;
const WINDOW_DAYS: i64 = 400;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpcomingCache {
    #[serde(default)]
    fetched_at: u64,
    #[serde(default)]
    releases: Vec<IgdbUpcomingRelease>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// The schedule starts at midnight UTC, so a game releasing today is included
/// even when the launcher opens after its storefront midnight.
fn day_start(now: u64) -> i64 {
    (now - now % 86_400) as i64
}

fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("upcoming_releases.json"))
}

fn read_cache(app: &AppHandle) -> UpcomingCache {
    cache_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_cache(app: &AppHandle, cache: &UpcomingCache) {
    let Some(path) = cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(cache) {
        let _ = std::fs::write(path, text);
    }
}

fn cache_is_fresh(cache: &UpcomingCache, now: u64) -> bool {
    !cache.releases.is_empty() && now.saturating_sub(cache.fetched_at) < CACHE_TTL_SECS
}

/// Upcoming PC releases for the calendar. `refresh` bypasses the six-hour cache;
/// a failed network request still serves the last good answer.
#[tauri::command]
pub async fn epic_upcoming_releases(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<Vec<IgdbUpcomingRelease>, String> {
    let refresh = refresh.unwrap_or(false);
    let now = now_secs();
    let mut cache = read_cache(&app);
    if !refresh && cache_is_fresh(&cache, now) {
        return Ok(cache.releases);
    }

    let from = day_start(now);
    let to = from + WINDOW_DAYS * 86_400;
    match igdb_upcoming_releases(&app, from, to).await {
        Ok(releases) => {
            if !releases.is_empty() {
                cache.fetched_at = now;
                cache.releases = releases.clone();
                write_cache(&app, &cache);
            }
            Ok(releases)
        }
        Err(error) => {
            // Offline must not empty a calendar that already had an answer.
            if cache.releases.is_empty() {
                Err(error)
            } else {
                Ok(cache.releases)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_release() -> IgdbUpcomingRelease {
        IgdbUpcomingRelease {
            id: 1,
            name: "Example".into(),
            cover_id: "abc".into(),
            url: "https://www.igdb.com/games/example".into(),
            slug: "example".into(),
            hypes: 12,
            human: "Jan 28, 2027".into(),
            artwork_id: String::new(),
            precision: "day".into(),
            year: Some(2027),
            month: Some(1),
            day: Some(28),
            date: Some("2027-01-28".into()),
            timestamp: Some(1_800_000_000),
            stores: Vec::new(),
        }
    }

    #[test]
    fn a_fresh_cache_is_served_for_six_hours() {
        let cache = UpcomingCache {
            fetched_at: 1_000,
            releases: vec![sample_release()],
        };
        assert!(cache_is_fresh(&cache, 1_000 + CACHE_TTL_SECS - 1));
        assert!(!cache_is_fresh(&cache, 1_000 + CACHE_TTL_SECS));
    }

    #[test]
    fn an_empty_cache_is_never_fresh() {
        let cache = UpcomingCache {
            fetched_at: 1_000,
            releases: Vec::new(),
        };
        assert!(!cache_is_fresh(&cache, 1_001));
    }

    #[test]
    fn the_window_starts_at_midnight_utc() {
        assert_eq!(day_start(86_400 * 20_000 + 12_345), 86_400 * 20_000);
        assert_eq!(day_start(86_400), 86_400);
    }

    #[test]
    fn the_cache_round_trips_and_uses_camel_case() {
        let cache = UpcomingCache {
            fetched_at: 1_000,
            releases: vec![sample_release()],
        };
        let text = serde_json::to_string(&cache).unwrap();
        let parsed: UpcomingCache = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.releases.len(), 1);
        let value: serde_json::Value = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            value.pointer("/releases/0/coverId").and_then(|v| v.as_str()),
            Some("abc")
        );
    }
}
