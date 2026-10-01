use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::AppHandle;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SteamGridAuthor {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub steam64: Option<String>,
    #[serde(default)]
    pub avatar: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SteamGridImage {
    pub id: u64,
    #[serde(default)]
    pub score: i64,
    #[serde(default)]
    pub style: Option<String>,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub nsfw: Option<bool>,
    #[serde(default)]
    pub humor: Option<bool>,
    #[serde(default)]
    pub epilepsy: Option<bool>,
    pub url: String,
    #[serde(default)]
    pub thumb: Option<String>,
    #[serde(default)]
    pub author: Option<SteamGridAuthor>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SteamGridGame {
    pub id: u64,
    pub name: String,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default)]
    pub verified: Option<bool>,
    /// Set when this row came from `/games/steam/{appid}`, not the name search.
    #[serde(default, rename = "matchedSteam")]
    pub matched_steam: bool,
}

#[derive(Debug, Deserialize)]
struct SteamGridResponse<T> {
    success: bool,
    #[serde(default = "Vec::new")]
    data: Vec<T>,
    #[serde(default)]
    errors: Option<Vec<String>>,
}

/// Optimizes the search term for SteamGridDB (strips edition and publisher suffixes).
pub fn clean_steamgrid_search_term(title: &str) -> String {
    let mut s = title.to_string();

    let prefixes = [
        "Tom Clancy's ",
        "Marvel's ",
        "Sid Meier's ",
        "Disney's ",
        "EA SPORTS™ ",
        "EA SPORTS ",
        "Star Wars™ ",
        "STAR WARS™ ",
        "STAR WARS ",
        "Warhammer 40,000: ",
        "Warhammer: ",
    ];
    for p in prefixes {
        if s.starts_with(p) {
            s = s[p.len()..].to_string();
        }
    }

    if let Some(pos) = s.find(" - ") {
        let sub = &s[pos + 3..];
        if sub.to_lowercase().contains("edition")
            || sub.to_lowercase().contains("cut")
            || sub.to_lowercase().contains("version")
        {
            s = s[..pos].to_string();
        }
    }

    let edition_suffixes = [
        " Standard Edition",
        " Enhanced Edition",
        " Definitive Edition",
        " Gold Edition",
        " Deluxe Edition",
        " Complete Edition",
        " Game of the Year Edition",
        " GOTY Edition",
        " Special Edition",
        " Remastered",
        " Director's Cut",
    ];
    for suffix in edition_suffixes {
        if let Some(pos) = s.to_lowercase().find(&suffix.to_lowercase()) {
            s = s[..pos].to_string();
        }
    }

    s.trim().to_string()
}

fn steamgrid_cache_dir() -> PathBuf {
    let base = std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".config"))
        .unwrap_or_else(|| PathBuf::from("."));
    base.join("legendary").join("steamgrid")
}

fn sanitize_filename(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | ' ' => '_',
            _ => c,
        })
        .collect()
}

/// SteamGridDB treats commas as list separators inside one parameter.
/// `reqwest`'s query encoder turns them into `%2C`, and the API answers
/// HTTP 400 for that encoding, so the query string is appended literally.
fn sgdb_url(path: &str, params: &[(&str, &str)]) -> String {
    let mut url = format!("https://www.steamgriddb.com/api/v2/{path}");
    let mut first = true;
    for (key, value) in params {
        if value.is_empty() {
            continue;
        }
        url.push(if first { '?' } else { '&' });
        first = false;
        url.push_str(key);
        url.push('=');
        url.push_str(value);
    }
    url
}

/// `official` is a picker filter, not a SteamGridDB style. Sending it
/// (`styles=official`) is rejected with HTTP 400.
fn style_for_api(styles: Option<&str>) -> &str {
    match styles.map(str::trim) {
        Some("") | Some("official") | None => "",
        Some(other) => other,
    }
}

