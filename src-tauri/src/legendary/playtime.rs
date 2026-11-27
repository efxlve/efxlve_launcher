//! Playtime tracking and live game status management.
//!
//! Records are stored in `%USERPROFILE%\.config\legendary\playtime.json`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaySession {
    /// Unix seconds when the session started. The end is `started_at + seconds`.
    pub started_at: u64,
    pub seconds: u64,
}

/// Sessions kept per game. A recap only needs recent months, and this keeps a
/// heavily played title from turning `playtime.json` into a large file. The
/// all-time total and session count are separate and stay complete.
pub const MAX_SESSIONS_PER_GAME: usize = 2000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlaytimeRecord {
    pub total_seconds: u64,
    pub session_count: u32,
    #[serde(default)]
    pub last_played_timestamp: Option<u64>,
    #[serde(default)]
    pub last_played: Option<String>,
    /// Recent sessions, oldest first. Older records load with an empty list.
    #[serde(default)]
    pub sessions: Vec<PlaySession>,
}

impl Default for PlaytimeRecord {
    fn default() -> Self {
        Self {
            total_seconds: 0,
            session_count: 0,
            last_played_timestamp: None,
            last_played: None,
            sessions: Vec::new(),
        }
    }
}

const PLAYTIME_FILE_VERSION: u32 = 2;

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
struct PlaytimeFile {
    #[serde(default)]
    version: u32,
    /// Epic playtimes scoped by `account_id -> (app_name -> PlaytimeRecord)`.
    #[serde(default)]
    accounts: HashMap<String, HashMap<String, PlaytimeRecord>>,
    /// Store-prefixed (`gog::`, `custom::`, `amazon::`, etc.) playtimes.
    #[serde(default)]
    shared: HashMap<String, PlaytimeRecord>,
}

fn is_epic_key(app_name: &str) -> bool {
    !app_name.contains("::")
}

pub(crate) fn active_epic_account_id(config_dir: &Path) -> Option<String> {
    super::accounts::read_active_user(config_dir)
        .map(|(id, _)| id)
        .or_else(|| super::cache::read_user(config_dir).and_then(|(_, id)| id))
        .map(|id| id.trim().to_string())
        .filter(|id| crate::vault_id::is_vault_id(id))
}

pub fn playtime_file_path() -> PathBuf {
    super::skip::default_config_dir().join("playtime.json")
}

fn read_playtime_file(path: &Path) -> PlaytimeFile {
    let Ok(content) = std::fs::read_to_string(path) else {
        return PlaytimeFile {
            version: PLAYTIME_FILE_VERSION,
            ..Default::default()
        };
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) else {
        return PlaytimeFile {
            version: PLAYTIME_FILE_VERSION,
            ..Default::default()
        };
    };
    if value.get("version").and_then(|v| v.as_u64()) == Some(PLAYTIME_FILE_VERSION as u64)
        || value.get("accounts").is_some()
    {
        if let Ok(mut file) = serde_json::from_value::<PlaytimeFile>(value) {
            file.version = PLAYTIME_FILE_VERSION;
            file.accounts
                .retain(|id, _| crate::vault_id::is_vault_id(id));
            return file;
        }
        return PlaytimeFile {
            version: PLAYTIME_FILE_VERSION,
            ..Default::default()
        };
    }

    // Legacy flat map (no `account_id` envelope): Epic entries have no owner
    // and must be treated as stale rather than attributed to whichever Epic
    // account happens to be signed in now. Non-Epic `store::id` keys stay in
    // `shared` because they are independent of Epic accounts.
    let mut shared = HashMap::new();
    if let Ok(legacy) = serde_json::from_value::<HashMap<String, PlaytimeRecord>>(value) {
        for (key, record) in legacy {
            if !is_epic_key(&key) {
                shared.insert(key, record);
            }
        }
    }
    PlaytimeFile {
        version: PLAYTIME_FILE_VERSION,
        accounts: HashMap::new(),
        shared,
    }
}

