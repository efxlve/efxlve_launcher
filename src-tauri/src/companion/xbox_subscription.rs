//! The Xbox app's cached subscription list.
//!
//! The Xbox PC app keeps the signed-in account's subscriptions in its own
//! cache. It is the only local place that answers "is a Game Pass plan active
//! right now?" for the account whose title history the library shows. The
//! Store library cache lists purchased products, not the subscription itself.
//!
//! This is a hint, not a gate: a missing app, a locked database or an
//! unreadable row answers `None` (unknown), and the caller keeps the normal
//! install action. Only a readable cache with no active subscription turns a
//! Game Pass title into "Subscribe".

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const TTL: Duration = Duration::from_secs(5 * 60);
/// A subscription cache older than a month is not trusted: the player may have
/// resubscribed without opening the Xbox app since.
const MAX_AGE_MS: u64 = 30 * 24 * 60 * 60 * 1000;
const XBOX_PACKAGE: &str = "Microsoft.GamingApp_8wekyb3d8bbwe";

static CACHE: Mutex<Option<(Instant, Option<bool>)>> = Mutex::new(None);

/// `Some(true)` for an active plan, `Some(false)` for none, `None` when the
/// Xbox app cache did not answer.
pub(crate) fn active() -> Option<bool> {
    if let Ok(guard) = CACHE.lock() {
        if let Some((at, value)) = guard.as_ref() {
            if at.elapsed() < TTL {
                return *value;
            }
        }
    }
    let fresh = read_active();
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some((Instant::now(), fresh));
    }
    fresh
}

fn read_active() -> Option<bool> {
    let path = cache_path()?;
    let conn = rusqlite::Connection::open_with_flags(
        &path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let fetched: String = conn
        .query_row(
            "select value from AsyncCache where scope = 'user_subscriptions' and key = 'lastFetchedMS'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    let fetched: u64 = fetched.trim().parse().ok()?;
    if !recent_enough(fetched, now_ms()) {
        return None;
    }
    let text = conn
        .query_row(
            "select value from AsyncCache where scope = 'user_subscriptions' and key = 'subscriptions'",
            [],
            |row| row.get::<_, String>(0),
        )
        .ok()?;
    active_from_json(&text)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

fn recent_enough(fetched_ms: u64, now_ms: u64) -> bool {
    now_ms.saturating_sub(fetched_ms) <= MAX_AGE_MS
}

fn cache_path() -> Option<PathBuf> {
    let root = std::env::var_os("LOCALAPPDATA")?;
    let path = PathBuf::from(root)
        .join("Packages")
        .join(XBOX_PACKAGE)
        .join("LocalState")
        .join("AsyncCache.db");
    path.is_file().then_some(path)
}

/// The app stores `{"<account>": {}}` with no plan and a populated object while
/// a subscription is active. An empty cache object cannot answer either way.
pub(crate) fn active_from_json(text: &str) -> Option<bool> {
    let value: serde_json::Value = serde_json::from_str(text).ok()?;
    let accounts = value.as_object()?;
    if accounts.is_empty() {
        return None;
    }
    Some(accounts.values().any(|entry| match entry {
        serde_json::Value::Object(map) => !map.is_empty(),
        serde_json::Value::Array(items) => !items.is_empty(),
        serde_json::Value::Null => false,
        serde_json::Value::Bool(value) => *value,
        serde_json::Value::Number(_) | serde_json::Value::String(_) => true,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_account_entry_means_no_plan() {
        assert_eq!(active_from_json(r#"{"00034001200E6DA3":{}}"#), Some(false));
    }

    #[test]
    fn a_populated_account_entry_means_a_plan() {
        assert_eq!(
            active_from_json(r#"{"00034001200E6DA3":{"CFQ7TTC0KGQ8":{"status":"Active"}}}"#),
            Some(true)
        );
        assert_eq!(
            active_from_json(r#"{"00034001200E6DA3":["CFQ7TTC0KGQ8"]}"#),
            Some(true)
        );
    }

    #[test]
    fn an_empty_or_broken_cache_is_unknown() {
        assert_eq!(active_from_json("{}"), None);
        assert_eq!(active_from_json("not json"), None);
        assert_eq!(active_from_json(r#"{"account":null}"#), Some(false));
    }

    #[test]
    fn a_month_old_subscription_cache_is_unknown() {
        let now = 1_800_000_000_000u64;
        assert!(recent_enough(now - 20 * 24 * 60 * 60 * 1000, now));
        assert!(!recent_enough(now - 40 * 24 * 60 * 60 * 1000, now));
        // A clock that moved backwards must not disable the hint.
        assert!(recent_enough(now + 60_000, now));
    }
}
