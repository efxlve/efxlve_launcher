//! Resolves current Steam library portraits.
//!
//! The flat CDN path (`/steam/apps/{id}/library_600x900.jpg`) 404s for many
//! newer titles. Their art lives under a content-hash path that only
//! `IStoreBrowseService/GetItems` publishes. This module asks for that path
//! in one batched call and returns a cover URL per app id.

use std::collections::HashMap;

const STORE_ASSET_HOST: &str = "https://shared.fastly.steamstatic.com/store_item_assets/";

fn asset_file_url(assets: &serde_json::Value, keys: &[&str]) -> Option<String> {
    let fmt = assets.get("asset_url_format").and_then(|v| v.as_str())?;
    let file = keys.iter().find_map(|key| {
        assets
            .get(*key)
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
    })?;
    let path = fmt.replace("${FILENAME}", file);
    if path.starts_with("http://") || path.starts_with("https://") {
        Some(path)
    } else {
        Some(format!("{STORE_ASSET_HOST}{path}"))
    }
}

/// Portrait first. Header is only used when Steam has not published a library capsule
/// (common for a preload that still has a store page).
pub fn cover_url_from_assets(assets: &serde_json::Value) -> Option<String> {
    asset_file_url(
        assets,
        &[
            "library_capsule",
            "library_capsule_2x",
            "main_capsule",
            "header",
        ],
    )
}

pub fn hero_url_from_assets(assets: &serde_json::Value) -> Option<String> {
    asset_file_url(
        assets,
        &["library_hero", "library_hero_2x", "hero_capsule", "hero_capsule_2x", "header"],
    )
}

/// GetItems ignores the request unless a store context is present. Without it the
/// response is an empty object, so preloaded games never receive their capsule.
pub fn store_items_query(ids: &[u64]) -> serde_json::Value {
    serde_json::json!({
        "ids": ids.iter().map(|id| serde_json::json!({"appid": id})).collect::<Vec<_>>(),
        "context": { "language": "english", "country_code": "US", "steam_realm": 1 },
        "data_request": { "include_assets": true }
    })
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SteamLibraryArt {
    #[serde(default)]
    pub cover: String,
    #[serde(default)]
    pub hero: String,
}

/// One GetItems call for up to 40 app ids. Missing art is omitted.
#[tauri::command]
pub async fn steam_library_art(app_ids: Vec<String>) -> Result<HashMap<String, SteamLibraryArt>, String> {
    let ids: Vec<u64> = app_ids
        .iter()
        .filter_map(|id| id.parse::<u64>().ok())
        .filter(|id| *id > 0)
        .take(40)
        .collect();
    if ids.is_empty() {
        return Ok(HashMap::new());
    }

    let input = store_items_query(&ids);
    let encoded: String = url::form_urlencoded::byte_serialize(input.to_string().as_bytes()).collect();
    let endpoint = format!(
        "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={encoded}"
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|e| e.to_string())?;
    let payload: serde_json::Value = client
        .get(&endpoint)
        .send()
        .await
        .map_err(|e| format!("Steam art lookup failed: {}", e.without_url()))?
        .json()
        .await
        .map_err(|e| format!("Steam art lookup failed: {}", e.without_url()))?;

    let mut out = HashMap::new();
    let items = payload
        .get("response")
        .and_then(|r| r.get("store_items"))
        .and_then(|v| v.as_array());
    if let Some(items) = items {
        for item in items {
            let Some(app_id) = item.get("appid").and_then(|v| v.as_u64()) else { continue };
            let Some(assets) = item.get("assets") else { continue };
            let cover = cover_url_from_assets(assets).unwrap_or_default();
            let hero = hero_url_from_assets(assets).unwrap_or_default();
            if cover.is_empty() && hero.is_empty() {
                continue;
            }
            out.insert(app_id.to_string(), SteamLibraryArt { cover, hero });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cover_url_uses_hashed_library_capsule() {
        let assets = serde_json::json!({
            "asset_url_format": "steam/apps/1580790/${FILENAME}?t=1751503462",
            "library_capsule": "67e60b0125feb2f0cc6964f0acb785faf1207fbd/library_600x900.jpg",
            "library_capsule_2x": "b52322f78cbdc7e6c267d873056abba7916f7ff3/library_600x900_2x.jpg",
            "header": "a7cee9165bb1bfc092c390c5cff215ce0e381dfc/header.jpg"
        });
        let url = cover_url_from_assets(&assets).unwrap();
        assert_eq!(
            url,
            "https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/1580790/67e60b0125feb2f0cc6964f0acb785faf1207fbd/library_600x900.jpg?t=1751503462"
        );
    }

    #[test]
    fn store_items_query_includes_store_context() {
        let query = store_items_query(&[3393110]);
        assert!(query.get("context").is_some());
        assert_eq!(
            query.pointer("/data_request/include_assets").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(query.pointer("/ids/0/appid").and_then(|v| v.as_u64()), Some(3393110));
    }

    #[test]
    fn hero_url_prefers_library_hero_over_header() {
        let assets = serde_json::json!({
            "asset_url_format": "steam/apps/3393110/${FILENAME}?t=1",
            "library_hero": "abc/library_hero.jpg",
            "header": "abc/header.jpg"
        });
        let url = hero_url_from_assets(&assets).unwrap();
        assert!(url.contains("library_hero.jpg"));
    }

    #[test]
    fn cover_url_falls_back_to_header_when_no_portrait_exists() {
        let assets = serde_json::json!({
            "asset_url_format": "steam/apps/10/${FILENAME}",
            "header": "header.jpg"
        });
        let url = cover_url_from_assets(&assets).unwrap();
        assert!(url.ends_with("/steam/apps/10/header.jpg"));
    }
}
