//! Upcoming PC release calendar backed by IGDB, supplemented by Steam and GOG.
//!
//! IGDB provides the primary 400-day schedule, hype counts and multi-store
//! links. Steam's Coming Soon / Popular Wishlist feeds and GOG's Upcoming
//! catalog run alongside IGDB in parallel so that:
//! - games IGDB already lists gain direct Steam/GOG store links, missing covers
//!   and more specific release dates when a store announces an exact day first;
//! - upcoming PC games not yet meeting IGDB's hype threshold (or when IGDB is
//!   unreachable) still appear on the calendar with official store artwork.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::igdb::{igdb_upcoming_releases, IgdbUpcomingRelease, UpcomingStore};

const CACHE_TTL_SECS: u64 = 6 * 60 * 60;
const CACHE_VERSION: u32 = 2;
const WINDOW_DAYS: i64 = 400;

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();

fn http_client() -> &'static reqwest::Client {
    HTTP.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(14))
            .user_agent("efxlve-launcher")
            .build()
            .unwrap_or_default()
    })
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpcomingCache {
    #[serde(default)]
    version: u32,
    #[serde(default)]
    fetched_at: u64,
    #[serde(default)]
    releases: Vec<IgdbUpcomingRelease>,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// The schedule starts at midnight UTC, so a game releasing today is included
/// even when the launcher opens after its storefront midnight.
fn day_start(now: u64) -> i64 {
    (now - now % 86_400) as i64
}

fn cache_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("upcoming_releases.json"))
}

