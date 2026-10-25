//! PowerPyx trophy/achievement guide lookup.
//!
//! PowerPyx exposes a normal WordPress search page and public guide pages. The
//! launcher reads the first matching trophy guide and keeps only the roadmap
//! facts (difficulty, time, missables) plus the link; the guide body stays on
//! the site. Coverage is best effort, so a miss is a normal empty answer.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use url::form_urlencoded;

use crate::steam::strip_html;

const HIT_TTL_SECS: u64 = 7 * 24 * 60 * 60;
const MISS_TTL_SECS: u64 = 24 * 60 * 60;
const MAX_TITLE_CHARS: usize = 160;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerPyxGuide {
    pub supported: bool,
    pub title: String,
    pub url: String,
    pub difficulty: String,
    pub time: String,
    pub missables: String,
}

#[derive(Serialize, Deserialize)]
struct GuideCache {
    fetched_at: u64,
    response: PowerPyxGuide,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn cache_path(app: &tauri::AppHandle, title: &str) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("guides")
        .join("powerpyx");
    let _ = std::fs::create_dir_all(&dir);
    let digest = Sha256::digest(title.to_lowercase().as_bytes());
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    dir.join(format!("{hash}.json"))
}

fn plain(html: &str) -> String {
    strip_html(html)
        .replace("&#8211;", "–")
        .replace("&#8212;", "—")
        .replace("&#8217;", "'")
        .replace("&#8220;", "\"")
        .replace("&#8221;", "\"")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize(value: &str) -> String {
    value
        .to_lowercase()
        .replace(['\u{2122}', '\u{00ae}', '\u{00a9}'], "")
        .chars()
        .map(|ch| if ch.is_alphanumeric() || ch.is_whitespace() { ch } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn truncate(value: &str, max: usize) -> String {
    let mut out = value.chars().take(max).collect::<String>();
    if value.chars().count() > max {
        out.push('…');
    }
    out
}

fn inner_after<'a>(block: &'a str, marker: &str, close: &str) -> Option<&'a str> {
    let start = block.find(marker)?;
    let rest = &block[start + marker.len()..];
    let open = rest.find('>')?;
    let rest = &rest[open + 1..];
    let end = rest.find(close)?;
    Some(&rest[..end])
}

fn attribute_after<'a>(block: &'a str, marker: &str, name: &str) -> Option<&'a str> {
    let start = block.find(marker)?;
    let rest = &block[start + marker.len()..];
    let attr = format!("{name}=\"");
    let attr_start = rest.find(&attr)?;
    let rest = &rest[attr_start + attr.len()..];
    let end = rest.find('"')?;
    Some(&rest[..end])
}

/// First trophy-guide search result whose title starts with the game title.
/// "Hades Trophy Guide & Roadmap" matches "Hades"; a "Hades 2" guide does not.
pub fn find_guide(html: &str, title: &str) -> Option<(String, String)> {
    let wanted = normalize(title);
    if wanted.is_empty() {
        return None;
    }
    for article in html.split("<article").skip(1) {
        if !article.contains("category-trophy-guide") {
            continue;
        }
        let Some(href) = attribute_after(article, "entry-title-link", "href") else {
            continue;
        };
        if !href.starts_with("https://www.powerpyx.com/") {
            continue;
        }
        let name = inner_after(article, "entry-title-link", "</a>")
            .map(plain)
            .unwrap_or_default();
        let normalized = normalize(&name);
        if normalized == wanted
            || normalized.starts_with(&format!("{wanted} "))
            || normalized.contains(&format!("{wanted} trophy"))
        {
            return Some((name, href.to_string()));
        }
    }
    None
}

/// Reads `<li><b>Label</b>: value</li>` roadmap lines. The first label that
/// exists wins; a missing line stays empty rather than becoming "unknown".
pub fn meta_after(html: &str, labels: &[&str]) -> String {
    for label in labels {
        let Some(start) = html.find(label) else {
            continue;
        };
        let rest = &html[start..];
        let end = rest.find("</li>").unwrap_or(rest.len().min(500));
        let text = plain(&rest[..end]);
        let value = text
            .split_once(':')
            .map(|(_, value)| value.trim())
            .unwrap_or(text.trim());
        if !value.is_empty() {
            return truncate(value, 120);
        }
    }
    String::new()
}

async fn fetch_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

