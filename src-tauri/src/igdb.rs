//! IGDB (Twitch) client: search and game details for the game pages.
//!
//! Two transports, picked automatically:
//!
//! * **Proxy** (default): the launcher's shared Netlify function holds the
//!   Twitch credentials, so users install nothing and register nothing. See
//!   `services/igdb-proxy/`. The address is stored in `<app_data>/igdb/proxy.json`
//!   and defaults to [`DEFAULT_PROXY_URL`].
//! * **Direct** (opt-in): the user's own Twitch app. The secret stays on this
//!   machine — sealed with DPAPI, never shipped with the launcher and never
//!   committed — because a leaked secret lets anyone mint tokens for that app
//!   and burn its rate limit. Saving credentials switches the transport to
//!   direct; clearing them falls back to the proxy.
//!
//! Requests run here in Rust (the API refuses browser calls on purpose), keep
//! the 4 requests/second limit, and cache each game on disk: IGDB explicitly
//! asks for caching, and it keeps the limit free for the games users open.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

const TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const API_BASE: &str = "https://api.igdb.com/v4";
/// The launcher's shared proxy: no user setup, the secret lives server-side.
const DEFAULT_PROXY_URL: &str = "https://efxlve.com/api/igdb";
/// The API allows 4 requests per second; one every 260 ms stays under it.
const MIN_REQUEST_GAP: Duration = Duration::from_millis(260);
/// How many screenshots / similar games a game page shows.
const MAX_SCREENSHOTS: usize = 6;
const MAX_SIMILAR: usize = 6;
/// DLC/expansion names IGDB returns; the page filters and caps them again.
const MAX_EXTRAS: usize = 40;

static TOKEN: Mutex<Option<CachedToken>> = Mutex::new(None);
static LAST_REQUEST: Mutex<Option<Instant>> = Mutex::new(None);

struct CachedToken {
    client_id: String,
    value: String,
    expires_at: Instant,
}

fn http() -> &'static reqwest::Client {
    static CLIENT: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default()
    })
}

/* ---------- Credentials (sealed, machine-local) ---------- */

#[derive(Serialize, Deserialize, Clone, Default)]
struct Credentials {
    client_id: String,
    client_secret: String,
}

fn igdb_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|dir| dir.join("igdb"))
}

fn credentials_path(app: &AppHandle) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join("credentials.bin"))
}

fn load_credentials(app: &AppHandle) -> Option<Credentials> {
    let path = credentials_path(app)?;
    let sealed = std::fs::read(path).ok()?;
    let plain = crate::steam_auth::vault::dpapi::unprotect(&sealed).ok()?;
    let credentials: Credentials = serde_json::from_slice(&plain).ok()?;
    if credentials.client_id.trim().is_empty() || credentials.client_secret.trim().is_empty() {
        return None;
    }
    Some(credentials)
}

fn save_credentials(app: &AppHandle, credentials: &Credentials) -> Result<(), String> {
    let path = credentials_path(app).ok_or_else(|| "@t:igdb.noStore".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "@t:igdb.noStore".to_string())?;
    }
    let plain = serde_json::to_vec(credentials).map_err(|_| "@t:igdb.noStore".to_string())?;
    let sealed = crate::steam_auth::vault::dpapi::protect(&plain)?;
    std::fs::write(&path, sealed).map_err(|_| "@t:igdb.noStore".to_string())
}

/* ---------- Proxy address (not a secret) ---------- */

#[derive(Serialize, Deserialize, Clone, Default)]
struct ProxyConfig {
    url: String,
}

fn proxy_config_path(app: &AppHandle) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join("proxy.json"))
}

/// The proxy address in use: the stored one, or the launcher's shared server.
fn proxy_url(app: &AppHandle) -> String {
    let stored = proxy_config_path(app)
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|raw| serde_json::from_slice::<ProxyConfig>(&raw).ok())
        .map(|config| config.url.trim().to_string())
        .unwrap_or_default();
    if stored.is_empty() {
        DEFAULT_PROXY_URL.to_string()
    } else {
        stored
    }
}

fn save_proxy_url(app: &AppHandle, url: &str) -> Result<(), String> {
    let path = proxy_config_path(app).ok_or_else(|| "@t:igdb.noStore".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|_| "@t:igdb.noStore".to_string())?;
    }
    let config = ProxyConfig {
        url: url.trim().to_string(),
    };
    let raw = serde_json::to_vec(&config).map_err(|_| "@t:igdb.noStore".to_string())?;
    std::fs::write(&path, raw).map_err(|_| "@t:igdb.noStore".to_string())
}

/// How this machine reaches IGDB: the user's own credentials win, the shared
/// proxy is the default, and "off" means neither is usable.
enum Transport {
    Direct,
    Proxy(String),
    Off,
}

fn transport(app: &AppHandle) -> Transport {
    if load_credentials(app).is_some() {
        return Transport::Direct;
    }
    let url = proxy_url(app);
    if url.starts_with("https://") || url.starts_with("http://") {
        Transport::Proxy(url)
    } else {
        Transport::Off
    }
}

/* ---------- Tokens and requests ---------- */

/// The app access token, reused until it is close to expiring.
async fn app_token(app: &AppHandle) -> Result<(String, String), String> {
    let credentials = load_credentials(app).ok_or_else(|| "@t:igdb.notConfigured".to_string())?;
    if let Ok(guard) = TOKEN.lock() {
        if let Some(cached) = guard.as_ref() {
            if cached.client_id == credentials.client_id && cached.expires_at > Instant::now() {
                return Ok((credentials.client_id.clone(), cached.value.clone()));
            }
        }
    }

    wait_for_slot().await;
    #[derive(Serialize)]
    struct TokenQuery<'a> {
        client_id: &'a str,
        client_secret: &'a str,
        grant_type: &'a str,
    }
    let response = http()
        .post(TOKEN_URL)
        .query(&TokenQuery {
            client_id: credentials.client_id.as_str(),
            client_secret: credentials.client_secret.as_str(),
            grant_type: "client_credentials",
        })
        .send()
        .await
        .map_err(|_| "@t:igdb.network".to_string())?;

    if response.status() == reqwest::StatusCode::BAD_REQUEST
        || response.status() == reqwest::StatusCode::UNAUTHORIZED
    {
        return Err("@t:igdb.badCredentials".to_string());
    }
    if !response.status().is_success() {
        return Err("@t:igdb.network".to_string());
    }

    #[derive(Deserialize)]
    struct TokenResponse {
        access_token: String,
        #[serde(default)]
        expires_in: u64,
    }
    let token: TokenResponse = response
        .json()
        .await
        .map_err(|_| "@t:igdb.network".to_string())?;
    // Refresh a minute early so a long session never uses a dying token.
    let lifetime = token.expires_in.saturating_sub(60).max(60);
    if let Ok(mut guard) = TOKEN.lock() {
        *guard = Some(CachedToken {
            client_id: credentials.client_id.clone(),
            value: token.access_token.clone(),
            expires_at: Instant::now() + Duration::from_secs(lifetime),
        });
    }
    Ok((credentials.client_id, token.access_token))
}

