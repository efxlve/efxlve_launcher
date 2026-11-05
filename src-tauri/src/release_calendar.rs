//! Release calendar: full dates for library games, batched and cached.
//!
//! The library itself only carries a release year. This module asks IGDB for
//! the exact date of one year's games, reuses the search cache inside `igdb`,
//! and persists the answers in `<app_data>/release_calendar.json` so opening
//! the calendar twice costs no requests. A hit is trusted for a week; a miss is
//! retried after an hour, so an offline session does not pin an empty answer.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::igdb::{igdb_search, IgdbSearchHit};

const HIT_TTL_SECS: u64 = 7 * 24 * 60 * 60;
const MISS_TTL_SECS: u64 = 60 * 60;
const MAX_QUERIES: usize = 80;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseQuery {
    pub app_name: String,
    pub title: String,
    #[serde(default)]
    pub year: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseEntry {
    pub app_name: String,
    pub title: String,
    /// ISO `YYYY-MM-DD`, or absent when IGDB has no full date.
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default)]
    pub timestamp: Option<i64>,
    /// IGDB's own title, so the UI can show when the match is an edition.
    #[serde(default)]
    pub matched_name: String,
    /// Unix seconds, internal cache bookkeeping.
    #[serde(default)]
    pub fetched_at: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct CalendarCache {
    #[serde(default)]
    entries: HashMap<String, ReleaseEntry>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("release_calendar.json"))
}

fn read_cache(app: &AppHandle) -> CalendarCache {
    cache_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_cache(app: &AppHandle, cache: &CalendarCache) {
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

fn entry_is_fresh(entry: &ReleaseEntry, now: u64) -> bool {
    let ttl = if entry.date.is_some() {
        HIT_TTL_SECS
    } else {
        MISS_TTL_SECS
    };
    now.saturating_sub(entry.fetched_at) < ttl
}

#[tauri::command]
pub async fn epic_release_calendar(
    app: AppHandle,
    queries: Vec<ReleaseQuery>,
    refresh: Option<bool>,
) -> Vec<ReleaseEntry> {
    let refresh = refresh.unwrap_or(false);
    let now = now_secs();
    let mut cache = read_cache(&app);
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    for query in queries.into_iter().take(MAX_QUERIES) {
        let app_name = query.app_name.trim().to_string();
        if app_name.is_empty() || !seen.insert(app_name.clone()) {
            continue;
        }
        if !refresh {
            if let Some(entry) = cache.entries.get(&app_name) {
                if entry_is_fresh(entry, now) {
                    out.push(entry.clone());
                    continue;
                }
            }
        }

        let matched = igdb_search(app.clone(), query.title.clone(), Some(5))
            .await
            .ok()
            .and_then(|hits| {
                IgdbSearchHit::best_match(&hits, &query.title, query.year).cloned()
            });
        let entry = ReleaseEntry {
            app_name: app_name.clone(),
            title: query.title,
            date: matched
                .as_ref()
                .map(|hit| hit.release_date.trim().to_string())
                .filter(|date| !date.is_empty()),
            timestamp: matched.as_ref().and_then(|hit| hit.release_timestamp),
            matched_name: matched.map(|hit| hit.name).unwrap_or_default(),
            fetched_at: now,
        };
        cache.entries.insert(app_name, entry.clone());
        out.push(entry);
    }

    write_cache(&app, &cache);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_cache_round_trips_through_json() {
        let cache = CalendarCache::default();
        let text = serde_json::to_string(&cache).unwrap();
        let parsed: CalendarCache = serde_json::from_str(&text).unwrap();
        assert!(parsed.entries.is_empty());
    }

    #[test]
    fn a_hit_is_fresh_for_a_week_and_a_miss_for_an_hour() {
        let hit = ReleaseEntry {
            app_name: "steam::1".into(),
            title: "Example".into(),
            date: Some("2026-11-05".into()),
            timestamp: Some(1_791_000_000),
            matched_name: "Example".into(),
            fetched_at: 1_000,
        };
        assert!(entry_is_fresh(&hit, 1_000 + HIT_TTL_SECS - 1));
        assert!(!entry_is_fresh(&hit, 1_000 + HIT_TTL_SECS));
        let miss = ReleaseEntry {
            date: None,
            ..hit
        };
        assert!(entry_is_fresh(&miss, 1_000 + MISS_TTL_SECS - 1));
        assert!(!entry_is_fresh(&miss, 1_000 + MISS_TTL_SECS));
    }

    #[test]
    fn the_entry_serializes_for_the_frontend() {
        let entry = ReleaseEntry {
            app_name: "gog::1".into(),
            title: "Example".into(),
            date: Some("2026-11-05".into()),
            timestamp: Some(1_791_000_000),
            matched_name: "Example".into(),
            fetched_at: 1_000,
        };
        let value: serde_json::Value = serde_json::to_value(entry).unwrap();
        assert_eq!(value.get("appName").and_then(|v| v.as_str()), Some("gog::1"));
        assert_eq!(value.get("date").and_then(|v| v.as_str()), Some("2026-11-05"));
    }
}