#[tauri::command]
pub async fn powerpyx_game_guide(
    app: tauri::AppHandle,
    title: String,
) -> Result<PowerPyxGuide, String> {
    let title = title.trim().to_string();
    if title.is_empty() {
        return Ok(PowerPyxGuide::default());
    }
    if title.chars().count() > MAX_TITLE_CHARS {
        return Err("Game title is too long".into());
    }

    let cache = cache_path(&app, &title);
    if let Ok(text) = std::fs::read_to_string(&cache) {
        if let Ok(cached) = serde_json::from_str::<GuideCache>(&text) {
            let ttl = if cached.response.supported { HIT_TTL_SECS } else { MISS_TTL_SECS };
            if now_secs().saturating_sub(cached.fetched_at) < ttl {
                return Ok(cached.response);
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|error| error.without_url().to_string())?;
    let search_url = format!(
        "https://www.powerpyx.com/?s={}",
        form_urlencoded::byte_serialize(title.as_bytes()).collect::<String>()
    );
    let Some(search_html) = fetch_text(&client, &search_url).await else {
        return Ok(PowerPyxGuide::default());
    };
    let Some((guide_title, guide_url)) = find_guide(&search_html, &title) else {
        let miss = PowerPyxGuide::default();
        let payload = GuideCache {
            fetched_at: now_secs(),
            response: miss.clone(),
        };
        if let Ok(text) = serde_json::to_string(&payload) {
            let _ = std::fs::write(cache, text);
        }
        return Ok(miss);
    };

    let guide_html = fetch_text(&client, &guide_url).await.unwrap_or_default();
    let response = PowerPyxGuide {
        supported: true,
        title: truncate(&guide_title, 160),
        url: guide_url,
        difficulty: meta_after(
            &guide_html,
            &[
                "Estimated trophy difficulty",
                "Estimated difficulty",
                "Trophy difficulty",
            ],
        ),
        time: meta_after(
            &guide_html,
            &[
                "Approximate amount of time to platinum",
                "Approximate amount of time to 100%",
                "Approximate amount of time",
                "Time to platinum",
            ],
        ),
        missables: meta_after(
            &guide_html,
            &["Number of missable trophies", "Missable trophies"],
        ),
    };
    let payload = GuideCache {
        fetched_at: now_secs(),
        response: response.clone(),
    };
    if let Ok(text) = serde_json::to_string(&payload) {
        let _ = std::fs::write(cache, text);
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEARCH: &str = r#"
      <article class="post-112455 post type-post status-publish format-standard has-post-thumbnail category-trophy-guide entry">
        <h2 class="entry-title"><a class="entry-title-link" rel="bookmark" href="https://www.powerpyx.com/hades-trophy-guide-roadmap/">Hades Trophy Guide &amp; Roadmap</a></h2>
      </article>
      <article class="post-26382 post type-post category-guide entry">
        <h2 class="entry-title"><a class="entry-title-link" rel="bookmark" href="https://www.powerpyx.com/hades-2-guide/">Hades 2 Guide</a></h2>
      </article>
    "#;

    const GUIDE: &str = r#"
      <ul>
        <li><b>Estimated trophy difficulty</b>: 7/10 without using God Mode, 4/10 using God Mode</li>
        <li><b>Approximate amount of time to platinum</b>: 50 &#8211; 75 hours</li>
        <li><b>Number of missable trophies</b>: No missable trophies</li>
      </ul>
    "#;

    #[test]
    fn exact_game_title_wins_over_a_sequel() {
        let hit = find_guide(SEARCH, "Hades").expect("Hades guide");
        assert_eq!(hit.0, "Hades Trophy Guide & Roadmap");
        assert!(hit.1.ends_with("/hades-trophy-guide-roadmap/"));
        assert!(find_guide(SEARCH, "Hades 2").is_none());
    }

    #[test]
    fn roadmap_metadata_is_read_without_the_label() {
        assert!(meta_after(GUIDE, &["Estimated trophy difficulty"]).starts_with("7/10"));
        assert!(meta_after(GUIDE, &["Approximate amount of time to platinum"]).contains("50"));
        assert!(meta_after(GUIDE, &["Number of missable trophies"]).contains("No missable"));
        assert!(meta_after(GUIDE, &["Not there"]).is_empty());
    }

    #[test]
    fn titles_are_normalized_for_matching() {
        assert_eq!(normalize("Marvel's Spider-Man 2™"), "marvel s spider man 2");
        assert_eq!(normalize("  Hades  "), "hades");
    }

    #[test]
    #[ignore = "talks to powerpyx.com"]
    fn live_powerpyx_lookup() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("efxlve-launcher")
            .build()
            .unwrap();
        let search = runtime
            .block_on(fetch_text(&client, "https://www.powerpyx.com/?s=Hades"))
            .expect("search page");
        let (_, url) = find_guide(&search, "Hades").expect("Hades result");
        let guide = runtime.block_on(fetch_text(&client, &url)).expect("guide page");
        assert!(!meta_after(&guide, &["Estimated trophy difficulty"]).is_empty());
    }
}
