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
}

#[derive(Debug, Deserialize)]
struct SteamGridResponse<T> {
    success: bool,
    #[serde(default = "Vec::new")]
    data: Vec<T>,
    #[serde(default)]
    errors: Option<Vec<String>>,
}

/// Arama terimini SteamGridDB için optimize eder (edisyon ve yayıncı takılarını temizler).
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
        .map_err(|e| format!("HTTP istemci hatası: {}", e))?;

    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .send()
        .await
        .map_err(|e| format!("SteamGridDB bağlantı hatası: {}", e))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Geçersiz veya yetkisiz SteamGridDB API anahtarı".to_string());
    }
    if !status.is_success() {
        return Err(format!("SteamGridDB arama hatası (HTTP {})", status.as_u16()));
    }

    let text = res.text().await.map_err(|e| format!("Yanıt okunamadı: {}", e))?;
    let parsed: SteamGridResponse<SteamGridGame> = serde_json::from_str(&text)
        .map_err(|e| format!("SteamGridDB veri formatı hatası: {}", e))?;

    if parsed.success {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
        if let Ok(serialized) = serde_json::to_string_pretty(&parsed.data) {
            let _ = tokio::fs::write(&cache_file, serialized).await;
        }
        Ok(parsed.data)
    } else {
        let err_msg = parsed.errors.and_then(|e| e.first().cloned()).unwrap_or_else(|| "Bilinmeyen arama hatası".to_string());
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
    let dim = dimensions.unwrap_or_else(|| "600x900,342x482,660x930".to_string());
    let st = styles.unwrap_or_default();
    let tp = types.unwrap_or_else(|| "static,animated".to_string());

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
                return Ok(images);
            }
        }
    }

    let mut query_params = vec![
        ("dimensions", dim.clone()),
        ("types", tp.clone()),
        ("nsfw", "false".to_string()),
    ];
    if !st.trim().is_empty() {
        query_params.push(("styles", st.clone()));
    }

    let url = format!("https://www.steamgriddb.com/api/v2/grids/game/{}", game_id);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP istemci hatası: {}", e))?;

    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .query(&query_params)
        .send()
        .await
        .map_err(|e| format!("SteamGridDB bağlantı hatası: {}", e))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Geçersiz veya yetkisiz SteamGridDB API anahtarı".to_string());
    }
    if !status.is_success() {
        return Err(format!("SteamGridDB kapak getirme hatası (HTTP {})", status.as_u16()));
    }

    let text = res.text().await.map_err(|e| format!("Yanıt okunamadı: {}", e))?;
    let parsed: SteamGridResponse<SteamGridImage> = serde_json::from_str(&text)
        .map_err(|e| format!("SteamGridDB veri formatı hatası: {}", e))?;

    if parsed.success {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
        if let Ok(serialized) = serde_json::to_string_pretty(&parsed.data) {
            let _ = tokio::fs::write(&cache_file, serialized).await;
        }
        Ok(parsed.data)
    } else {
        let err_msg = parsed.errors.and_then(|e| e.first().cloned()).unwrap_or_else(|| "Kapaklar yüklenemedi".to_string());
        Err(err_msg)
    }
}

pub async fn get_heroes(
    api_key: &str,
    game_id: u64,
    styles: Option<String>,
) -> Result<Vec<SteamGridImage>, String> {
    let st = styles.unwrap_or_default();
    let cache_dir = steamgrid_cache_dir();
    let cache_file = cache_dir.join(format!("heroes_{}_{}.json", game_id, sanitize_filename(&st)));

    if cache_file.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(images) = serde_json::from_str::<Vec<SteamGridImage>>(&content) {
                return Ok(images);
            }
        }
    }

    let mut query_params = vec![("types", "static,animated".to_string()), ("nsfw", "false".to_string())];
    if !st.trim().is_empty() {
        query_params.push(("styles", st.clone()));
    }

    let url = format!("https://www.steamgriddb.com/api/v2/heroes/game/{}", game_id);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP istemci hatası: {}", e))?;

    let res = client
        .get(&url)
        .header("Authorization", format!("Bearer {}", api_key))
        .query(&query_params)
        .send()
        .await
        .map_err(|e| format!("SteamGridDB bağlantı hatası: {}", e))?;

    let status = res.status();
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("Geçersiz veya yetkisiz SteamGridDB API anahtarı".to_string());
    }
    if !status.is_success() {
        return Err(format!("SteamGridDB afiş getirme hatası (HTTP {})", status.as_u16()));
    }

    let text = res.text().await.map_err(|e| format!("Yanıt okunamadı: {}", e))?;
    let parsed: SteamGridResponse<SteamGridImage> = serde_json::from_str(&text)
        .map_err(|e| format!("SteamGridDB veri formatı hatası: {}", e))?;

    if parsed.success {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
        if let Ok(serialized) = serde_json::to_string_pretty(&parsed.data) {
            let _ = tokio::fs::write(&cache_file, serialized).await;
        }
        Ok(parsed.data)
    } else {
        let err_msg = parsed.errors.and_then(|e| e.first().cloned()).unwrap_or_else(|| "Afişler yüklenemedi".to_string());
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
        return Err("Lütfen bir API anahtarı girin".to_string());
    }
    // Basit bir test araması
    let _ = search_games(trimmed, "Portal").await?;
    Ok(true)
}

#[tauri::command]
pub async fn epic_search_steamgrid(
    app: AppHandle,
    term: String,
) -> Result<Vec<SteamGridGame>, String> {
    let key = epic_get_steamgrid_key(app)
        .ok_or_else(|| "SteamGridDB API anahtarı yapılandırılmamış".to_string())?;
    let mut results = search_games(&key, &term).await?;
    if results.is_empty() {
        let cleaned = clean_steamgrid_search_term(&term);
        if cleaned != term && !cleaned.is_empty() {
            results = search_games(&key, &cleaned).await?;
        }
    }
    Ok(results)
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
        .ok_or_else(|| "SteamGridDB API anahtarı yapılandırılmamış".to_string())?;
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
}
