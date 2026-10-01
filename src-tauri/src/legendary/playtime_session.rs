//! Crash-safe playtime sessions.
//!
//! The game monitor lives in this process, so closing or restarting the
//! launcher (an update, a crash, the user quitting) used to lose the whole
//! session. A tiny marker with a heartbeat fixes that: the next start commits
//! the measured time before clearing it.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default)]
pub struct SessionMarker {
    pub app_name: String,
    pub started_at: u64,
    /// Refreshed while the game runs; the crash-safe end of the session.
    #[serde(default)]
    pub last_seen_at: u64,
}

/// A recovered session must be at least this long; anything shorter is a
/// mis-detected process rather than real playtime.
const MIN_RECOVERED_SECS: u64 = 60;
/// One commit never exceeds a day (a marker left behind for a week must not
/// turn into phantom hours).
const MAX_RECOVERED_SECS: u64 = 24 * 3600;

fn marker_path() -> PathBuf {
    super::skip::default_config_dir().join("playtime_session.json")
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read_at(path: &Path) -> Option<SessionMarker> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_at(path: &Path, marker: &SessionMarker) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(marker) {
        let _ = std::fs::write(path, text);
    }
}

/// Pure rule: seconds a stale marker may contribute (None = too short).
pub fn recovered_seconds(started_at: u64, last_seen_at: u64) -> Option<u64> {
    let seconds = last_seen_at.max(started_at).saturating_sub(started_at);
    if seconds < MIN_RECOVERED_SECS {
        None
    } else {
        Some(seconds.min(MAX_RECOVERED_SECS))
    }
}

/// Starts the marker once the game process is detected.
pub fn begin(app_name: &str) {
    let now = now_secs();
    write_at(
        &marker_path(),
        &SessionMarker {
            app_name: app_name.to_string(),
            started_at: now,
            last_seen_at: now,
        },
    );
}

/// Refreshes the heartbeat (the caller throttles the cadence).
pub fn heartbeat() {
    let path = marker_path();
    if let Some(mut marker) = read_at(&path) {
        marker.last_seen_at = now_secs();
        write_at(&path, &marker);
    }
}

/// Drops the marker after the live monitor recorded the session.
pub fn finish() {
    let _ = std::fs::remove_file(marker_path());
}

/// Testable core: reads and clears the marker, then hands the measured seconds
/// to the recorder. Clearing first means a crash between the steps can never
/// double count the same session later.
fn recover_with(path: &Path, record: &dyn Fn(&str, u64) -> bool) -> Option<(String, u64)> {
    let marker = read_at(path)?;
    let _ = std::fs::remove_file(path);
    let seconds = recovered_seconds(marker.started_at, marker.last_seen_at)?;
    let app_name = marker.app_name.trim().to_string();
    if app_name.is_empty() {
        return None;
    }
    if record(&app_name, seconds) {
        Some((app_name, seconds))
    } else {
        None
    }
}

/// Commits a leftover marker from a killed/restarted launcher. Returns the app
/// name and the seconds added.
pub fn recover_stale() -> Option<(String, u64)> {
    recover_with(&marker_path(), &|app, seconds| {
        super::playtime::record_session(app, seconds).is_ok()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_marker(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("efxlve_pt_session_{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir.join("playtime_session.json")
    }

    #[test]
    fn short_markers_are_ignored() {
        assert_eq!(recovered_seconds(1_000, 1_059), None);
        assert_eq!(recovered_seconds(1_000, 1_000), None);
    }

    #[test]
    fn normal_sessions_use_last_seen() {
        assert_eq!(recovered_seconds(1_000, 4_600), Some(3_600));
        // A missing heartbeat falls back to the start (no phantom time).
        assert_eq!(recovered_seconds(1_000, 0), None);
    }

    #[test]
    fn a_very_old_marker_is_capped() {
        assert_eq!(
            recovered_seconds(1_000, 1_000 + MAX_RECOVERED_SECS + 5_000),
            Some(MAX_RECOVERED_SECS)
        );
    }

    #[test]
    fn marker_round_trip_and_finish() {
        let path = temp_marker("roundtrip");
        write_at(
            &path,
            &SessionMarker {
                app_name: "Ginger".into(),
                started_at: 1_000,
                last_seen_at: 1_000,
            },
        );
        let marker = read_at(&path).expect("marker yazilmali");
        assert_eq!(marker.app_name, "Ginger");
        let _ = std::fs::remove_file(&path);
        assert!(read_at(&path).is_none());
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn recovery_commits_once_and_clears_the_marker() {
        let path = temp_marker("commit");
        write_at(
            &path,
            &SessionMarker {
                app_name: "Ginger".into(),
                started_at: 1_000,
                last_seen_at: 4_600,
            },
        );
        let calls = std::sync::Mutex::new(Vec::<(String, u64)>::new());
        let recorded = recover_with(&path, &|app, seconds| {
            calls.lock().unwrap().push((app.to_string(), seconds));
            true
        });
        assert_eq!(recorded, Some(("Ginger".to_string(), 3_600)));
        assert_eq!(
            calls.lock().unwrap().as_slice(),
            &[("Ginger".to_string(), 3_600)]
        );
        assert!(!path.exists(), "the marker must be gone after recovery");
        // A second recovery must not find anything.
        assert_eq!(recover_with(&path, &|_, _| true), None);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    #[test]
    fn short_or_failed_recovery_records_nothing() {
        let path = temp_marker("short");
        write_at(
            &path,
            &SessionMarker {
                app_name: "Ginger".into(),
                started_at: 1_000,
                last_seen_at: 1_010,
            },
        );
        let called = std::sync::atomic::AtomicBool::new(false);
        assert_eq!(
            recover_with(&path, &|_, _| {
                called.store(true, std::sync::atomic::Ordering::Relaxed);
                true
            }),
            None
        );
        assert!(
            !called.load(std::sync::atomic::Ordering::Relaxed),
            "a too-short marker must not reach the recorder"
        );
        assert!(!path.exists(), "even a rejected marker is cleared");
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }
}