fn read_cache(app: &AppHandle) -> UpcomingCache {
    cache_path(app)
        .and_then(|path| std::fs::read_to_string(path).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_cache(app: &AppHandle, cache: &UpcomingCache) {
    let Some(path) = cache_path(app) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(cache) {
        let _ = std::fs::write(path, text);
    }
}

fn cache_is_fresh(cache: &UpcomingCache, now: u64) -> bool {
    cache.version == CACHE_VERSION
        && !cache.releases.is_empty()
        && now.saturating_sub(cache.fetched_at) < CACHE_TTL_SECS
}

/* ---------- Date & Title Helpers ---------- */

#[derive(Debug, Clone, PartialEq, Eq)]
struct ParsedReleaseDate {
    precision: String,
    year: Option<i64>,
    month: Option<u32>,
    day: Option<u32>,
    date: Option<String>,
    timestamp: Option<i64>,
    human: String,
}

fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

fn ymd_to_timestamp(year: i64, month: u32, day: u32) -> Option<i64> {
    if year < 1970 || !(1..=12).contains(&month) || day < 1 || day > days_in_month(year, month) {
        return None;
    }
    let mut days: i64 = 0;
    for y in 1970..year {
        days += if is_leap_year(y) { 366 } else { 365 };
    }
    for m in 1..month {
        days += i64::from(days_in_month(year, m));
    }
    days += i64::from(day - 1);
    Some(days * 86_400)
}

fn timestamp_to_ymd(timestamp: i64) -> (i64, u32, u32) {
    let mut remaining = (timestamp.max(0)) / 86_400;
    let mut year = 1970;
    loop {
        let length = if is_leap_year(year) { 366 } else { 365 };
        if remaining < length {
            break;
        }
        remaining -= length;
        year += 1;
    }
    let mut month = 1u32;
    while month <= 12 {
        let length = i64::from(days_in_month(year, month));
        if remaining < length {
            break;
        }
        remaining -= length;
        month += 1;
    }
    (year, month, (remaining + 1) as u32)
}

fn short_month_name(month: u32) -> &'static str {
    match month {
        1 => "Jan",
        2 => "Feb",
        3 => "Mar",
        4 => "Apr",
        5 => "May",
        6 => "Jun",
        7 => "Jul",
        8 => "Aug",
        9 => "Sep",
        10 => "Oct",
        11 => "Nov",
        12 => "Dec",
        _ => "Jan",
    }
}

fn parse_month_token(token: &str) -> Option<u32> {
    let clean = token.trim_matches(|c: char| !c.is_alphabetic());
    if clean.len() < 3 {
        return None;
    }
    match clean[..3].to_ascii_lowercase().as_str() {
        "jan" => Some(1),
        "feb" => Some(2),
        "mar" => Some(3),
        "apr" => Some(4),
        "may" => Some(5),
        "jun" => Some(6),
        "jul" => Some(7),
        "aug" => Some(8),
        "sep" => Some(9),
        "oct" => Some(10),
        "nov" => Some(11),
        "dec" => Some(12),
        _ => None,
    }
}

fn exact_day_release(year: i64, month: u32, day: u32) -> Option<ParsedReleaseDate> {
    let timestamp = ymd_to_timestamp(year, month, day)?;
    Some(ParsedReleaseDate {
        precision: "day".to_string(),
        year: Some(year),
        month: Some(month),
        day: Some(day),
        date: Some(format!("{year:04}-{month:02}-{day:02}")),
        timestamp: Some(timestamp),
        human: format!("{} {day}, {year}", short_month_name(month)),
    })
}

/// Parses human or ISO date strings from Steam and GOG into the calendar's
/// precision model (`day`, `month`, `quarter`, `year` or `unknown`).
fn parse_flexible_date(raw: &str) -> ParsedReleaseDate {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return ParsedReleaseDate {
            precision: "unknown".to_string(),
            year: None,
            month: None,
            day: None,
            date: None,
            timestamp: None,
            human: "TBA".to_string(),
        };
    }

    // ISO or dotted date: YYYY-MM-DD / YYYY.MM.DD (with optional T... suffix)
    let date_head = trimmed
        .split(['T', ' '])
        .next()
        .unwrap_or(trimmed);
    let sep = if date_head.contains('-') {
        Some('-')
    } else if date_head.contains('.') {
        Some('.')
    } else {
        None
    };
    if let Some(sep) = sep {
        let parts: Vec<&str> = date_head.split(sep).collect();
        if parts.len() == 3 {
            if let (Ok(a), Ok(b), Ok(c)) = (
                parts[0].parse::<i64>(),
                parts[1].parse::<u32>(),
                parts[2].parse::<i64>(),
            ) {
                if a >= 1970 && (1..=31).contains(&c) {
                    if let Some(exact) = exact_day_release(a, b, c as u32) {
                        return exact;
                    }
                } else if c >= 1970 && (1..=31).contains(&a) {
                    if let Some(exact) = exact_day_release(c, b, a as u32) {
                        return exact;
                    }
                }
            }
        }
    }

    let parse_year = |s: &str| -> Option<i64> {
        let clean = s.trim_matches(|c: char| !c.is_ascii_digit());
        (clean.len() == 4)
            .then(|| clean.parse::<i64>().ok())
            .flatten()
            .filter(|y| (2020..=2040).contains(y))
    };

    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    match tokens.as_slice() {
        [only] => {
            if let Some(year) = parse_year(only) {
                return ParsedReleaseDate {
                    precision: "year".to_string(),
                    year: Some(year),
                    month: None,
                    day: None,
                    date: None,
                    timestamp: None,
                    human: year.to_string(),
                };
            }
        }
        [first, second] => {
            let q_upper = first.to_ascii_uppercase();
            if let (Some(q_num), Some(year)) = (
                q_upper
                    .strip_prefix('Q')
                    .and_then(|q| q.parse::<u32>().ok())
                    .filter(|q| (1..=4).contains(q)),
                parse_year(second),
            ) {
                return ParsedReleaseDate {
                    precision: "quarter".to_string(),
                    year: Some(year),
                    month: None,
                    day: None,
                    date: None,
                    timestamp: None,
                    human: format!("Q{q_num} {year}"),
                };
            }
            if let (Some(month), Some(year)) = (parse_month_token(first), parse_year(second)) {
                return ParsedReleaseDate {
                    precision: "month".to_string(),
                    year: Some(year),
                    month: Some(month),
                    day: None,
                    date: None,
                    timestamp: None,
                    human: format!("{} {year}", short_month_name(month)),
                };
            }
        }
        [first, second, third] => {
            let clean_num = |s: &str| -> Option<u32> {
                s.trim_matches(|c: char| !c.is_ascii_digit()).parse::<u32>().ok()
            };
            // "Nov 19, 2026" or "November 19, 2026"
            if let (Some(month), Some(day), Some(year)) = (
                parse_month_token(first),
                clean_num(second),
                parse_year(third),
            ) {
                if let Some(exact) = exact_day_release(year, month, day) {
                    return exact;
                }
            }
            // "19 Nov, 2026" or "19 November 2026"
            if let (Some(day), Some(month), Some(year)) = (
                clean_num(first),
                parse_month_token(second),
                parse_year(third),
            ) {
                if let Some(exact) = exact_day_release(year, month, day) {
                    return exact;
                }
            }
        }
        _ => {}
    }

    ParsedReleaseDate {
        precision: "unknown".to_string(),
        year: None,
        month: None,
        day: None,
        date: None,
        timestamp: None,
        human: "TBA".to_string(),
    }
}

