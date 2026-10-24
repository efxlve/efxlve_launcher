use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HltbData {
    pub app_name: String,
    pub title: String,
    pub supported: bool,
    pub main_story: Option<f64>,
    pub main_extra: Option<f64>,
    pub completionist: Option<f64>,
}

/// Optimizes the search term for HLTB (strips edition and publisher suffixes).
pub fn clean_hltb_search_term(title: &str) -> String {
    let mut s = title
        .replace(['\u{2018}', '\u{2019}', '\u{00B4}', '`'], "'")
        // En and em dashes are what the stores write ("... III – The Definitive
        // Edition"); the rules below look for a plain hyphen. Without this the
        // suffix survived and the search asked HowLongToBeat for "III –".
        .replace(['\u{2013}', '\u{2014}', '\u{2212}'], "-")
        .replace(['™', '®', '\u{00A0}'], " ");

    // Series and publisher prefixes stay: HowLongToBeat names carry them too
    // ("Marvel's Spider-Man Remastered" and "Tom Clancy's The Division 2" are the
    // site's own titles). Dropping them turned the search into "Spider-Man" and
    // matched the 2000 game.

    // Strip editions after a colon or dash
    if let Some(pos) = s.find(" - ") {
        let sub = &s[pos + 3..];
        if sub.to_lowercase().contains("edition")
            || sub.to_lowercase().contains("cut")
            || sub.to_lowercase().contains("version")
        {
            s = s[..pos].to_string();
        }
    }

    // Store tags that are not part of HowLongToBeat's own names. "Remastered" is
    // deliberately absent: the site carries it as a title of its own.
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
    ];
    for suffix in edition_suffixes {
        if let Some(pos) = s.to_lowercase().find(&suffix.to_lowercase()) {
            s = s[..pos].to_string();
        }
    }

    // A stripped suffix can leave the separator behind ("Grand Theft Auto III -");
    // the search then asks for a title ending in a dash and finds nothing.
    s.trim().trim_end_matches(['-', ':', '\u{2013}', '\u{2014}']).trim().to_string()
}

fn hltb_cache_dir() -> PathBuf {
    // The `-v4` marks the untouched-prefix search terms: older files hold results
    // from the stripped-title logic and must not be served again.
    if let Some(config_dir) = dirs_config_dir() {
        config_dir.join("legendary").join("hltb-v4")
    } else {
        PathBuf::from("hltb_cache_v4")
    }
}

fn dirs_config_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".config"))
}

