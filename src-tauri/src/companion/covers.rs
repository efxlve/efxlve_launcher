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
    /// Cover the caller already has (client catalog). It always wins; the
    /// resolver only fills the missing half (usually the wide hero).
    #[serde(default)]
    pub cover: String,
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

/// Drops one store's cached art so a fresh import (or a better matcher) can
/// resolve it again. Other stores keep their cache.
pub(crate) fn clear_store(store: &str) {
    let mut cache = load_cache();
    let before = cache.len();
    let prefix = format!("{store}::");
    cache.retain(|key, _| !key.starts_with(&prefix));
    if cache.len() != before {
        save_cache(&cache);
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
        let (cached_cover, cached_hero) = cached_cover(&cache, &query.store, &query.id);
        // The caller's catalog cover outranks the cached Steam cover.
        let known_cover = if query.cover.is_empty() { cached_cover } else { query.cover.clone() };
        if !known_cover.is_empty() && !cached_hero.is_empty() {
            hits.push(CoverHit { store: query.store, id: query.id, cover_url: known_cover, hero_url: cached_hero });
            continue;
        }
        pending.push(query);
        if pending.len() >= 48 {
            break;
        }
    }
    for query in pending {
        // Keep whatever the caller already had; the fetch only fills the gap.
        let requested_cover = query.cover.clone();
        let Some((query, fetched_cover, hero)) = fetch_one(client.clone(), query).await else {
            continue;
        };
        if fetched_cover.is_empty() && hero.is_empty() {
            continue;
        }
        let cover = if requested_cover.is_empty() { fetched_cover } else { requested_cover };
        cache.insert(cache_key(&query.store, &query.id), CachedArt { cover: cover.clone(), hero: hero.clone() });
        hits.push(CoverHit { store: query.store, id: query.id, cover_url: cover, hero_url: hero });
    }
    save_cache(&cache);
    hits
}

async fn fetch_one(client: reqwest::Client, query: CoverQuery) -> Option<(CoverQuery, String, String)> {
    // Xbox rows carry a Store id: the product page knows both the poster and
    // the wide art, so the portrait is never stretched into the banner.
    let xbox = if !query.store_id.is_empty() {
        xbox_art(&client, &query.store_id).await
    } else {
        None
    };
    let steam = steam_app(&client, &query.name).await;
    let cover = xbox
        .as_ref()
        .map(|(cover, _)| cover.clone())
        .filter(|cover| !cover.is_empty())
        .or_else(|| steam.map(steam_cover))
        .unwrap_or_default();
    let hero = xbox
        .as_ref()
        .map(|(_, hero)| hero.clone())
        .filter(|hero| !hero.is_empty())
        .or_else(|| steam.map(steam_hero))
        .unwrap_or_default();
    if !cover.is_empty() || !hero.is_empty() {
        return Some((query, cover, hero));
    }
    // Riot's PC titles are not on Steam: fall back to the game's own share
    // image, which the site publishes for link previews.
    if query.store == "riot" {
        if let Some(image) = riot_share_image(&client, &query.id).await {
            return Some((query, image.clone(), image));
        }
    }
    None
}

fn steam_cover(app: u64) -> String {
    format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{app}/library_600x900.jpg")
}

fn steam_hero(app: u64) -> String {
    format!("https://cdn.cloudflare.steamstatic.com/steam/apps/{app}/library_hero.jpg")
}

/// Microsoft Store images are tiny until a size is requested, and the title
/// APIs hand out plain `http://` links. Non-Store hosts pass through.
pub(crate) fn sized_store_image(url: &str, width: u32) -> String {
    let url = url.trim();
    if url.is_empty() {
        return String::new();
    }
    let mut url = url.to_string();
    if let Some(rest) = url.strip_prefix("http://") {
        url = format!("https://{rest}");
    }
    if !url.contains("store-images.s-microsoft.com") || url.contains('?') {
        return url;
    }
    format!("{url}?q=90&w={width}")
}

/// Official Riot pages used only to resolve a share image for the four titles.
const RIOT_SITES: &[(&str, &str)] = &[
    ("league_of_legends", "https://www.leagueoflegends.com/en-us/"),
    ("bacon", "https://playruneterra.com/en-us/"),
    ("valorant", "https://playvalorant.com/en-us/"),
    ("lion", "https://2xko.riotgames.com/en-us/"),
];

async fn riot_share_image(client: &reqwest::Client, id: &str) -> Option<String> {
    let url = RIOT_SITES.iter().find(|(code, _)| *code == id)?.1;
    let html = client.get(url).send().await.ok()?.text().await.ok()?;
    let image = html_meta_content(&html, "og:image")?;
    Some(image.replace("&amp;", "&"))
}

