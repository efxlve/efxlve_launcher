use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CriticData {
    pub app_name: String,
    pub title: String,
    pub supported: bool,
    pub opencritic_score: Option<u32>,
    pub opencritic_url: Option<String>,
    pub metacritic_score: Option<u32>,
    pub metacritic_url: Option<String>,
    pub igdb_score: Option<f64>,
    pub tier: Option<String>,
    /// Bumped when the reception parser changes so stale disk rows are rebuilt.
    #[serde(default)]
    pub parser_version: u32,
}

const CRITIC_PARSER_VERSION: u32 = 7;

/// Browser UA: metacritic.com serves the page (with its schema block) to normal
/// browsers only.
const METACRITIC_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/// Metacritic's slug for a title: lowercased, apostrophes dropped, everything
/// else that is not a letter or digit becomes one hyphen.
/// "Marvel's Spider-Man Remastered" → "marvels-spider-man-remastered".
pub fn metacritic_slug(title: &str) -> String {
    let mut out = String::new();
    let mut pending_dash = false;
    for ch in title.chars() {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
        } else if ch == '&' {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push_str("and");
        } else if ch == '\'' || ch == '\u{2019}' {
            // "Marvel's" is "marvels" in the slug, not "marvel-s".
        } else {
            pending_dash = true;
        }
    }
    out
}

/// The year in a schema.org date ("2022-08-12").
fn schema_year(value: &serde_json::Value) -> Option<u32> {
    let raw = ["datePublished", "dateCreated"]
        .iter()
        .find_map(|key| value.get(*key).and_then(|v| v.as_str()))?;
    raw.get(..4)?.parse::<u32>().ok()
}

/// The metascore out of a Metacritic page: its schema.org `VideoGame` block also
/// carries the game's own name and release date, so a page for another game is
/// rejected instead of scored.
pub fn parse_metacritic_page(html: &str, title: &str, year: Option<u32>) -> Option<u32> {
    for chunk in html.split("<script type=\"application/ld+json\">").skip(1) {
        let Some(end) = chunk.find("</script>") else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&chunk[..end]) else {
            continue;
        };
        if value.get("@type").and_then(|t| t.as_str()) != Some("VideoGame") {
            continue;
        }
        let name = value.get("name").and_then(|n| n.as_str()).unwrap_or("");
        if !name.is_empty()
            && !title_matches_page(title, name)
            && !title_matches_page(name, title)
        {
            continue;
        }
        if let (Some(page_year), Some(want)) = (schema_year(&value), year) {
            if (page_year as i64 - want as i64).abs() > 1 {
                continue;
            }
        }
        let score = value
            .get("aggregateRating")
            .and_then(|rating| rating.get("ratingValue"))
            .and_then(|v| v.as_f64());
        if let Some(score) = score {
            if score > 0.0 {
                return Some(score.round() as u32);
            }
        }
    }
    None
}

/// Fetches the game's own Metacritic page: the score and the URL it came from.
/// The slug is tried with the store tags first and without them after:
/// "... Enhanced" lives under the base name.
pub async fn fetch_metacritic(
    client: &reqwest::Client,
    title: &str,
    year: Option<u32>,
) -> Option<(u32, String)> {
    let mut slugs = vec![metacritic_slug(title)];
    let loosened = crate::legendary::hltb::loosen_hltb_search_term(title);
    let loose_slug = metacritic_slug(&loosened);
    if !loose_slug.is_empty() && loose_slug != slugs[0] {
        slugs.push(loose_slug);
    }
    for slug in slugs {
        if slug.is_empty() {
            continue;
        }
        let url = format!("https://www.metacritic.com/game/{}/", slug);
        let Ok(response) = client
            .get(&url)
            .header("User-Agent", METACRITIC_UA)
            .header("Accept-Language", "en-US,en;q=0.9")
            .send()
            .await
        else {
            continue;
        };
        if !response.status().is_success() {
            continue;
        }
        let Ok(html) = response.text().await else {
            continue;
        };
        if let Some(score) = parse_metacritic_page(&html, title, year) {
            return Some((score, url));
        }
    }
    None
}

