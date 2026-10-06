//! Box art and studio names for companion games.
//!
//! Xbox titles use the public Microsoft Store poster for their StoreId.
//! Everything else uses Steam's public store search and the portrait CDN, and
//! the same match supplies the developer. Results are cached so the library
//! does not search again on every launch.

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
    /// Studio resolved for the matched release (empty when nothing matched).
    pub developer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub(crate) struct CachedArt {
    pub(crate) cover: String,
    pub(crate) hero: String,
    /// Studio name for the matched release.
    #[serde(default)]
    pub(crate) developer: String,
    /// True once a developer lookup ran, so an empty result is not retried on
    /// every launch.
    #[serde(default)]
    dev_checked: bool,
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

pub(crate) fn cached_art(cache: &HashMap<String, CachedArt>, store: &str, id: &str) -> CachedArt {
    cache.get(&cache_key(store, id)).cloned().unwrap_or_default()
}

/// Official art for Riot titles whose site share image reads wrong on a card.
/// VALORANT's `og:image` is a 128px icon on a white background, which looks
/// like an empty tile in the dark library; the Ascent map splash is official
/// key art with the right aspect for both the portrait card and the wide hero.
const RIOT_ART: &[(&str, &str)] = &[(
    "valorant",
    "https://media.valorant-api.com/maps/7eaecc1b-4337-bbf6-6ab9-04b8f06b3319/splash.png",
)];

fn riot_art(id: &str) -> Option<&'static str> {
    RIOT_ART.iter().find(|(code, _)| *code == id).map(|(_, url)| *url)
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
        // Hardcoded official art wins over anything cached: an older cache may
        // still hold the share image it replaces.
        if let Some(url) = riot_art(&query.id).filter(|_| query.store == "riot") {
            let developer = "Riot Games".to_string();
            cache.insert(
                cache_key(&query.store, &query.id),
                CachedArt { cover: url.to_string(), hero: url.to_string(), developer: developer.clone(), dev_checked: true },
            );
            hits.push(CoverHit {
                store: query.store,
                id: query.id,
                cover_url: url.to_string(),
                hero_url: url.to_string(),
                developer,
            });
            continue;
        }
        let art = cached_art(&cache, &query.store, &query.id);
        // The caller's catalog cover outranks the cached Steam cover.
        let known_cover = if query.cover.is_empty() { art.cover } else { query.cover.clone() };
        if !known_cover.is_empty() && !art.hero.is_empty() && art.dev_checked {
            hits.push(CoverHit {
                store: query.store,
                id: query.id,
                cover_url: known_cover,
                hero_url: art.hero,
                developer: art.developer,
            });
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
        let Some((query, fetched_cover, hero, developer)) = fetch_one(client.clone(), query).await else {
            continue;
        };
        if fetched_cover.is_empty() && hero.is_empty() && developer.is_empty() {
            continue;
        }
        let cover = if requested_cover.is_empty() { fetched_cover } else { requested_cover };
        cache.insert(
            cache_key(&query.store, &query.id),
            CachedArt { cover: cover.clone(), hero: hero.clone(), developer: developer.clone(), dev_checked: true },
        );
        hits.push(CoverHit { store: query.store, id: query.id, cover_url: cover, hero_url: hero, developer });
    }
    save_cache(&cache);
    hits
}

