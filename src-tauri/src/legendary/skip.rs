//! Automatic skipping of broken catalog items.
//!
//! Some Epic catalog items permanently return 401 (removed/region-locked).
//! Because legendary crashes on a single item and kills the whole sync, this module:
//! 1. Captures the namespace/catalogItemId from the 401 error,
//! 2. `assets.json`'dan app_name ve platformu bulur,
//! 3. Writes stub metadata in legendary format (so next time it is considered
//!    "up to date" and skipped),
//! 4. Records it in `skipped.json` (shown in the UI).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::models::GameAsset;
use super::LegendaryError;

/// Extracts (namespace, catalogItemId) from the 401 catalog URL.
/// E.g.: `.../namespace/<ns>/bulk/items?id=<item>&...`
/// NOTE: the namespace is not always hex (readable names like `rosemallow`
/// also occur); so only a format check is performed.
pub fn parse_401_item(stderr: &str) -> Option<(String, String)> {
    if !(stderr.contains("401 Client Error") || stderr.contains("Unauthorized")) {
        return None;
    }
    let ns_key = "namespace/";
    let ns_start = stderr.find(ns_key)? + ns_key.len();
    let ns_rest = &stderr[ns_start..];
    let ns_end = ns_rest.find('/')?;
    let namespace = ns_rest[..ns_end].to_string();
    let id_key = "bulk/items?id=";
    let id_start = stderr.find(id_key)? + id_key.len();
    let id_rest = &stderr[id_start..];
    let id_end = id_rest
        .find(|c| c == '&' || c == '"' || c == '\'' || c == ' ' || c == '\n' || c == '\r')
        .unwrap_or(id_rest.len());
    let item = id_rest[..id_end].to_string();
    let ns_ok = !namespace.is_empty()
        && namespace.len() <= 64
        && namespace
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let item_ok = item.len() == 32 && item.chars().all(|c| c.is_ascii_hexdigit());
    if ns_ok && item_ok {
        Some((namespace, item))
    } else {
        None
    }
}

/// Finds the application inside `assets.json` (`{platform: [asset, ...]}`).
/// Returns: (app_name, platform, asset).
pub fn find_app(
    config_dir: &Path,
    namespace: &str,
    item: &str,
) -> Option<(String, String, GameAsset)> {
    let text = std::fs::read_to_string(config_dir.join("assets.json")).ok()?;
    let assets: HashMap<String, Vec<GameAsset>> = serde_json::from_str(&text).ok()?;
    for (platform, list) in &assets {
        for a in list {
            if a.namespace == namespace && a.catalog_item_id == item {
                return Some((a.app_name.clone(), platform.clone(), a.clone()));
            }
        }
    }
    None
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SkippedItem {
    pub app_name: String,
    pub namespace: String,
    pub catalog_item_id: String,
    pub reason: String,
    /// Epic account that hit the 401. Legacy records carry an empty string.
    #[serde(default)]
    pub account_id: String,
}

const STUB_SKIPPED_BY: &str = "efxlve-launcher";

fn skipped_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("skipped.json")
}

fn active_account_id(config_dir: &Path) -> Option<String> {
    super::accounts::read_active_user(config_dir)
        .map(|(id, _)| id)
        .or_else(|| super::cache::read_user(config_dir).and_then(|(_, id)| id))
        .map(|id| id.trim().to_string())
        .filter(|id| crate::vault_id::is_vault_id(id))
}

fn load_all_skipped_from(path: &Path) -> Vec<SkippedItem> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|d| serde_json::from_str(&d).ok())
        .unwrap_or_default()
}

pub fn load_skipped_for(path: &Path, config_dir: &Path) -> Vec<SkippedItem> {
    let Some(account_id) = active_account_id(config_dir) else {
        return Vec::new();
    };
    load_all_skipped_from(path)
        .into_iter()
        .filter(|item| item.account_id == account_id)
        .collect()
}

pub fn load_skipped(app: &AppHandle) -> Vec<SkippedItem> {
    load_skipped_for(&skipped_file(app), &default_config_dir())
}

fn save_skipped_to(path: &Path, items: &[SkippedItem]) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(items) {
        let _ = std::fs::write(path, data);
    }
}

