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
    /// The hours belong to one Epic account. Older files carry no id.
    #[serde(default)]
    account_id: String,
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

/// The account a cached snapshot belongs to. A file written before the id was
/// stored has none, so it is treated as stale rather than showing the previous
/// account's hours for up to the full TTL after a switch.
fn cache_belongs(cache: &PlaytimeCache, account_id: &str) -> bool {
    !account_id.is_empty() && cache.account_id == account_id
}

fn read_cache(path: &Path) -> Option<PlaytimeCache> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_cache(path: &Path, account_id: &str, playtimes: &HashMap<String, i64>, now: u64) {
    let cache = PlaytimeCache {
        fetched_at: now,
        account_id: account_id.to_string(),
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
        .and_then(|v| {
            v.get(key)
                .and_then(|x| x.as_str())
                .map(|s| s.trim().to_string())
        })
        .unwrap_or_default()
}

/// The signed-in launcher session that owns the playtime hours.
struct Session {
    token: String,
    account: String,
}

fn read_session() -> Result<Session, String> {
    let config = super::skip::default_config_dir();
    let raw = std::fs::read_to_string(config.join("user.json"))
        .map_err(|_| "@t:err.notAuthenticated".to_string())?;
    let token = user_value(&raw, "access_token");
    let account = user_value(&raw, "account_id");
    if token.is_empty() || account.is_empty() {
        return Err("@t:err.notAuthenticated".to_string());
    }
    Ok(Session { token, account })
}

async fn fetch_playtimes(session: &Session) -> Result<HashMap<String, i64>, String> {
    let token = session.token.as_str();
    let account = session.account.as_str();
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
/// session fails, the last snapshot of the same account is served instead of an
/// error.
#[tauri::command]
pub async fn epic_sync_epic_playtimes(force: Option<bool>) -> Result<HashMap<String, i64>, String> {
    let session = read_session()?;
    let path = cache_path();
    let now = now_secs();
    // Another account's hours are not this account's data, however fresh they are.
    let cached = read_cache(&path).filter(|cache| cache_belongs(cache, &session.account));
    if !force.unwrap_or(false) {
        if let Some(cache) = cached.as_ref() {
            if cache_fresh(cache.fetched_at, now) {
                return Ok(cache.playtimes.clone());
            }
        }
    }
    match fetch_playtimes(&session).await {
        Ok(map) => {
            write_cache(&path, &session.account, &map, now);
            Ok(map)
        }
        Err(err) => match cached {
            Some(cache) => Ok(cache.playtimes),
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

    /// After an account switch the previous account's hours must not be served,
    /// and a file written before the id was stored counts as stale.
    #[test]
    fn cache_is_bound_to_the_account_that_fetched_it() {
        let mine = PlaytimeCache {
            fetched_at: 1,
            account_id: "account_a".into(),
            playtimes: HashMap::from([("Ginger".to_string(), 5)]),
        };
        assert!(cache_belongs(&mine, "account_a"));
        assert!(!cache_belongs(&mine, "account_b"));
        assert!(!cache_belongs(&mine, ""));
        let legacy: PlaytimeCache = serde_json::from_str(r#"{"fetched_at":1,"playtimes":{}}"#).unwrap();
        assert!(!cache_belongs(&legacy, "account_a"));
    }

    /// Live smoke test (network + signed-in session). Run with:
    /// `cargo test epic_playtime_snapshot_is_readable -- --ignored --nocapture`
    #[test]
    #[ignore = "requires a signed-in Epic session and network"]
    fn epic_playtime_snapshot_is_readable() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let session = read_session().expect("signed-in session");
            let map = fetch_playtimes(&session).await.expect("live playtime fetch");
            assert!(
                !map.is_empty(),
                "a signed-in account should have playtime records"
            );
            assert!(map.values().any(|seconds| *seconds > 0));
        });
    }
}