/// `content` of the first `<meta>` tag whose attributes mention `property`.
pub(crate) fn html_meta_content(html: &str, property: &str) -> Option<String> {
    let mut rest = html;
    while let Some(start) = rest.find("<meta") {
        let end = rest[start..].find('>').map(|idx| idx + start)?;
        let tag = &rest[start..end];
        if tag.contains(property) {
            let content = tag.find("content=\"")? + "content=\"".len();
            let value_end = tag[content..].find('"')? + content;
            let value = tag[content..value_end].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
        rest = &rest[end + 1..];
    }
    None
}

async fn xbox_art(client: &reqwest::Client, store_id: &str) -> Option<(String, String)> {
    if !store_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let url = format!(
        "https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/{store_id}?market=US&locale=en-US&deviceFamily=Windows.Desktop"
    );
    let value: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;
    Some(xbox_art_urls(&value))
}

/// (cover, hero) from a displaycatalog product payload, sized for use. The
/// wide kinds win: `BrandedKeyArt` is often a portrait.
pub(crate) fn xbox_art_urls(value: &serde_json::Value) -> (String, String) {
    let cover = find_image(value, "Poster")
        .or_else(|| find_image(value, "BoxArt"))
        .unwrap_or_default();
    let hero = find_image(value, "SuperHeroArt")
        .or_else(|| find_image(value, "TitledHeroArt"))
        .or_else(|| find_image(value, "Hero"))
        .or_else(|| find_image(value, "TransparentKeyArt"))
        .or_else(|| find_image(value, "BrandedKeyArt"))
        .or_else(|| find_image(value, "Background"))
        .unwrap_or_default();
    (sized_store_image(&cover, 720), sized_store_image(&hero, 1920))
}

fn find_image(value: &serde_json::Value, kind: &str) -> Option<String> {
    match value {
        serde_json::Value::Array(items) => items.iter().find_map(|item| find_image(item, kind)),
        serde_json::Value::Object(map) => {
            let is_kind = map.get("ImageType").and_then(|v| v.as_str()) == Some(kind);
            if is_kind {
                if let Some(uri) = map.get("Uri").and_then(|v| v.as_str()) {
                    // `sized_store_image` upgrades plain http links later.
                    if uri.starts_with("https://") || uri.starts_with("http://") {
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

    #[test]
    fn store_images_get_a_size_and_https() {
        assert_eq!(
            sized_store_image("http://store-images.s-microsoft.com/image/apps.1.2", 1920),
            "https://store-images.s-microsoft.com/image/apps.1.2?q=90&w=1920"
        );
        // A URL that already carries a size is left alone.
        assert_eq!(
            sized_store_image("https://store-images.s-microsoft.com/image/apps.1.2?w=100", 1920),
            "https://store-images.s-microsoft.com/image/apps.1.2?w=100"
        );
        assert_eq!(sized_store_image("https://cdn.example/a.jpg", 720), "https://cdn.example/a.jpg");
        assert_eq!(sized_store_image("", 720), "");
    }

    #[test]
    fn xbox_art_sizes_the_poster_and_never_uses_portrait_key_art_as_hero() {
        let json = serde_json::json!({"Products":[{"Images":[
            {"ImageType":"Poster","Uri":"http://store-images.s-microsoft.com/image/poster"},
            {"ImageType":"BrandedKeyArt","Uri":"http://store-images.s-microsoft.com/image/branded"},
            {"ImageType":"SuperHeroArt","Uri":"http://store-images.s-microsoft.com/image/hero"}
        ]}]});
        let (cover, hero) = xbox_art_urls(&json);
        assert_eq!(cover, "https://store-images.s-microsoft.com/image/poster?q=90&w=720");
        assert_eq!(hero, "https://store-images.s-microsoft.com/image/hero?q=90&w=1920");

        // Only a portrait key art: it is still better than nothing.
        let only_branded = serde_json::json!({"Products":[{"Images":[
            {"ImageType":"BrandedKeyArt","Uri":"http://store-images.s-microsoft.com/image/branded"}
        ]}]});
        let (_, hero) = xbox_art_urls(&only_branded);
        assert_eq!(hero, "https://store-images.s-microsoft.com/image/branded?q=90&w=1920");
    }

    #[test]
    fn share_image_reads_the_meta_tag_in_any_attribute_order() {
        let a = r#"<head><meta property="og:image" content="https://cdn.example/a.jpg" /><meta property="og:title" content="x" /></head>"#;
        assert_eq!(html_meta_content(a, "og:image").as_deref(), Some("https://cdn.example/a.jpg"));
        let b = r#"<meta content="https://cdn.example/b.jpg" property="og:image">"#;
        assert_eq!(html_meta_content(b, "og:image").as_deref(), Some("https://cdn.example/b.jpg"));
        assert_eq!(html_meta_content("<head></head>", "og:image"), None);
        assert_eq!(html_meta_content(r#"<meta property="og:image" content="">"#, "og:image"), None);
    }
}