fn apply_style_filter(images: Vec<SteamGridImage>, styles: Option<&str>) -> Vec<SteamGridImage> {
    if styles.map(str::trim) != Some("official") {
        return images;
    }
    let official: Vec<_> = images
        .iter()
        .filter(|img| {
            matches!(
                img.style.as_deref().map(str::trim),
                None | Some("") | Some("official") | Some("white_logo")
            )
        })
        .cloned()
        .collect();
    if official.is_empty() {
        images
    } else {
        official
    }
}

async fn sgdb_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("@t:cover.httpClientFailed\u{1f}{}", e))
}

/// GET a SteamGridDB URL. A 400 is retried once without query filters, because
/// an over-strict dimension/type combination is still a bad request while the
/// unfiltered game endpoint usually succeeds.
async fn sgdb_fetch(api_key: &str, url: &str, bare: &str) -> Result<(reqwest::StatusCode, String), String> {
    let client = sgdb_client().await?;
    let first = client
        .get(url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("@t:cover.connectFailed\u{1f}{}", e))?;
    if first.status() == reqwest::StatusCode::BAD_REQUEST && url != bare {
        let second = client
            .get(bare)
            .header("Authorization", format!("Bearer {}", api_key))
            .send()
            .await
            .map_err(|e| format!("@t:cover.connectFailed\u{1f}{}", e))?;
        let status = second.status();
        let text = second
            .text()
            .await
            .map_err(|e| format!("@t:cover.readFailed\u{1f}{}", e))?;
        return Ok((status, text));
    }
    let status = first.status();
    let text = first
        .text()
        .await
        .map_err(|e| format!("@t:cover.readFailed\u{1f}{}", e))?;
    Ok((status, text))
}

pub async fn search_games(api_key: &str, term: &str) -> Result<Vec<SteamGridGame>, String> {
    let trimmed_term = term.trim();
    if trimmed_term.is_empty() {
        return Ok(Vec::new());
    }

    let cache_dir = steamgrid_cache_dir();
    let cache_file = cache_dir.join(format!("search_{}.json", sanitize_filename(trimmed_term)));

    if cache_file.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(games) = serde_json::from_str::<Vec<SteamGridGame>>(&content) {
                return Ok(games);
            }
        }
    }

    let encoded_term: String = url::form_urlencoded::byte_serialize(trimmed_term.as_bytes()).collect();
    let url = format!("https://www.steamgriddb.com/api/v2/search/autocomplete/{}", encoded_term);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("@t:cover.httpClientFailed\u{1f}{}", e))?;

    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("@t:cover.connectFailed\u{1f}{}", e))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("@t:cover.invalidKey".to_string());
    }
    if !status.is_success() {
        return Err(format!("@t:cover.searchFailed\u{1f}{}", status.as_u16()));
    }

    let text = res.text().await.map_err(|e| format!("@t:cover.readFailed\u{1f}{}", e))?;
    let parsed: SteamGridResponse<SteamGridGame> = serde_json::from_str(&text)
        .map_err(|e| format!("@t:cover.formatFailed\u{1f}{}", e))?;

    if parsed.success {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
        if let Ok(serialized) = serde_json::to_string_pretty(&parsed.data) {
            let _ = tokio::fs::write(&cache_file, serialized).await;
        }
        Ok(parsed.data)
    } else {
        let err_msg = parsed.errors.and_then(|e| e.first().cloned()).unwrap_or_else(|| "@t:cover.unknownSearchError".to_string());
        Err(err_msg)
    }
}