pub async fn get_hltb_data(
    title: &str,
    app_name: &str,
    force_refresh: bool,
    year: Option<u32>,
) -> HltbData {
    let clean_app = app_name.replace([':', '/', '\\', '*', '?', '"', '<', '>', '|'], "_");
    // The release year is part of the cache key too: a name-only hit can be an
    // older game with the same title ("Spider-Man 2" vs "Marvel's Spider-Man 2").
    let cache_file = hltb_cache_dir().join(format!("{}-{}.json", clean_app, year.unwrap_or(0)));

    if !force_refresh {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(data) = serde_json::from_str::<HltbData>(&content) {
                if data.supported {
                    return data;
                }
                // A stored "not on HowLongToBeat" answer is trusted for a month:
                // the site can add the game later, but until then the page must
                // not run the whole handshake again for the same game.
                let age = tokio::fs::metadata(&cache_file)
                    .await
                    .ok()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|at| at.elapsed().ok())
                    .map(|elapsed| elapsed.as_secs())
                    .unwrap_or(u64::MAX);
                if age < crate::lookup_cache::MISS_TTL_SECS {
                    return data;
                }
            }
        }
    }

    let search_term = clean_hltb_search_term(title);
    let terms: Vec<&str> = search_term.split_whitespace().collect();
    if terms.is_empty() {
        return HltbData {
            app_name: app_name.to_string(),
            title: title.to_string(),
            supported: false,
            main_story: None,
            main_extra: None,
            completionist: None,
        };
    }

    let ua = HLTB_UA;
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
    {
        Ok(c) => c,
        Err(_) => {
            return HltbData {
                app_name: app_name.to_string(),
                title: title.to_string(),
                supported: false,
                main_story: None,
                main_extra: None,
                completionist: None,
            };
        }
    };

    // 1. Dynamically detect the search endpoint (default: /api/search/site)
    let mut search_endpoint = "/api/search/site".to_string();
    if let Ok(home_resp) = client
        .get("https://howlongtobeat.com/")
        .header("User-Agent", ua)
        .send()
        .await
    {
        if let Ok(home_html) = home_resp.text().await {
            for part in home_html.split("src=\"") {
                if let Some(end) = part.find('\"') {
                    let path = &part[..end];
                    if path.contains("/_next/static/chunks/") {
                        let script_url = format!("https://howlongtobeat.com{}", path);
                        if let Ok(s_resp) = client
                            .get(&script_url)
                            .header("User-Agent", ua)
                            .send()
                            .await
                        {
                            if let Ok(js_content) = s_resp.text().await {
                                if let Some(idx) = js_content.find("/api/search/") {
                                    let sub = &js_content[idx..];
                                    if let Some(end_quote) =
                                        sub.find(['\"', '\'', '`', '?', ' ', '$'])
                                    {
                                        let mut ep =
                                            sub[..end_quote].trim_end_matches('/').to_string();
                                        if let Some(pos) = ep.find("/init") {
                                            ep = ep[..pos].to_string();
                                        }
                                        let ep = ep.trim_end_matches('/').to_string();
                                        if !ep.is_empty() {
                                            search_endpoint = ep;
                                            break;
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

    // 2. Auth token & dynamic key/val al
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let init_url = format!(
        "https://howlongtobeat.com{}/init?t={}",
        search_endpoint, now
    );

    let mut auth_token = String::new();
    let mut auth_key = String::new();
    let mut auth_val = String::new();

    if let Ok(init_resp) = client
        .get(&init_url)
        .header("User-Agent", ua)
        .header("Referer", "https://howlongtobeat.com/")
        .send()
        .await
    {
        if let Ok(init_json) = init_resp.json::<serde_json::Value>().await {
            if let Some(t) = init_json.get("token").and_then(|x| x.as_str()) {
                auth_token = t.to_string();
            }
            if let Some(obj) = init_json.as_object() {
                for (k, v) in obj {
                    let lower = k.to_lowercase();
                    if lower.contains("key") {
                        if let Some(s) = v.as_str() {
                            auth_key = s.to_string();
                        }
                    } else if lower.contains("val") {
                        if let Some(s) = v.as_str() {
                            auth_val = s.to_string();
                        }
                    }
                }
            }
        }
    }

    // 3. Search, then retry with the store's version tag removed when nothing
    // matched ("Grand Theft Auto V Enhanced" / "... Legacy" live in HLTB as
    // "Grand Theft Auto V"; a real title ending in such a word, like
    // "Hogwarts Legacy", already matched on the first try).
    let (mut result_data, first_exact, mut reached) = search_hltb(
        &client,
        &search_endpoint,
        &terms,
        (&auth_token, &auth_key, &auth_val),
        app_name,
        title,
        year,
    )
    .await;
    // The store tag is only dropped after a full-title pass, but that pass can
    // also match the wrong game ("Marvel's Spider-Man Remastered" → an entry
    // named "Spider-Man"). When it was not an exact hit, the loosened search
    // gets its turn, and an exact hit there wins.
    if !first_exact {
        let loosened = loosen_hltb_search_term(&search_term);
        let loose_terms: Vec<&str> = loosened.split_whitespace().collect();
        if loosened != search_term && !loose_terms.is_empty() {
            let (retry, retry_exact, retry_reached) = search_hltb(
                &client,
                &search_endpoint,
                &loose_terms,
                (&auth_token, &auth_key, &auth_val),
                app_name,
                title,
                year,
            )
            .await;
            reached |= retry_reached;
            if retry_exact || !result_data.supported {
                result_data = retry;
            }
        }
    }

    // A definitive answer is stored either way. A stored miss keeps the page
    // from asking HowLongToBeat again on every open; a network failure is not
    // stored, so the next open retries it.
    if result_data.supported || reached {
        if let Ok(_) = tokio::fs::create_dir_all(hltb_cache_dir()).await {
            if let Ok(json_str) = serde_json::to_string_pretty(&result_data) {
                let _ = tokio::fs::write(&cache_file, json_str).await;
            }
        }
    }

    result_data
}

/// Browser UA for every HLTB request (their endpoint rejects bare clients).
const HLTB_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

fn empty_hltb(app_name: &str, title: &str) -> HltbData {
    HltbData {
        app_name: app_name.to_string(),
        title: title.to_string(),
        supported: false,
        main_story: None,
        main_extra: None,
        completionist: None,
    }
}

/// One HLTB search: the payload, the session's dynamic auth headers, and the
/// best-matching result parsed into durations (plus whether it was an exact
/// name match and whether the site actually answered).
async fn search_hltb(
    client: &reqwest::Client,
    endpoint: &str,
    terms: &[&str],
    auth: (&str, &str, &str),
    app_name: &str,
    title: &str,
    year: Option<u32>,
) -> (HltbData, bool, bool) {
    if terms.is_empty() {
        return (empty_hltb(app_name, title), false, false);
    }
    let mut payload = serde_json::json!({
        "searchType": "games",
        "searchTerms": terms,
        "searchPage": 1,
        "size": 20,
        "searchOptions": {
            "games": {
                "userId": 0,
                "platform": "",
                "sortCategory": "popular",
                "rangeCategory": "main",
                "rangeTime": { "min": 0, "max": 0 },
                "gameplay": { "perspective": "", "flow": "", "genre": "", "difficulty": "" },
                "rangeYear": { "min": "", "max": "" },
                "modifier": ""
            },
            "users": { "sortCategory": "postcount" },
            "lists": { "sortCategory": "follows" },
            "filter": "",
            "sort": 0,
            "randomizer": 0
        },
        "useCache": true
    });

    if !auth.1.is_empty() && !auth.2.is_empty() {
        if let Some(m) = payload.as_object_mut() {
            m.insert(auth.1.to_string(), serde_json::Value::String(auth.2.to_string()));
        }
    }

    let mut req = client
        .post(format!("https://howlongtobeat.com{}", endpoint))
        .header("User-Agent", HLTB_UA)
        .header("Referer", "https://howlongtobeat.com/")
        .header("Origin", "https://howlongtobeat.com")
        .header("Content-Type", "application/json")
        .header("Accept", "*/*");

    if !auth.0.is_empty() {
        req = req.header("x-auth-token", auth.0);
    }
    if !auth.1.is_empty() {
        req = req.header("x-hp-key", auth.1);
    }
    if !auth.2.is_empty() {
        req = req.header("x-hp-val", auth.2);
    }

    match req.json(&payload).send().await {
        Ok(resp) if resp.status().is_success() => match resp.text().await {
            Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(val) => {
                    let (data, exact) = parse_hltb_response(app_name, title, terms, &val, year);
                    (data, exact, true)
                }
                Err(_) => (empty_hltb(app_name, title), false, false),
            },
            Err(_) => (empty_hltb(app_name, title), false, false),
        },
        _ => (empty_hltb(app_name, title), false, false),
    }
}

/// Second attempt for store version tags that HLTB's own names do not carry:
/// "Grand Theft Auto V Enhanced" and "... Legacy" are "Grand Theft Auto V"
/// there. Only used when the exact cleaned title found nothing, so a real title
/// ending in such a word ("Hogwarts Legacy") is never shortened.
pub fn loosen_hltb_search_term(term: &str) -> String {
    const TAGS: [&str; 14] = [
        "Enhanced", "Legacy", "Remastered", "Definitive", "Edition", "Complete", "Ultimate",
        "Premium", "Extended", "Deluxe", "Gold", "Standard", "Special", "GOTY",
    ];
    let trim = |s: &str| s.trim().trim_end_matches([':', '-', '\u{2013}']).trim().to_string();
    let mut rest = trim(term);
    for _ in 0..3 {
        let Some(last) = rest.split_whitespace().last().map(str::to_string) else {
            break;
        };
        let word = last.trim_end_matches(|c: char| !c.is_alphanumeric());
        let is_tag = TAGS.iter().any(|tag| tag.eq_ignore_ascii_case(word))
            || word.to_ascii_lowercase().ends_with("edition");
        if !is_tag {
            break;
        }
        let cut = rest.len() - last.len();
        rest = trim(&rest[..cut]);
    }
    rest
}

/// Letters and digits only, lowercased: "Marvel's Spider-Man 2" → "marvelsspiderman2".
fn hltb_norm(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The year HLTB stores for an entry. The search API has shipped `release_world`
/// both as a plain year and as a unix timestamp (seconds or milliseconds).
pub fn hltb_entry_year(item: &serde_json::Value) -> Option<u32> {
    let raw = ["release_world", "releaseYear", "release_year", "year"]
        .iter()
        .find_map(|key| item.get(*key))?;
    let value = raw
        .as_f64()
        .or_else(|| raw.as_str().and_then(|text| text.parse::<f64>().ok()))?;
    let year = if value >= 1_000_000_000_000.0 {
        (value / 1000.0 / 31_557_600.0) as u32 + 1970
    } else if value >= 1_000_000_000.0 {
        (value / 31_557_600.0) as u32 + 1970
    } else {
        value as u32
    };
    (1900..=2100).contains(&year).then_some(year)
}

/// Picks the entry whose name (and, when known, release year) matches. A
/// name-only hit is an older game with the same title, so with a year in hand a
/// non-matching entry is dropped instead of guessed.
pub fn pick_hltb_item<'a>(
    items: &'a [serde_json::Value],
    term: &str,
    year: Option<u32>,
) -> Option<&'a serde_json::Value> {
    let want = hltb_norm(term);
    if want.is_empty() {
        return items.first();
    }
    let mut best: Option<(i32, &serde_json::Value)> = None;
    for item in items {
        let name = hltb_norm(item.get("game_name").and_then(|v| v.as_str()).unwrap_or(""));
        if name.len() < 3 {
            continue;
        }
        let mut score = if name == want {
            1000
        } else if name.contains(&want) || want.contains(&name) {
            // A longer overlap is the more specific name: for "Marvel's
            // Spider-Man Remastered" the 2018 "Marvel's Spider-Man" beats the
            // 2000 "Spider-Man".
            500 + (name.len() as i32) * 2
        } else {
            0
        };
        if score == 0 {
            continue;
        }
        match (hltb_entry_year(item), year) {
            (Some(entry_year), Some(want_year)) => {
                let delta = (entry_year as i64 - want_year as i64).abs();
                if delta == 0 {
                    score += 400;
                } else if delta <= 1 {
                    score += 150;
                } else {
                    score -= 400;
                }
            }
            (None, Some(_)) => score -= 200,
            _ => {}
        }
        if best.as_ref().map(|(top, _)| score > *top).unwrap_or(true) {
            best = Some((score, item));
        }
    }
    match best {
        Some((score, item)) if score > 0 => Some(item),
        // No year to check against: keep HLTB's old behaviour (most popular).
        _ if year.is_none() => items.first(),
        _ => None,
    }
}

#[cfg(test)]
mod pick_tests {
    use super::{clean_hltb_search_term, pick_hltb_item};
    use serde_json::json;

    #[test]
    fn older_game_with_the_same_name_is_rejected() {
        let items = vec![
            json!({ "game_name": "Spider-Man 2", "release_world": 2004, "comp_main": 25000 }),
            json!({ "game_name": "Marvel's Spider-Man 2", "release_world": 2023, "comp_main": 60000 }),
        ];
        let picked = pick_hltb_item(&items, "Marvel's Spider-Man 2", Some(2023)).unwrap();
        assert_eq!(picked["release_world"], 2023);
        // Without a year the exact name still wins.
        let picked = pick_hltb_item(&items, "Marvel's Spider-Man 2", None).unwrap();
        assert_eq!(picked["release_world"], 2023);
    }

    #[test]
    fn timestamp_years_are_read() {
        let items = vec![json!({
            "game_name": "Marvel's Spider-Man 2",
            "release_world": 1698710400,
            "comp_main": 60000
        })];
        assert_eq!(pick_hltb_item(&items, "Marvel's Spider-Man 2", Some(2023)).is_some(), true);
    }

    /// The stores write edition suffixes after an en dash; the rules look for a
    /// hyphen, so the suffix used to survive and the search asked
    /// HowLongToBeat for a title ending in a dash.
    #[test]
    fn an_en_dash_edition_suffix_is_stripped_too() {
        assert_eq!(
            clean_hltb_search_term("Grand Theft Auto III – The Definitive Edition"),
            "Grand Theft Auto III"
        );
        assert_eq!(
            clean_hltb_search_term("The Witcher 3: Wild Hunt - Game of the Year Edition"),
            "The Witcher 3: Wild Hunt"
        );
        // A plain hyphen inside a name stays, and a bare title is untouched.
        assert_eq!(clean_hltb_search_term("Half-Life 2"), "Half-Life 2");
        assert_eq!(clean_hltb_search_term("Hades"), "Hades");
    }

    #[test]
    fn the_most_specific_partial_name_wins() {
        let items = vec![
            json!({ "game_name": "Spider-Man", "release_world": 2000, "comp_main": 21600 }),
            json!({ "game_name": "Marvel's Spider-Man", "release_world": 2018, "comp_main": 61200 }),
        ];
        // No year at hand: the 2018 game is the closer name, not the 2000 one.
        let picked = pick_hltb_item(&items, "Marvel's Spider-Man Remastered", None).unwrap();
        assert_eq!(picked["game_name"], "Marvel's Spider-Man");
    }

    #[test]
    fn nothing_matching_a_known_year_yields_none() {
        let items = vec![json!({ "game_name": "Some Other Game", "release_world": 2015 })];
        assert!(pick_hltb_item(&items, "Marvel's Spider-Man 2", Some(2023)).is_none());
    }

    /// Live probe: what does HowLongToBeat actually answer? Run it when a game
    /// page shows no lengths, with `--nocapture` to read the lines.
    #[test]
    #[ignore = "talks to howlongtobeat.com"]
    fn hltb_live_probe() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let cases: [(&str, Option<u32>); 5] = [
                ("Grand Theft Auto III", Some(2021)),
                ("Grand Theft Auto III", None),
                ("Grand Theft Auto III – The Definitive Edition", Some(2021)),
                ("Dead by Daylight", Some(2016)),
                ("Hades", Some(2020)),
            ];
            for (title, year) in cases {
                let data = super::get_hltb_data(title, "probe::hltb", true, year).await;
                println!(
                    "{title} (year {year:?}) -> supported={} story={:?} extra={:?} complete={:?}",
                    data.supported, data.main_story, data.main_extra, data.completionist
                );
            }
        });
    }
}

/// Parses a search response into durations. The flag says whether the picked
/// entry's name equals the search term — the strongest possible hit, and the one
/// the caller prefers over a looser search's result.
fn parse_hltb_response(
    app_name: &str,
    title: &str,
    terms: &[&str],
    val: &serde_json::Value,
    year: Option<u32>,
) -> (HltbData, bool) {
    if let Some(items) = val.get("data").and_then(|d| d.as_array()) {
        let term = terms.join(" ");
        if let Some(first) = pick_hltb_item(items, &term, year) {
            let exact = hltb_norm(first.get("game_name").and_then(|v| v.as_str()).unwrap_or(""))
                == hltb_norm(&term);
            let sec_to_hours = |k: &str| -> Option<f64> {
                let s = first.get(k)?.as_f64()?;
                if s <= 0.0 {
                    None
                } else {
                    Some(((s / 3600.0) * 10.0).round() / 10.0)
                }
            };

            let main_story = sec_to_hours("comp_main");
            let main_extra = sec_to_hours("comp_plus");
            let completionist = sec_to_hours("comp_100");

            let supported = main_story.is_some() || main_extra.is_some() || completionist.is_some();

            return (
                HltbData {
                    app_name: app_name.to_string(),
                    title: title.to_string(),
                    supported,
                    main_story,
                    main_extra,
                    completionist,
                },
                exact,
            );
        }
    }

    (empty_hltb(app_name, title), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_clean_hltb_search_term() {
        assert_eq!(
            clean_hltb_search_term("Cyberpunk 2077 - Standard Edition"),
            "Cyberpunk 2077"
        );
        // The site's own names carry the prefixes and the "Remastered" tag: the
        // term must stay exactly what the store title says.
        assert_eq!(
            clean_hltb_search_term("Tom Clancy's Rainbow Six Siege"),
            "Tom Clancy's Rainbow Six Siege"
        );
        assert_eq!(
            clean_hltb_search_term("Marvel's Spider-Man Remastered"),
            "Marvel's Spider-Man Remastered"
        );
        assert_eq!(
            clean_hltb_search_term("The Witcher 3: Wild Hunt - Game of the Year Edition"),
            "The Witcher 3: Wild Hunt"
        );
    }

    #[test]
    fn test_loosen_hltb_search_term() {
        assert_eq!(
            loosen_hltb_search_term("Grand Theft Auto V Enhanced"),
            "Grand Theft Auto V"
        );
        assert_eq!(
            loosen_hltb_search_term("Grand Theft Auto V Legacy"),
            "Grand Theft Auto V"
        );
        assert_eq!(
            loosen_hltb_search_term("The Witcher 3: Wild Hunt Complete Edition"),
            "The Witcher 3: Wild Hunt"
        );
        assert_eq!(loosen_hltb_search_term("Grand Theft Auto III"), "Grand Theft Auto III");
        // The loosened term is only a fallback: "Hogwarts Legacy" is searched
        // with its full name first, so stripping the word cannot hurt it.
        assert_eq!(loosen_hltb_search_term("Hogwarts Legacy"), "Hogwarts");
    }

    #[test]
    fn test_parse_hltb_response() {
        let json = serde_json::json!({
            "data": [{
                "game_id": 2127,
                "game_name": "Cyberpunk 2077",
                "comp_main": 90000,
                "comp_plus": 216000,
                "comp_100": 360000
            }]
        });

        let (data, exact) = parse_hltb_response("Ginger", "Cyberpunk 2077", &["Cyberpunk", "2077"], &json, None);
        assert!(exact);
        assert!(data.supported);
        assert_eq!(data.main_story, Some(25.0));
        assert_eq!(data.main_extra, Some(60.0));
        assert_eq!(data.completionist, Some(100.0));
    }
}