fn normalize_title(title: &str) -> String {
    title
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect()
}

fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.to_lowercase().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_end_matches('-').to_string()
}

/* ---------- Steam Upcoming Source ---------- */

fn extract_app_id_from_logo(logo: &str) -> Option<u64> {
    let marker = "/apps/";
    let start = logo.find(marker)? + marker.len();
    let rest = &logo[start..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse::<u64>().ok().filter(|id| *id > 0)
}

async fn fetch_steam_search_ids(filter: &str) -> Vec<u64> {
    let url = format!(
        "https://store.steampowered.com/search/results/?query=&start=0&count=50&os=win&filter={filter}&json=1"
    );
    let Ok(resp) = http_client().get(&url).send().await else {
        return Vec::new();
    };
    let Ok(json) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    json.get("items")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    item.get("logo")
                        .and_then(serde_json::Value::as_str)
                        .and_then(extract_app_id_from_logo)
                })
                .collect()
        })
        .unwrap_or_default()
}

async fn fetch_steam_featured_coming_soon_ids() -> Vec<u64> {
    let url = "https://store.steampowered.com/api/featuredcategories?cc=US&l=english";
    let Ok(resp) = http_client().get(url).send().await else {
        return Vec::new();
    };
    let Ok(json) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    json.pointer("/coming_soon/items")
        .and_then(serde_json::Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.get("id").and_then(serde_json::Value::as_u64))
                .filter(|id| *id > 0)
                .collect()
        })
        .unwrap_or_default()
}

fn parse_steam_release(
    steam_ts: Option<i64>,
    custom_msg: &str,
    from: i64,
    to: i64,
) -> Option<ParsedReleaseDate> {
    if !custom_msg.trim().is_empty() {
        let parsed = parse_flexible_date(custom_msg);
        if parsed.precision != "unknown" {
            if let Some(ts) = parsed.timestamp {
                if ts < from || ts > to {
                    return None;
                }
            }
            return Some(parsed);
        }
    }
    if let Some(ts) = steam_ts {
        if ts < from || ts > to {
            return None;
        }
        let (year, month, day) = timestamp_to_ymd(ts);
        return exact_day_release(year, month, day);
    }
    Some(ParsedReleaseDate {
        precision: "unknown".to_string(),
        year: None,
        month: None,
        day: None,
        date: None,
        timestamp: None,
        human: "TBA".to_string(),
    })
}

