//! Server-side Epic playtime from the launcher library service.
//!
//! The catalog APIs do not expose playtime, but the library service that the
//! Epic Games Launcher itself uses answers our stored launcher OAuth token, so
//! hours played outside Efxlve are included. The snapshot is cached on disk
//! with a TTL; a failed refresh serves the last snapshot.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const PLAYTIME_URL: &str =
    "https://library-service.live.use1a.on.epicgames.com/library/api/public/playtime/account";
const CACHE_TTL_SECS: u64 = 6 * 3600;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
struct PlaytimeCache {
    fetched_at: u64,
    playtimes: HashMap<String, i64>,
}

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerRecord {
    #[serde(default)]
    artifact_id: String,
    #[serde(default)]
    total_time: i64,
}

/// Maps the raw server payload onto `appName -> seconds` (pure, testable).
/// Zero/empty entries are dropped; Unreal assets are filtered by the caller.
fn records_to_map(list: &[ServerRecord]) -> HashMap<String, i64> {
    let mut map = HashMap::new();
    for rec in list {
        if !rec.artifact_id.trim().is_empty() && rec.total_time > 0 {
            map.insert(rec.artifact_id.trim().to_string(), rec.total_time);
        }
    }
    map
}

/// Pure rule behind the cache read: only a snapshot younger than the TTL is
/// served without asking Epic again.
fn cache_fresh(fetched_at: u64, now: u64) -> bool {
    now.saturating_sub(fetched_at) < CACHE_TTL_SECS
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cache_path() -> PathBuf {
    super::skip::default_config_dir().join("epic_playtime.json")
}

fn read_cache(path: &Path) -> Option<PlaytimeCache> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_cache(path: &Path, playtimes: &HashMap<String, i64>, now: u64) {
    let cache = PlaytimeCache {
        fetched_at: now,
        playtimes: playtimes.clone(),
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(&cache) {
        let _ = std::fs::write(path, text);
    }
}

fn user_value(raw: &str, key: &str) -> String {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|v| v.get(key).and_then(|x| x.as_str()).map(|s| s.trim().to_string()))
        .unwrap_or_default()
}

async fn fetch_playtimes() -> Result<HashMap<String, i64>, String> {
    let config = super::skip::default_config_dir();
    let raw = std::fs::read_to_string(config.join("user.json"))
        .map_err(|_| "@t:err.notAuthenticated".to_string())?;
    let token = user_value(&raw, "access_token");
    let account = user_value(&raw, "account_id");
    if token.is_empty() || account.is_empty() {
        return Err("@t:err.notAuthenticated".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("EfxlveLauncher/0.1 (https://github.com/efxlve/efxlve_launcher)")
        .build()
        .map_err(|e| format!("@t:err.network\u{1f}{e}"))?;
    let resp = client
        .get(format!("{PLAYTIME_URL}/{account}/all"))
        .header("Authorization", format!("Bearer {token}"))
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("@t:err.network\u{1f}{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        return Err(if status.as_u16() == 401 {
            "@t:err.sessionExpired".to_string()
        } else {
            format!("@t:err.network\u{1f}{status}")
        });
    }
    let list: Vec<ServerRecord> = resp
        .json()
        .await
        .map_err(|e| format!("@t:err.parse\u{1f}{e}"))?;
    Ok(records_to_map(&list))
}

/// Epic's server-side playtime snapshot (`appName -> seconds`). Cached for
/// {@link CACHE_TTL_SECS}; `force` skips the cache. When the network or the
/// session fails, the last snapshot is served instead of an error.
#[tauri::command]
pub async fn epic_sync_epic_playtimes(force: Option<bool>) -> Result<HashMap<String, i64>, String> {
    let path = cache_path();
    let now = now_secs();
    if !force.unwrap_or(false) {
        if let Some(cached) = read_cache(&path) {
            if cache_fresh(cached.fetched_at, now) {
                return Ok(cached.playtimes);
            }
        }
    }
    match fetch_playtimes().await {
        Ok(map) => {
            write_cache(&path, &map, now);
            Ok(map)
        }
        Err(err) => match read_cache(&path) {
            Some(cached) => Ok(cached.playtimes),
            None => Err(err),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_camel_case_records_and_drops_empty_ones() {
        let list: Vec<ServerRecord> = serde_json::from_str(
            r#"[
                {"accountId":"a","artifactId":"Ginger","totalTime":350535},
                {"accountId":"a","artifactId":"","totalTime":10},
                {"accountId":"a","artifactId":"Zero","totalTime":0}
            ]"#,
        )
        .unwrap();
        let map = records_to_map(&list);
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("Ginger"), Some(&350535));
    }

    #[test]
    fn cache_is_served_only_while_fresh() {
        assert!(cache_fresh(1_000, 1_000 + CACHE_TTL_SECS - 1));
        assert!(!cache_fresh(1_000, 1_000 + CACHE_TTL_SECS));
        // A clock skew backwards keeps the snapshot rather than panicking.
        assert!(cache_fresh(2_000, 1_000));
    }

    #[test]
    fn reads_user_json_fields() {
        let raw = r#"{"access_token":"tok","account_id":"acc","displayName":"X"}"#;
        assert_eq!(user_value(raw, "access_token"), "tok");
        assert_eq!(user_value(raw, "account_id"), "acc");
        assert_eq!(user_value(raw, "missing"), "");
    }

    /// Live smoke test (network + signed-in session). Run with:
    /// `cargo test epic_playtime_snapshot_is_readable -- --ignored --nocapture`
    #[test]
    #[ignore = "requires a signed-in Epic session and network"]
    fn epic_playtime_snapshot_is_readable() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let map = fetch_playtimes().await.expect("live playtime fetch");
            assert!(!map.is_empty(), "a signed-in account should have playtime records");
            assert!(map.values().any(|seconds| *seconds > 0));
        });
    }
}
