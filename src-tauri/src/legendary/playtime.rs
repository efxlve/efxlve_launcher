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

pub fn playtime_file_path() -> PathBuf {
    super::skip::default_config_dir().join("playtime.json")
}

pub fn read_playtime_store(path: &Path) -> HashMap<String, PlaytimeRecord> {
    if let Ok(content) = std::fs::read_to_string(path) {
        if let Ok(store) = serde_json::from_str::<HashMap<String, PlaytimeRecord>>(&content) {
            return store;
        }
    }
    HashMap::new()
}

pub fn write_playtime_store(
    path: &Path,
    store: &HashMap<String, PlaytimeRecord>,
) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = serde_json::to_string_pretty(store).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

pub fn get_playtimes() -> HashMap<String, PlaytimeRecord> {
    read_playtime_store(&playtime_file_path())
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

/// Records a session that ended at `ended_at` (Unix seconds). Keeping the span
/// lets the profile split a midnight-crossing session across both days.
pub fn record_session_at(
    app_name: &str,
    session_seconds: u64,
    ended_at: u64,
) -> Result<PlaytimeRecord, String> {
    let path = playtime_file_path();
    let mut store = read_playtime_store(&path);
    let now_ts = ended_at.max(1);

    let rec = store.entry(app_name.to_string()).or_default();
    rec.total_seconds = rec.total_seconds.saturating_add(session_seconds);
    rec.session_count = rec.session_count.saturating_add(1);
    rec.last_played_timestamp = Some(now_ts);
    push_session(rec, now_ts.saturating_sub(session_seconds), session_seconds);

    // Simple UTC/ISO format
    let days = now_ts / 86400;
    let rem = now_ts % 86400;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let approx_year = 1970 + days / 365;
    let date_str = format!("{approx_year:04} ({hours:02}:{minutes:02} UTC)");
    rec.last_played = Some(date_str);

    let updated = rec.clone();
    write_playtime_store(&path, &store)?;
    Ok(updated)
}

pub fn set_game_playtime(
    app_name: &str,
    total_seconds: u64,
    last_played: Option<String>,
) -> Result<PlaytimeRecord, String> {
    let path = playtime_file_path();
    let mut store = read_playtime_store(&path);

    let rec = store.entry(app_name.to_string()).or_default();
    rec.total_seconds = total_seconds;
    if rec.session_count == 0 && total_seconds > 0 {
        rec.session_count = 1;
    } else if total_seconds == 0 {
        rec.session_count = 0;
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
    write_playtime_store(&path, &store)?;
    Ok(updated)
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
}
