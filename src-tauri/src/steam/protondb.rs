//! ProtonDB's community compatibility tier for one Steam app.
//!
//! ProtonDB has no official API contract, but the public summary endpoint the
//! site itself uses is stable enough for a badge. The answer is cached per app
//! for a day; a network failure falls back to a stale cache instead of putting
//! an error on the game page. Only Steam app ids are accepted.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const CACHE_SCHEMA: u32 = 1;
const CACHE_TTL_SECS: u64 = 24 * 60 * 60;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtonDbSummary {
    pub tier: String,
    #[serde(default)]
    pub best_reported_tier: Option<String>,
    #[serde(default)]
    pub trending_tier: Option<String>,
    #[serde(default)]
    pub confidence: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub total: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct CacheFile {
    schema: u32,
    fetched_at: u64,
    /// `None` is a stored "ProtonDB has no page for this app", not a failure:
    /// the miss is answered from the disk like a hit and retried after the TTL.
    #[serde(default)]
    summary: Option<ProtonDbSummary>,
}

fn valid_app_id(app_id: &str) -> bool {
    !app_id.is_empty() && app_id.len() <= 12 && app_id.bytes().all(|byte| byte.is_ascii_digit())
}

fn cache_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("steam").join("protondb"))
}

fn cache_path(app: &AppHandle, app_id: &str) -> Option<PathBuf> {
    cache_dir(app).map(|dir| dir.join(format!("{app_id}.json")))
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

fn write_cache(path: &Path, summary: Option<&ProtonDbSummary>) {
    let Some(parent) = path.parent() else {
        return;
    };
    let _ = std::fs::create_dir_all(parent);
    let cache = CacheFile {
        schema: CACHE_SCHEMA,
        fetched_at: now_secs(),
        summary: summary.cloned(),
    };
    let Ok(text) = serde_json::to_string_pretty(&cache) else {
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

/// The ProtonDB answer and whether the site was reached: a miss is only stored
/// when it answered, so an offline page does not pin "no tier" for a day.
async fn fetch_summary(app_id: &str) -> (bool, Option<ProtonDbSummary>) {
    let Ok(client) = reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent("efxlve-launcher")
        .build()
    else {
        return (false, None);
    };
    let Ok(response) = client
        .get(format!(
            "https://www.protondb.com/api/v1/reports/summaries/{app_id}.json"
        ))
        .send()
        .await
    else {
        return (false, None);
    };
    if !response.status().is_success() {
        return (true, None);
    }
    let Ok(summary) = response.json::<ProtonDbSummary>().await else {
        return (false, None);
    };
    if summary.tier.trim().is_empty() {
        return (true, None);
    }
    (true, Some(summary))
}

/// The cached tier. `None` means ProtonDB has no answer (unknown app, offline
/// with no cache, or an endpoint change); the page then leaves the row out
/// rather than showing a failure.
///
/// A stored answer is always served at once. An entry older than a day is
/// refreshed behind the page, so a page open never waits on protondb.com.
#[tauri::command]
pub async fn steam_protondb_summary(
    app: AppHandle,
    app_id: String,
    offline: Option<bool>,
) -> Option<ProtonDbSummary> {
    if !valid_app_id(&app_id) {
        return None;
    }
    let offline = offline.unwrap_or(false);
    let path = cache_path(&app, &app_id);
    let cached = path
        .as_deref()
        .and_then(read_cache)
        .filter(|cache| cache.schema == CACHE_SCHEMA);
    if let Some(cache) = cached {
        if !offline && !cache_is_fresh(cache.fetched_at, now_secs()) {
            if let Some(path) = path.clone() {
                tauri::async_runtime::spawn(async move {
                    let (reached, summary) = fetch_summary(&app_id).await;
                    if reached {
                        write_cache(&path, summary.as_ref());
                    }
                });
            }
        }
        return cache.summary;
    }
    if offline {
        return None;
    }

    let (reached, summary) = fetch_summary(&app_id).await;
    if reached {
        if let Some(path) = path.as_deref() {
            write_cache(path, summary.as_ref());
        }
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_steam_app_ids_are_accepted() {
        assert!(valid_app_id("1091500"));
        assert!(valid_app_id("0"));
        assert!(!valid_app_id(""));
        assert!(!valid_app_id("http://x"));
        assert!(!valid_app_id("../12"));
        assert!(!valid_app_id("1234567890123"));
    }

    #[test]
    fn the_cache_is_fresh_for_one_day() {
        let now = 1_700_000_000;
        assert!(cache_is_fresh(now, now));
        assert!(cache_is_fresh(now - CACHE_TTL_SECS + 1, now));
        assert!(!cache_is_fresh(now - CACHE_TTL_SECS, now));
        assert!(cache_is_fresh(now + 10, now));
    }

    #[test]
    fn a_summary_reads_the_tiers_and_ignores_extra_fields() {
        let summary: ProtonDbSummary = serde_json::from_str(
            r#"{"tier":"gold","bestReportedTier":"platinum","trendingTier":"gold","confidence":"high","score":0.82,"total":420,"extra":"ignored"}"#,
        )
        .expect("summary");
        assert_eq!(summary.tier, "gold");
        assert_eq!(summary.best_reported_tier.as_deref(), Some("platinum"));
        assert_eq!(summary.total, Some(420));
    }
}
