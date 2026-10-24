//! Patch notes and announcements for a Steam app.
//!
//! The public `ISteamNews` endpoint needs no key and answers with real patch
//! notes, which is the one feed a launcher can show without scraping a timeline
//! or embedding somebody else's page. Steam is the only store here with such an
//! endpoint: for a game it does not list, the card is simply absent.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;
use tauri::{AppHandle, Manager};

/// News changes slowly; half an hour is plenty, and a page opened twice does not
/// ask twice.
const CACHE_TTL_SECS: u64 = 30 * 60;
const MAX_COUNT: u32 = 10;
/// Bump when a stored item gains a field.
const NEWS_SCHEMA: u32 = 1;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
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
    /// The first picture in the body, when it has one. Patch notes are usually
    /// text only, so a feed has to read well without it.
    pub image: String,
    /// The opening of the body as plain text, tags stripped: a headline alone
    /// tells the reader nothing about whether to open it.
    pub snippet: String,
}

/// The first `src` of an image in the announcement body. Steam writes some of
/// them as `{STEAM_CLAN_IMAGE}/<hash>.jpg`, a placeholder whose host the reader
/// has to put back — the raw value is not a URL.
fn first_image(contents: &str) -> String {
    let Some(tag_at) = contents.find("<img") else {
        return String::new();
    };
    let rest = &contents[tag_at..];
    let Some(src_at) = rest.find("src=\"") else {
        return String::new();
    };
    let after = &rest[src_at + 5..];
    let Some(end) = after.find('"') else {
        return String::new();
    };
    let raw = after[..end].trim();
    if raw.starts_with("http://") || raw.starts_with("https://") {
        return raw.to_string();
    }
    if let Some(rest) = raw.strip_prefix("{STEAM_CLAN_IMAGE}") {
        // The placeholder alone is not a picture: the host needs a real path.
        if rest.starts_with('/') && rest.len() > 1 {
            return format!("https://clan.cloudflare.steamstatic.com/images{rest}");
        }
    }
    String::new()
}

/// The body as a short plain-text line: HTML and BBCode tags dropped, whitespace
/// collapsed, cut at a word boundary. Empty when the post is only a headline.
fn snippet(contents: &str) -> String {
    let mut out = String::new();
    let mut in_html = false;
    let mut in_bbcode = false;
    for ch in contents.chars() {
        match ch {
            '<' => in_html = true,
            '>' if in_html => {
                in_html = false;
                out.push(' ');
            }
            '[' if !in_html => in_bbcode = true,
            ']' if in_bbcode => {
                in_bbcode = false;
                out.push(' ');
            }
            '\\' if !in_html && !in_bbcode => out.push(' '),
            _ if !in_html && !in_bbcode => out.push(ch),
            _ => {}
        }
    }
    let text = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if collapsed.chars().count() <= 220 {
        return collapsed;
    }
    let cut: String = collapsed.chars().take(220).collect();
    match cut.rsplit_once(' ') {
        Some((head, _)) => format!("{head}…"),
        None => format!("{cut}…"),
    }
}

fn has_non_english_script(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(
            c as u32,
            0x0400..=0x052F // Cyrillic & Cyrillic Supplement (Russian, etc.)
            | 0x2DE0..=0x2DFF
            | 0xA640..=0xA69F
            | 0x0590..=0x06FF // Hebrew & Arabic
            | 0x0E00..=0x0E7F // Thai
            | 0x3040..=0x9FFF // Hiragana, Katakana, CJK
            | 0xAC00..=0xD7AF // Hangul
        )
    })
}

/// True when the announcement is from an English source (filters out Russian
/// curator feeds like PlayGround.ru and non-English scripts).
fn is_english_news_item(title: &str, feed: &str, url: &str, snippet_text: &str) -> bool {
    if has_non_english_script(title)
        || has_non_english_script(feed)
        || has_non_english_script(snippet_text)
    {
        return false;
    }
    let lower_feed = feed.to_lowercase();
    let lower_url = url.to_lowercase();
    if lower_feed.contains(".ru")
        || lower_feed.contains("playground")
        || lower_feed.contains("igromania")
        || lower_feed.contains("stopgame")
        || lower_url.contains(".ru/")
    {
        return false;
    }
    let alpha_total = title.chars().filter(|c| c.is_alphabetic()).count();
    let ascii_alpha = title.chars().filter(|c| c.is_ascii_alphabetic()).count();
    alpha_total == 0 || ascii_alpha * 10 >= alpha_total * 8
}

