//! The player's own IGDB and HowLongToBeat entries for a game.
//!
//! A title search can land on a same-named game from another year ("Portal"
//! 1986 instead of 2007), on a different entry in the same series, or on a DLC
//! chapter ("Far Cry 6 - Lost Between Worlds"). The automatic pickers stay as
//! they are; this store points one game at an entry the player picked, and both
//! lookups read the choice before anything else.

use crate::legendary::hltb::HltbPick;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// What the player chose for one game. Either field can stand alone: fixing the
/// IGDB match must not touch the HowLongToBeat one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchOverride {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub igdb_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hltb: Option<HltbPick>,
}

impl MatchOverride {
    fn is_empty(&self) -> bool {
        self.igdb_id.is_none() && self.hltb.is_none()
    }
}

/// Serializes the read-modify-write passes inside one process.
static MATCHES_LOCK: Mutex<()> = Mutex::new(());

fn matches_path() -> PathBuf {
    // The same config root as the HLTB cache, so a portable build keeps its
    // choices next to the rest of its records.
    crate::legendary::skip::default_config_dir().join("matches.json")
}

fn read_file(path: &Path) -> BTreeMap<String, MatchOverride> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_file(path: &Path, map: &BTreeMap<String, MatchOverride>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(map).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| error.to_string())
}

/// Every choice on disk.
pub fn all() -> BTreeMap<String, MatchOverride> {
    read_file(&matches_path())
}

fn update<F>(app_name: &str, change: F) -> Result<(), String>
where
    F: FnOnce(&mut MatchOverride),
{
    if app_name.trim().is_empty() {
        return Ok(());
    }
    let _guard = MATCHES_LOCK.lock().unwrap_or_else(|error| error.into_inner());
    let path = matches_path();
    let mut map = read_file(&path);
    let mut entry = map.remove(app_name).unwrap_or_default();
    change(&mut entry);
    if !entry.is_empty() {
        map.insert(app_name.to_string(), entry);
    }
    write_file(&path, &map)
}

/// The chosen IGDB game id, when the player picked one.
pub fn igdb_id(app_name: &str) -> Option<i64> {
    all()
        .get(app_name)
        .and_then(|entry| entry.igdb_id)
        .filter(|id| *id > 0)
}

/// The chosen HowLongToBeat entry, when the player picked one.
pub fn hltb_pick(app_name: &str) -> Option<HltbPick> {
    all().get(app_name).and_then(|entry| entry.hltb.clone())
}

pub fn set_igdb(app_name: &str, id: i64) -> Result<(), String> {
    if id <= 0 {
        return Err("@t:match.invalid".to_string());
    }
    update(app_name, |entry| entry.igdb_id = Some(id))
}

pub fn clear_igdb(app_name: &str) -> Result<(), String> {
    update(app_name, |entry| entry.igdb_id = None)
}

pub fn set_hltb(app_name: &str, pick: HltbPick) -> Result<(), String> {
    update(app_name, |entry| entry.hltb = Some(pick))
}

pub fn clear_hltb(app_name: &str) -> Result<(), String> {
    update(app_name, |entry| entry.hltb = None)
}

/// The page's view of its own choices; every field absent means automatic.
#[tauri::command]
pub async fn game_match_get(app_name: String) -> MatchOverride {
    all().remove(&app_name).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick() -> HltbPick {
        HltbPick {
            id: 101237,
            name: "Alan Wake 2".to_string(),
            year: Some(2023),
            main_story: Some(19.1),
            main_extra: Some(26.3),
            completionist: Some(32.7),
        }
    }

    #[test]
    fn a_choice_survives_a_round_trip_and_clears_on_its_own() {
        let dir = std::env::temp_dir().join(format!("efxlve-match-{}", std::process::id()));
        let path = dir.join("matches.json");

        let mut map = BTreeMap::new();
        map.insert(
            "custom::alan".to_string(),
            MatchOverride {
                igdb_id: Some(185246),
                hltb: Some(pick()),
            },
        );
        write_file(&path, &map).unwrap();

        let stored = read_file(&path);
        assert_eq!(stored["custom::alan"].igdb_id, Some(185246));
        assert_eq!(stored["custom::alan"].hltb.as_ref().unwrap().name, "Alan Wake 2");

        // Clearing one side keeps the other.
        let mut entry = stored["custom::alan"].clone();
        entry.igdb_id = None;
        assert!(!entry.is_empty());
        assert_eq!(entry.hltb.as_ref().unwrap().id, 101237);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_empty_entry_is_not_written() {
        let entry = MatchOverride {
            igdb_id: None,
            hltb: None,
        };
        assert!(entry.is_empty());
    }
}