pub async fn get_grids(
    api_key: &str,
    game_id: u64,
    dimensions: Option<String>,
    styles: Option<String>,
    types: Option<String>,
) -> Result<Vec<SteamGridImage>, String> {
    let wanted = styles.clone();
    let dim = dimensions.unwrap_or_else(|| "600x900,342x482,660x930".to_string());
    let st = style_for_api(styles.as_deref()).to_string();
    let tp = types.unwrap_or_else(|| "static".to_string());

    let cache_dir = steamgrid_cache_dir();
    let cache_file = cache_dir.join(format!(
        "grids_{}_{}_{}_{}.json",
        game_id,
        sanitize_filename(&dim),
        sanitize_filename(&st),
        sanitize_filename(&tp)
    ));

    if cache_file.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(images) = serde_json::from_str::<Vec<SteamGridImage>>(&content) {
                return Ok(apply_style_filter(images, wanted.as_deref()));
            }
        }
    }

    let mut pairs = vec![
        ("dimensions", dim.as_str()),
        ("types", tp.as_str()),
        ("nsfw", "false"),
    ];
    if !st.trim().is_empty() {
        pairs.push(("styles", st.trim()));
    }
    let bare = format!("https://www.steamgriddb.com/api/v2/grids/game/{game_id}");
    let url = sgdb_url(&format!("grids/game/{game_id}"), &pairs);
    let (status, text) = sgdb_fetch(api_key, &url, &bare).await?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("@t:cover.invalidKey".to_string());
    }
    if !status.is_success() {
        return Err(format!("@t:cover.coversFailed\u{1f}{}", status.as_u16()));
    }
    let parsed: SteamGridResponse<SteamGridImage> = serde_json::from_str(&text)
        .map_err(|e| format!("@t:cover.formatFailed\u{1f}{}", e))?;

    if parsed.success {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
        if let Ok(serialized) = serde_json::to_string_pretty(&parsed.data) {
            let _ = tokio::fs::write(&cache_file, serialized).await;
        }
        Ok(apply_style_filter(parsed.data, wanted.as_deref()))
    } else {
        let err_msg = parsed.errors.and_then(|e| e.first().cloned()).unwrap_or_else(|| "@t:cover.coversLoadFailed".to_string());
        Err(err_msg)
    }
}

pub async fn get_heroes(
    api_key: &str,
    game_id: u64,
    styles: Option<String>,
) -> Result<Vec<SteamGridImage>, String> {
    let wanted = styles.clone();
    let st = style_for_api(styles.as_deref()).to_string();
    let cache_dir = steamgrid_cache_dir();
    let cache_file = cache_dir.join(format!("heroes_{}_{}.json", game_id, sanitize_filename(&st)));

    if cache_file.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(images) = serde_json::from_str::<Vec<SteamGridImage>>(&content) {
                return Ok(apply_style_filter(images, wanted.as_deref()));
            }
        }
    }

    let mut pairs = vec![("types", "static"), ("nsfw", "false")];
    if !st.trim().is_empty() {
        pairs.push(("styles", st.trim()));
    }
    let bare = format!("https://www.steamgriddb.com/api/v2/heroes/game/{game_id}");
    let url = sgdb_url(&format!("heroes/game/{game_id}"), &pairs);
    let (status, text) = sgdb_fetch(api_key, &url, &bare).await?;
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("@t:cover.invalidKey".to_string());
    }
    if !status.is_success() {
        return Err(format!("@t:cover.heroesFailed\u{1f}{}", status.as_u16()));
    }
    let parsed: SteamGridResponse<SteamGridImage> = serde_json::from_str(&text)
        .map_err(|e| format!("@t:cover.formatFailed\u{1f}{}", e))?;

    if parsed.success {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
        if let Ok(serialized) = serde_json::to_string_pretty(&parsed.data) {
            let _ = tokio::fs::write(&cache_file, serialized).await;
        }
        Ok(apply_style_filter(parsed.data, wanted.as_deref()))
    } else {
        let err_msg = parsed.errors.and_then(|e| e.first().cloned()).unwrap_or_else(|| "@t:cover.heroesLoadFailed".to_string());
        Err(err_msg)
    }
}

// ---------------- TAURI COMMANDS ----------------

#[tauri::command]
pub fn epic_get_steamgrid_key(app: AppHandle) -> Option<String> {
    let s = crate::load_settings(&app);
    s.steamgrid_api_key.filter(|k| !k.trim().is_empty())
}