/// One request every `MIN_REQUEST_GAP`, so the 4/second budget is never hit.
async fn wait_for_slot() {
    let wait = {
        let mut guard = LAST_REQUEST.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        let wait = guard
            .map(|last| MIN_REQUEST_GAP.saturating_sub(now.duration_since(last)))
            .unwrap_or_default();
        *guard = Some(now + wait);
        wait
    };
    if !wait.is_zero() {
        tokio::time::sleep(wait).await;
    }
}

/// One IGDB query on whichever transport this machine uses.
async fn api_post(app: &AppHandle, endpoint: &str, body: &str) -> Result<serde_json::Value, String> {
    match transport(app) {
        Transport::Direct => direct_post(app, endpoint, body).await,
        Transport::Proxy(url) => proxy_get(&url, endpoint, body).await,
        Transport::Off => Err("@t:igdb.notConfigured".to_string()),
    }
}

/// The user's own credentials: token, then one POST, retried once on a stale
/// token.
async fn direct_post(app: &AppHandle, endpoint: &str, body: &str) -> Result<serde_json::Value, String> {
    for attempt in 0..2 {
        let (client_id, token) = app_token(app).await?;
        wait_for_slot().await;
        let response = http()
            .post(format!("{API_BASE}/{endpoint}"))
            .header("Client-ID", client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .body(body.to_string())
            .send()
            .await
            .map_err(|_| "@t:igdb.network".to_string())?;

        if response.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            // The token died early (revoked app, rotated secret): take a fresh
            // one and try once more.
            if let Ok(mut guard) = TOKEN.lock() {
                *guard = None;
            }
            continue;
        }
        if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err("@t:igdb.rateLimited".to_string());
        }
        if !response.status().is_success() {
            return Err("@t:igdb.request".to_string());
        }
        return response
            .json::<serde_json::Value>()
            .await
            .map_err(|_| "@t:igdb.parse".to_string());
    }
    Err("@t:igdb.auth".to_string())
}

/// The shared proxy: one GET, no credentials on this machine at all. A 404 —
/// or an HTML answer, which is what an undeployed path returns — means the
/// endpoint is not live, and the settings row explains what to do instead.
async fn proxy_get(url: &str, endpoint: &str, body: &str) -> Result<serde_json::Value, String> {
    wait_for_slot().await;
    let response = http()
        .get(url)
        .query(&[("endpoint", endpoint), ("q", body)])
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|_| "@t:igdb.network".to_string())?;

    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err("@t:igdb.proxyMissing".to_string());
    }
    if response.status() == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err("@t:igdb.rateLimited".to_string());
    }
    if !response.status().is_success() {
        return Err("@t:igdb.network".to_string());
    }
    let text = response
        .text()
        .await
        .map_err(|_| "@t:igdb.parse".to_string())?;
    // A site without the function answers with its own HTML page; saying
    // "the server is not deployed" beats "the answer could not be read".
    let trimmed = text.trim_start();
    if !trimmed.starts_with('[') && !trimmed.starts_with('{') {
        return Err("@t:igdb.proxyMissing".to_string());
    }
    serde_json::from_str::<serde_json::Value>(trimmed)
        .map_err(|_| "@t:igdb.parse".to_string())
}

/* ---------- Query building and mapping (pure, tested below) ---------- */

/// Apicalypse strings cannot carry quotes; a title never needs them. Typographic
/// punctuation is folded to ASCII first: store catalogs write `Marvel’s` where
/// IGDB has `Marvel's`, and the substring match is literal, so a curly apostrophe
/// silently finds nothing.
fn sanitize_query_text(text: &str) -> String {
    text.replace(['\u{2018}', '\u{2019}', '\u{02bc}'], "'")
        .replace(['\u{201c}', '\u{201d}', '\u{201e}'], " ")
        .replace(['\u{2013}', '\u{2014}'], "-")
        .replace('\u{00a0}', " ")
        .replace(['"', '\\'], " ")
        .trim()
        .to_string()
}

fn search_query(title: &str, limit: usize) -> String {
    format!(
        "search \"{}\"; {} limit {limit};",
        sanitize_query_text(title),
        MATCH_FIELDS
    )
}

/// The substring question, asked when the ranked search comes back with a bare
/// duplicate or only DLC chapters. IGDB's `search` ranks those above the game
/// itself (Dead by Daylight is the poster child), while `name ~` finds the entry
/// people actually rated.
fn name_like_query(title: &str, limit: usize) -> String {
    format!(
        "{} where name ~ *\"{}\"*; limit {limit};",
        MATCH_FIELDS,
        sanitize_query_text(title)
    )
}

/// What {@link pick_best_match} needs to tell a real entry from its neighbours.
const MATCH_FIELDS: &str = "fields name, first_release_date, cover.image_id, rating, \
     aggregated_rating, rating_count, version_parent, parent_game, game_type;";

fn game_query(id: i64) -> String {
    format!(
        "fields name, summary, url, first_release_date, rating, rating_count, aggregated_rating, \
         genres.name, themes.name, game_modes.name, player_perspectives.name, \
         involved_companies.company.name, involved_companies.developer, involved_companies.publisher, \
         franchises.name, collection.name, cover.image_id, screenshots.image_id, \
         similar_games.name, similar_games.first_release_date, similar_games.cover.image_id, \
         similar_games.slug, \
         dlcs.name, dlcs.first_release_date, dlcs.cover.image_id, dlcs.slug, \
         expansions.name, expansions.first_release_date, expansions.cover.image_id, expansions.slug, \
         websites.category, websites.url, age_ratings.organization, age_ratings.rating_category, \
         release_dates.platform, release_dates.date; \
         where id = {id};"
    )
}

/// External ids (Steam/GOG/Amazon) turn a fuzzy title match into an exact one.
fn external_query(category: i64, uid: &str) -> String {
    format!(
        "fields id; where external_games.category = {category} & external_games.uid = \"{}\"; limit 1;",
        sanitize_query_text(uid)
    )
}