async fn fetch_one(client: reqwest::Client, query: CoverQuery) -> Option<(CoverQuery, String, String, String)> {
    // Xbox rows carry a Store id: the product page knows both the poster and
    // the wide art, so the portrait is never stretched into the banner.
    let xbox = if !query.store_id.is_empty() {
        xbox_art(&client, &query.store_id).await
    } else {
        None
    };
    let steam = steam_app(&client, &query.name).await;
    let mut cover = xbox
        .as_ref()
        .map(|(cover, _, _)| cover.clone())
        .filter(|cover| !cover.is_empty())
        .or_else(|| steam.map(steam_cover))
        .unwrap_or_default();
    let mut hero = xbox
        .as_ref()
        .map(|(_, hero, _)| hero.clone())
        .filter(|hero| !hero.is_empty())
        .or_else(|| steam.map(steam_hero))
        .unwrap_or_default();
    let mut developer = xbox
        .as_ref()
        .map(|(_, _, developer)| developer.clone())
        .filter(|developer| !developer.is_empty())
        .unwrap_or_default();
    if developer.is_empty() {
        if let Some(app) = steam {
            developer = steam_developer(&client, app).await.unwrap_or_default();
        }
    }
    // Riot's PC titles are not on Steam, and the client catalog has no studio.
    if query.store == "riot" {
        developer = "Riot Games".to_string();
    }
    // Battle.net's product list is Blizzard's own catalog.
    if developer.is_empty() && query.store == "battlenet" {
        developer = "Blizzard Entertainment".to_string();
    }
    if cover.is_empty() && hero.is_empty() && query.store == "riot" {
        // Fall back to the game's own share image, which the site publishes
        // for link previews.
        if let Some(image) = riot_share_image(&client, &query.id).await {
            cover = image.clone();
            hero = image;
        }
    }
    if cover.is_empty() && hero.is_empty() && developer.is_empty() {
        return None;
    }
    Some((query, cover, hero, developer))
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

async fn xbox_art(client: &reqwest::Client, store_id: &str) -> Option<(String, String, String)> {
    if !store_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    let url = format!(
        "https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/{store_id}?market=US&locale=en-US&deviceFamily=Windows.Desktop"
    );
    let value: serde_json::Value = client.get(url).send().await.ok()?.json().await.ok()?;
    let (cover, hero) = xbox_art_urls(&value);
    Some((cover, hero, xbox_developer(&value)))
}

/// `Payload.DeveloperName` names the studio on Microsoft Store products.
pub(crate) fn xbox_developer(value: &serde_json::Value) -> String {
    value
        .pointer("/Payload/DeveloperName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
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

/// Studio for one Steam app. The store endpoint can answer with just the two
/// name lists, so the request stays tiny even for a large companion library.
async fn steam_developer(client: &reqwest::Client, app: u64) -> Option<String> {
    let url = format!(
        "https://store.steampowered.com/api/appdetails?appids={app}&filters=developers,publishers&l=english"
    );
    let value: serde_json::Value = client.get(&url).send().await.ok()?.json().await.ok()?;
    parse_steam_developer(&value)
}

/// First developer, falling back to the publisher, from an appdetails payload.
pub(crate) fn parse_steam_developer(value: &serde_json::Value) -> Option<String> {
    let data = value.as_object()?.values().next()?.get("data")?;
    let first_name = |key: &str| -> Option<String> {
        data.get(key)?
            .as_array()?
            .iter()
            .find_map(|v| v.as_str())
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string)
    };
    first_name("developers").or_else(|| first_name("publishers"))
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

    #[test]
    fn steam_developer_prefers_the_studio_and_falls_back_to_the_publisher() {
        let both = serde_json::json!({
            "431960": {"success": true, "data": {"developers": ["Wallpaper Engine Team"], "publishers": ["Some Publisher"]}}
        });
        assert_eq!(parse_steam_developer(&both).as_deref(), Some("Wallpaper Engine Team"));

        let publisher_only = serde_json::json!({
            "730": {"success": true, "data": {"developers": [], "publishers": ["Valve"]}}
        });
        assert_eq!(parse_steam_developer(&publisher_only).as_deref(), Some("Valve"));

        let failed = serde_json::json!({"999": {"success": false}});
        assert!(parse_steam_developer(&failed).is_none());
    }

    #[test]
    fn xbox_developer_reads_the_payload_field() {
        let json = serde_json::json!({"Payload": {"DeveloperName": "Mojang/Microsoft Studios"}});
        assert_eq!(xbox_developer(&json), "Mojang/Microsoft Studios");
        assert_eq!(xbox_developer(&serde_json::json!({})), "");
        assert_eq!(xbox_developer(&serde_json::json!({"Payload": {"DeveloperName": ""}})), "");
    }
}
