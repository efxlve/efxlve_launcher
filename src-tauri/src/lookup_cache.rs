//! Disk cache for the game page's network lookups.
//!
//! Every source stores its answer on disk, including "nothing found", so a later
//! open paints without the network. The rule is the same everywhere: the stored
//! answer is served at once; only a missing entry waits for the network, and an
//! aged entry is refreshed behind the page.
//!
//! Each file carries the epoch second it was written next to a schema number, so
//! a changed answer shape is fetched again instead of being read half empty.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// How long a stored "nothing found" answer is trusted. A store can add the
/// game later, so a miss is retried once a month instead of never.
pub const MISS_TTL_SECS: u64 = 30 * 24 * 3600;

/// Seconds since the Unix epoch.
pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

#[derive(Serialize, Deserialize)]
struct Entry<T> {
    #[serde(default)]
    schema: u32,
    fetched_at: u64,
    value: T,
}

/// The stored answer for one lookup: the value and the moment it was written.
/// `None` when the file is missing, unreadable or from another schema.
pub fn read<T: DeserializeOwned>(path: &Path, schema: u32) -> Option<(T, u64)> {
    let text = std::fs::read_to_string(path).ok()?;
    let entry: Entry<T> = serde_json::from_str(&text).ok()?;
    (entry.schema == schema).then_some((entry.value, entry.fetched_at))
}

/// Stores one answer, stamped with the current time.
pub fn write<T: Serialize + ?Sized>(path: &Path, schema: u32, value: &T) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let entry = Entry {
        schema,
        fetched_at: now_secs(),
        value,
    };
    let Ok(text) = serde_json::to_string(&entry) else {
        return;
    };
    // A crash mid-write must not leave a truncated answer behind: the reader
    // would treat it as a miss and the page would wait again. The stamp keeps two
    // writers of the same answer apart.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_extension(format!("{stamp}.tmp"));
    if std::fs::write(&tmp, text).is_err() {
        return;
    }
    if std::fs::rename(&tmp, path).is_err() {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::rename(&tmp, path);
    }
}

/// True while a stored answer is younger than `ttl_secs`.
pub fn fresh(fetched_at: u64, ttl_secs: u64) -> bool {
    now_secs().saturating_sub(fetched_at) < ttl_secs
}

/// A lookup key that is safe as a file name on every platform.
pub fn file_key(raw: &str) -> String {
    raw.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{file_key, fresh, read, write};

    fn scratch(name: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join("efxlve-lookup-cache-test")
            .join(name)
            .join("answer.json")
    }

    #[test]
    fn an_answer_round_trips_with_its_timestamp() {
        let path = scratch("round-trip");
        let _ = std::fs::remove_file(&path);
        write(&path, 2, &vec!["one".to_string(), "two".to_string()]);
        let (value, fetched_at) = read::<Vec<String>>(&path, 2).expect("stored answer");
        assert_eq!(value, vec!["one", "two"]);
        assert!(fresh(fetched_at, 60), "a just-written answer is fresh");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_different_schema_is_a_miss() {
        let path = scratch("schema");
        let _ = std::fs::remove_file(&path);
        write(&path, 1, &"value");
        assert!(read::<String>(&path, 2).is_none());
        assert!(read::<String>(&path, 1).is_some());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn an_old_answer_is_stale_but_still_readable() {
        let path = scratch("age");
        let _ = std::fs::remove_file(&path);
        write(&path, 1, &42_i64);
        let (value, fetched_at) = read::<i64>(&path, 1).expect("stored answer");
        assert_eq!(value, 42);
        // The value stays readable a year later; only `fresh` asks for a refresh.
        let year_ago = fetched_at.saturating_sub(365 * 24 * 3600);
        assert!(!fresh(year_ago, 60));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn keys_drop_every_path_separator() {
        assert_eq!(file_key("steam::1091500"), "steam__1091500");
        assert_eq!(file_key("../../etc/passwd"), "______etc_passwd");
        assert_eq!(file_key("A B/C"), "A_B_C");
    }
}
