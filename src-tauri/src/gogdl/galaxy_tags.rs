//! GOG Galaxy tag (collection) import (read-only).
//!
//! Galaxy stores user tags in the same local SQLite database as playtime
//! (`UserReleaseTags`). Tags are cross-platform: a row points at a release key
//! such as `gog_1207658924_GameOfTheYear` or `steam_500`, so every row is
//! mapped back to the launcher's composite key (`gog::1207658924`,
//! `steam::500`, `epic::<appName>` through the metadata cache).
//!
//! Galaxy's own "hidden" marker is a tag in older clients (named in the client
//! language) and a `UserReleaseProperties.isHidden` flag in newer ones; the tag
//! is skipped so it never comes over as a collection.
//!
//! Everything is best effort: a missing or locked database returns no rows.

use std::collections::{BTreeMap, HashMap};

use rusqlite::{Connection, OpenFlags};

use crate::legendary::collections::{
    build_metadata_lookup, chrono_now_iso, generate_collection_id, merge_collections,
    CollectionImport, GameCollection,
};

/// Localized names Galaxy gives its own "hidden" marker tag.
const HIDDEN_TAG_NAMES: &[&str] = &[
    "hidden",
    "gizlenmiş",
    "gizlenmis",
    "versteckt",
    "oculto",
    "oculta",
    "ocultos",
    "ocultas",
    "masqué",
    "masquée",
    "masqués",
    "masquées",
    "nascosto",
    "nascosta",
    "nascosti",
    "nascoste",
    "ukryte",
    "ukryty",
    "скрытые",
    "скрыто",
    "مخفي",
    "مخفية",
    "ซ่อน",
    "非表示",
    "숨김",
    "隐藏",
    "隱藏",
];

fn is_hidden_tag(tag: &str) -> bool {
    let lower = tag.trim().to_lowercase();
    HIDDEN_TAG_NAMES.iter().any(|name| *name == lower)
}

/// Maps a Galaxy release key to the launcher's composite key. GOG, Steam and
/// Epic are supported; other platforms' keys are skipped.
fn composite_key(release: &str, epic: &HashMap<String, String>) -> Option<String> {
    if let Some(id) = super::galaxy_playtime::product_id_from_release_key(release) {
        return Some(format!("gog::{id}"));
    }
    if let Some(app) = release.strip_prefix("steam_") {
        if !app.is_empty() && app.chars().all(|c| c.is_ascii_digit()) {
            return Some(format!("steam::{app}"));
        }
    }
    if let Some(catalog) = release.strip_prefix("epic_") {
        if let Some(app_name) = epic.get(&catalog.to_lowercase()) {
            return Some(format!("epic::{app_name}"));
        }
    }
    None
}

/// Reads the user's Galaxy tags as launcher collections.
fn read_galaxy_collections() -> Vec<GameCollection> {
    let Some(path) = super::galaxy_playtime::galaxy_db_path() else {
        return Vec::new();
    };
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = Connection::open_with_flags(&path, flags) else {
        return Vec::new();
    };

    let epic = build_metadata_lookup();
    let rows = conn
        .prepare("SELECT tag, releaseKey FROM UserReleaseTags")
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            Ok(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    let mut by_tag: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (tag, release) in rows {
        let name = tag.trim();
        if name.is_empty() || is_hidden_tag(name) {
            continue;
        }
        if let Some(key) = composite_key(&release, &epic) {
            by_tag.entry(name.to_string()).or_default().push(key);
        }
    }

    by_tag
        .into_iter()
        .map(|(name, mut app_names)| {
            app_names.sort();
            app_names.dedup();
            GameCollection {
                id: generate_collection_id(&name),
                name,
                app_names,
                created_at: Some(chrono_now_iso()),
                emoji: None,
            }
        })
        .collect()
}

/// Reads the releases the user hid in Galaxy (`UserReleaseProperties.isHidden`),
/// mapped to the launcher's composite keys.
fn read_galaxy_hidden() -> Vec<String> {
    let Some(path) = super::galaxy_playtime::galaxy_db_path() else {
        return Vec::new();
    };
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX;
    let Ok(conn) = Connection::open_with_flags(&path, flags) else {
        return Vec::new();
    };

    let epic = build_metadata_lookup();
    let rows = conn
        .prepare("SELECT releaseKey FROM UserReleaseProperties WHERE isHidden = 1")
        .and_then(|mut stmt| {
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            Ok(rows.filter_map(|r| r.ok()).collect::<Vec<_>>())
        })
        .unwrap_or_default();

    let mut hidden: Vec<String> = rows
        .iter()
        .filter_map(|release| composite_key(release, &epic))
        .collect();
    hidden.sort();
    hidden.dedup();
    hidden
}

/// Imports the user's GOG Galaxy tags as collections and returns the merged
/// collection list (the same shape the EGL import returns) plus the releases
/// Galaxy had hidden.
pub fn import_galaxy_tags() -> CollectionImport {
    CollectionImport {
        collections: merge_collections(read_galaxy_collections()),
        hidden: read_galaxy_hidden(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn release_keys_map_to_composite_keys() {
        let epic = HashMap::from([("2b04bd96d2c34822b37c91ece7fa5f1c".to_string(), "Salt".to_string())]);
        assert_eq!(
            composite_key("gog_1207658924_GameOfTheYear", &epic).as_deref(),
            Some("gog::1207658924")
        );
        assert_eq!(composite_key("steam_500", &epic).as_deref(), Some("steam::500"));
        assert_eq!(
            composite_key("epic_2B04BD96D2C34822B37C91ECE7FA5F1C", &epic).as_deref(),
            Some("epic::Salt")
        );
        assert_eq!(composite_key("origin_123", &epic), None);
        assert_eq!(composite_key("steam_abc", &epic), None);
        assert_eq!(composite_key("epic_unknown", &epic), None);
    }

    #[test]
    fn the_hidden_marker_tag_is_skipped() {
        assert!(is_hidden_tag("Gizlenmiş"));
        assert!(is_hidden_tag("Hidden"));
        assert!(!is_hidden_tag("2 = TEK OYUNCULU OYUNLAR"));
    }
}
