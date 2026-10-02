//! Steam library collection import (read-only).
//!
//! Steam keeps the user's collections in `userdata/<account>/config/localconfig.vdf`
//! as a JSON string under `UserLocalConfigStore > WebStorage > user-collections`.
//! Each entry carries an `id`, a `name` and `added`/`removed` app id lists.
//! Steam's own hidden marker is the entry whose id is `hidden`; its app ids are
//! returned as hidden composite keys instead of a collection. Dynamic
//! (filter-based) entries have no `added` list and are skipped.

use std::path::Path;

use serde_json::Value;

use super::users::active_steam_id;
use super::vdf::{parse_vdf, Vdf};
use crate::legendary::collections::{
    chrono_now_iso, merge_collections, CollectionImport, GameCollection,
};

/// Steam's account id (the `userdata` folder name) from its 64-bit id.
fn account_id(steam_id64: &str) -> Option<u64> {
    let id: u64 = steam_id64.parse().ok()?;
    id.checked_sub(76561197960265728)
}

/// App ids from an `added`/`removed` list; numbers and numeric strings count.
fn app_ids(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    if let Some(number) = item.as_u64() {
                        Some(number.to_string())
                    } else {
                        item.as_str()
                            .filter(|text| !text.is_empty())
                            .map(str::to_string)
                    }
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Reads the collections and hidden app ids of the most recent Steam account.
fn read_steam_collections(steam: &Path) -> (Vec<GameCollection>, Vec<String>) {
    let Some(account) = active_steam_id(steam).and_then(|id| account_id(&id)) else {
        return (Vec::new(), Vec::new());
    };
    let path = steam
        .join("userdata")
        .join(account.to_string())
        .join("config")
        .join("localconfig.vdf");
    let Ok(text) = std::fs::read_to_string(path) else {
        return (Vec::new(), Vec::new());
    };
    let root = parse_vdf(&text);
    let Some(json) = root
        .get("UserLocalConfigStore")
        .and_then(|node| node.get("WebStorage"))
        .and_then(|node| node.get("user-collections"))
        .and_then(Vdf::as_str)
    else {
        return (Vec::new(), Vec::new());
    };
    let Ok(value) = serde_json::from_str::<Value>(json) else {
        return (Vec::new(), Vec::new());
    };
    let Some(map) = value.as_object() else {
        return (Vec::new(), Vec::new());
    };

    let mut collections = Vec::new();
    let mut hidden = Vec::new();
    for (key, entry) in map {
        let added = app_ids(entry.get("added"));
        if added.is_empty() {
            // Dynamic (filter-based) collections have no explicit members.
            continue;
        }
        let id = entry.get("id").and_then(Value::as_str).unwrap_or(key);
        if id == "hidden" {
            hidden.extend(added.iter().map(|app| format!("steam::{app}")));
            continue;
        }
        let name = entry
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if name.is_empty() {
            continue;
        }
        let removed: std::collections::HashSet<String> =
            app_ids(entry.get("removed")).into_iter().collect();
        let mut app_names: Vec<String> = added
            .into_iter()
            .filter(|app| !removed.contains(app))
            .map(|app| format!("steam::{app}"))
            .collect();
        app_names.sort();
        app_names.dedup();
        if app_names.is_empty() {
            continue;
        }
        collections.push(GameCollection {
            id: format!("steam_{id}"),
            name: name.to_string(),
            app_names,
            created_at: Some(chrono_now_iso()),
            emoji: None,
        });
    }
    hidden.sort();
    hidden.dedup();
    (collections, hidden)
}

/// Imports the Steam library collections and returns the merged collection list
/// plus the games the user hid in Steam.
#[tauri::command]
pub async fn steam_import_collections() -> Result<CollectionImport, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let Some(steam) = super::steam_install_path() else {
            return CollectionImport {
                collections: Vec::new(),
                hidden: Vec::new(),
            };
        };
        let (collections, hidden) = read_steam_collections(&steam);
        CollectionImport {
            collections: merge_collections(collections),
            hidden,
        }
    })
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOCAL_CONFIG: &str = r#"
"UserLocalConfigStore"
{
	"WebStorage"
	{
		"user-collections"		"{\"1\":{\"id\":\"1\",\"name\":\"Hikaye\",\"added\":[220,550],\"removed\":[550]},\"2\":{\"id\":\"2\",\"name\":\"\",\"added\":[]},\"hidden\":{\"id\":\"hidden\",\"added\":[\"4000\"]}}"
	}
}
"#;

    #[test]
    fn steam_collections_parse_and_skip_dynamic_and_hidden_entries() {
        let root = parse_vdf(LOCAL_CONFIG);
        let json = root
            .get("UserLocalConfigStore")
            .and_then(|node| node.get("WebStorage"))
            .and_then(|node| node.get("user-collections"))
            .and_then(Vdf::as_str)
            .expect("user-collections");
        let value: Value = serde_json::from_str(json).expect("json");
        assert_eq!(app_ids(value.get("1").and_then(|e| e.get("added"))), vec!["220", "550"]);
        assert_eq!(app_ids(value.get("hidden").and_then(|e| e.get("added"))), vec!["4000"]);
    }

    #[test]
    fn account_id_converts_the_64_bit_id() {
        assert_eq!(account_id("76561199140017878"), Some(1179752150));
        assert_eq!(account_id("not-a-number"), None);
    }
}
