//! IGDB (Twitch) client: search and game details for the game pages.
//!
//! The API is free but needs application credentials from a Twitch developer
//! app (Client ID + Client Secret). The secret stays on this machine — sealed
//! with DPAPI, never shipped with the launcher and never committed — because a
//! leaked secret lets anyone mint tokens for our app and burn its rate limit.
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
/// The API allows 4 requests per second; one every 260 ms stays under it.
const MIN_REQUEST_GAP: Duration = Duration::from_millis(260);
/// How many screenshots / similar games a game page shows.
const MAX_SCREENSHOTS: usize = 6;
const MAX_SIMILAR: usize = 6;

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

async fn api_post(app: &AppHandle, endpoint: &str, body: &str) -> Result<serde_json::Value, String> {
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

/* ---------- Query building and mapping (pure, tested below) ---------- */

/// Apicalypse strings cannot carry quotes; a title never needs them.
fn sanitize_query_text(text: &str) -> String {
    text.replace(['"', '\\'], " ").trim().to_string()
}

fn search_query(title: &str, limit: usize) -> String {
    format!(
        "search \"{}\"; fields name, first_release_date, cover.image_id, rating, aggregated_rating, version_parent; limit {limit};",
        sanitize_query_text(title)
    )
}

fn game_query(id: i64) -> String {
    format!(
        "fields name, summary, url, first_release_date, rating, rating_count, aggregated_rating, \
         genres.name, themes.name, game_modes.name, player_perspectives.name, \
         involved_companies.company.name, involved_companies.developer, involved_companies.publisher, \
         franchises.name, collection.name, cover.image_id, screenshots.image_id, \
         similar_games.name, similar_games.first_release_date, similar_games.cover.image_id, \
         websites.category, websites.url; where id = {id};"
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
    pub website: String,
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
    }
}

fn map_game(value: &serde_json::Value) -> IgdbGame {
    let timestamp = value
        .get("first_release_date")
        .and_then(serde_json::Value::as_i64);

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

    IgdbGame {
        id: value.get("id").and_then(serde_json::Value::as_i64).unwrap_or(0),
        name: string_field(value, "name"),
        summary: string_field(value, "summary"),
        url: string_field(value, "url"),
        release_date: timestamp.map(release_date).unwrap_or_default(),
        release_year: timestamp.map(year_of),
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
        website,
    }
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
        if score > 0 {
            match best {
                Some((_, best_score)) if best_score >= score => {}
                _ => best = Some((id, score)),
            }
        }
    }
    best.map(|(id, _)| id)
}

/* ---------- Disk cache ---------- */

fn lookup_path(app: &AppHandle) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join("lookup.json"))
}

fn game_cache_path(app: &AppHandle, id: i64) -> Option<PathBuf> {
    igdb_dir(app).map(|dir| dir.join(format!("game-{id}.json")))
}

fn read_lookup(app: &AppHandle) -> serde_json::Map<String, serde_json::Value> {
    lookup_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|data| serde_json::from_str(&data).ok())
        .unwrap_or_default()
}

fn write_lookup(app: &AppHandle, lookup: &serde_json::Map<String, serde_json::Value>) {
    let Some(path) = lookup_path(app) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(data) = serde_json::to_string(lookup) {
        let _ = std::fs::write(path, data);
    }
}

fn read_cached_game(app: &AppHandle, id: i64) -> Option<IgdbGame> {
    let path = game_cache_path(app, id)?;
    let data = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&data).ok()
}

fn write_cached_game(app: &AppHandle, game: &IgdbGame) {
    let Some(path) = game_cache_path(app, game.id) else { return };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(data) = serde_json::to_string(game) {
        let _ = std::fs::write(path, data);
    }
}

/* ---------- Commands ---------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IgdbStatus {
    pub configured: bool,
}

#[tauri::command]
pub fn igdb_status(app: AppHandle) -> IgdbStatus {
    IgdbStatus {
        configured: load_credentials(&app).is_some(),
    }
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

/// Proves the pair works: a token plus one tiny search.
#[tauri::command]
pub async fn igdb_test(app: AppHandle) -> Result<String, String> {
    let value = api_post(&app, "games", &search_query("Halo", 1)).await?;
    let first = value
        .as_array()
        .and_then(|items| items.first())
        .map(|hit| string_field(hit, "name"))
        .unwrap_or_default();
    if first.is_empty() {
        return Err("@t:igdb.request".to_string());
    }
    Ok(first)
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
    let value = api_post(&app, "games", &game_query(id)).await?;
    let game = value
        .as_array()
        .and_then(|items| items.first())
        .map(map_game)
        .ok_or_else(|| "@t:igdb.notFound".to_string())?;
    write_cached_game(&app, &game);
    Ok(game)
}

/// The game page's entry point: a title (plus the year when the store knows
/// it) becomes an IGDB game. `None` when nothing convincing matched.
#[tauri::command]
pub async fn igdb_enrich(app: AppHandle, title: String, year: Option<i64>) -> Result<Option<IgdbGame>, String> {
    if title.trim().is_empty() || load_credentials(&app).is_none() {
        return Ok(None);
    }
    let key = normalize_title(&title);
    if key.is_empty() {
        return Ok(None);
    }

    let mut lookup = read_lookup(&app);
    let mut id = lookup
        .get(&key)
        .and_then(serde_json::Value::as_i64)
        .filter(|id| *id > 0);

    if id.is_none() {
        let value = api_post(&app, "games", &search_query(&title, 8)).await?;
        let hits = value.as_array().cloned().unwrap_or_default();
        id = pick_best_match(&hits, &title, year);
        if let Some(found) = id {
            lookup.insert(key, serde_json::Value::from(found));
            write_lookup(&app, &lookup);
        }
    }

    let Some(id) = id else { return Ok(None) };
    if let Some(cached) = read_cached_game(&app, id) {
        return Ok(Some(cached));
    }
    let value = api_post(&app, "games", &game_query(id)).await?;
    let game = value
        .as_array()
        .and_then(|items| items.first())
        .map(map_game)
        .ok_or_else(|| "@t:igdb.notFound".to_string())?;
    write_cached_game(&app, &game);
    Ok(Some(game))
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
            "websites": [
                { "category": 3, "url": "https://store.example" },
                { "category": 1, "url": "https://thewitcher.com" }
            ]
        });
        let game = map_game(&sample);
        assert_eq!(game.id, 1942);
        assert_eq!(game.developer, "CD Projekt RED");
        assert_eq!(game.publisher, "CD Projekt");
        assert_eq!(game.release_year, Some(2015));
        assert_eq!(game.release_date, "2015-05-19");
        assert_eq!(game.screenshots.len(), MAX_SCREENSHOTS);
        assert_eq!(game.similar.len(), 1);
        assert_eq!(game.similar[0].name, "Skyrim");
        assert_eq!(game.franchises, vec!["The Witcher".to_string()]);
        assert_eq!(game.website, "https://thewitcher.com");
        assert_eq!(game.genres, vec!["Role-playing (RPG)".to_string()]);
    }

    #[test]
    fn normalize_title_keeps_letters_and_digits() {
        assert_eq!(normalize_title("The Witcher 3: Wild Hunt!"), "thewitcher3wildhunt");
    }
}
