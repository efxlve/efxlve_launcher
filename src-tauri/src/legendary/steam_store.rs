//! Localized "About this game" text from the public Steam store API.
//!
//! Epic catalog blurbs are often English-only. Steam's `appdetails` endpoint
//! returns a short description in the language we ask for, so the about
//! paragraph follows the launcher language. Results are cached per game and
//! language; a miss keeps the existing Epic text.

use serde::Deserialize;
use std::path::PathBuf;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SteamAbout {
    pub supported: bool,
    pub description: String,
    #[serde(default)]
    pub developers: String,
    #[serde(default)]
    pub release_date: String,
    #[serde(default)]
    pub genres: String,
}

/// Maps a launcher locale to Steam's `l` query value.
pub fn steam_language(lang: &str) -> &'static str {
    match lang {
        "tr" => "turkish",
        "de" => "german",
        "es" => "spanish",
        "fr" => "french",
        "it" => "italian",
        "ja" => "japanese",
        "ko" => "koreana",
        "pl" => "polish",
        "pt" | "pt-BR" => "brazilian",
        "ru" => "russian",
        "th" => "thai",
        "zh" | "zh-Hans" => "schinese",
        "zh-Hant" => "tchinese",
        "ar" => "arabic",
        _ => "english",
    }
}

fn normalize_title(title: &str) -> String {
    title
        .replace(['™', '®', '\u{00A0}'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Picks the store app that best matches the library title.
/// Soundtracks, demos and DLC lose to a plain game of the same name.
pub fn pick_app_id(title: &str, items: &[(u64, String)]) -> Option<u64> {
    let want = normalize_title(title);
    if want.is_empty() || items.is_empty() {
        return None;
    }
    let junk = |name: &str| {
        let n = name.to_lowercase();
        n.contains("soundtrack")
            || n.contains("demo")
            || n.contains("dlc")
            || n.contains(" ost")
            || n.ends_with(" ost")
    };
    if let Some((id, _)) = items.iter().find(|(_, name)| normalize_title(name) == want && !junk(name)) {
        return Some(*id);
    }
    if let Some((id, _)) = items.iter().find(|(_, name)| !junk(name)) {
        return Some(*id);
    }
    items.first().map(|(id, _)| *id)
}

fn cache_path(app_name: &str, lang: &str) -> PathBuf {
    let safe: String = app_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    super::skip::default_config_dir()
        .join("steam_about")
        .join(format!("{safe}_{}_v4.json", steam_language(lang)))
}

fn read_cache(app_name: &str, lang: &str) -> Option<SteamAbout> {
    let text = std::fs::read_to_string(cache_path(app_name, lang)).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_cache(app_name: &str, lang: &str, data: &SteamAbout) {
    let path = cache_path(app_name, lang);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(data) {
        let _ = std::fs::write(path, text);
    }
}

#[derive(Deserialize)]
struct SearchResponse {
    #[serde(default)]
    items: Vec<SearchItem>,
}

#[derive(Deserialize)]
struct SearchItem {
    id: u64,
    #[serde(default)]
    name: String,
}

fn decode_basic_entities(input: &str) -> String {
    input
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
}

/// Turns Steam's HTML about blurb into readable paragraphs.
fn html_to_text(html: &str) -> String {
    let mut marked = html.to_string();
    for tag in ["<br", "</p", "</h1", "</h2", "</h3", "</li", "<p", "</div"] {
        marked = marked.replace(tag, &format!("\n{tag}"));
        marked = marked.replace(&tag.to_uppercase(), &format!("\n{tag}"));
    }
    let mut out = String::new();
    let mut in_tag = false;
    for c in marked.chars() {
        if c == '<' {
            in_tag = true;
            continue;
        }
        if c == '>' {
            in_tag = false;
            continue;
        }
        if !in_tag {
            out.push(c);
        }
    }
    decode_basic_entities(&out)
        .lines()
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Prefer the long store description. The one-line short blurb is only a fallback.
fn plain_about(short: &str, about_html: &str) -> String {
    let long = html_to_text(about_html);
    let short = decode_basic_entities(short).trim().to_string();
    if long.chars().count() > short.chars().count().saturating_add(40) {
        return long;
    }
    if !short.is_empty() {
        return short;
    }
    long
}

pub async fn get_steam_about(title: &str, app_name: &str, lang: &str, force: bool) -> SteamAbout {
    if !force {
        if let Some(cached) = read_cache(app_name, lang) {
            if cached.supported && !cached.description.trim().is_empty() {
                return cached;
            }
        }
    }
    let empty = SteamAbout {
        supported: false,
        description: String::new(),
        developers: String::new(),
        release_date: String::new(),
        genres: String::new(),
    };
    let steam_lang = steam_language(lang);
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
    {
        Ok(c) => c,
        Err(_) => return empty,
    };

    // Steam is optional metadata (studio, date, genres) and a short fallback.
    // A failed store search must not skip the Wikipedia summary.
    let mut result = empty.clone();
    let search_url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l={}&cc=US",
        urlencoding_term(title),
        steam_lang
    );
    if let Ok(resp) = client.get(&search_url).send().await {
        if let Ok(body) = resp.json::<SearchResponse>().await {
            let items = body.items.into_iter().map(|i| (i.id, i.name)).collect::<Vec<_>>();
            if let Some(app_id) = pick_app_id(title, &items) {
                let details_url = format!(
                    "https://store.steampowered.com/api/appdetails?appids={app_id}&l={steam_lang}"
                );
                if let Ok(resp) = client.get(&details_url).send().await {
                    if let Ok(body) = resp.json::<serde_json::Value>().await {
                        let about = about_from_appdetails(&body);
                        if !about.description.is_empty() {
                            result = about;
                        }
                    }
                }
            }
        }
    }
    // Steam blurbs are often one marketing line. Wikipedia's lead is a real
    // summary in the launcher language, with English as a fallback.
    let wiki = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .user_agent("EfxlveLauncher/0.1 (https://github.com/efxlve/efxlve_launcher)")
        .build()
        .ok();
    if let Some(wiki) = wiki.as_ref() {
        if let Some(lead) = wiki_lead(wiki, title, lang).await {
            result.description = lead;
        } else if lang != "en" {
            if let Some(lead) = wiki_lead(wiki, title, "en").await {
                result.description = lead;
            }
        }
    }
    if result.description.is_empty() {
        return result;
    }
    result.supported = true;
    write_cache(app_name, lang, &result);
    result
}

/// `appdetails` keys the payload by whichever id Steam resolved, not always
/// the id in the query. Take the first successful entry.
fn joined_names(data: &serde_json::Value, key: &str) -> String {
    data.get(key)
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().or_else(|| item.get("description").and_then(|d| d.as_str())))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ")
        })
        .unwrap_or_default()
}

fn about_from_appdetails(body: &serde_json::Value) -> SteamAbout {
    let blank = SteamAbout {
        supported: false,
        description: String::new(),
        developers: String::new(),
        release_date: String::new(),
        genres: String::new(),
    };
    let Some(obj) = body.as_object() else { return blank };
    for value in obj.values() {
        if value.get("success").and_then(|v| v.as_bool()) != Some(true) {
            continue;
        }
        let Some(data) = value.get("data") else { continue };
        let short = data.get("short_description").and_then(|v| v.as_str()).unwrap_or("");
        let about = data.get("about_the_game").and_then(|v| v.as_str()).unwrap_or("");
        let detailed = data.get("detailed_description").and_then(|v| v.as_str()).unwrap_or("");
        let long_html = if detailed.trim().len() >= about.trim().len() { detailed } else { about };
        let text = plain_about(short, long_html);
        if text.is_empty() {
            continue;
        }
        return SteamAbout {
            supported: true,
            description: text,
            developers: joined_names(data, "developers"),
            release_date: data
                .get("release_date")
                .and_then(|v| v.get("date"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            genres: joined_names(data, "genres"),
        };
    }
    blank
}

fn wiki_language(lang: &str) -> &'static str {
    match lang {
        "tr" => "tr",
        "de" => "de",
        "es" => "es",
        "fr" => "fr",
        "it" => "it",
        "ja" => "ja",
        "ko" => "ko",
        "pl" => "pl",
        "pt" | "pt-BR" => "pt",
        "ru" => "ru",
        "th" => "th",
        "ar" => "ar",
        "zh" | "zh-Hans" | "zh-Hant" => "zh",
        _ => "en",
    }
}

fn is_disambiguation(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("may refer to")
        || lower.contains("şunlardan biri")
        || lower.contains("birden fazla anlam")
        || lower.contains("anlam ayrımı")
}

/// Higher is a better "about this game" paragraph. Negative means reject.
fn wiki_extract_score(title: &str, extract: &str) -> i32 {
    let text = extract.trim();
    if text.chars().count() < 80 || is_disambiguation(text) {
        return -1;
    }
    let lower = text.to_lowercase();
    let title_l = title.trim().to_lowercase();
    let mut score = 1;
    if !title_l.is_empty() && lower.contains(&title_l) {
        score += 4;
    }
    const GAME: &[&str] = &[
        "video game",
        "video oyunu",
        "bilgisayar oyunu",
        "oyunudur",
        "developed by",
        "geliştirilen",
    ];
    if GAME.iter().any(|hint| lower.contains(hint)) {
        score += 6;
    }
    score
}

/// Lead section of the best-matching Wikipedia article, as plain text.
async fn wiki_lead(client: &reqwest::Client, title: &str, lang: &str) -> Option<String> {
    let url = format!(
        "https://{}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch={}&gsrlimit=5&gsrnamespace=0&prop=extracts&exintro=1&explaintext=1&format=json",
        wiki_language(lang),
        urlencoding_term(title)
    );
    let body = client
        .get(&url)
        .header("Accept", "application/json")
        .header("Api-User-Agent", "EfxlveLauncher/0.1 (https://github.com/efxlve/efxlve_launcher)")
        .send()
        .await
        .ok()?
        .json::<serde_json::Value>()
        .await
        .ok()?;
    let pages = body.get("query")?.get("pages")?.as_object()?;
    let mut best: Option<(i32, String)> = None;
    for page in pages.values() {
        let Some(extract) = page.get("extract").and_then(|v| v.as_str()) else { continue };
        let score = wiki_extract_score(title, extract);
        if score < 0 {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((prev, _)) => score > *prev,
        };
        if replace {
            best = Some((score, extract.trim().to_string()));
        }
    }
    best.map(|(_, text)| text)
}

fn urlencoding_term(title: &str) -> String {
    let mut out = String::new();
    for b in title.trim().as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(*b as char),
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[tauri::command]
pub async fn epic_get_steam_about(
    title: String,
    app_name: String,
    lang: String,
    force_refresh: Option<bool>,
) -> Result<SteamAbout, String> {
    Ok(get_steam_about(&title, &app_name, &lang, force_refresh.unwrap_or(false)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn language_codes_match_steam() {
        assert_eq!(steam_language("tr"), "turkish");
        assert_eq!(steam_language("en"), "english");
        assert_eq!(steam_language("pt-BR"), "brazilian");
        assert_eq!(steam_language("zh-Hans"), "schinese");
        assert_eq!(steam_language("ko"), "koreana");
        assert_eq!(wiki_language("tr"), "tr");
        assert_eq!(wiki_language("pt-BR"), "pt");
        assert!(is_disambiguation("Cyberpunk may refer to several things"));
        let game = "Cyberpunk 2077, CD Projekt Red tarafından geliştirilen bir video oyunudur. Night City'de geçer.";
        let film = "Cyberpunk, 1980'lerde çekilmiş bir film hakkında uzun bir ansiklopedi paragrafıdır ve oyun değildir.";
        assert!(wiki_extract_score("Cyberpunk 2077", game) > wiki_extract_score("Cyberpunk 2077", film));
        assert_eq!(wiki_extract_score("Cyberpunk 2077", "kısa"), -1);
    }

    #[test]
    fn prefers_exact_game_over_soundtrack() {
        let items = vec![
            (1, "Cyberpunk 2077 Soundtrack".to_string()),
            (1091500, "Cyberpunk 2077".to_string()),
        ];
        assert_eq!(pick_app_id("Cyberpunk 2077", &items), Some(1091500));
    }

    #[test]
    fn reads_description_when_response_key_differs() {
        let body = serde_json::json!({
            "2441600": {
                "success": true,
                "data": { "short_description": "Night City.", "steam_appid": 1091500 }
            }
        });
        let about = about_from_appdetails(&body);
        assert_eq!(about.description, "Night City.");
    }

    #[test]
    fn strips_html_when_short_text_is_missing() {
        let text = plain_about("", "<p>Night City.</p><br>Play.");
        assert_eq!(text, "Night City.\nPlay.");
        let long = plain_about("Short.", "<p>This is the long store description that should replace the one line blurb.</p>");
        assert!(long.contains("long store description"));
    }
}