#[tauri::command]
pub fn epic_set_steamgrid_key(app: AppHandle, api_key: String) -> Result<(), String> {
    let mut s = crate::load_settings(&app);
    let trimmed = api_key.trim().to_string();
    if trimmed.is_empty() {
        s.steamgrid_api_key = None;
    } else {
        s.steamgrid_api_key = Some(trimmed);
    }
    crate::save_settings(&app, &s);
    Ok(())
}

#[tauri::command]
pub async fn epic_test_steamgrid_key(api_key: String) -> Result<bool, String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("@t:cover.enterKey".to_string());
    }
    // A simple test search
    let _ = search_games(trimmed, "Portal").await?;
    Ok(true)
}

#[tauri::command]
pub async fn epic_search_steamgrid(
    app: AppHandle,
    term: String,
    steam_app_id: Option<String>,
) -> Result<Vec<SteamGridGame>, String> {
    let key = epic_get_steamgrid_key(app)
        .ok_or_else(|| "@t:cover.keyNotConfigured".to_string())?;
    let mut results = search_games(&key, &term).await?;
    if results.is_empty() {
        let cleaned = clean_steamgrid_search_term(&term);
        if cleaned != term && !cleaned.is_empty() {
            results = search_games(&key, &cleaned).await?;
        }
    }
    let steam_id = steam_app_id
        .as_deref()
        .and_then(|id| id.parse::<u64>().ok())
        .filter(|id| *id > 0);
    if let Some(id) = steam_id {
        let hit = game_by_platform(&key, "steam", id).await;
        results = pin_platform_match(results, hit);
    }
    Ok(results)
}

/// Name search ranks older, more popular games first ("Aion" beats "AION 2").
/// A platform id is one game, so it is pinned ahead of those name hits.
pub fn pin_platform_match(mut games: Vec<SteamGridGame>, hit: Option<SteamGridGame>) -> Vec<SteamGridGame> {
    let Some(mut hit) = hit else {
        return games;
    };
    hit.matched_steam = true;
    games.retain(|game| game.id != hit.id);
    games.insert(0, hit);
    games
}

#[derive(Debug, Deserialize)]
struct SteamGridOne<T> {
    success: bool,
    #[serde(default)]
    data: Option<T>,
}

/// `GET /games/{platform}/{id}`. A 404 means SteamGridDB has no page for that
/// app; the name search is still usable, so this returns `None` instead of an error.
async fn game_by_platform(api_key: &str, platform: &str, platform_id: u64) -> Option<SteamGridGame> {
    let url = format!("https://www.steamgriddb.com/api/v2/games/{platform}/{platform_id}");
    let client = sgdb_client().await.ok()?;
    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let parsed: SteamGridOne<SteamGridGame> = res.json().await.ok()?;
    if !parsed.success {
        return None;
    }
    parsed.data
}

#[tauri::command]
pub async fn epic_get_steamgrid_covers(
    app: AppHandle,
    game_id: u64,
    asset_type: Option<String>,
    styles: Option<String>,
    dimensions: Option<String>,
) -> Result<Vec<SteamGridImage>, String> {
    let key = epic_get_steamgrid_key(app)
        .ok_or_else(|| "@t:cover.keyNotConfigured".to_string())?;
    let at = asset_type.as_deref().unwrap_or("grids");
    if at == "heroes" {
        get_heroes(&key, game_id, styles).await
    } else {
        get_grids(&key, game_id, dimensions, styles, None).await
    }
}