async fn steam_upcoming_releases(from: i64, to: i64) -> Vec<IgdbUpcomingRelease> {
    let (featured, coming_soon, popular_wishlist) = tokio::join!(
        fetch_steam_featured_coming_soon_ids(),
        fetch_steam_search_ids("comingsoon"),
        fetch_steam_search_ids("popularwishlist"),
    );

    let mut seen = HashSet::new();
    let mut app_ids = Vec::new();
    for id in featured
        .into_iter()
        .chain(coming_soon)
        .chain(popular_wishlist)
    {
        if seen.insert(id) {
            app_ids.push(id);
            if app_ids.len() >= 100 {
                break;
            }
        }
    }
    if app_ids.is_empty() {
        return Vec::new();
    }

    let mut out = Vec::new();
    for chunk in app_ids.chunks(50) {
        let input = serde_json::json!({
            "ids": chunk.iter().map(|id| serde_json::json!({ "appid": id })).collect::<Vec<_>>(),
            "context": { "language": "english", "country_code": "US", "steam_realm": 1 },
            "data_request": { "include_assets": true, "include_release": true }
        });
        let encoded: String =
            url::form_urlencoded::byte_serialize(input.to_string().as_bytes()).collect();
        let endpoint = format!(
            "https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json={encoded}"
        );
        let Ok(resp) = http_client().get(&endpoint).send().await else {
            continue;
        };
        let Ok(payload) = resp.json::<serde_json::Value>().await else {
            continue;
        };
        let Some(items) = payload
            .pointer("/response/store_items")
            .and_then(serde_json::Value::as_array)
        else {
            continue;
        };

        for item in items {
            let Some(appid) = item.get("appid").and_then(serde_json::Value::as_u64) else {
                continue;
            };
            let name = item
                .get("name")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if name.is_empty() {
                continue;
            }
            let release_obj = item.get("release");
            let is_coming_soon = release_obj
                .and_then(|r| r.get("is_coming_soon"))
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false);
            let steam_ts = release_obj
                .and_then(|r| r.get("steam_release_date"))
                .and_then(serde_json::Value::as_i64);
            let custom_msg = release_obj
                .and_then(|r| r.get("custom_release_date_message"))
                .and_then(serde_json::Value::as_str)
                .unwrap_or("");

            if !is_coming_soon && steam_ts.map(|ts| ts < from).unwrap_or(true) {
                continue;
            }
            let Some(parsed) = parse_steam_release(steam_ts, custom_msg, from, to) else {
                continue;
            };

            let assets = item.get("assets");
            let cover_id = assets
                .and_then(crate::steam_art::cover_url_from_assets)
                .unwrap_or_default();
            let artwork_id = assets
                .and_then(crate::steam_art::hero_url_from_assets)
                .unwrap_or_default();

            out.push(IgdbUpcomingRelease {
                id: 1_000_000_000 + (appid as i64),
                slug: slugify(&name),
                name,
                cover_id,
                artwork_id,
                url: String::new(),
                hypes: 15,
                human: parsed.human,
                precision: parsed.precision,
                year: parsed.year,
                month: parsed.month,
                day: parsed.day,
                date: parsed.date,
                timestamp: parsed.timestamp,
                stores: vec![UpcomingStore {
                    id: "steam".to_string(),
                    label: "Steam".to_string(),
                    url: format!("https://store.steampowered.com/app/{appid}"),
                }],
            });
        }
    }
    out
}

/* ---------- GOG Upcoming Source ---------- */