pub fn clean_critic_search_term(title: &str) -> String {
    let mut s = title
        .replace(['\u{2018}', '\u{2019}', '\u{00B4}', '`'], "'")
        .replace(['™', '®', '©'], "")
        // En and em dashes are what the stores write; the edition rules below
        // look for a plain hyphen.
        .replace(['\u{2013}', '\u{2014}', '\u{2212}'], "-")
        .replace('\u{00A0}', " ");
    while s.contains("  ") {
        s = s.replace("  ", " ");
    }
    s = s.replace(" :", ":");

    // Common series / publisher prefixes
    let prefixes = [
        "Tom Clancy's ",
        "Marvel's ",
        "Sid Meier's ",
        "Disney's ",
        "EA SPORTS ",
        "Star Wars ",
        "STAR WARS ",
        "Warhammer 40,000: ",
        "Warhammer: ",
    ];
    for p in prefixes {
        if s.starts_with(p) {
            s = s[p.len()..].to_string();
        }
    }

    // Strip editions after a colon or dash
    if let Some(pos) = s.find(" - ") {
        let sub = &s[pos + 3..];
        let sub_low = sub.to_lowercase();
        if sub_low.contains("edition")
            || sub_low.contains("cut")
            || sub_low.contains("version")
            || sub_low.contains("remastered")
        {
            s = s[..pos].to_string();
        }
    }

    // Common version suffixes
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
        " Director's Cut",
        " Remastered",
    ];
    for suffix in edition_suffixes {
        if let Some(pos) = s.to_lowercase().find(&suffix.to_lowercase()) {
            s = s[..pos].to_string();
        }
    }

    s.trim().to_string()
}

/// Extra queries when the cleaned title is a collection or has a subtitle.
pub fn critic_search_terms(title: &str) -> Vec<String> {
    let clean = clean_critic_search_term(title);
    let mut terms: Vec<String> = Vec::new();
    let mut push = |value: &str| {
        let trimmed = value.trim();
        if trimmed.len() < 2 {
            return;
        }
        if terms
            .iter()
            .any(|existing| existing.eq_ignore_ascii_case(trimmed))
        {
            return;
        }
        terms.push(trimmed.to_string());
    };
    push(&clean);
    let lower = clean.to_lowercase();
    if let Some(rest) = lower.strip_suffix(" collection") {
        push(&clean[..rest.len()]);
    }
    if let Some((head, tail)) = clean.split_once(':') {
        push(tail);
        push(head);
    }
    terms
}

fn critic_cache_dir() -> PathBuf {
    if let Some(config_dir) = dirs_config_dir() {
        config_dir.join("legendary").join("critic")
    } else {
        PathBuf::from("critic_cache")
    }
}

fn dirs_config_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".config"))
}

pub fn calculate_tier(score: u32) -> &'static str {
    if score >= 84 {
        "Mighty"
    } else if score >= 75 {
        "Strong"
    } else if score >= 66 {
        "Fair"
    } else {
        "Weak"
    }
}

/// Parses `{{Infobox game/row/reception|...}}` lines in the PCGamingWiki MediaWiki content.
///
/// Two shapes show up in the wild:
///   {{Infobox game/row/reception|Metacritic|dead-by-daylight|71}}
///   {{Infobox game/row/reception|Metacritic|pc|counter-strike-2|82}}
pub fn parse_reception_data(
    content: &str,
) -> (
    Option<u32>,
    Option<String>,
    Option<u32>,
    Option<String>,
    Option<f64>,
) {
    let mut oc_score: Option<u32> = None;
    let mut oc_url: Option<String> = None;
    let mut mc_score: Option<u32> = None;
    let mut mc_url: Option<String> = None;
    let mut igdb_score: Option<f64> = None;
    let mut mc_is_pc = false;

    for raw_line in content.lines() {
        let line = raw_line.trim();
        let lower = line.to_lowercase();
        if !lower.contains("infobox game/row/reception") {
            continue;
        }

        if let Some(start) = line.find("{{") {
            let inner = &line[start + 2..];
            let inner = if let Some(end) = inner.find("}}") {
                &inner[..end]
            } else {
                inner
            };

            let parts: Vec<&str> = inner.split('|').map(|p| p.trim()).collect();
            let Some((provider_raw, id_or_slug, score_str, platform)) = reception_fields(&parts)
            else {
                continue;
            };
            let provider = provider_raw.to_lowercase();

            if provider.contains("opencritic") {
                if let Ok(s) = score_str.parse::<u32>() {
                    oc_score = Some(s);
                    if !id_or_slug.is_empty() {
                        oc_url = Some(if id_or_slug.starts_with("http") {
                            id_or_slug.to_string()
                        } else {
                            format!("https://opencritic.com/game/{}", id_or_slug)
                        });
                    }
                }
            } else if provider.contains("metacritic") {
                if let Ok(s) = score_str.parse::<u32>() {
                    let this_pc = platform.eq_ignore_ascii_case("pc");
                    if mc_score.is_none() || (this_pc && !mc_is_pc) {
                        mc_score = Some(s);
                        mc_is_pc = this_pc;
                        if !id_or_slug.is_empty() {
                            mc_url = Some(if id_or_slug.starts_with("http") {
                                id_or_slug.to_string()
                            } else {
                                format!(
                                    "https://www.metacritic.com/game/{}/",
                                    id_or_slug.trim_end_matches('/')
                                )
                            });
                        }
                    }
                }
            } else if provider.contains("igdb") {
                if let Ok(s) = score_str.parse::<f64>() {
                    igdb_score = Some(s);
                }
            }
        }
    }

    (oc_score, oc_url, mc_score, mc_url, igdb_score)
}

