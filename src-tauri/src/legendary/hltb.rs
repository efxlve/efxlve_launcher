use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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

/// One HowLongToBeat entry the player picked for a game. The durations are a
/// snapshot: a hit in the normal cache never expires either, and clearing the
/// choice runs the automatic search again.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct HltbPick {
    pub id: i64,
    pub name: String,
    #[serde(default)]
    pub year: Option<u32>,
    #[serde(default)]
    pub main_story: Option<f64>,
    #[serde(default)]
    pub main_extra: Option<f64>,
    #[serde(default)]
    pub completionist: Option<f64>,
}

impl HltbPick {
    pub fn to_data(&self, app_name: &str, title: &str) -> HltbData {
        HltbData {
            app_name: app_name.to_string(),
            title: title.to_string(),
            supported: self.main_story.is_some()
                || self.main_extra.is_some()
                || self.completionist.is_some(),
            main_story: self.main_story,
            main_extra: self.main_extra,
            completionist: self.completionist,
        }
    }
}

/// One row of the match picker's search: the site's own name, year and type.
#[derive(Debug, Clone, Serialize)]
pub struct HltbSearchHit {
    pub id: i64,
    pub name: String,
    pub year: Option<u32>,
    pub dlc: bool,
    pub main_story: Option<f64>,
    pub main_extra: Option<f64>,
    pub completionist: Option<f64>,
}

impl HltbSearchHit {
    /// Used by the picker test; the frontend sends the same fields back and
    /// serde ignores the extra `dlc` flag.
    #[cfg(test)]
    pub fn pick(&self) -> HltbPick {
        HltbPick {
            id: self.id,
            name: self.name.clone(),
            year: self.year,
            main_story: self.main_story,
            main_extra: self.main_extra,
            completionist: self.completionist,
        }
    }
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
    // `-v5` marks the answers written before the picker preferred the base game
    // over its DLC chapters and before a renamed game had to be searched again.
    // Older files can hold a chapter's times under a base game's title, so they
    // must not be served again.
    if let Some(config_dir) = dirs_config_dir() {
        config_dir.join("legendary").join("hltb-v5")
    } else {
        PathBuf::from("hltb_cache_v5")
    }
}

fn dirs_config_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .map(PathBuf::from)
        .map(|p| p.join(".config"))
}

/// Every HowLongToBeat hit already stored on disk.
///
/// The library's story-length sort reads this once at boot, so the order covers
/// the games whose page was opened before without one network lookup per game.
/// A stored miss stays out: it has no length to sort, and the page keeps owning
/// its monthly retry. The same game can have a file per release year; the newer
/// answer wins.
pub fn cached_times() -> Vec<HltbData> {
    let Ok(entries) = std::fs::read_dir(hltb_cache_dir()) else {
        return Vec::new();
    };
    let mut by_app: HashMap<String, (HltbData, u64)> = HashMap::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(data) = serde_json::from_str::<HltbData>(&text) else {
            continue;
        };
        if data.app_name.trim().is_empty() || !data.supported {
            continue;
        }
        let written = entry
            .metadata()
            .ok()
            .and_then(|meta| meta.modified().ok())
            .and_then(|at| at.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        match by_app.get_mut(&data.app_name) {
            Some((stored, stored_at)) => {
                if written >= *stored_at {
                    *stored = data;
                    *stored_at = written;
                }
            }
            None => {
                by_app.insert(data.app_name.clone(), (data, written));
            }
        }
    }
    let mut rows: Vec<HltbData> = by_app.into_values().map(|(data, _)| data).collect();
    // A hand-picked entry is the answer the page shows, so the sort uses it too.
    for (app_name, choice) in crate::game_match::all() {
        if let Some(pick) = choice.hltb {
            rows.retain(|row| row.app_name != app_name);
            rows.push(pick.to_data(&app_name, &pick.name));
        }
    }
    rows.sort_by(|a, b| a.app_name.cmp(&b.app_name));
    rows
}

