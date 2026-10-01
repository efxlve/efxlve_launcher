//! Box art for companion games.
//!
//! Xbox titles use the public Microsoft Store poster for their StoreId.
//! Everything else uses Steam's public store search and the portrait CDN.
//! Results are cached so the library does not search again on every launch.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::time::Duration;

use super::accounts::data_dir;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverQuery {
    pub store: String,
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub store_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverHit {
    pub store: String,
    pub id: String,
    pub cover_url: String,
    pub hero_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct CachedArt {
    cover: String,
    hero: String,
}

pub(crate) fn cache_path() -> PathBuf {
    data_dir().join("companion_covers.json")
}

pub(crate) fn load_cache() -> HashMap<String, CachedArt> {
    let Ok(text) = std::fs::read_to_string(cache_path()) else {
        return HashMap::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_cache(cache: &HashMap<String, CachedArt>) {
    let path = cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, text);
    }
}

fn cache_key(store: &str, id: &str) -> String {
    format!("{store}::{id}")
}

pub(crate) fn cached_cover(cache: &HashMap<String, CachedArt>, store: &str, id: &str) -> (String, String) {
    cache
        .get(&cache_key(store, id))
        .map(|art| (art.cover.clone(), art.hero.clone()))
        .unwrap_or_default()
}

pub async fn resolve_covers(queries: Vec<CoverQuery>) -> Vec<CoverHit> {
    let mut cache = load_cache();
    let client = match reqwest::Client::builder().user_agent("efxlve-launcher").timeout(Duration::from_secs(8)).build() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let mut hits = Vec::new();
    let mut pending = Vec::new();
    for query in queries {
        if query.id.is_empty() || query.name.is_empty() {
            continue;
        }
        let (cover, hero) = cached_cover(&cache, &query.store, &query.id);
        if !cover.is_empty() {
            hits.push(CoverHit { store: query.store, id: query.id, cover_url: cover, hero_url: hero });
            continue;
        }
        pending.push(query);
        if pending.len() >= 48 {
            break;
        }
    }
    for query in pending {
        let Some((query, cover, hero)) = fetch_one(client.clone(), query).await else {
            continue;
        };
        if cover.is_empty() {
            continue;
        }
        cache.insert(cache_key(&query.store, &query.id), CachedArt { cover: cover.clone(), hero: hero.clone() });
        hits.push(CoverHit { store: query.store, id: query.id, cover_url: cover, hero_url: hero });
    }
    save_cache(&cache);
    hits
}

async fn fetch_one(client: reqwest::Client, query: CoverQuery) -> Option<(CoverQuery, String, String)> {
    if !query.store_id.is_empty() {
        if let Some(poster) = xbox_poster(&client, &query.store_id).await {
            return Some((query, poster, String::new()));
        }
    }
    let app = steam_app(&client, &query.name).await?;
    let cover = format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{app}/library_600x900.jpg");
    let hero = format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{app}/library_hero.jpg");
    Some((query, cover, hero))
}

async fn xbox_poster(client: &reqwest::Client, store_id: &str) -> Option<String> {
    if !store_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let url = format!(
        "https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/{store_id}?market=US&locale=en-US&deviceFamily=Windows.Desktop"
    );
    let value: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;
    find_image(&value, "Poster").or_else(|| find_image(&value, "BoxArt"))
}

fn find_image(value: &serde_json::Value, kind: &str) -> Option<String> {
    match value {
        serde_json::Value::Array(items) => items.iter().find_map(|item| find_image(item, kind)),
        serde_json::Value::Object(map) => {
            let is_kind = map.get("ImageType").and_then(|v| v.as_str()) == Some(kind);
            if is_kind {
                if let Some(uri) = map.get("Uri").and_then(|v| v.as_str()) {
                    if uri.starts_with("https://") {
                        return Some(uri.to_string());
                    }
                }
            }
            map.values().find_map(|child| find_image(child, kind))
        }
        _ => None,
    }
}

async fn steam_app(client: &reqwest::Client, name: &str) -> Option<u64> {
    #[derive(Deserialize)]
    struct Search {
        #[serde(default)]
        items: Vec<Hit>,
    }
    #[derive(Deserialize)]
    struct Hit {
        id: u64,
        name: String,
    }
    let search: Search = client
        .get("https://store.steampowered.com/api/storesearch/")
        .query(&[("term", name), ("l", "english"), ("cc", "US")])
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    // Best match, not the first: the exact title must win over a longer one
    // ("Watch Dogs" must not resolve to "Watch Dogs: Legion").
    let query = norm(name);
    let mut best: Option<(usize, u64)> = None;
    for hit in search.items {
        if !names_match(name, &hit.name) {
            continue;
        }
        let extra = norm(&hit.name).len().saturating_sub(query.len());
        if best.map(|(best_extra, _)| extra < best_extra).unwrap_or(true) {
            best = Some((extra, hit.id));
        }
    }
    best.map(|(_, id)| id)
}

pub(crate) fn names_match(query: &str, candidate: &str) -> bool {
    let q = norm(query);
    let c = norm(candidate);
    if q.len() < 3 || c.len() < 3 {
        return false;
    }
    if q == c {
        return true;
    }
    // "Watch Dogs" must not pick "Watch Dogs 2": a trailing number has to agree.
    let trailing_number = |s: &str| {
        s.rsplit(' ')
            .next()
            .filter(|part| !part.is_empty() && part.chars().all(|ch| ch.is_ascii_digit()))
            .map(str::to_string)
    };
    if trailing_number(&q) != trailing_number(&c) {
        return false;
    }
    let (short, long) = if q.len() <= c.len() { (q.as_str(), c.as_str()) } else { (c.as_str(), q.as_str()) };
    if !long.contains(short) {
        return false;
    }
    if short.len() * 100 / long.len() >= 55 {
        return true;
    }
    // "FC 25" inside "EA SPORTS FC 25": two real tokens, not a single short word.
    short.split(' ').filter(|part| !part.is_empty()).count() >= 2 && short.len() >= 5
}

fn norm(value: &str) -> String {
    let mut out = String::new();
    let mut space = false;
    for ch in value.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            space = false;
        } else if !out.is_empty() && !space {
            out.push(' ');
            space = true;
        }
    }
    out.trim().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_names_match_editions_and_reject_a_different_game() {
        assert!(names_match("No Man's Sky", "No Man's Sky"));
        assert!(names_match("EA SPORTS FC 25", "FC 25"));
        assert!(!names_match("No Man's Sky", "Sky"));
        assert!(!names_match("Minecraft Launcher", "Minecraft Dungeons"));
        // A sequel is not the same game.
        assert!(!names_match("Watch Dogs", "Watch Dogs 2"));
        assert!(!names_match("Far Cry 5", "Far Cry 6"));
        assert!(names_match("Watch Dogs 2", "WATCH_DOGS® 2"));
    }

    #[test]
    fn poster_url_is_taken_from_the_store_payload() {
        let json = serde_json::json!({"Products":[{"Images":[
            {"ImageType":"screenshot","Uri":"https://store-images.s-microsoft.com/image/shot"},
            {"ImageType":"Poster","Uri":"https://store-images.s-microsoft.com/image/poster"}
        ]}]});
        assert_eq!(
            find_image(&json, "Poster").as_deref(),
            Some("https://store-images.s-microsoft.com/image/poster")
        );
    }
}