/// The cover picker's search: covers and key art in one request.
fn covers_query(query: &str, limit: usize) -> String {
    format!(
        "search \"{}\"; fields name, first_release_date, cover.image_id, artworks.image_id, screenshots.image_id; limit {limit};",
        sanitize_query_text(query)
    )
}

fn year_of(timestamp: i64) -> i64 {
    // 1970 + seconds/31_556_952 is accurate enough for a release year.
    1970 + timestamp / 31_556_952
}

fn release_date(timestamp: i64) -> String {
    let days = timestamp / 86_400;
    let mut year = 1970;
    let mut remaining = days;
    loop {
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
        let length = if leap { 366 } else { 365 };
        if remaining < length {
            break;
        }
        remaining -= length;
        year += 1;
    }
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let months = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    let mut month = 1;
    for length in months {
        if remaining < length {
            break;
        }
        remaining -= length;
        month += 1;
    }
    format!("{year:04}-{month:02}-{:02}", remaining + 1)
}

fn string_field(value: &serde_json::Value, key: &str) -> String {
    value
        .get(key)
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn name_list(value: &serde_json::Value, key: &str) -> Vec<String> {
    let Some(field) = value.get(key) else {
        return Vec::new();
    };
    match field {
        serde_json::Value::Array(items) => items
            .iter()
            .filter_map(|item| item.get("name").and_then(serde_json::Value::as_str))
            .map(str::to_string)
            .collect(),
        // `collection` is a single object, not a list like `franchises`.
        serde_json::Value::Object(_) => field
            .get("name")
            .and_then(serde_json::Value::as_str)
            .map(|name| vec![name.to_string()])
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IgdbSearchHit {
    pub id: i64,
    pub name: String,
    pub year: Option<i64>,
    pub cover_id: String,
    pub rating: Option<f64>,
    /// IGDB's URL name for the game: `igdb.com/games/<slug>` is the only link
    /// that works, the numeric id lands on a search page.
    #[serde(default)]
    pub slug: String,
}

/// One community channel from IGDB's `websites`: kind is "official",
/// "wikipedia", "twitter", "reddit" or "discord".
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IgdbLink {
    pub kind: String,
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct IgdbAgeRating {
    /// "ESRB", "PEGI", …
    pub organization: String,
    /// "M", "18", …
    pub rating: String,
}

/// The two small reference tables behind `age_ratings`, fetched once.
#[derive(Serialize, Deserialize, Clone, Default)]
struct AgeTables {
    organizations: std::collections::HashMap<i64, String>,
    /// id → (organization id, rating name)
    categories: std::collections::HashMap<i64, (i64, String)>,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IgdbGame {
    pub id: i64,
    pub name: String,
    pub summary: String,
    pub url: String,
    pub release_date: String,
    pub release_year: Option<i64>,
    /// The PC release, when IGDB has one: this is a PC launcher, so a remaster's
    /// PS5 date must not stand in for the version on this machine.
    #[serde(default)]
    pub pc_release_date: String,
    #[serde(default)]
    pub pc_release_year: Option<i64>,
    /// IGDB's own 0-100 rating.
    pub rating: Option<f64>,
    pub genres: Vec<String>,
    pub themes: Vec<String>,
    pub modes: Vec<String>,
    pub developer: String,
    pub publisher: String,
    pub franchises: Vec<String>,
    pub cover_id: String,
    /// `images.igdb.com` image ids for the size templates.
    pub screenshots: Vec<String>,
    pub similar: Vec<IgdbSearchHit>,
    /// Add-ons IGDB knows under `dlcs` / `expansions`. The store's own DLC list
    /// is the installation surface; these names fill the gaps it leaves.
    #[serde(default)]
    pub dlcs: Vec<IgdbSearchHit>,
    #[serde(default)]
    pub expansions: Vec<IgdbSearchHit>,
    pub website: String,
    /// ESRB/PEGI-style ratings, mapped through the reference tables.
    #[serde(default)]
    pub age_ratings: Vec<IgdbAgeRating>,
    /// Community channels, in the order the page shows them.
    pub links: Vec<IgdbLink>,
}

/// One cover-picker row: the game's portrait cover and its key art.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IgdbCoverHit {
    pub id: i64,
    pub name: String,
    pub year: Option<i64>,
    pub cover_id: String,
    pub artworks: Vec<String>,
    pub screenshots: Vec<String>,
}

fn map_search_hit(value: &serde_json::Value) -> IgdbSearchHit {
    let timestamp = value
        .get("first_release_date")
        .and_then(serde_json::Value::as_i64);
    IgdbSearchHit {
        id: value.get("id").and_then(serde_json::Value::as_i64).unwrap_or(0),
        name: string_field(value, "name"),
        year: timestamp.map(year_of),
        cover_id: value
            .get("cover")
            .map(|cover| string_field(cover, "image_id"))
            .unwrap_or_default(),
        rating: value.get("rating").and_then(serde_json::Value::as_f64),
        slug: string_field(value, "slug"),
    }
}

fn map_cover_hit(value: &serde_json::Value) -> IgdbCoverHit {
    let images = |key: &str, max: usize| -> Vec<String> {
        value
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(|item| item.get("image_id").and_then(serde_json::Value::as_str))
                    .take(max)
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let timestamp = value
        .get("first_release_date")
        .and_then(serde_json::Value::as_i64);
    IgdbCoverHit {
        id: value.get("id").and_then(serde_json::Value::as_i64).unwrap_or(0),
        name: string_field(value, "name"),
        year: timestamp.map(year_of),
        cover_id: value
            .get("cover")
            .map(|cover| string_field(cover, "image_id"))
            .unwrap_or_default(),
        artworks: images("artworks", 4),
        screenshots: images("screenshots", 2),
    }
}

fn map_game(value: &serde_json::Value, age_tables: &AgeTables) -> IgdbGame {
    let timestamp = value
        .get("first_release_date")
        .and_then(serde_json::Value::as_i64);
    let pc_timestamp = pc_release_timestamp(value);

    let mut developer = String::new();
    let mut publisher = String::new();
    if let Some(companies) = value.get("involved_companies").and_then(serde_json::Value::as_array) {
        for entry in companies {
            let name = entry
                .get("company")
                .map(|company| string_field(company, "name"))
                .unwrap_or_default();
            if name.is_empty() {
                continue;
            }
            if entry.get("developer").and_then(serde_json::Value::as_bool).unwrap_or(false)
                && developer.is_empty()
            {
                developer = name.clone();
            }
            if entry.get("publisher").and_then(serde_json::Value::as_bool).unwrap_or(false)
                && publisher.is_empty()
            {
                publisher = name;
            }
        }
    }

    let screenshots = value
        .get("screenshots")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("image_id").and_then(serde_json::Value::as_str))
                .take(MAX_SCREENSHOTS)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();

    let similar = value
        .get("similar_games")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .take(MAX_SIMILAR)
                .map(map_search_hit)
                .collect()
        })
        .unwrap_or_default();

    let extras = |key: &str| -> Vec<IgdbSearchHit> {
        value
            .get(key)
            .and_then(serde_json::Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .take(MAX_EXTRAS)
                    .map(map_search_hit)
                    .collect()
            })
            .unwrap_or_default()
    };
    let dlcs = extras("dlcs");
    let expansions = extras("expansions");

    let website = value
        .get("websites")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            // Category 1 is the official site.
            items
                .iter()
                .find(|item| item.get("category").and_then(serde_json::Value::as_i64) == Some(1))
                .map(|item| string_field(item, "url"))
                .unwrap_or_default()
        })
        .unwrap_or_default();

    // The community channels IGDB already carries, kept apart so the page can
    // show one icon per channel instead of a single anonymous "website" link.
    // Categories: 1 official, 3 Wikipedia, 5 Twitter/X, 14 Reddit, 18 Discord.
    let links = value
        .get("websites")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            const WANTED: [(&str, i64); 5] = [
                ("official", 1),
                ("wikipedia", 3),
                ("twitter", 5),
                ("reddit", 14),
                ("discord", 18),
            ];
            WANTED
                .iter()
                .filter_map(|(kind, category)| {
                    let url = items
                        .iter()
                        .find(|item| item.get("category").and_then(serde_json::Value::as_i64) == Some(*category))
                        .map(|item| string_field(item, "url"))?;
                    if url.trim().is_empty() {
                        return None;
                    }
                    Some(IgdbLink {
                        kind: (*kind).to_string(),
                        url,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let age_ratings = value
        .get("age_ratings")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let category = item
                        .get("rating_category")
                        .and_then(serde_json::Value::as_i64)?;
                    let (organization_id, rating) = age_tables.categories.get(&category)?;
                    if rating.trim().is_empty() {
                        return None;
                    }
                    Some(IgdbAgeRating {
                        organization: age_tables
                            .organizations
                            .get(organization_id)
                            .cloned()
                            .unwrap_or_default(),
                        rating: rating.clone(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    IgdbGame {
        id: value.get("id").and_then(serde_json::Value::as_i64).unwrap_or(0),
        name: string_field(value, "name"),
        summary: string_field(value, "summary"),
        url: string_field(value, "url"),
        release_date: timestamp.map(release_date).unwrap_or_default(),
        release_year: timestamp.map(year_of),
        pc_release_date: pc_timestamp.map(release_date).unwrap_or_default(),
        pc_release_year: pc_timestamp.map(year_of),
        rating: value.get("rating").and_then(serde_json::Value::as_f64),
        genres: name_list(value, "genres"),
        themes: name_list(value, "themes"),
        modes: name_list(value, "game_modes"),
        developer,
        publisher,
        franchises: {
            let mut names = name_list(value, "franchises");
            names.extend(name_list(value, "collection"));
            names
        },
        cover_id: value
            .get("cover")
            .map(|cover| string_field(cover, "image_id"))
            .unwrap_or_default(),
        screenshots,
        similar,
        dlcs,
        expansions,
        website,
        links,
        age_ratings,
    }
}

/// IGDB platform 6 is PC (Microsoft Windows).
const PC_PLATFORM: i64 = 6;

/// The earliest PC release date, when the game has one. IGDB keeps one entry per
/// platform, so this is the date a PC launcher should show.
fn pc_release_timestamp(value: &serde_json::Value) -> Option<i64> {
    value
        .get("release_dates")
        .and_then(serde_json::Value::as_array)
        .and_then(|dates| {
            dates
                .iter()
                .filter(|entry| {
                    entry.get("platform").and_then(serde_json::Value::as_i64) == Some(PC_PLATFORM)
                })
                .filter_map(|entry| entry.get("date").and_then(serde_json::Value::as_i64))
                .min()
        })
}

/// Lowercase, letters and digits only: the key the title lookup caches under.
fn normalize_title(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

/// The best search hit for a title: the exact name wins, then the year the
/// caller knows, then the first hit that looks like a game (no version parent).
fn pick_best_match(hits: &[serde_json::Value], title: &str, year: Option<i64>) -> Option<i64> {
    let wanted = normalize_title(title);
    let mut best: Option<(i64, i32)> = None;
    for hit in hits {
        let Some(id) = hit.get("id").and_then(serde_json::Value::as_i64) else {
            continue;
        };
        let name = string_field(hit, "name");
        let normalized = normalize_title(&name);
        if normalized.is_empty() {
            continue;
        }
        // A DLC, an expansion or a re-release names the game it belongs to. It is
        // not the page's game when the main entry is in the list — but a remaster
        // or a port is a real standalone release (Spider-Man Remastered is one),
        // so this is a penalty, never a skip.
        let parented = hit.get("parent_game").map(|v| !v.is_null()).unwrap_or(false);
        // Editions carry a version_parent; prefer the main game.
        let edition = hit.get("version_parent").map(|v| !v.is_null()).unwrap_or(false);
        let mut score = 0;
        if normalized == wanted {
            score += 100;
        } else if normalized.contains(&wanted) || wanted.contains(&normalized) {
            score += 40;
        }
        if let (Some(wanted_year), Some(hit_year)) = (
            year,
            hit.get("first_release_date")
                .and_then(serde_json::Value::as_i64)
                .map(year_of),
        ) {
            let distance = (wanted_year - hit_year).abs();
            score += if distance == 0 { 30 } else if distance <= 1 { 20 } else { 0 };
        }
        if edition {
            score -= 25;
        }
        if parented {
            score -= 40;
        }
        // Two entries can carry the same name — a bare duplicate with no data
        // next to the real one. The one people actually rated is the real one.
        let ratings = hit.get("rating_count").and_then(serde_json::Value::as_i64).unwrap_or(0);
        score += (ratings / 20).clamp(0, 25) as i32;
        if score > 0 {
            match best {
                Some((_, best_score)) if best_score >= score => {}
                _ => best = Some((id, score)),
            }
        }
    }
    best.map(|(id, _)| id)
}

/// True when the chosen hit carries something to show: a score or ratings. A
/// bare duplicate answers false, which is the cue to ask the substring question.
fn match_has_data(hits: &[serde_json::Value], id: Option<i64>) -> bool {
    let Some(id) = id else { return false };
    hits.iter().any(|hit| {
        hit.get("id").and_then(serde_json::Value::as_i64) == Some(id)
            && (hit.get("rating").map(|v| !v.is_null()).unwrap_or(false)
                || hit
                    .get("rating_count")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0)
                    > 0)
    })
}

/* ---------- Disk cache ---------- */

fn lookup_path(app: &AppHandle) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join("lookup.json"))
}

fn game_cache_path(app: &AppHandle, id: i64) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join(format!("game-{id}.json")))
}

fn read_lookup(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    read_map(lookup_path(app))
}

fn write_lookup(app: &AppHandle, lookup: &serde_json::Map<String, serde_json::Value>) {
    write_map(lookup_path(app), lookup);
}

/// Title lookups IGDB had no match for, with the epoch second of the miss.
fn misses_path(app: &AppHandle) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join("misses.json"))
}

