//! Steam Community answers for one achievement.
//!
//! Steam's guide and discussion search pages are server-rendered and public,
//! unlike the achievement databases that sit behind Cloudflare. The launcher
//! reads the first few result rows, keeps the link and a short snippet, and
//! caches the answer for a day. It never copies a guide body: the row opens the
//! real page in the user's browser.

use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::Manager;
use url::form_urlencoded;

const COMMUNITY_TTL_SECS: u64 = 24 * 60 * 60;
const MAX_RESULTS: usize = 3;
const MAX_QUERY_CHARS: usize = 120;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamGuideHit {
    pub title: String,
    pub url: String,
    pub author: String,
    pub description: String,
    pub rating: Option<u8>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamThreadHit {
    pub title: String,
    pub url: String,
    pub snippet: String,
    pub replies: u32,
    pub date: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamAchievementCommunity {
    pub guides: Vec<SteamGuideHit>,
    pub threads: Vec<SteamThreadHit>,
    /// False when Steam itself could not be reached. The UI then keeps the
    /// plain search links and does not show an empty community block.
    pub supported: bool,
}

#[derive(Serialize, Deserialize)]
struct CommunityCache {
    fetched_at: u64,
    response: SteamAchievementCommunity,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn cache_path(app: &tauri::AppHandle, app_id: &str, query: &str) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam")
        .join("community");
    let _ = std::fs::create_dir_all(&dir);
    let digest = Sha256::digest(query.to_lowercase().as_bytes());
    let hash = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    dir.join(format!("{app_id}_{hash}.json"))
}

fn query_param(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Steam's search pages are public but age-gated pages can answer with a login
/// screen. Treat anything non-200 as "not available" rather than failing the
/// whole detail view.
async fn fetch_text(client: &reqwest::Client, url: &str) -> Option<String> {
    let response = client.get(url).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    response.text().await.ok()
}

/* ---------- Parsers ---------- */

/// The result rows are nested `<div>`/`<span>` blocks. Strip tags, decode the
/// handful of entities Steam actually writes, and collapse whitespace.
fn text_of(html: &str) -> String {
    let mut out = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                out.push(' ');
            }
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&nbsp;", " ")
        .replace("&hellip;", "…")
        .replace("&mdash;", "—")
        .replace("&ndash;", "–")
        .replace("&rsquo;", "'")
        .replace("&lsquo;", "'")
        .replace("&ldquo;", "\"")
        .replace("&rdquo;", "\"");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn truncate(text: &str, max: usize) -> String {
    let mut out = text.chars().take(max).collect::<String>();
    if text.chars().count() > max {
        out.push('…');
    }
    out
}

/// Finds the text after `<marker ...>` up to the next closing tag. The search
/// page uses one wrapper per title/snippet, so the first close is the right one.
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

fn find_url(block: &str) -> Option<String> {
    let url = attribute_after(block, "class=\"workshopItemCollection", "href")
        .or_else(|| attribute_after(block, "forum_topic_overlay", "href"))?;
    let url = url.trim();
    if url.starts_with("https://steamcommunity.com/") || url.starts_with("http://steamcommunity.com/") {
        Some(url.to_string())
    } else if url.starts_with('/') {
        Some(format!("https://steamcommunity.com{url}"))
    } else {
        None
    }
}

fn rating_of(block: &str) -> Option<u8> {
    let src = attribute_after(block, "fileRating", "src")?;
    let star = src.find("-star")?;
    let digit = src[..star].chars().rev().find(|ch| ch.is_ascii_digit())?;
    digit.to_digit(10).map(|value| value as u8)
}

/// Guide rows on `/app/<id>/guides/?searchText=...&browsesort=textsearch`.
pub fn parse_guide_hits(html: &str, limit: usize) -> Vec<SteamGuideHit> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for block in html.split("id=\"sharedfile_").skip(1) {
        let title = inner_after(block, "class=\"workshopItemTitle\"", "</div")
            .map(text_of)
            .unwrap_or_default();
        let url = find_url(block);
        let Some(url) = url else { continue };
        if title.is_empty() || !seen.insert(url.clone()) {
            continue;
        }
        let author = inner_after(block, "class=\"workshopItemAuthorName\"", "</span")
            .map(text_of)
            .unwrap_or_default();
        let description = inner_after(block, "class=\"workshopItemShortDesc\"", "</div")
            .map(text_of)
            .unwrap_or_default();
        out.push(SteamGuideHit {
            title: truncate(&title, 180),
            url,
            author: truncate(&author, 80),
            description: truncate(&description, 240),
            rating: rating_of(block),
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/// Topic rows on `/app/<id>/discussions/search/?q=...`.
pub fn parse_thread_hits(html: &str, limit: usize) -> Vec<SteamThreadHit> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for block in html.split("class=\"post_searchresult\"").skip(1) {
        let title = inner_after(block, "class=\"forum_topic_name", "</div")
            .map(text_of)
            .unwrap_or_default();
        let url = find_url(block);
        let Some(url) = url else { continue };
        if title.is_empty() || !seen.insert(url.clone()) {
            continue;
        }
        let snippet = inner_after(block, "class=\"forum_searchresult_reply_inner\"", "</div")
            .map(text_of)
            .unwrap_or_default();
        let replies = inner_after(block, "class=\"forum_topic_reply_count\"", "</div")
            .map(text_of)
            .and_then(|text| {
                text.split_whitespace()
                    .find_map(|part| part.parse::<u32>().ok())
            })
            .unwrap_or(0);
        let date = inner_after(block, "class=\"searchresult_timestamp\"", "</div")
            .map(text_of)
            .unwrap_or_default();
        out.push(SteamThreadHit {
            title: truncate(&title, 180),
            url,
            snippet: truncate(&snippet, 240),
            replies,
            date: truncate(&date, 60),
        });
        if out.len() >= limit {
            break;
        }
    }
    out
}

/* ---------- Command ---------- */

#[tauri::command]
pub async fn steam_get_achievement_community(
    app: tauri::AppHandle,
    app_id: String,
    query: String,
) -> Result<SteamAchievementCommunity, String> {
    if app_id.is_empty() || !app_id.chars().all(|ch| ch.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(SteamAchievementCommunity::default());
    }
    if query.chars().count() > MAX_QUERY_CHARS {
        return Err("Achievement name is too long".into());
    }

    let cache = cache_path(&app, &app_id, &query);
    if let Ok(text) = std::fs::read_to_string(&cache) {
        if let Ok(cached) = serde_json::from_str::<CommunityCache>(&text) {
            if now_secs().saturating_sub(cached.fetched_at) < COMMUNITY_TTL_SECS {
                return Ok(cached.response);
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|error| error.without_url().to_string())?;
    let encoded = query_param(&query);
    let guides_url = format!(
        "https://steamcommunity.com/app/{app_id}/guides/?searchText={encoded}&browsefilter=trend&browsesort=textsearch"
    );
    let threads_url = format!(
        "https://steamcommunity.com/app/{app_id}/discussions/search/?q={encoded}"
    );

    let (guides_html, threads_html) = tokio::join!(
        fetch_text(&client, &guides_url),
        fetch_text(&client, &threads_url)
    );
    let supported = guides_html.is_some() || threads_html.is_some();
    let response = SteamAchievementCommunity {
        guides: guides_html
            .as_deref()
            .map(|html| parse_guide_hits(html, MAX_RESULTS))
            .unwrap_or_default(),
        threads: threads_html
            .as_deref()
            .map(|html| parse_thread_hits(html, MAX_RESULTS))
            .unwrap_or_default(),
        supported,
    };

    if supported {
        let payload = CommunityCache {
            fetched_at: now_secs(),
            response: response.clone(),
        };
        if let Ok(text) = serde_json::to_string(&payload) {
            let _ = std::fs::write(cache, text);
        }
    }

    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GUIDES: &str = r#"
      <div data-panel="{&quot;clickOnActivate&quot;:&quot;firstChild&quot;}" role="button" id="sharedfile_2986993749_1297428437" class="workshopItemCollectionContainer">
        <a class="workshopItemCollection ugc_show_warning_image ugc" href="https://steamcommunity.com/sharedfiles/filedetails/?id=2986993749&searchtext=Escaped+Tartarus">
          <img class="fileRating" src="https://community.fastly.steamstatic.com/public/images/sharedfiles/5-star.png?v=2" />
          <div class="workshopItemTitle">Pro Tips To Escape The Underworld</div>
          <div class="workshopItemAuthorLine">by&nbsp;<span class="workshopItemAuthorName">mud</span></div>
          <div class="workshopItemShortDesc">These tips and tricks will have you escaping the Underworld in Hades like an absolute pro....</div>
        </a>
      </div>
      <div id="sharedfile_2306791734_1544565766" class="workshopItemCollectionContainer">
        <a class="workshopItemCollection" href="https://steamcommunity.com/sharedfiles/filedetails/?id=2306791734">
          <img class="fileRating" src="https://community.fastly.steamstatic.com/public/images/sharedfiles/3-star.png" />
          <div class="workshopItemTitle">Guide for your first escape !</div>
          <div class="workshopItemAuthorLine">by&nbsp;<span class="workshopItemAuthorName">ass.shaker</span></div>
          <div class="workshopItemShortDesc">Struggling to escape the underworld ? here is a guide to get you out of there!</div>
        </a>
      </div>
    "#;

    const THREADS: &str = r#"
      <div class="post_searchresult">
        <a class="forum_topic_overlay" href="https://steamcommunity.com/app/1145360/discussions/0/3270186971451794558/"></a>
        <div class="forum_topic_reply_count">2</div>
        <div class="forum_topic_name op_hidden">Weapons used to succesfully escape Tartarus?</div>
        <div class="searchresult_timestamp">9 May, 2022 @ 5:34am</div>
        <div class="forum_searchresult_reply_inner">Is there a way to know which weapons I managed to escape Tartarus with?</div>
      </div>
      <div class="post_searchresult">
        <a class="forum_topic_overlay" href="https://steamcommunity.com/app/1145360/discussions/0/2944747978659110017/"></a>
        <div class="forum_topic_reply_count">3 replies</div>
        <div class="forum_topic_name op_hidden">Got the Escaped Tartarus achievement after loading up 1.0</div>
        <div class="searchresult_timestamp">18 Sep, 2020 @ 9:04am</div>
        <div class="forum_searchresult_reply_inner">This happened to anyone else? I know this doesn't matter.</div>
      </div>
    "#;

    #[test]
    fn guides_keep_title_author_rating_and_url() {
        let hits = parse_guide_hits(GUIDES, 3);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Pro Tips To Escape The Underworld");
        assert_eq!(hits[0].author, "mud");
        assert_eq!(hits[0].rating, Some(5));
        assert!(hits[0].url.contains("filedetails/?id=2986993749"));
        assert_eq!(hits[1].rating, Some(3));
    }

    #[test]
    fn threads_keep_title_replies_date_and_snippet() {
        let hits = parse_thread_hits(THREADS, 3);
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "Weapons used to succesfully escape Tartarus?");
        assert_eq!(hits[0].replies, 2);
        assert_eq!(hits[0].date, "9 May, 2022 @ 5:34am");
        assert!(hits[0].snippet.starts_with("Is there a way"));
        assert_eq!(hits[1].replies, 3);
    }

    #[test]
    fn empty_pages_and_limit_are_safe() {
        assert!(parse_guide_hits("", 3).is_empty());
        assert!(parse_thread_hits("<div class=\"post_searchresult\"></div>", 3).is_empty());
        assert_eq!(parse_guide_hits(GUIDES, 1).len(), 1);
        assert_eq!(parse_thread_hits(THREADS, 1).len(), 1);
    }

    #[test]
    fn text_of_decodes_entities_and_collapses_space() {
        let text = text_of("  <b>Hello</b>&nbsp;&amp; <span>world</span>  ");
        assert_eq!(text, "Hello & world");
    }

    #[test]
    #[ignore = "talks to steamcommunity.com"]
    fn live_community_pages_parse() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(12))
            .user_agent("efxlve-launcher")
            .build()
            .unwrap();
        let guides_url = "https://steamcommunity.com/app/1145360/guides/?searchText=Escaped+Tartarus&browsefilter=trend&browsesort=textsearch";
        let threads_url = "https://steamcommunity.com/app/1145360/discussions/search/?q=Escaped+Tartarus";
        let (guides_html, threads_html) = runtime.block_on(async {
            tokio::join!(
                fetch_text(&client, guides_url),
                fetch_text(&client, threads_url)
            )
        });
        let guides = parse_guide_hits(&guides_html.expect("guide page"), 3);
        let threads = parse_thread_hits(&threads_html.expect("thread page"), 3);
        assert!(!guides.is_empty(), "guide search returned no rows");
        assert!(!threads.is_empty(), "thread search returned no rows");
        assert!(guides.iter().all(|hit| hit.url.contains("steamcommunity.com")));
        assert!(threads.iter().all(|hit| hit.url.contains("steamcommunity.com")));
    }
}