pub fn record_skipped_at(path: &Path, item: SkippedItem) {
    let mut items = load_all_skipped_from(path);
    if !items
        .iter()
        .any(|i| i.app_name == item.app_name && i.account_id == item.account_id)
    {
        items.push(item);
        save_skipped_to(path, &items);
    }
}

/// True when a parsed metadata JSON is a 401 stub written by this launcher.
pub fn is_stub_metadata(value: &serde_json::Value) -> bool {
    value
        .pointer("/metadata/skippedBy")
        .and_then(|v| v.as_str())
        == Some(STUB_SKIPPED_BY)
}

/// Deletes only stub metadata files (`"skippedBy": "efxlve-launcher"`) under
/// `<config_dir>/metadata` so a newly signed-in or switched account re-fetches
/// catalog metadata for titles it actually owns. Real metadata stays untouched.
pub fn remove_stub_metadata(config_dir: &Path) -> usize {
    let meta_dir = config_dir.join("metadata");
    let Ok(entries) = std::fs::read_dir(meta_dir) else {
        return 0;
    };
    let mut removed = 0usize;
    for entry in entries.flatten() {
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        if !text.contains("\"skippedBy\"") {
            continue;
        }
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        if is_stub_metadata(&val) && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

/// Seed JSON'u kurar (saf fonksiyon — test edilebilir).
/// NOTE: a bare variable key in `json!` is not written (it becomes a literal!),
/// so the `asset_infos` map is built explicitly.
pub fn build_seed(app_name: &str, platform: &str, asset: &GameAsset) -> serde_json::Value {
    let mut asset_infos = serde_json::Map::new();
    asset_infos.insert(
        platform.to_string(),
        serde_json::to_value(asset).unwrap_or(serde_json::Value::Null),
    );
    serde_json::json!({
        "achievements": {
            "achievement_sets": [],
            "achievements": [],
            "namespace": asset.namespace,
            "platinum_rarity": {},
            "total_achievements": 0,
            "total_product_xp": 0
        },
        "app_name": app_name,
        "app_title": app_name,
        "asset_infos": asset_infos,
        "base_urls": [],
        "metadata": {
            "categories": [],
            "description": "Epic katalogundan erisilemeyen oge (otomatik atlandi).",
            "id": asset.catalog_item_id,
            "namespace": asset.namespace,
            "skippedBy": STUB_SKIPPED_BY,
            "title": app_name
        },
        "sidecar": null
    })
}

/// Writes a stub in legendary's `Game.from_json` format (ASCII-only).
/// Asset versions are copied verbatim so it is considered "up to date" and skipped.
pub fn write_seed(
    config_dir: &Path,
    app_name: &str,
    platform: &str,
    asset: &GameAsset,
) -> Result<(), LegendaryError> {
    if app_name.trim().is_empty()
        || app_name.contains("..")
        || app_name.contains(['/', '\\', ':'])
    {
        return Err(LegendaryError::ParseError("invalid app_name".into()));
    }
    let seed = build_seed(app_name, platform, asset);
    let text = serde_json::to_string_pretty(&seed)
        .map_err(|e| LegendaryError::ParseError(e.to_string()))?;
    let dir = config_dir.join("metadata");
    std::fs::create_dir_all(&dir).map_err(LegendaryError::from)?;
    std::fs::write(dir.join(format!("{app_name}.json")), text).map_err(LegendaryError::from)?;
    Ok(())
}

/// legendary default config dir (fallback when the status command fails).
pub fn default_config_dir() -> PathBuf {
    // Portable builds point this at a folder next to the executable. Legendary's
    // own override comes next: when a player sets LEGENDARY_CONFIG_PATH, the CLI
    // reads that folder, so the launcher must read the same one or it serves an
    // empty library while legendary installs into another directory.
    for key in ["EFXLVE_CONFIG_DIR", "LEGENDARY_CONFIG_PATH"] {
        if let Ok(path) = std::env::var(key) {
            if !path.trim().is_empty() {
                return PathBuf::from(path);
            }
        }
    }
    #[cfg(windows)]
    {
        std::env::var("USERPROFILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(".config")
            .join("legendary")
    }
    #[cfg(not(windows))]
    {
        std::env::var("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir())
            .join(".config")
            .join("legendary")
    }
}

pub fn skip_item_in(
    skipped_path: &Path,
    config_dir: &Path,
    namespace: &str,
    item: &str,
) -> Result<String, LegendaryError> {
    let (app_name, platform, asset) = find_app(config_dir, namespace, item).ok_or_else(|| {
        LegendaryError::ParseError("katalog ogesi varlik listesinde bulunamadi".into())
    })?;
    write_seed(config_dir, &app_name, &platform, &asset)?;
    let account_id = active_account_id(config_dir).unwrap_or_default();
    record_skipped_at(
        skipped_path,
        SkippedItem {
            app_name: app_name.clone(),
            namespace: namespace.to_string(),
            catalog_item_id: item.to_string(),
            reason: "Epic katalogu 401 (erisilemiyor)".into(),
            account_id,
        },
    );
    Ok(app_name)
}

/// One-step auto-skip: find -> write stub -> record. Returns app_name.
pub fn skip_item(
    app: &AppHandle,
    config_dir: &Path,
    namespace: &str,
    item: &str,
) -> Result<String, LegendaryError> {
    skip_item_in(&skipped_file(app), config_dir, namespace, item)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_401: &str = "requests.exceptions.HTTPError: 401 Client Error: Unauthorized for url: \
        https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/8de58df378c34407b6db0388e0470a45/bulk/items?id=3b5f7509b172464ca18def194a12fc3c&includeDLCDetails=True&includeMainGameDetails=True&country=TR&locale=tr";

    #[test]
    fn parses_namespace_and_item_from_401_url() {
        let (ns, item) = parse_401_item(SAMPLE_401).expect("parse edilmeli");
        assert_eq!(ns, "8de58df378c34407b6db0388e0470a45");
        assert_eq!(item, "3b5f7509b172464ca18def194a12fc3c");
    }

    #[test]
    fn ignores_non_401_output() {
        assert!(parse_401_item("all good, exit 0").is_none());
        assert!(parse_401_item("ValueError: No saved credentials").is_none());
    }

    const SAMPLE_401_NAMED_NS: &str = "requests.exceptions.HTTPError: 401 Client Error: Unauthorized for url: \
        https://catalog-public-service-prod06.ol.epicgames.com/catalog/api/shared/namespace/rosemallow/bulk/items?id=fdb4a3820d7e49169fd6187ef2828a65&includeDLCDetails=True";

    #[test]
    fn parses_named_namespace() {
        let (ns, item) = parse_401_item(SAMPLE_401_NAMED_NS).expect("parse edilmeli");
        assert_eq!(ns, "rosemallow");
        assert_eq!(item, "fdb4a3820d7e49169fd6187ef2828a65");
    }

    #[test]
    fn seed_uses_real_platform_key() {
        let asset = GameAsset {
            app_name: "x".into(),
            build_version: "1.2".into(),
            namespace: "8de58df378c34407b6db0388e0470a45".into(),
            catalog_item_id: "3b5f7509b172464ca18def194a12fc3c".into(),
            ..Default::default()
        };
        let seed = build_seed("x", "Windows", &asset);
        // The variable key must not turn into a literal!
        assert!(seed["asset_infos"].get("Windows").is_some());
        assert!(seed["asset_infos"].get("platform").is_none());
        assert_eq!(seed["asset_infos"]["Windows"]["build_version"], "1.2");
    }

    #[test]
    fn legacy_skipped_file_without_account_id_loads_cleanly() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_skip_legacy_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let skipped_path = root.join("skipped.json");
        std::fs::write(
            &skipped_path,
            r#"[{"app_name":"OldStub","namespace":"ns","catalog_item_id":"3b5f7509b172464ca18def194a12fc3c","reason":"401"}]"#,
        )
        .unwrap();
        std::fs::write(
            root.join("user.json"),
            r#"{"account_id":"19927295d6e3467887d4e830d8c85963","displayName":"Alice"}"#,
        )
        .unwrap();

        // Legacy entries deserialize without error and do not hide games for signed-in accounts.
        let all = load_all_skipped_from(&skipped_path);
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].account_id, "");
        assert!(load_skipped_for(&skipped_path, &root).is_empty());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn skipped_items_and_stub_metadata_are_isolated_per_account() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_skip_accounts_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let config = root.join("config");
        std::fs::create_dir_all(config.join("metadata")).unwrap();
        let skipped_path = root.join("skipped.json");

        // Real game metadata must never be touched when cleaning stubs.
        let real_meta = config.join("metadata").join("RealGame.json");
        std::fs::write(
            &real_meta,
            r#"{"app_name":"RealGame","app_title":"Real Game","metadata":{"entitlementType":"EXECUTABLE"}}"#,
        )
        .unwrap();

        // Assets table shared across steps.
        std::fs::write(
            config.join("assets.json"),
            r#"{"Windows":[
                {"app_name":"SharedTitle","asset_id":"SharedTitle","build_version":"1.0","catalog_item_id":"11111111111111111111111111111111","label_name":"Live","metadata":{},"namespace":"ns_shared"},
                {"app_name":"OnlyBrokenOnB","asset_id":"OnlyBrokenOnB","build_version":"2.0","catalog_item_id":"22222222222222222222222222222222","label_name":"Live","metadata":{},"namespace":"ns_b"}
            ]}"#,
        )
        .unwrap();

        // Sign in Account A and prepare Account B in the account vault.
        std::fs::write(
            config.join("user.json"),
            r#"{"account_id":"account_a","displayName":"Alice"}"#,
        )
        .unwrap();
        super::super::accounts::list_saved_accounts(&config);

        let acc_b_dir = config.join("accounts").join("account_b");
        std::fs::create_dir_all(&acc_b_dir).unwrap();
        std::fs::write(
            acc_b_dir.join("user.json"),
            r#"{"account_id":"account_b","displayName":"Bob"}"#,
        )
        .unwrap();
        std::fs::write(
            config.join("accounts").join("accounts_meta.json"),
            r#"[
                {"account_id":"account_a","display_name":"Alice","last_used":10,"is_active":true,"game_count":null},
                {"account_id":"account_b","display_name":"Bob","last_used":5,"is_active":false,"game_count":null}
            ]"#,
        )
        .unwrap();

        // 1. Account A hits 401 on SharedTitle: stub written, skipped recorded under account_a.
        let skipped_name = skip_item_in(
            &skipped_path,
            &config,
            "ns_shared",
            "11111111111111111111111111111111",
        )
        .unwrap();
        assert_eq!(skipped_name, "SharedTitle");
        let stub_path = config.join("metadata").join("SharedTitle.json");
        assert!(stub_path.is_file());
        let list_a = load_skipped_for(&skipped_path, &config);
        assert_eq!(list_a.len(), 1);
        assert_eq!(list_a[0].app_name, "SharedTitle");
        assert_eq!(list_a[0].account_id, "account_a");

        // 2. Switch to Account B: stub metadata is removed so Legendary re-fetches SharedTitle,
        //    real metadata stays intact, and Account B sees an empty skip list.
        super::super::accounts::switch_account(&config, "account_b").unwrap();
        assert!(!stub_path.exists(), "stub metadata must be removed on account switch");
        assert!(real_meta.is_file(), "real metadata must remain untouched");
        assert!(load_skipped_for(&skipped_path, &config).is_empty());

        // 3. Account B hits 401 on OnlyBrokenOnB: recorded under account_b without losing account_a's row.
        skip_item_in(
            &skipped_path,
            &config,
            "ns_b",
            "22222222222222222222222222222222",
        )
        .unwrap();
        let list_b = load_skipped_for(&skipped_path, &config);
        assert_eq!(list_b.len(), 1);
        assert_eq!(list_b[0].app_name, "OnlyBrokenOnB");

        // 4. Switch back to Account A: OnlyBrokenOnB stub is removed and Account A still sees SharedTitle.
        super::super::accounts::switch_account(&config, "account_a").unwrap();
        assert!(!config.join("metadata").join("OnlyBrokenOnB.json").exists());
        assert!(real_meta.is_file());
        let list_a_again = load_skipped_for(&skipped_path, &config);
        assert_eq!(list_a_again.len(), 1);
        assert_eq!(list_a_again[0].app_name, "SharedTitle");

        let _ = std::fs::remove_dir_all(&root);
    }
}