fn write_playtime_file(path: &Path, file: &PlaytimeFile) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut stamped = file.clone();
    stamped.version = PLAYTIME_FILE_VERSION;
    let json = serde_json::to_string_pretty(&stamped).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn read_playtime_store_for(
    path: &Path,
    account_id: Option<&str>,
) -> HashMap<String, PlaytimeRecord> {
    let mut file = read_playtime_file(path);
    let mut out = file.shared;
    if let Some(id) = account_id.filter(|id| crate::vault_id::is_vault_id(id)) {
        if let Some(epic_records) = file.accounts.remove(id) {
            for (app, record) in epic_records {
                out.insert(app, record);
            }
        }
    }
    out
}

pub fn get_playtimes_in(config_dir: &Path) -> HashMap<String, PlaytimeRecord> {
    let account_id = active_epic_account_id(config_dir);
    read_playtime_store_for(&config_dir.join("playtime.json"), account_id.as_deref())
}

pub fn get_playtimes() -> HashMap<String, PlaytimeRecord> {
    get_playtimes_in(&super::skip::default_config_dir())
}

#[allow(dead_code)]
pub fn get_game_playtime(app_name: &str) -> PlaytimeRecord {
    let store = get_playtimes();
    store.get(app_name).cloned().unwrap_or_default()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Appends one session span and drops the oldest entries over the cap.
fn push_session(rec: &mut PlaytimeRecord, started_at: u64, seconds: u64) {
    if seconds == 0 {
        return;
    }
    rec.sessions.push(PlaySession {
        started_at,
        seconds,
    });
    let excess = rec.sessions.len().saturating_sub(MAX_SESSIONS_PER_GAME);
    if excess > 0 {
        rec.sessions.drain(0..excess);
    }
}

pub fn record_session(app_name: &str, session_seconds: u64) -> Result<PlaytimeRecord, String> {
    record_session_at(app_name, session_seconds, now_secs())
}

pub fn record_session_for_account(
    path: &Path,
    account_id: Option<&str>,
    app_name: &str,
    session_seconds: u64,
    ended_at: u64,
) -> Result<PlaytimeRecord, String> {
    let mut file = read_playtime_file(path);
    let store = if is_epic_key(app_name) {
        let Some(id) = account_id.filter(|id| crate::vault_id::is_vault_id(id)) else {
            return Err("@t:err.notAuthenticated".to_string());
        };
        file.accounts.entry(id.to_string()).or_default()
    } else {
        &mut file.shared
    };
    let now_ts = ended_at.max(1);

    let rec = store.entry(app_name.to_string()).or_default();
    rec.total_seconds = rec.total_seconds.saturating_add(session_seconds);
    rec.session_count = rec.session_count.saturating_add(1);
    rec.last_played_timestamp = Some(now_ts);
    push_session(rec, now_ts.saturating_sub(session_seconds), session_seconds);

    // Real calendar date: `1970 + days / 365` dropped the month and day and put
    // late-December sessions into the next year.
    let at = std::time::UNIX_EPOCH + std::time::Duration::from_secs(now_ts);
    let stamp = crate::clock::stamp(at);
    rec.last_played = Some(format!("{} UTC", &stamp[..16]));

    let updated = rec.clone();
    write_playtime_file(path, &file)?;
    Ok(updated)
}

/// Records a session that ended at `ended_at` (Unix seconds). Keeping the span
/// lets the profile split a midnight-crossing session across both days.
pub fn record_session_at(
    app_name: &str,
    session_seconds: u64,
    ended_at: u64,
) -> Result<PlaytimeRecord, String> {
    let config = super::skip::default_config_dir();
    let account_id = active_epic_account_id(&config);
    record_session_for_account(
        &config.join("playtime.json"),
        account_id.as_deref(),
        app_name,
        session_seconds,
        ended_at,
    )
}

pub fn set_game_playtime_for_account(
    path: &Path,
    account_id: Option<&str>,
    app_name: &str,
    total_seconds: u64,
    last_played: Option<String>,
) -> Result<PlaytimeRecord, String> {
    let mut file = read_playtime_file(path);
    let store = if is_epic_key(app_name) {
        let Some(id) = account_id.filter(|id| crate::vault_id::is_vault_id(id)) else {
            return Err("@t:err.notAuthenticated".to_string());
        };
        file.accounts.entry(id.to_string()).or_default()
    } else {
        &mut file.shared
    };

    let rec = store.entry(app_name.to_string()).or_default();
    rec.total_seconds = total_seconds;
    if rec.session_count == 0 && total_seconds > 0 {
        rec.session_count = 1;
    } else if total_seconds == 0 {
        rec.session_count = 0;
        // Clearing the total also clears the daily history; otherwise the
        // activity chart would keep showing time the user just removed.
        rec.sessions.clear();
    }

    match last_played {
        Some(lp) => {
            let trimmed = lp.trim();
            if trimmed.is_empty() || trimmed == "none" || trimmed == "Belirtilmemiş" {
                rec.last_played = None;
                rec.last_played_timestamp = None;
            } else {
                rec.last_played = Some(trimmed.to_string());
            }
        }
        None => {
            rec.last_played = None;
            rec.last_played_timestamp = None;
        }
    }

    let updated = rec.clone();
    write_playtime_file(path, &file)?;
    Ok(updated)
}

pub fn set_game_playtime(
    app_name: &str,
    total_seconds: u64,
    last_played: Option<String>,
) -> Result<PlaytimeRecord, String> {
    let config = super::skip::default_config_dir();
    let account_id = active_epic_account_id(&config);
    set_game_playtime_for_account(
        &config.join("playtime.json"),
        account_id.as_deref(),
        app_name,
        total_seconds,
        last_played,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_record_session_in_memory() {
        let mut store: HashMap<String, PlaytimeRecord> = HashMap::new();
        let app = "test_game";
        let rec = store.entry(app.to_string()).or_default();
        rec.total_seconds += 120;
        rec.session_count += 1;

        assert_eq!(rec.total_seconds, 120);
        assert_eq!(rec.session_count, 1);

        rec.total_seconds += 3600;
        rec.session_count += 1;
        assert_eq!(rec.total_seconds, 3720);
        assert_eq!(rec.session_count, 2);
    }

    #[test]
    fn test_set_playtime_logic() {
        let mut store: HashMap<String, PlaytimeRecord> = HashMap::new();
        let app = "custom_game";
        let rec = store.entry(app.to_string()).or_default();
        rec.total_seconds = 7200;
        rec.session_count = 1;
        rec.last_played = Some("15 Eyl 2026".to_string());

        assert_eq!(rec.total_seconds, 7200);
        assert_eq!(rec.session_count, 1);
        assert_eq!(rec.last_played.as_deref(), Some("15 Eyl 2026"));

        // Update with new values
        rec.total_seconds = 14400;
        assert_eq!(rec.total_seconds, 14400);

        // Test clearing last_played
        rec.last_played = None;
        assert_eq!(rec.last_played, None);
    }

    #[test]
    fn old_records_load_without_sessions() {
        let record: PlaytimeRecord = serde_json::from_str(
            r#"{"total_seconds":3600,"session_count":2,"last_played":"2026"}"#,
        )
        .expect("an older record must still parse");
        assert_eq!(record.total_seconds, 3600);
        assert!(record.sessions.is_empty());
    }

    #[test]
    fn sessions_keep_the_newest_and_drop_the_oldest() {
        let mut rec = PlaytimeRecord::default();
        for index in 0..(MAX_SESSIONS_PER_GAME + 5) {
            push_session(&mut rec, index as u64, 60);
        }
        assert_eq!(rec.sessions.len(), MAX_SESSIONS_PER_GAME);
        assert_eq!(rec.sessions.first().map(|s| s.started_at), Some(5));
        assert_eq!(
            rec.sessions.last().map(|s| s.started_at),
            Some((MAX_SESSIONS_PER_GAME + 4) as u64)
        );
    }

    #[test]
    fn a_zero_length_session_is_not_stored() {
        let mut rec = PlaytimeRecord::default();
        push_session(&mut rec, 1_000, 0);
        assert!(rec.sessions.is_empty());
    }

    #[test]
    fn epic_playtimes_stay_isolated_per_account_while_shared_stores_persist() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_playtime_accounts_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let pt_path = root.join("playtime.json");

        // Account A records 3600s on Ginger and 900s on a custom game.
        std::fs::write(
            root.join("user.json"),
            r#"{"account_id":"account_a","displayName":"Alice"}"#,
        )
        .unwrap();
        record_session_for_account(&pt_path, Some("account_a"), "Ginger", 3_600, 1_700_003_600)
            .unwrap();
        record_session_for_account(&pt_path, Some("account_a"), "custom::1", 900, 1_700_004_500)
            .unwrap();

        let view_a = get_playtimes_in(&root);
        assert_eq!(view_a.get("Ginger").map(|r| r.total_seconds), Some(3_600));
        assert_eq!(view_a.get("custom::1").map(|r| r.total_seconds), Some(900));

        // Switch to Account B: Ginger is absent, custom::1 remains, and B records 600s on Ginger.
        std::fs::write(
            root.join("user.json"),
            r#"{"account_id":"account_b","displayName":"Bob"}"#,
        )
        .unwrap();
        let view_b_initial = get_playtimes_in(&root);
        assert!(!view_b_initial.contains_key("Ginger"));
        assert_eq!(
            view_b_initial.get("custom::1").map(|r| r.total_seconds),
            Some(900)
        );

        record_session_for_account(&pt_path, Some("account_b"), "Ginger", 600, 1_700_010_000)
            .unwrap();
        let view_b_after = get_playtimes_in(&root);
        assert_eq!(
            view_b_after.get("Ginger").map(|r| r.total_seconds),
            Some(600)
        );

        // Switch back to Account A: Alice's 3600s on Ginger was not overwritten by Bob.
        std::fs::write(
            root.join("user.json"),
            r#"{"account_id":"account_a","displayName":"Alice"}"#,
        )
        .unwrap();
        let view_a_again = get_playtimes_in(&root);
        assert_eq!(
            view_a_again.get("Ginger").map(|r| r.total_seconds),
            Some(3_600)
        );

        // Signed out: Epic hours are hidden while shared non-Epic hours remain.
        std::fs::remove_file(root.join("user.json")).unwrap();
        let signed_out = get_playtimes_in(&root);
        assert!(!signed_out.contains_key("Ginger"));
        assert_eq!(
            signed_out.get("custom::1").map(|r| r.total_seconds),
            Some(900)
        );

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn legacy_unbound_playtime_file_treats_epic_entries_as_stale_and_keeps_shared_keys() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_playtime_legacy_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("playtime.json"),
            r#"{
                "Ginger": {"total_seconds": 7200, "session_count": 3},
                "gog::1234": {"total_seconds": 1800, "session_count": 1}
            }"#,
        )
        .unwrap();
        std::fs::write(
            root.join("user.json"),
            r#"{"account_id":"account_b","displayName":"Bob"}"#,
        )
        .unwrap();

        let view = get_playtimes_in(&root);
        assert!(
            !view.contains_key("Ginger"),
            "legacy Epic playtime without account_id must not leak into the active account"
        );
        assert_eq!(view.get("gog::1234").map(|r| r.total_seconds), Some(1_800));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn portable_migration_and_profile_archive_preserve_scoped_playtimes() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_playtime_portable_profile_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let legacy_cfg = root.join("legacy_cfg");
        let portable_cfg = root.join("portable_cfg");
        let appdata = root.join("appdata");
        std::fs::create_dir_all(&legacy_cfg).unwrap();
        std::fs::create_dir_all(&portable_cfg).unwrap();
        std::fs::create_dir_all(&appdata).unwrap();

        std::fs::write(
            legacy_cfg.join("user.json"),
            r#"{"account_id":"account_a","displayName":"Alice"}"#,
        )
        .unwrap();
        record_session_for_account(
            &legacy_cfg.join("playtime.json"),
            Some("account_a"),
            "Ginger",
            2_400,
            1_700_002_400,
        )
        .unwrap();
        set_game_playtime_for_account(
            &legacy_cfg.join("playtime.json"),
            Some("account_b"),
            "Ginger",
            600,
            None,
        )
        .unwrap();

        assert!(crate::portable::migrate_legendary_config(
            &legacy_cfg,
            &portable_cfg
        ));
        assert_eq!(
            read_playtime_store_for(&portable_cfg.join("playtime.json"), Some("account_a"))
                .get("Ginger")
                .map(|r| r.total_seconds),
            Some(2_400)
        );
        assert_eq!(
            read_playtime_store_for(&portable_cfg.join("playtime.json"), Some("account_b"))
                .get("Ginger")
                .map(|r| r.total_seconds),
            Some(600)
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
