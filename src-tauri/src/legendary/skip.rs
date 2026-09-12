//! Bozuk katalog öğelerinin otomatik atlanması.
//!
//! Bazı Epic katalog öğeleri kalıcı 401 döndürür (kaldırılmış/bölge kilitli).
//! legendary tek bir öğede çöküp tüm senkronu öldürdüğü için bu modül:
//! 1. 401 hatasındaki namespace/catalogItemId'yi yakalar,
//! 2. `assets.json`'dan app_name ve platformu bulur,
//! 3. legendary formatında stub metadata yazar (bir dahaki sefere "güncel"
//!    sayılıp atlanılır),
//! 4. kaydı `skipped.json`'a işler (arayüzde gösterilir).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::models::GameAsset;
use super::LegendaryError;

/// 401 veren katalog URL'sinden (namespace, catalogItemId) çıkarır.
/// Örn: `.../namespace/<ns>/bulk/items?id=<item>&...`
/// NOT: namespace her zaman hex değildir (`rosemallow` gibi okunabilir
/// adlar da olur); o yüzden sadece biçim denetimi yapılır.
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

/// `assets.json` (`{platform: [asset, ...]}`) içinden uygulamayı bulur.
/// Döndürür: (app_name, platform, asset).
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedItem {
    pub app_name: String,
    pub namespace: String,
    pub catalog_item_id: String,
    pub reason: String,
}

fn skipped_file(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("skipped.json")
}

pub fn load_skipped(app: &AppHandle) -> Vec<SkippedItem> {
    std::fs::read_to_string(skipped_file(app))
        .ok()
        .and_then(|d| serde_json::from_str(&d).ok())
        .unwrap_or_default()
}

fn save_skipped(app: &AppHandle, items: &[SkippedItem]) {
    let path = skipped_file(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(data) = serde_json::to_string_pretty(items) {
        let _ = std::fs::write(path, data);
    }
}

pub fn record_skipped(app: &AppHandle, item: SkippedItem) {
    let mut items = load_skipped(app);
    if !items.iter().any(|i| i.app_name == item.app_name) {
        items.push(item);
        save_skipped(app, &items);
    }
}

/// Seed JSON'u kurar (saf fonksiyon — test edilebilir).
/// NOT: `json!` içinde çıplak değişken anahtar yazılmaz (literal'a dönüşür!),
/// bu yüzden `asset_infos` haritası açıkça kurulur.
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
            "skippedBy": "efxlve-launcher",
            "title": app_name
        },
        "sidecar": null
    })
}

/// legendary'nin `Game.from_json` formatında stub yazar (ASCII-only).
/// Asset sürümleri birebir kopyalanır ki "güncel" sayılıp atlanılsın.
pub fn write_seed(
    config_dir: &Path,
    app_name: &str,
    platform: &str,
    asset: &GameAsset,
) -> Result<(), LegendaryError> {
    let seed = build_seed(app_name, platform, asset);
    let text =
        serde_json::to_string_pretty(&seed).map_err(|e| LegendaryError::ParseError(e.to_string()))?;
    let dir = config_dir.join("metadata");
    std::fs::create_dir_all(&dir).map_err(LegendaryError::from)?;
    std::fs::write(dir.join(format!("{app_name}.json")), text).map_err(LegendaryError::from)?;
    Ok(())
}

/// legendary varsayılan config dizini (status komutu çalışmazsa yedek).
pub fn default_config_dir() -> PathBuf {
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

/// Tek adımlı otomatik atlama: bul → stub yaz → kaydet. app_name döndürür.
pub fn skip_item(
    app: &AppHandle,
    config_dir: &Path,
    namespace: &str,
    item: &str,
) -> Result<String, LegendaryError> {
    let (app_name, platform, asset) = find_app(config_dir, namespace, item).ok_or_else(|| {
        LegendaryError::ParseError("katalog ogesi varlik listesinde bulunamadi".into())
    })?;
    write_seed(config_dir, &app_name, &platform, &asset)?;
    record_skipped(
        app,
        SkippedItem {
            app_name: app_name.clone(),
            namespace: namespace.to_string(),
            catalog_item_id: item.to_string(),
            reason: "Epic katalogu 401 (erisilemiyor)".into(),
        },
    );
    Ok(app_name)
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
        // Değişken anahtar literal'a dönüşmemeli!
        assert!(seed["asset_infos"].get("Windows").is_some());
        assert!(seed["asset_infos"].get("platform").is_none());
        assert_eq!(seed["asset_infos"]["Windows"]["build_version"], "1.2");
    }
}
