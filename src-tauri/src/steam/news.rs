//! Patch notes and announcements for a Steam app.
//!
//! The public `ISteamNews` endpoint needs no key and answers with real patch
//! notes, which is the one feed a launcher can show without scraping a timeline
//! or embedding somebody else's page. Steam is the only store here with such an
//! endpoint: for a game it does not list, the card is simply absent.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// News changes slowly; half an hour is plenty, and a page opened twice does not
/// ask twice.
const CACHE_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_COUNT: u32 = 10;

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SteamNewsItem {
    pub title: String,
    pub url: String,
    /// Epoch seconds.
    pub date: i64,
    /// Steam's own feed name ("Community Announcements", …).
    pub feed: String,
    /// True when Steam tagged it as a patch note.
    pub patch_notes: bool,
}

static CACHE: Mutex<Option<HashMap<String, (Instant, Vec<SteamNewsItem>)>>> = Mutex::new(None);

/// Reads the endpoint's answer. Pure, so the shape is testable without a network.
fn parse_news(body: &serde_json::Value) -> Vec<SteamNewsItem> {
    body.get("appnews")
        .and_then(|news| news.get("newsitems"))
        .and_then(|items| items.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let title = item.get("title")?.as_str()?.trim().to_string();
                    if title.is_empty() {
                        return None;
                    }
                    Some(SteamNewsItem {
                        title,
                        url: item.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string(),
                        date: item.get("date").and_then(|d| d.as_i64()).unwrap_or(0),
                        feed: item
                            .get("feedlabel")
                            .and_then(|f| f.as_str())
                            .unwrap_or("")
                            .to_string(),
                        patch_notes: item
                            .get("tags")
                            .and_then(|t| t.as_array())
                            .map(|tags| tags.iter().any(|tag| tag.as_str() == Some("patchnotes")))
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// The last few announcements for a Steam app, newest first.
#[tauri::command]
pub async fn steam_news(app_id: String, count: u32) -> Result<Vec<SteamNewsItem>, String> {
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("@t:steam.newsFailed".to_string());
    }
    let count = count.clamp(1, MAX_COUNT);
    let key = format!("{app_id}:{count}");

    if let Ok(guard) = CACHE.lock() {
        if let Some(map) = guard.as_ref() {
            if let Some((at, items)) = map.get(&key) {
                if at.elapsed() < CACHE_TTL {
                    return Ok(items.clone());
                }
            }
        }
    }

    let url = format!(
        "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid={app_id}&count={count}&maxlength=400&format=json"
    );
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| "@t:steam.newsFailed".to_string())?;
    let response = client
        .get(&url)
        .send()
        .await
        .map_err(|_| "@t:steam.newsFailed".to_string())?;
    if !response.status().is_success() {
        return Err("@t:steam.newsFailed".to_string());
    }
    let body: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "@t:steam.newsFailed".to_string())?;
    let items = parse_news(&body);

    if let Ok(mut guard) = CACHE.lock() {
        guard
            .get_or_insert_with(HashMap::new)
            .insert(key, (Instant::now(), items.clone()));
    }
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_shape_is_read_into_items() {
        let body = serde_json::json!({
            "appnews": {
                "appid": 730,
                "newsitems": [
                    {
                        "title": "Counter-Strike 2 Update",
                        "url": "https://store.steampowered.com/news/1",
                        "date": 1792018968,
                        "feedlabel": "Community Announcements",
                        "tags": ["patchnotes", "mod_reviewed"]
                    },
                    { "title": "   ", "url": "https://x", "date": 1 },
                    {
                        "title": "Summer Sale",
                        "url": "https://store.steampowered.com/news/2",
                        "date": 1791000000,
                        "feedlabel": "Steam News"
                    }
                ]
            }
        });
        let items = parse_news(&body);
        assert_eq!(items.len(), 2, "the blank title is dropped");
        assert_eq!(items[0].title, "Counter-Strike 2 Update");
        assert!(items[0].patch_notes, "the patchnotes tag is read");
        assert_eq!(items[0].feed, "Community Announcements");
        assert!(!items[1].patch_notes);
        assert_eq!(items[1].date, 1791000000);
    }

    #[test]
    fn an_answer_without_items_is_empty_not_an_error() {
        assert!(parse_news(&serde_json::json!({})).is_empty());
        assert!(parse_news(&serde_json::json!({ "appnews": { "newsitems": [] } })).is_empty());
    }
}