pub async fn get_hltb_data(
    title: &str,
    app_name: &str,
    force_refresh: bool,
    year: Option<u32>,
) -> HltbData {
    // A game the player matched by hand reads that entry until the choice is
    // cleared; it beats the automatic answer and its cache.
    if let Some(pick) = crate::game_match::hltb_pick(app_name) {
        return pick.to_data(app_name, title);
    }
    let clean_app = app_name.replace([':', '/', '\\', '*', '?', '"', '<', '>', '|'], "_");
    // The release year is part of the cache key too: a name-only hit can be an
    // older game with the same title ("Spider-Man 2" vs "Marvel's Spider-Man 2").
    let cache_file = hltb_cache_dir().join(format!("{}-{}.json", clean_app, year.unwrap_or(0)));

    if !force_refresh {
        if let Ok(content) = tokio::fs::read_to_string(&cache_file).await {
            if let Ok(data) = serde_json::from_str::<HltbData>(&content) {
                // A file written for an earlier title of this game (a renamed
                // custom game, a DLC row that later became the base game) must
                // not answer for the title the page shows now.
                let same_title = hltb_norm(&data.title) == hltb_norm(title);
                if data.supported && same_title {
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
                if !data.supported && same_title && age < crate::lookup_cache::MISS_TTL_SECS {
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

    // 1. Search endpoint, discovered once per app run (see `detect_search_endpoint`).
    let search_endpoint = detect_search_endpoint(&client).await;

    // 2. Auth token and the session's dynamic key/value pair.
    let auth = hltb_auth(&client, &search_endpoint).await;

    // 3. Search, then retry with the store's version tag removed when nothing
    // matched ("Grand Theft Auto V Enhanced" / "... Legacy" live in HLTB as
    // "Grand Theft Auto V"; a real title ending in such a word, like
    // "Hogwarts Legacy", already matched on the first try).
    let (mut result_data, first_exact, mut reached) = search_hltb(
        &client,
        &search_endpoint,
        &terms,
        (&auth.token, &auth.key, &auth.val),
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
                (&auth.token, &auth.key, &auth.val),
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

    // A search that never reached the site may mean the discovered endpoint
    // moved; drop it so the next game loads the site bundle again.
    if !reached {
        forget_search_endpoint().await;
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

/// The search endpoint is read from the site's own JavaScript bundle. It only
/// changes when HowLongToBeat ships a new build, so one discovery per app run is
/// enough: the library length pass would otherwise load the homepage for every
/// game it asks about. A failed discovery is not cached, and a request that
/// never reached the site clears the answer so the next game tries again.
static SEARCH_ENDPOINT: tokio::sync::Mutex<Option<String>> = tokio::sync::Mutex::const_new(None);

async fn detect_search_endpoint(client: &reqwest::Client) -> String {
    let cached = SEARCH_ENDPOINT.lock().await.clone();
    if let Some(endpoint) = cached {
        return endpoint;
    }
    let discovered = discover_search_endpoint(client).await;
    if let Some(endpoint) = discovered.clone() {
        *SEARCH_ENDPOINT.lock().await = Some(endpoint);
    }
    discovered.unwrap_or_else(|| "/api/search/site".to_string())
}

async fn forget_search_endpoint() {
    *SEARCH_ENDPOINT.lock().await = None;
}

async fn discover_search_endpoint(client: &reqwest::Client) -> Option<String> {
    let home_resp = client
        .get("https://howlongtobeat.com/")
        .header("User-Agent", HLTB_UA)
        .send()
        .await
        .ok()?;
    let home_html = home_resp.text().await.ok()?;
    for part in home_html.split("src=\"") {
        let Some(end) = part.find('"') else {
            continue;
        };
        let path = &part[..end];
        if !path.contains("/_next/static/chunks/") {
            continue;
        }
        let script_url = format!("https://howlongtobeat.com{}", path);
        let Ok(resp) = client
            .get(&script_url)
            .header("User-Agent", HLTB_UA)
            .send()
            .await
        else {
            continue;
        };
        let Ok(js_content) = resp.text().await else {
            continue;
        };
        let Some(idx) = js_content.find("/api/search/") else {
            continue;
        };
        let sub = &js_content[idx..];
        let Some(end_quote) = sub.find(['"', '\'', '`', '?', ' ', '$']) else {
            continue;
        };
        let mut ep = sub[..end_quote].trim_end_matches('/').to_string();
        if let Some(pos) = ep.find("/init") {
            ep = ep[..pos].to_string();
        }
        let ep = ep.trim_end_matches('/').to_string();
        if !ep.is_empty() {
            return Some(ep);
        }
    }
    None
}

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

/// The session headers HowLongToBeat's search needs. The key and value are
/// dynamic (`x-hp-key` / `x-hp-val`) and change with the site's build, so they
/// are read for every session instead of being hardcoded.
struct HltbAuth {
    token: String,
    key: String,
    val: String,
}

async fn hltb_auth(client: &reqwest::Client, endpoint: &str) -> HltbAuth {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let init_url = format!(
        "https://howlongtobeat.com{}/init?t={}",
        endpoint, now
    );
    let mut auth = HltbAuth {
        token: String::new(),
        key: String::new(),
        val: String::new(),
    };
    let Ok(init_resp) = client
        .get(&init_url)
        .header("User-Agent", HLTB_UA)
        .header("Referer", "https://howlongtobeat.com/")
        .send()
        .await
    else {
        return auth;
    };
    let Ok(init_json) = init_resp.json::<serde_json::Value>().await else {
        return auth;
    };
    if let Some(token) = init_json.get("token").and_then(|x| x.as_str()) {
        auth.token = token.to_string();
    }
    if let Some(obj) = init_json.as_object() {
        for (key, value) in obj {
            let lower = key.to_lowercase();
            if lower.contains("key") {
                if let Some(text) = value.as_str() {
                    auth.key = text.to_string();
                }
            } else if lower.contains("val") {
                if let Some(text) = value.as_str() {
                    auth.val = text.to_string();
                }
            }
        }
    }
    auth
}

/// One search request. `None` means the site did not answer with JSON, which is
/// also the cue to forget a search endpoint the site no longer serves.
async fn hltb_search_value(
    client: &reqwest::Client,
    endpoint: &str,
    terms: &[&str],
    auth: (&str, &str, &str),
) -> Option<serde_json::Value> {
    if terms.is_empty() {
        return None;
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
        if let Some(map) = payload.as_object_mut() {
            map.insert(auth.1.to_string(), serde_json::Value::String(auth.2.to_string()));
        }
    }

    let mut request = client
        .post(format!("https://howlongtobeat.com{}", endpoint))
        .header("User-Agent", HLTB_UA)
        .header("Referer", "https://howlongtobeat.com/")
        .header("Origin", "https://howlongtobeat.com")
        .header("Content-Type", "application/json")
        .header("Accept", "*/*");

    if !auth.0.is_empty() {
        request = request.header("x-auth-token", auth.0);
    }
    if !auth.1.is_empty() {
        request = request.header("x-hp-key", auth.1);
    }
    if !auth.2.is_empty() {
        request = request.header("x-hp-val", auth.2);
    }

    let response = request.json(&payload).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let text = response.text().await.ok()?;
    serde_json::from_str::<serde_json::Value>(&text).ok()
}

/// One HLTB search: the session's dynamic auth headers and the best-matching
/// result parsed into durations (plus whether it was an exact name match and
/// whether the site actually answered).
async fn search_hltb(
    client: &reqwest::Client,
    endpoint: &str,
    terms: &[&str],
    auth: (&str, &str, &str),
    app_name: &str,
    title: &str,
    year: Option<u32>,
) -> (HltbData, bool, bool) {
    match hltb_search_value(client, endpoint, terms, auth).await {
        Some(value) => {
            let (data, exact) = parse_hltb_response(app_name, title, terms, &value, year);
            (data, exact, true)
        }
        None => (empty_hltb(app_name, title), false, false),
    }
}

/// The match picker's search: every row the site returned, in its own order,
/// with the release year, the type and the three lengths. No automatic pick:
/// the player chooses the entry.
pub async fn search_hltb_entries(title: &str) -> Result<Vec<HltbSearchHit>, String> {
    let search_term = clean_hltb_search_term(title);
    let terms: Vec<&str> = search_term.split_whitespace().collect();
    if terms.is_empty() {
        return Ok(Vec::new());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|_| "@t:match.searchFailed".to_string())?;
    let endpoint = detect_search_endpoint(&client).await;
    let auth = hltb_auth(&client, &endpoint).await;
    let Some(value) = hltb_search_value(
        &client,
        &endpoint,
        &terms,
        (&auth.token, &auth.key, &auth.val),
    )
    .await
    else {
        forget_search_endpoint().await;
        return Err("@t:match.searchFailed".to_string());
    };
    Ok(value
        .get("data")
        .and_then(serde_json::Value::as_array)
        .map(|items| items.iter().filter_map(hltb_search_hit).collect())
        .unwrap_or_default())
}

fn hltb_search_hit(item: &serde_json::Value) -> Option<HltbSearchHit> {
    let id = item.get("game_id").and_then(serde_json::Value::as_i64)?;
    let name = item
        .get("game_name")
        .and_then(serde_json::Value::as_str)?
        .trim()
        .to_string();
    if id <= 0 || name.is_empty() {
        return None;
    }
    let game_type = item
        .get("game_type")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase();
    Some(HltbSearchHit {
        id,
        name,
        year: hltb_entry_year(item),
        dlc: game_type == "dlc",
        main_story: seconds_to_hours(item.get("comp_main")),
        main_extra: seconds_to_hours(item.get("comp_plus")),
        completionist: seconds_to_hours(item.get("comp_100")),
    })
}

fn seconds_to_hours(value: Option<&serde_json::Value>) -> Option<f64> {
    let seconds = value?.as_f64()?;
    if seconds <= 0.0 {
        return None;
    }
    Some(((seconds / 3600.0) * 10.0).round() / 10.0)
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
        // The site keeps a game's DLC chapters under the game's own name. A
        // base-game entry wins the tie, so "Far Cry 6" is the game and not its
        // "Lost Between Worlds" chapter; a DLC page still matches its exact
        // name and keeps its own lengths.
        let game_type = item
            .get("game_type")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        if game_type.is_empty() || game_type.eq_ignore_ascii_case("game") {
            score += 60;
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

    /// The reported "wrong HowLongToBeat time" was a DLC chapter: the site
    /// returns the base game and its add-ons for one search, and the base game
    /// must win when the search names it exactly.
    #[test]
    fn the_base_game_beats_its_dlc_chapters() {
        let items = vec![
            json!({
                "game_id": 117861,
                "game_name": "Far Cry 6 - Lost Between Worlds",
                "release_world": 2022,
                "game_type": "dlc",
                "comp_main": 14799
            }),
            json!({
                "game_id": 80870,
                "game_name": "Far Cry 6",
                "release_world": 2021,
                "game_type": "game",
                "comp_main": 90398
            }),
        ];
        let picked = pick_hltb_item(&items, "Far Cry 6", Some(2021)).unwrap();
        assert_eq!(picked["game_id"], 80870);

        // A page for the chapter still gets the chapter's own entry.
        let picked =
            pick_hltb_item(&items, "Far Cry 6 - Lost Between Worlds", Some(2022)).unwrap();
        assert_eq!(picked["game_id"], 117861);
    }

    /// Live probe: what does the match picker's search return? Run it with
    /// `--ignored --nocapture` when a reported game needs the wrong entry
    /// untangled by hand.
    #[test]
    #[ignore = "talks to howlongtobeat.com"]
    fn hltb_picker_live_probe() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            for title in ["Far Cry 6", "Alan Wake 2", "Portal"] {
                match super::search_hltb_entries(title).await {
                    Ok(rows) => {
                        println!("{title}: {} rows", rows.len());
                        for row in rows.iter().take(6) {
                            println!(
                                "  {} · {:?} · dlc={} · {:?} h",
                                row.name, row.year, row.dlc, row.main_story
                            );
                        }
                    }
                    Err(error) => println!("{title}: {error}"),
                }
            }
        });
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
            let main_story = seconds_to_hours(first.get("comp_main"));
            let main_extra = seconds_to_hours(first.get("comp_plus"));
            let completionist = seconds_to_hours(first.get("comp_100"));

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

    #[test]
    fn a_search_row_carries_the_type_and_every_length() {
        let item = serde_json::json!({
            "game_id": 151820,
            "game_name": "Alan Wake II: Night Springs",
            "game_type": "dlc",
            "release_world": 2024,
            "comp_main": 8704,
            "comp_plus": 0,
            "comp_100": 10507
        });
        let hit = hltb_search_hit(&item).expect("a row with an id and a name");
        assert_eq!(hit.id, 151820);
        assert!(hit.dlc);
        assert_eq!(hit.year, Some(2024));
        assert_eq!(hit.main_story, Some(2.4));
        assert_eq!(hit.main_extra, None);
        assert_eq!(hit.completionist, Some(2.9));

        // The pick keeps the page's own title, not the site's.
        let data = hit.pick().to_data("custom::alan", "Alan Wake 2");
        assert!(data.supported);
        assert_eq!(data.title, "Alan Wake 2");
        assert_eq!(data.main_story, Some(2.4));
    }
}