/// (provider, id/slug, score, platform-or-empty)
fn reception_fields<'a>(parts: &'a [&str]) -> Option<(&'a str, &'a str, &'a str, &'a str)> {
    if parts.len() >= 5 && parts[3].parse::<f64>().is_err() && parts[4].parse::<f64>().is_ok() {
        return Some((parts[1], parts[3], parts[4], parts[2]));
    }
    if parts.len() >= 4 {
        return Some((parts[1], parts[2], parts[3], ""));
    }
    None
}

fn normalize_for_match(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let lowered = s
        .to_lowercase()
        .replace(" ii", " 2")
        .replace(" iii", " 3")
        .replace(" iv", " 4")
        .replace(" v", " 5")
        .replace(" vi", " 6")
        .replace(" vii", " 7")
        .replace(" viii", " 8");
    for c in lowered.chars() {
        if c.is_alphanumeric() {
            out.extend(c.to_lowercase());
        }
    }
    out
}

/// True when a wiki page can be about the game we searched for: its own name
/// must be a shortened form of the title ("Marvel's Spider-Man" for "Marvel's
/// Spider-Man Remastered"). "Spider-Man (2000)" and "... Miles Morales" are not,
/// so an older or sibling game can no longer answer for it.
pub fn title_matches_page(raw_title: &str, page: &str) -> bool {
    let want = normalize_for_match(raw_title);
    let candidate = normalize_for_match(page);
    if want.is_empty() || candidate.len() < 5 {
        return false;
    }
    want.contains(&candidate)
}

