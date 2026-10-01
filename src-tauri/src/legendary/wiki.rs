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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn is_disambiguation(text: &str) -> bool {
    let lower = text.to_lowercase();
    lower.contains("may refer to")
        || lower.contains("may also refer to")
        || lower.contains("can refer to")
        || lower.contains("şunlardan biri")
        || lower.contains("şu anlamlara gelebilir")
        || lower.contains("anlamına gelebilir")
        || lower.contains("anlamlarına gelebilir")
        || lower.contains("birden fazla anlam")
        || lower.contains("anlam ayrımı")
        || lower.contains("anlam ayrım")
}

/// Strips a parenthetical suffix: "Mortal Shell (video game)" -> "Mortal Shell".
fn strip_parenthetical(title: &str) -> &str {
    match title.find(" (") {
        Some(idx) => title[..idx].trim(),
        None => title,
    }
}

/// Letters/digits only, lowercased: "Rogue Legacy 2" -> "roguelegacy2".
fn normalize_name(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

/// Store titles carry edition tails ("Deponia The Complete Journey"); the wiki
/// article is about the base game. Longest suffix match wins.
fn strip_edition(title: &str) -> &str {
    const EDITIONS: &[&str] = &[
        "the complete journey",
        "complete edition",
        "definitive edition",
        "enhanced edition",
        "game of the year edition",
        "goty edition",
        "deluxe edition",
        "ultimate edition",
        "gold edition",
        "special edition",
        "director's cut",
        "final cut",
        "remastered",
    ];
    let lower = title.to_lowercase();
    let mut best: Option<&str> = None;
    for suffix in EDITIONS {
        if lower.ends_with(suffix) {
            let cut = title.len() - suffix.len();
            let trimmed = title[..cut]
                .trim_end_matches([' ', ':', '-', '–', '—'])
                .trim_end();
            if !trimmed.is_empty() && best.map(|b| trimmed.len() > b.len()).unwrap_or(true) {
                best = Some(trimmed);
            }
        }
    }
    best.unwrap_or(title)
}

/// Search query for Wikipedia: no trademark symbols, no edition tail, single
/// spaces. Also used for title matching so "X ™" finds "X".
fn clean_query(title: &str) -> String {
    let cleaned = title.replace(['™', '®', '©'], " ");
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    strip_edition(&collapsed).to_string()
}

/// The article title must be the game itself, not a sequel, film or band.
fn title_matches(game_title: &str, page_title: &str) -> bool {
    let want = normalize_name(&clean_query(strip_parenthetical(game_title)));
    if want.is_empty() {
        return false;
    }
    normalize_name(strip_parenthetical(page_title)) == want
}

/// Keywords that mean "this article is about a video game", per wiki. Used for
/// the short description ("2007 video game") and for categories alike.
fn game_hints(wiki_lang: &str) -> &'static [&'static str] {
    match wiki_lang {
        "tr" => &["video oyun"],
        "de" => &["computerspiel", "videospiel"],
        "es" => &["videojuego"],
        "fr" => &["jeu vidéo", "jeu video"],
        "it" => &["videogioc"],
        "ja" => &["コンピュータゲーム", "ビデオゲーム"],
        "ko" => &["비디오 게임", "컴퓨터 게임"],
        "pl" => &["gry komputerowe", "gra komputerowa"],
        "pt" => &["jogos eletr", "jogo eletr"],
        "ru" => &["компьютерн", "видеоигр"],
        "ar" => &["ألعاب فيديو", "ألعاب الفيديو"],
        "th" => &["วิดีโอเกม"],
        "zh" => &["电子游戏", "電子遊戲"],
        _ => &["video game"],
    }
}

#[derive(Debug, Clone, Default)]
struct WikiPage {
    title: String,
    extract: String,
    description: String,
    categories: Vec<String>,
}

