//! One-time hand-over of the normal Legendary config into a portable build.
//!
//! Earlier portable releases wrote installs to `~/.config/legendary` while the
//! app read `portable-data/config/legendary`. The 0.1.58 fix points Legendary
//! at the portable folder, but an existing portable user would then see an
//! empty account/installed list. This module copies the legacy data once.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// Files that describe the account, the install records and the launcher's own
/// small caches. Large backup and image caches stay in the old folder.
const SIDECARS: &[&str] = &[
    "user.json",
    "assets.json",
    "entitlements.json",
    "config.ini",
    "version.json",
    "aliases.json",
    "achievements.json",
    "efxlve_library_snapshot.json",
    "efxlve_game_settings.json",
    "collections.json",
    "playtime.json",
    "epic_playtime.json",
    "profile_cache.json",
    "cloud_backup_settings.json",
    "cloud_secrets.bin",
    "efxlve-download-resumes.json",
    "efxlve-download-queue.json",
    "efxlve-pending-download.json",
    "efxlve_binary_version.json",
    "store_hub_cache.json",
    "store_local_cart.json",
];

const DIRS: &[&str] = &["metadata", "manifests", "accounts", "tmp"];

const MARKER: &str = "efxlve_portable_migration.json";

/// Copies the legacy config into `destination` once. Returns true when this
/// call changed something. A marker makes later launches a single file check.
pub(crate) fn migrate_legendary_config(source: &Path, destination: &Path) -> bool {
    if source == destination || !source.is_dir() {
        return false;
    }
    if destination.join(MARKER).is_file() {
        return false;
    }
    // No account and no install record means there is nothing worth carrying
    // over; leave the marker unwritten so a later launch can still migrate.
    if !source.join("user.json").is_file() && !source.join("installed.json").is_file() {
        return false;
    }
    if std::fs::create_dir_all(destination).is_err() {
        return false;
    }

    let mut changed = merge_installed(
        &source.join("installed.json"),
        &destination.join("installed.json"),
    );

    for name in SIDECARS {
        changed |= copy_if_missing(&source.join(name), &destination.join(name));
    }
    for name in DIRS {
        changed |= copy_dir_missing(&source.join(name), &destination.join(name));
    }

    let marker = serde_json::json!({
        "version": 1,
        "source": source.to_string_lossy(),
    });
    if let Ok(text) = serde_json::to_string_pretty(&marker) {
        let _ = std::fs::write(destination.join(MARKER), text);
    }
    changed
}

/// Merges the legacy install map into the portable one without dropping an
/// install the portable build already made.
fn merge_installed(source: &Path, destination: &Path) -> bool {
    let Ok(source_text) = std::fs::read_to_string(source) else {
        return false;
    };
    let Ok(source_map) = serde_json::from_str::<Map<String, Value>>(&source_text) else {
        return false;
    };
    if source_map.is_empty() {
        return false;
    }
    let mut destination_map = std::fs::read_to_string(destination)
        .ok()
        .and_then(|text| serde_json::from_str::<Map<String, Value>>(&text).ok())
        .unwrap_or_default();
    let before = destination_map.len();
    for (app_name, record) in source_map {
        destination_map.entry(app_name).or_insert(record);
    }
    if destination_map.len() == before && destination.is_file() {
        return false;
    }
    let Ok(text) = serde_json::to_string_pretty(&destination_map) else {
        return false;
    };
    std::fs::write(destination, text).is_ok()
}

fn copy_if_missing(source: &Path, destination: &Path) -> bool {
    if !source.is_file() || destination.exists() {
        return false;
    }
    if let Some(parent) = destination.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    std::fs::copy(source, destination).is_ok()
}

/// Copies files the portable folder does not have yet; an existing file wins.
fn copy_dir_missing(source: &Path, destination: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(source) else {
        return false;
    };
    let mut changed = false;
    for entry in entries.flatten() {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if source_path.is_dir() {
            let _ = std::fs::create_dir_all(&destination_path);
            changed |= copy_dir_missing(&source_path, &destination_path);
        } else if !destination_path.exists() {
            changed |= copy_if_missing(&source_path, &destination_path);
        }
    }
    changed
}

/// The normal Legendary folder for this Windows account, if it exists.
pub(crate) fn legacy_config_dir() -> Option<PathBuf> {
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    Some(PathBuf::from(home).join(".config").join("legendary"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "efxlve_portable_{}_{}",
            std::process::id(),
            name
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn legacy_account_and_installs_move_into_the_portable_folder() {
        let root = temp_dir("move");
        let source = root.join("legacy");
        let destination = root.join("portable");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(
            source.join("installed.json"),
            r#"{"Fortnite":{"app_name":"Fortnite","version":"1.0"}}"#,
        )
        .unwrap();
        std::fs::write(source.join("user.json"), r#"{"displayName":"Efe"}"#).unwrap();
        std::fs::write(source.join("config.ini"), "[Legendary]\n").unwrap();
        std::fs::create_dir_all(source.join("metadata")).unwrap();
        std::fs::write(source.join("metadata").join("Fortnite.json"), "{}").unwrap();
        std::fs::create_dir_all(source.join("manifests")).unwrap();
        std::fs::write(source.join("manifests").join("Fortnite.manifest"), "x").unwrap();

        assert!(migrate_legendary_config(&source, &destination));
        let installed = std::fs::read_to_string(destination.join("installed.json")).unwrap();
        assert!(installed.contains("Fortnite"));
        assert!(destination.join("user.json").is_file());
        assert!(destination.join("metadata").join("Fortnite.json").is_file());
        assert!(destination.join("manifests").join("Fortnite.manifest").is_file());
        assert!(destination.join(MARKER).is_file());

        // A second launch is a single marker read.
        assert!(!migrate_legendary_config(&source, &destination));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_portable_install_is_kept_next_to_the_legacy_one() {
        let root = temp_dir("merge");
        let source = root.join("legacy");
        let destination = root.join("portable");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(
            source.join("installed.json"),
            r#"{"Legacy":{"app_name":"Legacy","version":"1.0"}}"#,
        )
        .unwrap();
        std::fs::write(source.join("user.json"), r#"{"displayName":"Old"}"#).unwrap();
        std::fs::write(
            destination.join("installed.json"),
            r#"{"Portable":{"app_name":"Portable","version":"2.0"}}"#,
        )
        .unwrap();
        std::fs::write(destination.join("user.json"), r#"{"displayName":"New"}"#).unwrap();

        assert!(migrate_legendary_config(&source, &destination));
        let installed = std::fs::read_to_string(destination.join("installed.json")).unwrap();
        assert!(installed.contains("Legacy"));
        assert!(installed.contains("Portable"));
        let user = std::fs::read_to_string(destination.join("user.json")).unwrap();
        assert!(user.contains("New"), "an existing portable session must win");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_legacy_folder_is_not_marked_as_migrated() {
        let root = temp_dir("empty");
        let source = root.join("legacy");
        let destination = root.join("portable");
        std::fs::create_dir_all(&source).unwrap();
        assert!(!migrate_legendary_config(&source, &destination));
        assert!(!destination.join(MARKER).is_file());
        let _ = std::fs::remove_dir_all(&root);
    }
}