async fn gog_upcoming_releases(from: i64, to: i64) -> Vec<IgdbUpcomingRelease> {
    let url = "https://catalog.gog.com/v1/catalog?limit=48&releaseStatuses=in:upcoming&order=desc:trending&productType=in:game&page=1&countryCode=US&locale=en-US&currencyCode=USD";
    let Ok(resp) = http_client().get(url).send().await else {
        return Vec::new();
    };
    let Ok(payload) = resp.json::<serde_json::Value>().await else {
        return Vec::new();
    };
    let Some(products) = payload
        .get("products")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for product in products {
        let name = product
            .get("title")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let raw_id = product
            .get("id")
            .and_then(|v| {
                v.as_i64()
                    .or_else(|| v.as_str().and_then(|s| s.parse::<i64>().ok()))
            })
            .unwrap_or(0);
        let slug = product
            .get("slug")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| slugify(&name));

        let release_raw = product
            .get("releaseDate")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("");
        let parsed = parse_flexible_date(release_raw);
        if let Some(ts) = parsed.timestamp {
            if ts < from || ts > to {
                continue;
            }
        }

        let cover_id = product
            .get("coverVertical")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let artwork_id = product
            .get("coverHorizontal")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("")
            .trim()
            .to_string();
        let store_url = product
            .get("storeLink")
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|s| s.starts_with("http"))
            .map(str::to_string)
            .unwrap_or_else(|| format!("https://www.gog.com/en/game/{slug}"));

        let id = 2_000_000_000 + (raw_id.abs() % 800_000_000).max(1);
        out.push(IgdbUpcomingRelease {
            id,
            name,
            slug,
            cover_id,
            artwork_id,
            url: String::new(),
            hypes: 10,
            human: parsed.human,
            precision: parsed.precision,
            year: parsed.year,
            month: parsed.month,
            day: parsed.day,
            date: parsed.date,
            timestamp: parsed.timestamp,
            stores: vec![UpcomingStore {
                id: "gog".to_string(),
                label: "GOG".to_string(),
                url: store_url,
            }],
        });
    }
    out
}

/* ---------- Multi-Source Merger ---------- */

fn precision_rank(precision: &str) -> u8 {
    match precision {
        "day" => 4,
        "month" => 3,
        "quarter" => 2,
        "year" => 1,
        _ => 0,
    }
}

fn store_order(id: &str) -> u8 {
    match id {
        "steam" => 0,
        "epic" => 1,
        "gog" => 2,
        "xbox" => 3,
        _ => 4,
    }
}

fn merge_upcoming_sources(
    igdb: Vec<IgdbUpcomingRelease>,
    steam: Vec<IgdbUpcomingRelease>,
    gog: Vec<IgdbUpcomingRelease>,
) -> Vec<IgdbUpcomingRelease> {
    let igdb_was_empty = igdb.is_empty();
    let mut merged = igdb;
    let mut by_title: HashMap<String, usize> = HashMap::new();

    for (idx, item) in merged.iter().enumerate() {
        let key = normalize_title(&item.name);
        if !key.is_empty() {
            by_title.entry(key).or_insert(idx);
        }
    }

    for extra in steam.into_iter().chain(gog) {
        let key = normalize_title(&extra.name);
        if key.is_empty() {
            continue;
        }
        if let Some(&idx) = by_title.get(&key) {
            let target = &mut merged[idx];
            for store in extra.stores {
                if !target.stores.iter().any(|existing| existing.id == store.id) {
                    target.stores.push(store);
                }
            }
            target
                .stores
                .sort_by_key(|store| store_order(&store.id));
            if target.cover_id.is_empty() && !extra.cover_id.is_empty() {
                target.cover_id = extra.cover_id;
            }
            if target.artwork_id.is_empty() && !extra.artwork_id.is_empty() {
                target.artwork_id = extra.artwork_id;
            }
            if precision_rank(&extra.precision) > precision_rank(&target.precision) {
                target.precision = extra.precision;
                target.year = extra.year;
                target.month = extra.month;
                target.day = extra.day;
                target.date = extra.date;
                target.timestamp = extra.timestamp;
                target.human = extra.human;
            }
        } else if extra.precision != "unknown" || igdb_was_empty {
            let idx = merged.len();
            by_title.insert(key, idx);
            merged.push(extra);
        }
    }

    merged.sort_by(|left, right| match (left.timestamp, right.timestamp) {
        (Some(left_ts), Some(right_ts)) => left_ts
            .cmp(&right_ts)
            .then(left.name.to_lowercase().cmp(&right.name.to_lowercase())),
        (Some(_), None) => std::cmp::Ordering::Less,
        (None, Some(_)) => std::cmp::Ordering::Greater,
        (None, None) => left
            .year
            .cmp(&right.year)
            .then(left.month.cmp(&right.month))
            .then(right.hypes.cmp(&left.hypes))
            .then(left.name.to_lowercase().cmp(&right.name.to_lowercase())),
    });
    merged
}