fn page_from_value(value: &serde_json::Value) -> WikiPage {
    let title = value
        .get("title")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let extract = value
        .get("extract")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let description = value
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let categories = value
        .get("categories")
        .and_then(|v| v.as_array())
        .map(|items| {
            items
                .iter()
                .filter_map(|c| c.get("title").and_then(|t| t.as_str()))
                .map(|t| t.trim_start_matches("Category:").trim().to_string())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    WikiPage {
        title,
        extract,
        description,
        categories,
    }
}

/// How strongly a page claims to be this game's article:
/// 1 = short description says "video game" (strongest, films never match),
/// 2 = a video-game category, 3 = an explicit game phrase in the extract.
/// 0 rejects the page (wrong title, disambiguation, another medium).
fn page_tier(game_title: &str, wiki_lang: &str, page: &WikiPage) -> u8 {
    let extract = page.extract.trim();
    if extract.chars().count() < 80 || is_disambiguation(extract) {
        return 0;
    }
    if !title_matches(game_title, &page.title) {
        return 0;
    }
    let hints = game_hints(wiki_lang);
    let description = page.description.to_lowercase();
    if hints.iter().any(|hint| description.contains(hint)) {
        return 1;
    }
    let categories = page.categories.join("\n").to_lowercase();
    if hints.iter().any(|hint| categories.contains(hint)) {
        return 2;
    }
    let lower = extract.to_lowercase();
    const GAME_PHRASES: &[&str] = &[
        "game developed by",
        "game published by",
        "video oyunu",
        "bilgisayar oyunu",
        "oyunudur",
        "geliştirilen",
    ];
    if GAME_PHRASES.iter().any(|phrase| lower.contains(phrase)) {
        return 3;
    }
    0
}

/// One search call. `Err` means "could not tell" (network/HTTP), so the caller
/// must not cache a miss.
async fn search_pages(
    client: &reqwest::Client,
    wiki_lang: &str,
    query: &str,
) -> Result<Vec<WikiPage>, ()> {
    let url = format!(
        "https://{}.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch={}&gsrlimit=5&gsrnamespace=0&prop=extracts|categories|description&cllimit=50&exintro=1&explaintext=1&format=json",
        wiki_lang,
        urlencoding_term(query)
    );
    let body = client
        .get(&url)
        .header("Accept", "application/json")
        // Wikipedia answers 403 to requests without a descriptive user agent.
        .header(
            "User-Agent",
            "EfxlveLauncher/0.1 (https://github.com/efxlve/efxlve_launcher)",
        )
        .header(
            "Api-User-Agent",
            "EfxlveLauncher/0.1 (https://github.com/efxlve/efxlve_launcher)",
        )
        .send()
        .await
        .map_err(|_| ())?;
    if !body.status().is_success() {
        return Err(());
    }
    let body = body.json::<serde_json::Value>().await.map_err(|_| ())?;
    let pages = body
        .get("query")
        .and_then(|q| q.get("pages"))
        .and_then(|p| p.as_object())
        .ok_or(())?;
    Ok(pages.values().map(page_from_value).collect())
}

/// Best acceptable extract: the lowest tier wins, tier 1 short-circuits.
fn best_extract(pages: &[WikiPage], title: &str, wiki_lang: &str) -> Option<String> {
    let mut best: Option<(u8, String)> = None;
    for page in pages {
        let tier = page_tier(title, wiki_lang, page);
        if tier == 0 {
            continue;
        }
        let replace = match &best {
            None => true,
            Some((previous, _)) => tier < *previous,
        };
        if replace {
            best = Some((tier, page.extract.trim().to_string()));
        }
        if tier == 1 {
            break;
        }
    }
    best.map(|(_, text)| text)
}

/// Lead section of the best-matching Wikipedia article, as plain text.
///
/// Returns `(definitive, lead)`: `definitive` is false when a request failed
/// or the response could not be parsed, so the caller does not cache a
/// transient miss as "no text".
async fn wiki_lead(client: &reqwest::Client, title: &str, lang: &str) -> (bool, Option<String>) {
    let wiki_lang = wiki_language(lang);
    let Ok(pages) = search_pages(client, wiki_lang, &clean_query(title)).await else {
        return (false, None);
    };
    if let Some(text) = best_extract(&pages, title, wiki_lang) {
        return (true, Some(text));
    }
    // Second, game-biased pass: titles like "Zero Hour" or "Stranded Deep"
    // rank films and encyclopedic pages above the game in a plain search.
    let biased = format!("{} video game", clean_query(title));
    let Ok(pages) = search_pages(client, wiki_lang, &biased).await else {
        return (false, None);
    };
    (true, best_extract(&pages, title, wiki_lang))
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
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
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
    // First pass in the launcher language, then English (many game articles
    // only exist there). A miss is only cached when every pass completed.
    let (ok_first, first) = wiki_lead(&client, title, lang).await;
    let (definitive, lead) = if let Some(text) = first {
        (true, Some(text))
    } else if !ok_first {
        (false, None)
    } else if lang != "en" {
        let (ok_en, lead_en) = wiki_lead(&client, title, "en").await;
        (ok_en, lead_en)
    } else {
        (true, None)
    };
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

    fn page(title: &str, extract: &str, description: &str, categories: &[&str]) -> WikiPage {
        WikiPage {
            title: title.into(),
            extract: extract.into(),
            description: description.into(),
            categories: categories.iter().map(|c| c.to_string()).collect(),
        }
    }

    const GAME_EXTRACT: &str = "Portal is a puzzle-platform video game developed and published by Valve. It was released in 2007 for Windows and later ported to consoles.";
    const FILM_EXTRACT: &str = "Zero Hour! is a 1957 American disaster film directed by Hall Bartlett and starring Dana Andrews. The film was based on a teleplay.";

    #[test]
    fn short_description_is_the_strongest_signal() {
        let game = page("Portal", GAME_EXTRACT, "2007 video game", &[]);
        assert_eq!(page_tier("Portal", "en", &game), 1);
        let film = page(
            "Zero Hour!",
            FILM_EXTRACT,
            "1957 American drama film",
            &["1957 films"],
        );
        assert_eq!(page_tier("Zero Hour", "en", &film), 0);
        let musician = page(
            "Grime (musician)",
            "Claire Elise Boucher, known as Grimes, is a Canadian musician and record producer.",
            "Canadian musician",
            &["Musicians"],
        );
        assert_eq!(page_tier("GRIME", "en", &musician), 0);
    }

    #[test]
    fn category_and_phrase_are_lower_tiers() {
        let by_category = page(
            "Portal",
            GAME_EXTRACT,
            "",
            &["Video games developed in the United States"],
        );
        assert_eq!(page_tier("Portal", "en", &by_category), 2);
        let by_phrase = page("Ghostwire: Tokyo", "Ghostwire: Tokyo is an action-adventure game developed by Tango Gameworks for Windows.", "", &[]);
        assert_eq!(page_tier("Ghostwire Tokyo", "en", &by_phrase), 3);
        let studio = page("Tango Gameworks", "Tango Gameworks Inc. is a Japanese video game developer based in Tokyo and owned by ZeniMax Media.", "Japanese video game development company", &["Video game developers"]);
        assert_eq!(page_tier("Ghostwire Tokyo", "en", &studio), 0);
    }

    #[test]
    fn parenthetical_and_edition_tails_are_ignored() {
        assert!(title_matches("Mortal Shell", "Mortal Shell (video game)"));
        assert!(title_matches(
            "Deponia The Complete Journey",
            "Deponia (video game)"
        ));
        assert!(title_matches(
            "Dying Light: Enhanced Edition",
            "Dying Light"
        ));
        assert!(!title_matches("Rogue Legacy", "Rogue Legacy 2"));
    }

    #[test]
    fn trademark_symbols_and_spacing_are_cleaned() {
        assert_eq!(
            clean_query("Train Sim World® 7: Sand Patch Grade"),
            "Train Sim World 7: Sand Patch Grade"
        );
        assert_eq!(clean_query("Cyberpunk 2077™"), "Cyberpunk 2077");
        assert_eq!(clean_query("Deponia The Complete Journey"), "Deponia");
        assert!(title_matches("Train Sim World® 7", "Train Sim World 7"));
    }

    #[test]
    fn localized_hints_are_used_per_wiki() {
        let p = page("Mortal Shell", GAME_EXTRACT, "video oyunu", &[]);
        assert_eq!(page_tier("Mortal Shell", "tr", &p), 1);
        // The English wiki does not recognise the Turkish hint.
        assert_eq!(page_tier("Mortal Shell", "en", &p), 0);
    }

    #[test]
    fn rejects_disambiguation_pages_and_short_extracts() {
        assert!(is_disambiguation("Cyberpunk may refer to several things"));
        let disamb = page(
            "Portal",
            "Portal may refer to several things, including a video game developed by Valve for Windows systems.",
            "Topics referred to by the same term",
            &["Video games"],
        );
        assert_eq!(page_tier("Portal", "en", &disamb), 0);
        let short = page(
            "Portal",
            "Portal is a game developed by Valve.",
            "2007 video game",
            &[],
        );
        assert_eq!(page_tier("Portal", "en", &short), 0);
    }

    #[test]
    fn negative_cache_expires_but_positive_never_does() {
        assert!(negative_answer_usable(
            true,
            Some(NEGATIVE_CACHE_TTL + Duration::from_secs(60))
        ));
        assert!(negative_answer_usable(false, Some(Duration::from_secs(60))));
        assert!(!negative_answer_usable(
            false,
            Some(NEGATIVE_CACHE_TTL + Duration::from_secs(1))
        ));
        // No timestamp (unknown age) keeps the old behaviour.
        assert!(negative_answer_usable(false, None));
    }

    /// Live smoke test (network). Run with:
    /// `cargo test wiki_live_smoke -- --ignored --nocapture`
    #[test]
    #[ignore = "requires network access to wikipedia.org"]
    fn wiki_live_smoke() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap();
            for (query, expect_found) in [
                ("Mortal Shell", true),                                    // exact article
                ("Zero Hour", true), // the film ranks first; the game-biased pass must win
                ("The Dungeon Of Naheulbeuk: The Amulet Of Chaos", false), // no safe article
            ] {
                let (ok, lead) = wiki_lead(&client, query, "en").await;
                assert!(ok, "request failed for {query}");
                assert_eq!(
                    lead.is_some(),
                    expect_found,
                    "{query} lead found = {}",
                    lead.is_some()
                );
                tokio::time::sleep(Duration::from_millis(600)).await;
            }
        });
    }
}