// ---------------- TESTS ----------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_platform_match_is_pinned_ahead_of_older_names() {
        let older = SteamGridGame {
            id: 1,
            name: "Aion".to_string(),
            ..Default::default()
        };
        let sequel = SteamGridGame {
            id: 2,
            name: "AION 2".to_string(),
            ..Default::default()
        };
        let pinned = pin_platform_match(vec![older], Some(sequel));
        assert_eq!(pinned[0].name, "AION 2");
        assert!(pinned[0].matched_steam);
        assert_eq!(pinned.len(), 2);
        assert!(!pinned[1].matched_steam);
    }

    #[test]
    fn pinning_the_same_game_does_not_duplicate_it() {
        let game = SteamGridGame {
            id: 2,
            name: "AION 2".to_string(),
            ..Default::default()
        };
        let pinned = pin_platform_match(vec![game.clone()], Some(game));
        assert_eq!(pinned.len(), 1);
        assert!(pinned[0].matched_steam);
    }

    #[test]
    fn test_clean_steamgrid_search_term() {
        assert_eq!(
            clean_steamgrid_search_term("Cyberpunk 2077 - Standard Edition"),
            "Cyberpunk 2077"
        );
        assert_eq!(
            clean_steamgrid_search_term("Tom Clancy's Rainbow Six Siege"),
            "Rainbow Six Siege"
        );
        assert_eq!(
            clean_steamgrid_search_term("Death Stranding Director's Cut"),
            "Death Stranding"
        );
        assert_eq!(
            clean_steamgrid_search_term("The Witcher 3: Wild Hunt - Game of the Year Edition"),
            "The Witcher 3: Wild Hunt"
        );
    }

    #[test]
    fn test_parse_steamgrid_search_response() {
        let json_data = r#"{
            "success": true,
            "data": [
                {
                    "id": 1234,
                    "name": "Portal 2",
                    "types": ["game"],
                    "verified": true
                }
            ]
        }"#;
        let res: SteamGridResponse<SteamGridGame> = serde_json::from_str(json_data).unwrap();
        assert!(res.success);
        assert_eq!(res.data.len(), 1);
        assert_eq!(res.data[0].id, 1234);
        assert_eq!(res.data[0].name, "Portal 2");
    }

    #[test]
    fn test_parse_steamgrid_grids_response() {
        let json_data = r#"{
            "success": true,
            "data": [
                {
                    "id": 9988,
                    "score": 15,
                    "style": "alternate",
                    "width": 600,
                    "height": 900,
                    "url": "https://cdn2.steamgriddb.com/grid/abc.png",
                    "thumb": "https://cdn2.steamgriddb.com/thumb/abc.jpg",
                    "author": {
                        "name": "ArtistName",
                        "steam64": "76561198000000000"
                    }
                }
            ]
        }"#;
        let res: SteamGridResponse<SteamGridImage> = serde_json::from_str(json_data).unwrap();
        assert!(res.success);
        assert_eq!(res.data.len(), 1);
        assert_eq!(res.data[0].score, 15);
        assert_eq!(res.data[0].style.as_deref(), Some("alternate"));
        assert_eq!(res.data[0].author.as_ref().and_then(|a| a.name.as_deref()), Some("ArtistName"));
    }

    #[test]
    fn test_sgdb_url_keeps_comma_separators() {
        let url = sgdb_url(
            "grids/game/5",
            &[
                ("dimensions", "600x900,342x482,660x930"),
                ("types", "static"),
                ("styles", ""),
            ],
        );
        assert_eq!(
            url,
            "https://www.steamgriddb.com/api/v2/grids/game/5?dimensions=600x900,342x482,660x930&types=static"
        );
        assert!(!url.contains("%2C"));
    }

    #[test]
    fn test_official_style_is_not_sent_to_the_api() {
        assert_eq!(style_for_api(Some("official")), "");
        assert_eq!(style_for_api(Some("no_logo")), "no_logo");
        assert_eq!(style_for_api(None), "");
    }

    #[test]
    fn test_official_filter_keeps_unlabeled_grids() {
        let images = vec![
            SteamGridImage {
                id: 1,
                url: "https://example/a.png".into(),
                style: None,
                ..SteamGridImage::default()
            },
            SteamGridImage {
                id: 2,
                url: "https://example/b.png".into(),
                style: Some("alternate".into()),
                ..SteamGridImage::default()
            },
        ];
        let kept = apply_style_filter(images, Some("official"));
        assert_eq!(kept.len(), 1);
        assert_eq!(kept[0].id, 1);
    }
}