/// Upcoming PC releases for the calendar. `refresh` bypasses the six-hour cache;
/// a failed network request still serves the last good answer.
#[tauri::command]
pub async fn epic_upcoming_releases(
    app: AppHandle,
    refresh: Option<bool>,
) -> Result<Vec<IgdbUpcomingRelease>, String> {
    let refresh = refresh.unwrap_or(false);
    let now = now_secs();
    let mut cache = read_cache(&app);
    if !refresh && cache_is_fresh(&cache, now) {
        return Ok(cache.releases);
    }

    let from = day_start(now);
    let to = from + WINDOW_DAYS * 86_400;
    let (igdb_res, steam_list, gog_list) = tokio::join!(
        igdb_upcoming_releases(&app, from, to),
        steam_upcoming_releases(from, to),
        gog_upcoming_releases(from, to),
    );

    let (igdb_list, igdb_err) = match igdb_res {
        Ok(list) => (list, None),
        Err(err) => (Vec::new(), Some(err)),
    };

    let releases = merge_upcoming_sources(igdb_list, steam_list, gog_list);
    if !releases.is_empty() {
        cache.version = CACHE_VERSION;
        cache.fetched_at = now;
        cache.releases = releases.clone();
        write_cache(&app, &cache);
        return Ok(releases);
    }

    if !cache.releases.is_empty() {
        Ok(cache.releases)
    } else if let Some(err) = igdb_err {
        Err(err)
    } else {
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_release() -> IgdbUpcomingRelease {
        IgdbUpcomingRelease {
            id: 1,
            name: "Example".into(),
            cover_id: "abc".into(),
            url: "https://www.igdb.com/games/example".into(),
            slug: "example".into(),
            hypes: 12,
            human: "Jan 28, 2027".into(),
            artwork_id: String::new(),
            precision: "day".into(),
            year: Some(2027),
            month: Some(1),
            day: Some(28),
            date: Some("2027-01-28".into()),
            timestamp: Some(1_800_000_000),
            stores: Vec::new(),
        }
    }

    #[test]
    fn a_fresh_cache_is_served_for_six_hours() {
        let cache = UpcomingCache {
            version: CACHE_VERSION,
            fetched_at: 1_000,
            releases: vec![sample_release()],
        };
        assert!(cache_is_fresh(&cache, 1_000 + CACHE_TTL_SECS - 1));
        assert!(!cache_is_fresh(&cache, 1_000 + CACHE_TTL_SECS));
    }

    #[test]
    fn an_empty_cache_is_never_fresh() {
        let cache = UpcomingCache {
            version: CACHE_VERSION,
            fetched_at: 1_000,
            releases: Vec::new(),
        };
        assert!(!cache_is_fresh(&cache, 1_001));
    }

    #[test]
    fn the_window_starts_at_midnight_utc() {
        assert_eq!(day_start(86_400 * 20_000 + 12_345), 86_400 * 20_000);
        assert_eq!(day_start(86_400), 86_400);
    }

    #[test]
    fn the_cache_round_trips_and_uses_camel_case() {
        let cache = UpcomingCache {
            version: CACHE_VERSION,
            fetched_at: 1_000,
            releases: vec![sample_release()],
        };
        let text = serde_json::to_string(&cache).unwrap();
        let parsed: UpcomingCache = serde_json::from_str(&text).unwrap();
        assert_eq!(parsed.releases.len(), 1);
        let value: serde_json::Value = serde_json::to_value(&parsed).unwrap();
        assert_eq!(
            value.pointer("/releases/0/coverId").and_then(|v| v.as_str()),
            Some("abc")
        );
    }

    #[test]
    fn parses_steam_and_gog_date_formats() {
        let iso = parse_flexible_date("2026-11-20");
        assert_eq!(iso.precision, "day");
        assert_eq!(iso.date.as_deref(), Some("2026-11-20"));
        assert_eq!(iso.year, Some(2026));
        assert_eq!(iso.month, Some(11));
        assert_eq!(iso.day, Some(20));

        let gog_dot = parse_flexible_date("2026.12.04");
        assert_eq!(gog_dot.precision, "day");
        assert_eq!(gog_dot.date.as_deref(), Some("2026-12-04"));

        let month_only = parse_flexible_date("November 2026");
        assert_eq!(month_only.precision, "month");
        assert_eq!(month_only.year, Some(2026));
        assert_eq!(month_only.month, Some(11));
        assert_eq!(month_only.day, None);

        let quarter = parse_flexible_date("Q2 2027");
        assert_eq!(quarter.precision, "quarter");
        assert_eq!(quarter.year, Some(2027));

        let tba = parse_flexible_date("Coming soon");
        assert_eq!(tba.precision, "unknown");
    }

    #[test]
    fn merges_steam_and_gog_into_igdb_and_adds_extras() {
        let mut igdb_item = sample_release();
        igdb_item.name = "Example: The Game".into();
        igdb_item.precision = "year".into();
        igdb_item.year = Some(2027);
        igdb_item.month = None;
        igdb_item.day = None;
        igdb_item.date = None;
        igdb_item.timestamp = None;
        igdb_item.human = "2027".into();

        let steam_match = IgdbUpcomingRelease {
            id: 1_000_000_123,
            name: "Example The Game".into(),
            cover_id: "https://shared.fastly.steamstatic.com/cover.jpg".into(),
            artwork_id: "https://shared.fastly.steamstatic.com/hero.jpg".into(),
            url: String::new(),
            slug: "example-the-game".into(),
            hypes: 15,
            human: "Jan 28, 2027".into(),
            precision: "day".into(),
            year: Some(2027),
            month: Some(1),
            day: Some(28),
            date: Some("2027-01-28".into()),
            timestamp: Some(1_801_094_400),
            stores: vec![UpcomingStore {
                id: "steam".into(),
                label: "Steam".into(),
                url: "https://store.steampowered.com/app/123".into(),
            }],
        };

        let gog_extra = IgdbUpcomingRelease {
            id: 2_000_000_456,
            name: "GOG Exclusive Upcoming".into(),
            cover_id: "https://images.gog-statics.com/cover.jpg".into(),
            artwork_id: String::new(),
            url: String::new(),
            slug: "gog-exclusive-upcoming".into(),
            hypes: 10,
            human: "Feb 14, 2027".into(),
            precision: "day".into(),
            year: Some(2027),
            month: Some(2),
            day: Some(14),
            date: Some("2027-02-14".into()),
            timestamp: Some(1_802_563_200),
            stores: vec![UpcomingStore {
                id: "gog".into(),
                label: "GOG".into(),
                url: "https://www.gog.com/en/game/gog_exclusive".into(),
            }],
        };

        let merged = merge_upcoming_sources(vec![igdb_item], vec![steam_match], vec![gog_extra]);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].id, 1);
        assert_eq!(merged[0].precision, "day");
        assert_eq!(merged[0].date.as_deref(), Some("2027-01-28"));
        assert_eq!(merged[0].stores.len(), 1);
        assert_eq!(merged[0].stores[0].id, "steam");
        assert_eq!(
            merged[0].artwork_id,
            "https://shared.fastly.steamstatic.com/hero.jpg"
        );
        assert_eq!(merged[1].name, "GOG Exclusive Upcoming");
    }
}
