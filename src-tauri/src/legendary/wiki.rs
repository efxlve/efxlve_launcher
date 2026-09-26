//! Wikipedia fallback for the "About this game" box.
//!
//! The description always comes from the game's own store first (Epic today).
//! Many catalog entries carry no text, so the launcher then asks Wikipedia in
//! the UI language (English only when that wiki has no article) and caches the
//! answer per game + language. No API key is required.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::time::Duration;

/// `supported: false` means "checked, nothing usable found".
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WikiAbout {
    pub supported: bool,
    pub description: String,
}

fn empty_about() -> WikiAbout {
    WikiAbout {
        supported: false,
        description: String::new(),
    }
}

/// Maps a launcher locale to its Wikipedia subdomain.
pub fn wiki_language(lang: &str) -> &'static str {
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
///
/// Returns `(definitive, lead)`: `definitive` is false when the request failed
/// or the response could not be parsed, so the caller does not cache a
/// transient miss as "no text".
async fn wiki_lead(client: &reqwest::Client, title: &str, lang: &str) -> (bool, Option<String>) {
    let url = format!(
        "https://{}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch={}&gsrlimit=5&gsrnamespace=0&prop=extracts&exintro=1&explaintext=1&format=json",
        wiki_language(lang),
        urlencoding_term(title)
    );
    let Some(body) = client
        .get(&url)
        .header("Accept", "application/json")
        .header("Api-User-Agent", "EfxlveLauncher/0.1 (https://github.com/efxlve/efxlve_launcher)")
        .send()
        .await
        .ok()
    else {
        return (false, None);
    };
    let Some(body) = body.json::<serde_json::Value>().await.ok() else {
        return (false, None);
    };
    let Some(pages) = body.get("query").and_then(|q| q.get("pages")).and_then(|p| p.as_object()) else {
        return (false, None);
    };
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
    (true, best.map(|(_, text)| text))
}

/* --------------------------------- Cache ---------------------------------- */

/// A cached "nothing found" answer is retried after this long, in case the game
/// gains a wiki article later. Positive answers never expire.
const NEGATIVE_CACHE_TTL: Duration = Duration::from_secs(30 * 24 * 3600);

/// Pure rule behind the cache read: only a fresh negative answer is trusted.
fn negative_answer_usable(supported: bool, age: Option<Duration>) -> bool {
    supported || age.map(|a| a < NEGATIVE_CACHE_TTL).unwrap_or(true)
}

fn cache_path(app_name: &str, lang: &str) -> PathBuf {
    let safe: String = app_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    super::skip::default_config_dir()
        .join("wiki_about")
        .join(format!("{safe}_{}_v1.json", wiki_language(lang)))
}

fn read_cache(app_name: &str, lang: &str) -> Option<WikiAbout> {
    let path = cache_path(app_name, lang);
    let text = std::fs::read_to_string(&path).ok()?;
    let data: WikiAbout = serde_json::from_str(&text).ok()?;
    let age = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok());
    if !negative_answer_usable(data.supported, age) {
        return None;
    }
    Some(data)
}

fn write_cache(app_name: &str, lang: &str, data: &WikiAbout) {
    let path = cache_path(app_name, lang);
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(text) = serde_json::to_string(data) {
        let _ = std::fs::write(path, text);
    }
}

/* -------------------------------- Fetching -------------------------------- */

pub async fn get_wiki_about(title: &str, app_name: &str, lang: &str, force: bool) -> WikiAbout {
    if !force {
        // Any cache file means a definitive answer was stored before (even
        // "nothing found"), so the network is not asked twice for the same game.
        if let Some(cached) = read_cache(app_name, lang) {
            return cached;
        }
    }
    let Some(client) = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .user_agent("EfxlveLauncher/0.1 (https://github.com/efxlve/efxlve_launcher)")
        .build()
        .ok()
    else {
        return empty_about();
    };
    let (mut definitive, mut lead) = wiki_lead(&client, title, lang).await;
    if lead.is_none() && lang != "en" {
        // Many game articles only exist in English.
        let (ok_en, lead_en) = wiki_lead(&client, title, "en").await;
        definitive = definitive || ok_en;
        lead = lead_en;
    }
    let about = WikiAbout {
        supported: lead.is_some(),
        description: lead.unwrap_or_default(),
    };
    // Cache every definitive answer (including "nothing found") so the same
    // game is never fetched twice; transient network failures are retried.
    if definitive {
        write_cache(app_name, lang, &about);
    }
    about
}

#[tauri::command]
pub async fn epic_get_wiki_about(
    title: String,
    app_name: String,
    lang: String,
    force_refresh: Option<bool>,
) -> Result<WikiAbout, String> {
    Ok(get_wiki_about(&title, &app_name, &lang, force_refresh.unwrap_or(false)).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_launcher_language_maps_to_a_wiki_subdomain() {
        for (lang, wiki) in [
            ("tr", "tr"),
            ("en", "en"),
            ("de", "de"),
            ("es", "es"),
            ("fr", "fr"),
            ("it", "it"),
            ("ja", "ja"),
            ("ko", "ko"),
            ("pl", "pl"),
            ("pt-BR", "pt"),
            ("ru", "ru"),
            ("zh-Hans", "zh"),
            ("zh-Hant", "zh"),
            ("ar", "ar"),
            ("th", "th"),
        ] {
            assert_eq!(wiki_language(lang), wiki, "wiki code for {lang}");
        }
    }

    #[test]
    fn wiki_scoring_prefers_games_over_films() {
        assert!(is_disambiguation("Cyberpunk may refer to several things"));
        let game = "Cyberpunk 2077, CD Projekt Red tarafından geliştirilen bir video oyunudur. Night City'de geçer.";
        let film = "Cyberpunk, 1980'lerde çekilmiş bir film hakkında uzun bir ansiklopedi paragrafıdır ve oyun değildir.";
        assert!(wiki_extract_score("Cyberpunk 2077", game) > wiki_extract_score("Cyberpunk 2077", film));
        assert_eq!(wiki_extract_score("Cyberpunk 2077", "kısa"), -1);
    }

    #[test]
    fn negative_cache_expires_but_positive_never_does() {
        assert!(negative_answer_usable(true, Some(NEGATIVE_CACHE_TTL + Duration::from_secs(60))));
        assert!(negative_answer_usable(false, Some(Duration::from_secs(60))));
        assert!(!negative_answer_usable(false, Some(NEGATIVE_CACHE_TTL + Duration::from_secs(1))));
        // No timestamp (unknown age) keeps the old behaviour.
        assert!(negative_answer_usable(false, None));
    }
}