/// Reads the endpoint's answer and keeps only English news items. Pure, so the
/// shape is testable without a network.
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
                    let url = item.get("url").and_then(|u| u.as_str()).unwrap_or("").to_string();
                    let feed = item
                        .get("feedlabel")
                        .and_then(|f| f.as_str())
                        .unwrap_or("")
                        .to_string();
                    let raw_contents = item.get("contents").and_then(|c| c.as_str()).unwrap_or("");
                    let snippet_text = snippet(raw_contents);
                    if !is_english_news_item(&title, &feed, &url, &snippet_text) {
                        return None;
                    }
                    Some(SteamNewsItem {
                        title,
                        url,
                        date: item.get("date").and_then(|d| d.as_i64()).unwrap_or(0),
                        feed,
                        patch_notes: item
                            .get("tags")
                            .and_then(|t| t.as_array())
                            .map(|tags| tags.iter().any(|tag| tag.as_str() == Some("patchnotes")))
                            .unwrap_or(false),
                        image: first_image(raw_contents),
                        snippet: snippet_text,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

fn news_cache_path(app: &AppHandle, app_id: &str, count: u32) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam")
        .join("news")
        .join(format!("{app_id}_{count}.json"))
}

/// The last few announcements for a Steam app, newest first (English only).
///
/// The feed is stored on disk, so a restart still paints the news card without
/// the network. An entry older than half an hour is answered as it is and
/// refreshed behind the page.
#[tauri::command]
pub async fn steam_news(
    app: AppHandle,
    app_id: String,
    count: u32,
) -> Result<Vec<SteamNewsItem>, String> {
    let app_id = app_id.trim().to_string();
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("@t:steam.newsFailed".to_string());
    }
    let count = count.clamp(1, MAX_COUNT);
    let cache = news_cache_path(&app, &app_id, count);
    if let Some((items, fetched_at)) =
        crate::lookup_cache::read::<Vec<SteamNewsItem>>(&cache, NEWS_SCHEMA)
    {
        if !crate::lookup_cache::fresh(fetched_at, CACHE_TTL_SECS) {
            let refresh = app.clone();
            let refresh_id = app_id.clone();
            tauri::async_runtime::spawn(async move {
                if let Ok(items) = fetch_news(&refresh_id, count).await {
                    let path = news_cache_path(&refresh, &refresh_id, count);
                    crate::lookup_cache::write(&path, NEWS_SCHEMA, &items);
                }
            });
        }
        return Ok(items);
    }

    let items = fetch_news(&app_id, count).await?;
    crate::lookup_cache::write(&cache, NEWS_SCHEMA, &items);
    Ok(items)
}

/// The request behind `steam_news`, without the cache.
async fn fetch_news(app_id: &str, count: u32) -> Result<Vec<SteamNewsItem>, String> {
    // Request a wider window from Steam so filtering out non-English curator
    // posts (e.g. PlayGround.ru) still leaves `count` English announcements.
    let fetch_count = (count * 5).clamp(15, 30);
    let url = format!(
        "https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid={app_id}&count={fetch_count}&maxlength=400&format=json&l=english"
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
    Ok(parse_news(&body)
        .into_iter()
        .take(count as usize)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_endpoint_shape_is_read_into_items_and_russian_sources_are_dropped() {
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
                    {
                        "title": "Valve ускорила перезарядку AUG в Counter-Strike 2",
                        "url": "https://store.steampowered.com/news/ru",
                        "date": 1791500000,
                        "feedlabel": "PlayGround.ru - официальная группа",
                        "contents": "Valve выпустила небольшое обновление для Counter-Strike 2"
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
        assert_eq!(items.len(), 2, "blank and Russian items are dropped");
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

    /// The feed reads like Steam's because a card carries a picture and the
    /// opening of the body; both come out of the announcement's own HTML.
    #[test]
    fn the_body_gives_a_picture_and_a_snippet() {
        // A real shape: Steam writes clan images as a placeholder path.
        let body = "<img src=\"{STEAM_CLAN_IMAGE}/1234/abc.jpg\"> <p>Hello <b>world</b> &amp; friends</p>";
        assert_eq!(
            first_image(body),
            "https://clan.cloudflare.steamstatic.com/images/1234/abc.jpg"
        );
        assert_eq!(snippet(body), "Hello world & friends");
        // A plain URL stays as it is, and a post without a picture says so.
        assert_eq!(first_image("<img src=\"https://x.test/a.png\">"), "https://x.test/a.png");
        assert_eq!(first_image("no picture here"), "");
        assert_eq!(first_image("<img src=\"{STEAM_CLAN_IMAGE}\">"), "");
        // A long body is cut at a word boundary and marked as cut.
        let long = "word ".repeat(80);
        let cut = snippet(&long);
        assert!(cut.ends_with('…'), "got {cut}");
        assert!(cut.chars().count() <= 221, "{} chars", cut.chars().count());
    }
}