fn read_misses(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    read_map(misses_path(app))
}

fn write_misses(app: &AppHandle, misses: &serde_json::Map<String, serde_json::Value>) {
    write_map(misses_path(app), misses);
}

/// External ids already resolved (`steam:620` → the IGDB game id), so a page
/// open does not repeat the exact-id query for a game it already mapped.
fn external_path(app: &AppHandle) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join("external.json"))
}

fn read_external(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    read_map(external_path(app))
}

fn write_external(app: &AppHandle, external: &serde_json::Map<String, serde_json::Value>) {
    write_map(external_path(app), external);
}

fn read_map(path: Option<PathBuf>) -> serde_json::Map<String, serde_json::Value> {
    path.and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn write_map(path: Option<PathBuf>, map: &serde_json::Map<String, serde_json::Value>) {
    let Some(path) = path else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(data) = serde_json::to_string(map) {
        let _ = std::fs::write(path, data);
    }
}

/// Bumped whenever `IgdbGame` gains a field: entries written by an older build
/// are fetched again instead of showing up half empty.
const CACHE_SCHEMA: u32 = 5;

/// What actually lands on disk: the schema marker next to the game itself.
#[derive(Serialize, Deserialize)]
struct CachedGame {
    #[serde(default)]
    schema: u32,
    #[serde(flatten)]
    game: IgdbGame,
}

fn read_cached_game(app: &AppHandle, id: i64) -> Option<IgdbGame> {
    let path = game_cache_path(app, id)?;
    let data = std::fs::read_to_string(path).ok()?;
    let cached: CachedGame = serde_json::from_str(&data).ok()?;
    (cached.schema == CACHE_SCHEMA).then_some(cached.game)
}

fn write_cached_game(app: &AppHandle, game: &IgdbGame) {
    let Some(path) = game_cache_path(app, game.id) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let cached = CachedGame {
        schema: CACHE_SCHEMA,
        game: game.clone(),
    };
    if let Ok(data) = serde_json::to_string(&cached) {
        let _ = std::fs::write(path, data);
    }
}

/* ---------- Age rating reference tables ---------- */

fn age_tables_path(app: &AppHandle) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join("age-ratings.json"))
}