pub async fn get_critic_data(
    title: &str,
    app_name: &str,
    force_refresh: bool,
    year: Option<u32>,
) -> CriticData {
    let clean_app = app_name.replace([':', '/', '\\', '*', '?', '"', '<', '>', '|'], "_");
    let cache_dir = critic_cache_dir();
    // The year is part of the cache key: the same title can be two different
    // games ("Spider-Man 2" and "Marvel's Spider-Man 2").
    let cache_file = cache_dir.join(format!("{}-{}.json", clean_app, year.unwrap_or(0)));

    let ua = "EfxlveLauncher/1.0 (https://github.com/efxlve/launcher)";
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return CriticData {
                app_name: app_name.to_string(),
                title: title.to_string(),
                supported: false,
                opencritic_score: None,
                opencritic_url: None,
                metacritic_score: None,
                metacritic_url: None,
                igdb_score: None,
                tier: None,
                parser_version: 0,
            };
        }
    };

    // 1. Cache check
    if !force_refresh && cache_file.exists() {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(mut data) = serde_json::from_str::<CriticData>(&content) {
                if data.supported && data.parser_version >= CRITIC_PARSER_VERSION {
                    return data;
                }
            }
        }
    }

    // Direct Metacritic lookup first: a store field is often missing and the
    // wiki can land on an older game with the same name. The page's own schema
    // block carries the game, its release date and the metascore.
    let (direct_score, direct_url) = match fetch_metacritic(&client, title, year).await {
        Some((score, url)) => (Some(score), Some(url)),
        None => (None, None),
    };

    let search_terms = critic_search_terms(title);
    if search_terms.is_empty() {
        let supported = direct_score.is_some();
        let result = CriticData {
            app_name: app_name.to_string(),
            title: title.to_string(),
            supported,
            opencritic_score: None,
            opencritic_url: None,
            metacritic_score: direct_score,
            metacritic_url: direct_url,
            igdb_score: None,
            tier: direct_score.map(|s| calculate_tier(s).to_string()),
            parser_version: CRITIC_PARSER_VERSION,
        };
        if supported {
            let _ = tokio::fs::create_dir_all(&cache_dir).await;
            if let Ok(json_str) = serde_json::to_string_pretty(&result) {
                let _ = tokio::fs::write(&cache_file, json_str).await;
            }
        }
        return result;
    }

    let mut oc_score: Option<u32> = None;
    let mut oc_url: Option<String> = None;
    let mut mc_score: Option<u32> = None;
    let mut mc_url: Option<String> = None;
    let mut igdb_score: Option<f64> = None;

    let mut fallback: Option<(
        Option<u32>,
        Option<String>,
        Option<u32>,
        Option<String>,
        Option<f64>,
    )> = None;
    'terms: for term in search_terms.iter().take(3) {
        let search_url = format!(
            "https://www.pcgamingwiki.com/w/api.php?action=opensearch&search={}&limit=3&format=json",
            url::form_urlencoded::byte_serialize(term.as_bytes()).collect::<String>()
        );
        let mut pages: Vec<String> = Vec::new();
        if let Ok(resp) = client
            .get(&search_url)
            .header("User-Agent", ua)
            .send()
            .await
        {
            if let Ok(json_val) = resp.json::<serde_json::Value>().await {
                if let Some(arr) = json_val.get(1).and_then(|v| v.as_array()) {
                    for title in arr.iter().filter_map(|v| v.as_str()) {
                        if !title.trim().is_empty() {
                            pages.push(title.to_string());
                        }
                    }
                }
            }
        }
        if pages.is_empty() {
            pages.push(term.clone());
        }
        for target_page in pages.into_iter().take(3) {
            // A page about a different game (older entry, sibling title) is not
            // a source: skipping it beats showing the wrong score.
            if !title_matches_page(title, &target_page) {
                continue;
            }
            let query_url = format!(
                "https://www.pcgamingwiki.com/w/api.php?action=query&titles={}&prop=revisions&rvprop=content&format=json&redirects=1",
                url::form_urlencoded::byte_serialize(target_page.as_bytes()).collect::<String>()
            );
            if let Ok(resp) = client.get(&query_url).header("User-Agent", ua).send().await {
                if let Ok(json_val) = resp.json::<serde_json::Value>().await {
                    if let Some(pages_map) = json_val
                        .get("query")
                        .and_then(|q| q.get("pages"))
                        .and_then(|p| p.as_object())
                    {
                        for (_pid, pdata) in pages_map {
                            if let Some(revs) = pdata.get("revisions").and_then(|r| r.as_array()) {
                                if let Some(first_rev) = revs.first() {
                                    if let Some(content_str) =
                                        first_rev.get("*").and_then(|c| c.as_str())
                                    {
                                        let (o_sc, o_u, m_sc, m_u, i_sc) =
                                            parse_reception_data(content_str);
                                        if o_sc.is_some() || m_sc.is_some() || i_sc.is_some() {
                                            // Prefer the page for the requested release
                                            // year: the wiki also hosts older games that
                                            // share the name (Spider-Man 2, 2004).
                                            let year_hit = year
                                                .map(|y| content_str.contains(&y.to_string()))
                                                .unwrap_or(true);
                                            if year_hit {
                                                oc_score = o_sc;
                                                oc_url = o_u;
                                                mc_score = m_sc;
                                                mc_url = m_u;
                                                igdb_score = i_sc;
                                                break 'terms;
                                            }
                                            if fallback.is_none() {
                                                fallback = Some((o_sc, o_u, m_sc, m_u, i_sc));
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Page picked but no release year in its text: with a known year this is
    // another game with the same name, so it is dropped (no score beats a wrong
    // score). Without a year the old fallback stays.
    if year.is_none() && oc_score.is_none() && mc_score.is_none() && igdb_score.is_none() {
        if let Some((o_sc, o_u, m_sc, m_u, i_sc)) = fallback {
            oc_score = o_sc;
            oc_url = o_u;
            mc_score = m_sc;
            mc_url = m_u;
            igdb_score = i_sc;
        }
    }

    let supported = oc_score.is_some()
        || direct_score.is_some()
        || mc_score.is_some()
        || igdb_score.is_some();
    let effective_score = oc_score.or(direct_score).or(mc_score);
    let tier = effective_score.map(|s| calculate_tier(s).to_string());

    let result = CriticData {
        app_name: app_name.to_string(),
        title: title.to_string(),
        supported,
        opencritic_score: oc_score,
        opencritic_url: oc_url,
        metacritic_score: direct_score.or(mc_score),
        metacritic_url: direct_url.or(mc_url),
        igdb_score,
        tier,
        parser_version: CRITIC_PARSER_VERSION,
    };

    // 5. Diske kaydet
    if supported {
        let _ = tokio::fs::create_dir_all(&cache_dir).await;
        if let Ok(json_str) = serde_json::to_string_pretty(&result) {
            let _ = tokio::fs::write(&cache_file, json_str).await;
        }
    }

    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_titles_must_shorten_the_game_title() {
        assert!(title_matches_page(
            "Marvel's Spider-Man Remastered",
            "Marvel's Spider-Man"
        ));
        assert!(title_matches_page("Cyberpunk 2077", "Cyberpunk 2077"));
        assert!(!title_matches_page(
            "Marvel's Spider-Man Remastered",
            "Spider-Man (2000)"
        ));
        assert!(!title_matches_page(
            "Marvel's Spider-Man Remastered",
            "Marvel's Spider-Man: Miles Morales"
        ));
    }

    #[test]
    fn metacritic_slugs_follow_the_site() {
        assert_eq!(
            metacritic_slug("Marvel's Spider-Man Remastered"),
            "marvels-spider-man-remastered"
        );
        assert_eq!(metacritic_slug("Cyberpunk 2077"), "cyberpunk-2077");
        assert_eq!(
            metacritic_slug("The Witcher 3: Wild Hunt"),
            "the-witcher-3-wild-hunt"
        );
        assert_eq!(metacritic_slug("Portal 2"), "portal-2");
    }

    #[test]
    fn metacritic_page_reads_its_own_schema_block() {
        let html = r#"<html><head>
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"VideoGame","name":"Old Game","datePublished":"2004-06-28","aggregateRating":{"ratingValue":42}}</script>
        <script type="application/ld+json">{"@type":"VideoGame","name":"Marvel's Spider-Man Remastered","datePublished":"2022-08-12","aggregateRating":{"ratingValue":87}}</script>
        </head></html>"#;
        // The 2004 block is skipped: its name and year disagree with ours.
        assert_eq!(
            parse_metacritic_page(html, "Marvel's Spider-Man Remastered", Some(2022)),
            Some(87)
        );
        let wrong = r#"<script type="application/ld+json">{"@type":"VideoGame","name":"Spider-Man 2","datePublished":"2004-06-28","aggregateRating":{"ratingValue":42}}</script>"#;
        assert_eq!(
            parse_metacritic_page(wrong, "Marvel's Spider-Man Remastered", Some(2022)),
            None
        );
    }

    #[test]
    fn test_clean_critic_search_term() {
        assert_eq!(
            clean_critic_search_term("Dead by Daylight - Gold Edition"),
            "Dead by Daylight"
        );
        assert_eq!(
            clean_critic_search_term("Alan Wake 2 Deluxe Edition"),
            "Alan Wake 2"
        );
        assert_eq!(
            clean_critic_search_term("Tom Clancy's The Division 2"),
            "The Division 2"
        );
        assert_eq!(
            clean_critic_search_term("Death Stranding Director's Cut"),
            "Death Stranding"
        );
        assert_eq!(
            clean_critic_search_term("UNCHARTED™: Legacy of Thieves Collection"),
            "UNCHARTED: Legacy of Thieves Collection"
        );
    }

    #[test]
    fn test_calculate_tier() {
        assert_eq!(calculate_tier(94), "Mighty");
        assert_eq!(calculate_tier(84), "Mighty");
        assert_eq!(calculate_tier(80), "Strong");
        assert_eq!(calculate_tier(75), "Strong");
        assert_eq!(calculate_tier(70), "Fair");
        assert_eq!(calculate_tier(66), "Fair");
        assert_eq!(calculate_tier(60), "Weak");
    }

    #[test]
    fn test_parse_reception_data() {
        let sample = r#"
|reception    =
{{Infobox game/row/reception|Metacritic|dead-by-daylight|71}}
{{Infobox game/row/reception|Opencritic|2844/dead-by-daylight|70}}
{{Infobox game/row/reception|IGDB|dead-by-daylight|6.7}}
        "#;
        let (oc_score, oc_url, mc_score, mc_url, igdb_score) = parse_reception_data(sample);
        assert_eq!(oc_score, Some(70));
        assert_eq!(
            oc_url,
            Some("https://opencritic.com/game/2844/dead-by-daylight".to_string())
        );
        assert_eq!(mc_score, Some(71));
        assert_eq!(
            mc_url,
            Some("https://www.metacritic.com/game/dead-by-daylight/".to_string())
        );
        assert_eq!(igdb_score, Some(6.7));

        let with_platform = r#"
{{Infobox game/row/reception|Metacritic|playstation-5|counter-strike-2|80}}
{{Infobox game/row/reception|Metacritic|pc|counter-strike-2|82}}
{{Infobox game/row/reception|Opencritic|14365/counter-strike-2|81}}
        "#;
        let (_, _, mc_pc, mc_pc_url, _) = parse_reception_data(with_platform);
        assert_eq!(mc_pc, Some(82));
        assert_eq!(
            mc_pc_url,
            Some("https://www.metacritic.com/game/counter-strike-2/".to_string())
        );
    }
}