fn read_age_tables(app: &AppHandle) -> Option<AgeTables> {
    let path = age_tables_path(app)?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_age_tables(app: &AppHandle, tables: &AgeTables) {
    let Some(path) = age_tables_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(data) = serde_json::to_string(tables) {
        let _ = std::fs::write(path, data);
    }
}

/// The two reference tables behind `age_ratings`: two small requests, once.
async fn ensure_age_tables(app: &AppHandle) -> AgeTables {
    if let Some(tables) = read_age_tables(app) {
        if !tables.categories.is_empty() {
            return tables;
        }
    }
    let mut tables = AgeTables::default();
    if let Ok(orgs) = api_post(app, "age_rating_organizations", "fields id, name; limit 50;").await {
        if let Some(items) = orgs.as_array() {
            for item in items {
                if let (Some(id), Some(name)) = (
                    item.get("id").and_then(serde_json::Value::as_i64),
                    item.get("name").and_then(serde_json::Value::as_str),
                ) {
                    tables.organizations.insert(id, name.to_string());
                }
            }
        }
    }
    if let Ok(cats) = api_post(app, "age_rating_categories", "fields id, organization, rating; limit 200;").await {
        if let Some(items) = cats.as_array() {
            for item in items {
                let Some(id) = item.get("id").and_then(serde_json::Value::as_i64) else {
                    continue;
                };
                let organization = item
                    .get("organization")
                    .and_then(serde_json::Value::as_i64)
                    .unwrap_or(0);
                let rating = item
                    .get("rating")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("");
                tables.categories.insert(id, (organization, rating.to_string()));
            }
        }
    }
    if !tables.categories.is_empty() {
        write_age_tables(app, &tables);
    }
    tables
}

/// Does the response carry age ratings worth the two reference requests?
fn has_age_ratings(value: &serde_json::Value) -> bool {
    value
        .as_array()
        .and_then(|items| items.first())
        .and_then(|first| first.get("age_ratings"))
        .and_then(serde_json::Value::as_array)
        .map(|items| !items.is_empty())
        .unwrap_or(false)
}

/// Fetches one game's details and maps them, pulling the reference tables in
/// only when the game actually carries ratings.
async fn fetch_game(app: &AppHandle, id: i64) -> Result<IgdbGame, String> {
    let value = api_post(app, "games", &game_query(id)).await?;
    let tables = if has_age_ratings(&value) {
        ensure_age_tables(app).await
    } else {
        AgeTables::default()
    };
    let game = value
        .as_array()
        .and_then(|items| items.first())
        .map(|item| map_game(item, &tables))
        .ok_or_else(|| "@t:igdb.notFound".to_string())?;
    write_cached_game(app, &game);
    Ok(game)
}

/* ---------- Commands ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgdbStatus {
    pub configured: bool,
    /// The Client ID is not a secret; the settings row shows it back.
    pub client_id: String,
    /// `direct` (own Twitch app) | `proxy` (the shared server) | `off`.
    pub mode: String,
    /// The proxy address in use, so the row can show and edit it.
    pub proxy_url: String,
}

#[tauri::command]
pub fn igdb_status(app: AppHandle) -> IgdbStatus {
    let client_id = load_credentials(&app)
        .map(|credentials| credentials.client_id)
        .unwrap_or_default();
    match transport(&app) {
        Transport::Direct => IgdbStatus {
            configured: true,
            client_id,
            mode: "direct".to_string(),
            proxy_url: proxy_url(&app),
        },
        Transport::Proxy(url) => IgdbStatus {
            configured: true,
            client_id,
            mode: "proxy".to_string(),
            proxy_url: url,
        },
        Transport::Off => IgdbStatus {
            configured: false,
            client_id,
            mode: "off".to_string(),
            proxy_url: proxy_url(&app),
        },
    }
}

/// Stores the proxy address; an empty string restores the shared server.
#[tauri::command]
pub fn igdb_set_proxy_url(app: AppHandle, url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !trimmed.is_empty() && !trimmed.starts_with("https://") && !trimmed.starts_with("http://") {
        return Err("@t:igdb.badProxy".to_string());
    }
    save_proxy_url(&app, trimmed)
}

/// Stores the pair (the secret sealed with DPAPI) and drops any cached token.
#[tauri::command]
pub fn igdb_set_credentials(app: AppHandle, client_id: String, client_secret: String) -> Result<(), String> {
    let credentials = Credentials {
        client_id: client_id.trim().to_string(),
        client_secret: client_secret.trim().to_string(),
    };
    if credentials.client_id.is_empty() || credentials.client_secret.is_empty() {
        return Err("@t:igdb.missingFields".to_string());
    }
    save_credentials(&app, &credentials)?;
    if let Ok(mut guard) = TOKEN.lock() {
        *guard = None;
    }
    Ok(())
}

#[tauri::command]
pub fn igdb_clear_credentials(app: AppHandle) {
    if let Some(path) = credentials_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    if let Ok(mut guard) = TOKEN.lock() {
        *guard = None;
    }
}

/// Proves the active transport works: one tiny search, whichever way it goes.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgdbTestResult {
    /// Which transport answered: `direct` or `proxy`.
    pub mode: String,
    /// The game IGDB returned, so the row can say what it found.
    pub name: String,
}

#[tauri::command]
pub async fn igdb_test(app: AppHandle) -> Result<IgdbTestResult, String> {
    let mode = match transport(&app) {
        Transport::Direct => "direct",
        Transport::Proxy(_) => "proxy",
        Transport::Off => return Err("@t:igdb.notConfigured".to_string()),
    };
    let value = api_post(&app, "games", &search_query("Halo", 1)).await?;
    let name = value
        .as_array()
        .and_then(|items| items.first())
        .map(|hit| string_field(hit, "name"))
        .unwrap_or_default();
    if name.is_empty() {
        return Err("@t:igdb.request".to_string());
    }
    Ok(IgdbTestResult {
        mode: mode.to_string(),
        name,
    })
}

/// The one bit of the shared proxy's state a settings row can show: whether the
/// endpoint answers with JSON at all, i.e. whether the function is deployed.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgdbProxyProbe {
    pub url: String,
    pub reachable: bool,
}

#[tauri::command]
pub async fn igdb_probe_proxy(app: AppHandle) -> IgdbProxyProbe {
    let url = proxy_url(&app);
    let probe = async {
        wait_for_slot().await;
        let response = http()
            .get(&url)
            .query(&[("endpoint", "games"), ("q", "fields name; limit 1;")])
            .header("Accept", "application/json")
            .send()
            .await
            .ok()?;
        let text = response.text().await.ok()?;
        let trimmed = text.trim_start();
        Some(trimmed.starts_with('[') || trimmed.starts_with('{'))
    }
    .await;
    IgdbProxyProbe {
        url,
        reachable: probe.unwrap_or(false),
    }
}

#[tauri::command]
pub async fn igdb_search(app: AppHandle, query: String, limit: Option<usize>) -> Result<Vec<IgdbSearchHit>, String> {
    let limit = limit.unwrap_or(8).clamp(1, 30);
    let value = api_post(&app, "games", &search_query(&query, limit)).await?;
    Ok(value
        .as_array()
        .map(|items| items.iter().map(map_search_hit).collect())
        .unwrap_or_default())
}

/// One game by its IGDB id, cache first.
#[tauri::command]
pub async fn igdb_game(app: AppHandle, id: i64) -> Result<IgdbGame, String> {
    if let Some(cached) = read_cached_game(&app, id) {
        return Ok(cached);
    }
    fetch_game(&app, id).await
}

/// The cover picker's search: portraits and key art for one title.
#[tauri::command]
pub async fn igdb_covers(app: AppHandle, query: String, limit: Option<usize>) -> Result<Vec<IgdbCoverHit>, String> {
    let limit = limit.unwrap_or(6).clamp(1, 20);
    let value = api_post(&app, "games", &covers_query(&query, limit)).await?;
    Ok(value
        .as_array()
        .map(|items| items.iter().map(map_cover_hit).collect())
        .unwrap_or_default())
}

/// The game page's entry point: an exact external id when the library knows
/// one (Steam/GOG/Amazon), then the cached title lookup, then a title search
/// with the year as a tiebreaker. `None` when nothing convincing matched.
#[tauri::command]
pub async fn igdb_enrich(
    app: AppHandle,
    title: String,
    year: Option<i64>,
    external_category: Option<i64>,
    external_uid: Option<String>,
) -> Result<Option<IgdbGame>, String> {
    // The shared proxy needs no credentials on this machine, so the guard asks
    // the transport, not the credential store: proxy mode used to bail out here
    // and game pages never got any IGDB data.
    if title.trim().is_empty() || matches!(transport(&app), Transport::Off) {
        return Ok(None);
    }
    let key = normalize_title(&title);
    if key.is_empty() {
        return Ok(None);
    }

    let mut id: Option<i64> = None;

    // An external id is exact: it beats every fuzzy match. The resolved id is
    // kept on disk, so the exact-id request runs once per game, not per open.
    if let (Some(category), Some(uid)) = (
        external_category,
        external_uid
            .as_deref()
            .map(str::trim)
            .filter(|uid| !uid.is_empty()),
    ) {
        let external_key = format!("{category}:{uid}");
        let mut external = read_external(&app);
        id = external
            .get(&external_key)
            .and_then(serde_json::Value::as_i64)
            .filter(|id| *id > 0);
        if id.is_none() {
            // A failed exact-id request must not lose an answer that is already
            // on disk: the title lookup below still gets its turn.
            if let Ok(value) = api_post(&app, "games", &external_query(category, uid)).await {
                let found = value
                    .as_array()
                    .and_then(|items| items.first())
                    .and_then(|item| item.get("id").and_then(serde_json::Value::as_i64));
                if let Some(found) = found {
                    external.insert(external_key, serde_json::Value::from(found));
                    write_external(&app, &external);
                }
                id = found;
            }
        }
    }

    let mut lookup = read_lookup(&app);
    if id.is_none() {
        id = lookup
            .get(&key)
            .and_then(serde_json::Value::as_i64)
            .filter(|id| *id > 0);
    }

    // A title that had no match is not searched again for a month: the page
    // would otherwise run the same two queries on every open. IGDB adds games,
    // so the miss expires instead of being permanent.
    let mut misses = read_misses(&app);
    if id.is_none() {
        if let Some(at) = misses.get(&key).and_then(serde_json::Value::as_u64) {
            if crate::lookup_cache::fresh(at, crate::lookup_cache::MISS_TTL_SECS) {
                return Ok(None);
            }
        }
    }

    if id.is_none() {
        let value = api_post(&app, "games", &search_query(&title, 8)).await?;
        let mut hits = value.as_array().cloned().unwrap_or_default();
        id = pick_best_match(&hits, &title, year);
        // A bare duplicate (an exact name with no ratings) usually means the real
        // entry sits outside the ranked results, so ask the substring question
        // and pick from both lists together.
        if !match_has_data(&hits, id) {
            let value = api_post(&app, "games", &name_like_query(&title, 20)).await?;
            if let Some(more) = value.as_array() {
                hits.extend(more.iter().cloned());
            }
            id = pick_best_match(&hits, &title, year).or(id);
        }
    }

    if let Some(found) = id {
        if lookup.get(&key).and_then(serde_json::Value::as_i64) != Some(found) {
            lookup.insert(key.clone(), serde_json::Value::from(found));
            write_lookup(&app, &lookup);
        }
        if misses.remove(&key).is_some() {
            write_misses(&app, &misses);
        }
    } else {
        misses.insert(key, serde_json::Value::from(crate::lookup_cache::now_secs()));
        write_misses(&app, &misses);
    }

    let Some(id) = id else { return Ok(None) };
    if let Some(cached) = read_cached_game(&app, id) {
        return Ok(Some(cached));
    }
    Ok(Some(fetch_game(&app, id).await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_text_drops_quotes() {
        assert_eq!(sanitize_query_text("  Halo \"Infinite\"  "), "Halo  Infinite");
        assert!(search_query("Halo", 3).contains("search \"Halo\";"));
        assert!(game_query(42).contains("where id = 42;"));
    }

    #[test]
    fn query_text_folds_typographic_punctuation() {
        // A store catalog title against IGDB's ASCII spelling.
        assert_eq!(
            sanitize_query_text("Marvel\u{2019}s Spider-Man: Miles Morales"),
            "Marvel's Spider-Man: Miles Morales"
        );
        assert_eq!(sanitize_query_text("Half\u{2013}Life"), "Half-Life");
        assert_eq!(sanitize_query_text("A\u{00a0}B"), "A B");
        assert_eq!(sanitize_query_text("\u{201c}Quoted\u{201d}"), "Quoted");
    }

    #[test]
    fn release_date_counts_leap_years() {
        assert_eq!(release_date(0), "1970-01-01");
        // 2024-02-29 (leap day), seconds since epoch.
        assert_eq!(release_date(1_709_164_800), "2024-02-29");
        assert_eq!(year_of(1_709_164_800), 2024);
    }

    #[test]
    fn best_match_prefers_the_exact_name_and_the_year() {
        let hits = serde_json::json!([
            { "id": 1, "name": "Halo 3: ODST", "first_release_date": 1_224_057_600_i64 },
            { "id": 2, "name": "Halo 3", "first_release_date": 1_193_769_600_i64 },
            { "id": 3, "name": "Halo 3", "first_release_date": 1_193_769_600_i64, "version_parent": 2 }
        ]);
        let hits = hits.as_array().cloned().unwrap_or_default();
        assert_eq!(pick_best_match(&hits, "Halo 3", Some(2007)), Some(2));
        assert_eq!(pick_best_match(&hits, "Halo 3", None), Some(2));
        assert_eq!(pick_best_match(&hits, "Something else", None), None);
    }

    #[test]
    fn best_match_keeps_the_main_entry_over_its_dlc_and_accepts_a_remaster() {
        let hits = serde_json::json!([
            { "id": 10, "name": "Dead by Daylight: Headcase", "first_release_date": 1_496_880_000_i64, "parent_game": 18866, "rating_count": 12 },
            { "id": 11, "name": "Dead By DayLight", "first_release_date": 1_615_248_000_i64 },
            { "id": 12, "name": "Dead by Daylight", "first_release_date": 1_465_862_400_i64, "rating_count": 434, "rating": 70.6 }
        ]);
        let hits = hits.as_array().cloned().unwrap_or_default();
        // The DLC belongs to another game, and the bare duplicate loses to the
        // entry people actually rated.
        assert_eq!(pick_best_match(&hits, "Dead by Daylight", Some(2016)), Some(12));
        assert!(match_has_data(&hits, Some(12)));
        assert!(!match_has_data(&hits, Some(11)));
        assert!(!match_has_data(&hits, None));

        // A standalone re-release is parented too. Alone in the list it still
        // has to win: this is Spider-Man Remastered.
        let remaster = serde_json::json!([
            { "id": 138949, "name": "Marvel's Spider-Man Remastered", "first_release_date": 1_660_000_000_i64, "parent_game": 19565, "rating_count": 295, "rating": 84.0 }
        ]);
        let remaster = remaster.as_array().cloned().unwrap_or_default();
        assert_eq!(
            pick_best_match(&remaster, "Marvel's Spider-Man Remastered", Some(2022)),
            Some(138949)
        );
    }

    #[test]
    fn name_like_query_asks_for_a_substring_and_drops_quotes() {
        let query = name_like_query("Dead \"by\" Daylight", 20);
        assert!(query.contains("where name ~ *\"Dead  by  Daylight\"*;"));
        assert!(query.contains("limit 20;"));
        assert!(query.contains("rating_count"));
    }

    #[test]
    fn the_pc_release_date_wins_over_a_console_first_release() {
        // Spider-Man Remastered: PS5 in 2020, PC in 2022.
        let sample = serde_json::json!({
            "id": 138949,
            "name": "Marvel's Spider-Man Remastered",
            "first_release_date": 1_605_139_200_i64,
            "release_dates": [
                { "platform": 6, "date": 1_660_262_400_i64 },
                { "platform": 167, "date": 1_605_139_200_i64 }
            ]
        });
        let game = map_game(&sample, &AgeTables::default());
        assert_eq!(game.release_year, Some(2020));
        assert_eq!(game.pc_release_date, "2022-08-12");
        assert_eq!(game.pc_release_year, Some(2022));
    }

    #[test]
    fn a_game_without_a_pc_release_keeps_the_pc_fields_empty() {
        let sample = serde_json::json!({
            "id": 1,
            "name": "Console Only",
            "first_release_date": 1_605_139_200_i64,
            "release_dates": [{ "platform": 167, "date": 1_605_139_200_i64 }]
        });
        let game = map_game(&sample, &AgeTables::default());
        assert!(game.pc_release_date.is_empty());
        assert_eq!(game.pc_release_year, None);
    }

    /// The community row shows one icon per channel, so the mapping has to keep
    /// the categories apart — and ignore the ones the page does not show
    /// (Facebook, Instagram, Twitch).
    #[test]
    fn mapping_keeps_the_community_channels_apart() {
        let sample = serde_json::json!({
            "id": 1942,
            "name": "The Witcher 3: Wild Hunt",
            "websites": [
                { "category": 5, "url": "https://twitter.com/witchergame" },
                { "category": 1, "url": "https://thewitcher.com" },
                { "category": 14, "url": "https://www.reddit.com/r/witcher" },
                { "category": 4, "url": "https://facebook.com/thewitcher" },
                { "category": 18, "url": "https://discord.gg/witcher" }
            ]
        });
        let game = map_game(&sample, &AgeTables::default());
        let kinds: Vec<&str> = game.links.iter().map(|link| link.kind.as_str()).collect();
        assert_eq!(kinds, vec!["official", "twitter", "reddit", "discord"]);
        assert_eq!(game.links[0].url, "https://thewitcher.com");
        assert_eq!(game.website, "https://thewitcher.com");
    }

    #[test]
    fn mapping_reads_companies_screenshots_and_similar_games() {
        let sample = serde_json::json!({
            "id": 1942,
            "name": "The Witcher 3: Wild Hunt",
            "summary": "RPG",
            "url": "https://www.igdb.com/games/the-witcher-3-wild-hunt",
            "first_release_date": 1_431_993_600_i64,
            "rating": 92.5,
            "genres": [{ "name": "Role-playing (RPG)" }],
            "themes": [{ "name": "Fantasy" }],
            "game_modes": [{ "name": "Single player" }],
            "involved_companies": [
                { "company": { "name": "CD Projekt RED" }, "developer": true, "publisher": false },
                { "company": { "name": "CD Projekt" }, "developer": false, "publisher": true }
            ],
            "collection": { "name": "The Witcher" },
            "cover": { "image_id": "coa1" },
            "screenshots": [
                { "image_id": "s1" }, { "image_id": "s2" }, { "image_id": "s3" },
                { "image_id": "s4" }, { "image_id": "s5" }, { "image_id": "s6" }, { "image_id": "s7" }
            ],
            "similar_games": [
                { "id": 10, "name": "Skyrim", "first_release_date": 1_320_624_000_i64, "cover": { "image_id": "sky" } }
            ],
            "dlcs": [
                { "id": 11, "name": "Hearts of Stone", "first_release_date": 1_445_020_800_i64, "cover": { "image_id": "hos" }, "slug": "hearts-of-stone" }
            ],
            "expansions": [
                { "id": 12, "name": "Blood and Wine", "first_release_date": 1_464_566_400_i64, "cover": { "image_id": "baw" }, "slug": "blood-and-wine" }
            ],
            "websites": [
                { "category": 3, "url": "https://store.example" },
                { "category": 1, "url": "https://thewitcher.com" }
            ]
        });
        let game = map_game(&sample, &AgeTables::default());
        assert_eq!(game.id, 1942);        assert_eq!(game.developer, "CD Projekt RED");
        assert_eq!(game.publisher, "CD Projekt");
        assert_eq!(game.release_year, Some(2015));
        assert_eq!(game.release_date, "2015-05-19");
        assert_eq!(game.screenshots.len(), MAX_SCREENSHOTS);
        assert_eq!(game.similar.len(), 1);
        assert_eq!(game.similar[0].name, "Skyrim");
        assert_eq!(game.dlcs.len(), 1);
        assert_eq!(game.dlcs[0].name, "Hearts of Stone");
        assert_eq!(game.dlcs[0].cover_id, "hos");
        assert_eq!(game.expansions.len(), 1);
        assert_eq!(game.expansions[0].slug, "blood-and-wine");
        assert_eq!(game.franchises, vec!["The Witcher".to_string()]);
        assert_eq!(game.website, "https://thewitcher.com");
        assert_eq!(game.genres, vec!["Role-playing (RPG)".to_string()]);
        // Without the reference tables the ratings stay out.
        assert!(game.age_ratings.is_empty());
    }

    #[test]
    fn age_ratings_map_through_the_reference_tables() {
        let mut tables = AgeTables::default();
        tables.organizations.insert(1, "ESRB".to_string());
        tables.organizations.insert(2, "PEGI".to_string());
        tables.categories.insert(11, (1, "M".to_string()));
        tables.categories.insert(5, (2, "18".to_string()));

        let sample = serde_json::json!({
            "id": 1,
            "name": "Game",
            "age_ratings": [
                { "organization": 1, "rating_category": 11 },
                { "organization": 2, "rating_category": 5 },
                { "organization": 3, "rating_category": 99 }
            ]
        });
        let game = map_game(&sample, &tables);
        assert_eq!(game.age_ratings.len(), 2);
        assert_eq!(game.age_ratings[0].organization, "ESRB");
        assert_eq!(game.age_ratings[0].rating, "M");
        assert_eq!(game.age_ratings[1].organization, "PEGI");
        assert_eq!(game.age_ratings[1].rating, "18");
    }

    #[test]
    fn external_and_cover_queries_are_well_formed() {
        assert!(external_query(1, "570").contains("external_games.category = 1 & external_games.uid = \"570\""));
        assert!(external_query(5, "1234").contains("limit 1;"));
        let covers = covers_query("Halo", 6);
        assert!(covers.contains("cover.image_id"));
        assert!(covers.contains("artworks.image_id"));
        assert!(covers.contains("limit 6;"));
    }

    #[test]
    fn normalize_title_keeps_letters_and_digits() {
        assert_eq!(normalize_title("The Witcher 3: Wild Hunt!"), "thewitcher3wildhunt");
    }
}
