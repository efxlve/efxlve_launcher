//! Exophase: a read-only mirror of a public cross-platform profile.
//!
//! Exophase has no documented public API, but its own frontend calls
//! `api.exophase.com/public/player/{id}/...` without authentication. This
//! module resolves the numeric player id from the profile HTML, reads the
//! games list page by page, then caches the answer on disk. Nothing here
//! writes to Exophase, and no token is stored: the profile is public by
//! definition and the username is not a secret.
//!
//! Exophase is an independent third-party service. The UI says so explicitly;
//! this module only reads the data that the service already serves publicly.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::PathBuf;
use tauri::Manager;

use crate::lookup_cache;

const PROFILE_ROOT: &str = "https://www.exophase.com";
const API_ROOT: &str = "https://api.exophase.com";
const CACHE_SCHEMA: u32 = 3;
/// The launcher's own copy is refreshed at most this often. Exophase itself
/// only moves when the user runs its profile sync, so a shorter TTL would just
/// repeat the same answer.
const CACHE_TTL_SECS: u64 = 6 * 3600;
const PAGE_SIZE: usize = 50;
const MAX_PAGES: usize = 200;
const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExophaseStatus {
    pub configured: bool,
    pub username: String,
    /// The Profile tab switch. Existing settings without the key stay visible.
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExophaseService {
    pub slug: String,
    pub label: String,
    pub games: u32,
    pub awards: u32,
    pub playtime_minutes: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExophaseSummary {
    pub username: String,
    pub display_name: String,
    pub player_id: String,
    pub user_id: String,
    pub avatar: String,
    pub profile_url: String,
    pub total_awards: u32,
    pub total_games: u32,
    pub playtime_minutes: u32,
    pub completed_games: u32,
    pub rank: u32,
    pub services: Vec<ExophaseService>,
    /// Unix seconds of Exophase's own last profile sync, when the page reports it.
    pub last_sync: u64,
    /// Unix seconds of this launcher's last successful read.
    pub fetched_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExophaseGame {
    pub master_id: u64,
    /// The service-specific player id Exophase uses for `/earned`.
    pub player_id: u64,
    pub title: String,
    pub platform_slug: String,
    pub platform: String,
    pub percent: f64,
    pub earned_awards: u32,
    pub total_awards: u32,
    pub playtime_minutes: u32,
    pub last_played: u64,
    /// Wide card art (`meta.images.l`, 288x158) so the grid is not a 64px tile.
    pub cover: String,
    /// Wide hero art (`meta.images.o`) for the tab backdrop.
    #[serde(default)]
    pub hero: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExophaseAward {
    pub name: String,
    pub description: String,
    pub game: String,
    pub platform: String,
    pub earned: String,
    pub icon: String,
    pub url: String,
    pub rarity: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExophaseData {
    pub summary: ExophaseSummary,
    pub games: Vec<ExophaseGame>,
    pub awards: Vec<ExophaseAward>,
}

/// A profile page summary parsed from the page's embedded JSON. Every field is
/// optional because the page can change; the games list remains the source of
/// the totals.
#[derive(Debug, Clone, Default)]
struct ExtractedSummary {
    user_id: String,
    player_id: String,
    display_name: String,
    username: String,
    avatar: String,
    rank: u32,
    last_sync: u64,
    services: Vec<ExophaseService>,
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent(USER_AGENT)
        .build()
        .map_err(|error| format!("network:{error}"))
}

fn cache_path(app: &tauri::AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("exophase")
        .join("cache.json")
}

fn stored_username(app: &tauri::AppHandle) -> String {
    crate::load_settings(app)
        .exophase_username
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn status_for(app: &tauri::AppHandle) -> ExophaseStatus {
    let settings = crate::load_settings(app);
    let username = settings
        .exophase_username
        .unwrap_or_default()
        .trim()
        .to_string();
    ExophaseStatus {
        configured: !username.is_empty(),
        username,
        enabled: settings.exophase_enabled.unwrap_or(true),
    }
}

fn clear_cache(app: &tauri::AppHandle) {
    let _ = std::fs::remove_file(cache_path(app));
}

/// Percent-encodes one path segment. Usernames are simple, but a pasted URL or
/// a non-ASCII name must never smuggle a slash into the request path.
fn encode_segment(raw: &str) -> String {
    let mut out = String::new();
    for byte in raw.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn digits_after(html: &str, marker: &str) -> Option<String> {
    let start = html.find(marker)? + marker.len();
    let digits: String = html[start..]
        .chars()
        .skip_while(|c| !c.is_ascii_digit())
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        Some(digits)
    }
}

fn player_id_from_html(html: &str) -> Option<String> {
    digits_after(html, "playerProfileId").or_else(|| digits_after(html, "data-playerid=\""))
}

/// The summary lives in a single-quoted JavaScript string; the closing quote is
/// the first one that is not escaped.
fn summary_literal(html: &str) -> Option<&str> {
    let marker = "window.currentPlayerSummary = '";
    let start = html.find(marker)? + marker.len();
    let bytes = html.as_bytes();
    let mut escaped = false;
    for index in start..bytes.len() {
        let byte = bytes[index];
        if escaped {
            escaped = false;
            continue;
        }
        if byte == b'\\' {
            escaped = true;
            continue;
        }
        if byte == b'\'' {
            return html.get(start..index);
        }
    }
    None
}

/// JavaScript string escapes, in one pass. A second pass would turn the JSON's
/// own `\\u2013` into a stray backslash and break the parse.
fn unescape_js(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut chars = input.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('r') => out.push('\r'),
            Some('t') => out.push('\t'),
            Some('b') => out.push('\u{8}'),
            Some('f') => out.push('\u{c}'),
            Some('u') => {
                let hex: String = chars.by_ref().take(4).collect();
                if hex.len() == 4 {
                    if let Ok(code) = u32::from_str_radix(&hex, 16) {
                        if let Some(decoded) = char::from_u32(code) {
                            out.push(decoded);
                        }
                    }
                }
            }
            Some(other) => out.push(other),
            None => break,
        }
    }
    out
}

fn text_of(value: Option<&Value>) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_string()
}

fn u64_of(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number
            .as_u64()
            .or_else(|| number.as_f64().map(|f| f.max(0.0) as u64))
            .unwrap_or(0),
        Some(Value::String(raw)) => raw.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

fn f64_of(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(raw)) => raw.trim().parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn u32_of(value: Option<&Value>) -> u32 {
    u64_of(value).min(u32::MAX as u64) as u32
}

fn hours_to_minutes(hours: f64) -> u32 {
    (hours.max(0.0) * 60.0).round().min(u32::MAX as f64) as u32
}

fn absolute_url(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return trimmed.to_string();
    }
    if let Some(rest) = trimmed.strip_prefix("//") {
        return format!("https://{rest}");
    }
    if trimmed.starts_with('/') {
        return format!("{PROFILE_ROOT}{trimmed}");
    }
    trimmed.to_string()
}

/// The public API's `meta.images` only ships the 127x70 `m` tile. The CDN
/// serves `l` (288x158) and `o` (the original upload) at the same path, so swap
/// the single-letter size segment instead of upscaling the thumbnail.
fn art_at_size(raw: &str, size: &str) -> String {
    let url = absolute_url(raw);
    let Some(games) = url.find("/games/") else {
        return url;
    };
    let start = games + "/games/".len();
    let Some(end) = url[start..].find('/').map(|offset| start + offset) else {
        return url;
    };
    if url[start..end].len() != 1 {
        return url;
    }
    format!("{}{}{}", &url[..start], size, &url[end..])
}

fn platform_label(slug: &str) -> String {
    match slug {
        "steam" => "Steam",
        "epic" => "Epic Games",
        "origin" | "ea" => "EA",
        "psn" | "playstation" => "PlayStation",
        "xbox" => "Xbox",
        "nintendo" => "Nintendo",
        "gog" => "GOG",
        "uplay" | "ubisoft" => "Ubisoft",
        "battlenet" | "blizzard" => "Battle.net",
        "retro" => "RetroAchievements",
        "android" | "gplay" => "Google Play",
        "apple" => "Apple",
        "stadia" => "Stadia",
        "legacy" => "Other",
        "" => "Other",
        other => other,
    }
    .to_string()
}

fn summary_from_value(value: &Value) -> ExtractedSummary {
    let mut services = Vec::new();
    if let Some(list) = value.get("services").and_then(Value::as_array) {
        for service in list {
            let slug = text_of(service.get("environment_slug"));
            if slug.is_empty() || slug == "legacy" {
                continue;
            }
            let playtime = service.get("playtime");
            services.push(ExophaseService {
                slug: slug.clone(),
                label: {
                    let phrase = text_of(service.get("environment_phrase"));
                    if phrase.is_empty() {
                        platform_label(&slug)
                    } else {
                        phrase
                    }
                },
                games: u32_of(service.get("gamesplayed")),
                awards: u32_of(service.get("total_awards")),
                playtime_minutes: hours_to_minutes(f64_of(playtime)),
            });
        }
    }

    ExtractedSummary {
        user_id: u64_of(value.get("user_id")).to_string(),
        player_id: u64_of(value.get("master_playerid")).to_string(),
        display_name: {
            let display = text_of(value.get("displayname"));
            if display.is_empty() {
                text_of(value.get("username"))
            } else {
                display
            }
        },
        username: text_of(value.get("username")),
        avatar: {
            let avatar = text_of(value.get("avatar"));
            if avatar.is_empty() {
                String::new()
            } else {
                absolute_url(&avatar)
            }
        },
        rank: u32_of(value.get("rank_ww")),
        last_sync: u64_of(value.get("lastsync")),
        services,
    }
}

fn parse_summary(html: &str) -> Option<ExtractedSummary> {
    let literal = summary_literal(html)?;
    let decoded = unescape_js(literal);
    let value: Value = serde_json::from_str(&decoded).ok()?;
    Some(summary_from_value(&value))
}

fn is_challenge(html: &str) -> bool {
    html.len() < 20_000
        && (html.contains("Just a moment")
            || html.contains("cf-challenge")
            || html.contains("Attention Required")
            || html.contains("Enable JavaScript and cookies"))
}

enum Input {
    PlayerId(String),
    Username(String),
}

fn parse_input(raw: &str) -> Input {
    let trimmed = raw.trim();
    if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Input::PlayerId(trimmed.to_string());
    }
    if let Ok(url) = reqwest::Url::parse(trimmed) {
        let segments: Vec<&str> = url.path_segments().map(|s| s.collect()).unwrap_or_default();
        if let Some(position) = segments.iter().position(|segment| *segment == "user") {
            if let Some(name) = segments.get(position + 1).filter(|name| !name.is_empty()) {
                return Input::Username((*name).to_string());
            }
        }
        if let Some(name) = segments.iter().rev().find(|segment| !segment.is_empty()) {
            return Input::Username((*name).to_string());
        }
    }
    Input::Username(trimmed.to_string())
}

fn player_id_from_summary_or_html(html: &str) -> Option<String> {
    player_id_from_html(html)
        .or_else(|| {
            parse_summary(html)
                .map(|summary| summary.player_id)
                .filter(|id| !id.is_empty())
        })
        .filter(|id| !id.is_empty())
}

async fn fetch_profile(
    client: &reqwest::Client,
    username: &str,
) -> Result<(String, ExtractedSummary), String> {
    let url = format!("{PROFILE_ROOT}/user/{}/", encode_segment(username));
    let response = client
        .get(&url)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header(reqwest::header::REFERER, format!("{PROFILE_ROOT}/"))
        .send()
        .await
        .map_err(|error| format!("network:{error}"))?;
    let status = response.status();
    let html = response
        .text()
        .await
        .map_err(|error| format!("network:{error}"))?;
    if status == reqwest::StatusCode::FORBIDDEN
        || status == reqwest::StatusCode::SERVICE_UNAVAILABLE
        || is_challenge(&html)
    {
        return Err("blocked".into());
    }
    if status == reqwest::StatusCode::NOT_FOUND {
        return Err("not_found".into());
    }
    if !status.is_success() {
        return Err(format!("api:{}", status.as_u16()));
    }
    let player_id = player_id_from_summary_or_html(&html).ok_or_else(|| "not_found".to_string())?;
    let summary = parse_summary(&html).unwrap_or_default();
    Ok((player_id, summary))
}

async fn api_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .header(reqwest::header::ACCEPT, "application/json, text/plain, */*")
        .header(reqwest::header::ACCEPT_LANGUAGE, "en-US,en;q=0.9")
        .header(reqwest::header::REFERER, format!("{PROFILE_ROOT}/"))
        .send()
        .await
        .map_err(|error| format!("network:{error}"))?;
    let status = response.status();
    if status == reqwest::StatusCode::FORBIDDEN {
        return Err("blocked".into());
    }
    if !status.is_success() {
        return Err(format!("api:{}", status.as_u16()));
    }
    response
        .json()
        .await
        .map_err(|error| format!("api:{error}"))
}

fn parse_game(raw: &Value) -> Option<ExophaseGame> {
    let meta = raw.get("meta");
    let title = text_of(meta.and_then(|meta| meta.get("title")));
    if title.is_empty() {
        return None;
    }
    let master_id = u64_of(raw.get("master_id"));
    if master_id == 0 {
        return None;
    }
    let platform_slug = text_of(meta.and_then(|meta| meta.get("environment_slug")));
    let listed_platform = text_of(
        meta.and_then(|meta| meta.get("platforms"))
            .and_then(Value::as_array)
            .and_then(|platforms| platforms.first())
            .and_then(|platform| platform.get("name")),
    );
    let platform = if listed_platform.is_empty() {
        platform_label(&platform_slug)
    } else {
        listed_platform
    };

    let mut playtime_minutes = 0;
    if let Some(units) = raw.get("playtimeUnits") {
        let hours = f64_of(units.get("hours"));
        let minutes = f64_of(units.get("minutes"));
        playtime_minutes = hours_to_minutes(hours) + (minutes.max(0.0).round() as u32);
    }
    if playtime_minutes == 0 {
        // Steam answers a decimal hour string when the unit object is empty.
        let text_playtime = f64_of(raw.get("playtime"));
        playtime_minutes = hours_to_minutes(text_playtime);
    }

    let images = meta.and_then(|meta| meta.get("images"));
    let featured = text_of(meta.and_then(|meta| meta.get("featured_image")));
    let base_art = ["m", "l", "s", "t"]
        .iter()
        .map(|key| text_of(images.and_then(|images| images.get(*key))))
        .chain(std::iter::once(featured))
        .chain(
            ["resource_standard", "resource_small", "resource_tile"]
                .iter()
                .map(|key| text_of(raw.get(*key))),
        )
        .find(|value| !value.is_empty())
        .map(|value| absolute_url(&value))
        .unwrap_or_default();
    let cover = art_at_size(&base_art, "l");
    let hero = art_at_size(&base_art, "o");

    let url = ["endpoint_awards", "endpoint_overview"]
        .iter()
        .map(|key| text_of(meta.and_then(|meta| meta.get(*key))))
        .find(|value| !value.is_empty())
        .map(|value| absolute_url(&value))
        .unwrap_or_default();

    let total_awards = u32_of(raw.get("total_awards"))
        .max(u32_of(meta.and_then(|meta| meta.get("total_awards"))));

    Some(ExophaseGame {
        master_id,
        player_id: u64_of(raw.get("master_playerid")),
        title,
        platform_slug,
        platform,
        percent: f64_of(raw.get("percent")).clamp(0.0, 100.0),
        earned_awards: u32_of(raw.get("earned_awards")),
        total_awards,
        playtime_minutes,
        last_played: u64_of(raw.get("lastplayed_utc")).max(u64_of(raw.get("lastplayed"))),
        cover,
        hero,
        url,
    })
}

async fn fetch_games(
    client: &reqwest::Client,
    player_id: &str,
) -> Result<Vec<ExophaseGame>, String> {
    let mut games = Vec::new();
    let mut seen: HashSet<(u64, u64)> = HashSet::new();
    for page in 1..=MAX_PAGES {
        let url = format!(
            "{API_ROOT}/public/player/{player_id}/games?page={page}&environment=&sort=1&showHidden=0"
        );
        let value = api_json(client, &url).await?;
        if value.get("success").and_then(Value::as_bool) != Some(true) {
            return Err("api:success".into());
        }
        let batch = value
            .get("games")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        if batch.len() > PAGE_SIZE {
            return Err("api:shape".into());
        }
        let mut added = 0;
        for raw in &batch {
            if let Some(game) = parse_game(raw) {
                if seen.insert((game.player_id, game.master_id)) {
                    games.push(game);
                    added += 1;
                }
            }
        }
        if batch.len() < PAGE_SIZE {
            return Ok(games);
        }
        if added == 0 {
            // A full page with nothing new would repeat forever.
            return Err("api:loop".into());
        }
        // Polite pacing: one profile is only a handful of pages.
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    }
    Ok(games)
}

fn parse_award(raw: &Value) -> Option<ExophaseAward> {
    let name = text_of(raw.get("name"));
    if name.is_empty() {
        return None;
    }
    let meta = raw.get("meta");
    let rarity = text_of(raw.get("average")).parse::<f64>().ok();
    Some(ExophaseAward {
        name,
        description: text_of(raw.get("description")),
        game: text_of(meta.and_then(|meta| meta.get("title"))),
        platform: text_of(meta.and_then(|meta| meta.get("environment_slug"))),
        earned: text_of(raw.get("earned")),
        icon: absolute_url(&text_of(raw.get("image"))),
        url: absolute_url(&text_of(raw.get("endpoint"))),
        rarity,
    })
}

async fn fetch_awards(
    client: &reqwest::Client,
    player_id: &str,
) -> Result<Vec<ExophaseAward>, String> {
    let url = format!("{API_ROOT}/public/player/{player_id}/awards");
    let value = api_json(client, &url).await?;
    if value.get("success").and_then(Value::as_bool) != Some(true) {
        return Err("api:success".into());
    }
    Ok(value
        .get("awards")
        .and_then(Value::as_array)
        .map(|awards| awards.iter().take(10).filter_map(parse_award).collect())
        .unwrap_or_default())
}

fn build_summary(
    player_id: &str,
    input: &Input,
    extracted: Option<ExtractedSummary>,
    games: &[ExophaseGame],
) -> ExophaseSummary {
    let extracted = extracted.unwrap_or_default();
    let username = if extracted.username.is_empty() {
        match input {
            Input::Username(name) => name.clone(),
            Input::PlayerId(_) => String::new(),
        }
    } else {
        extracted.username.clone()
    };
    let display_name = if extracted.display_name.is_empty() {
        if username.is_empty() {
            format!("Exophase {player_id}")
        } else {
            username.clone()
        }
    } else {
        extracted.display_name.clone()
    };

    let total_awards = games.iter().map(|game| game.earned_awards).sum::<u32>();
    let playtime_minutes = games.iter().map(|game| game.playtime_minutes).sum::<u32>();
    let completed_games = games
        .iter()
        .filter(|game| game.total_awards > 0 && game.percent >= 100.0)
        .count() as u32;

    let labels: HashMap<String, String> = extracted
        .services
        .iter()
        .map(|service| (service.slug.clone(), service.label.clone()))
        .collect();
    let mut by_slug: BTreeMap<String, ExophaseService> = BTreeMap::new();
    for game in games {
        let slug = if game.platform_slug.is_empty() {
            "other".to_string()
        } else {
            game.platform_slug.clone()
        };
        let entry = by_slug.entry(slug.clone()).or_insert_with(|| ExophaseService {
            slug: slug.clone(),
            label: labels
                .get(&slug)
                .cloned()
                .unwrap_or_else(|| platform_label(&slug)),
            games: 0,
            awards: 0,
            playtime_minutes: 0,
        });
        entry.games = entry.games.saturating_add(1);
        entry.awards = entry.awards.saturating_add(game.earned_awards);
        entry.playtime_minutes = entry.playtime_minutes.saturating_add(game.playtime_minutes);
    }
    let mut services: Vec<ExophaseService> = by_slug.into_values().collect();
    services.sort_by(|left, right| {
        right
            .games
            .cmp(&left.games)
            .then_with(|| left.label.cmp(&right.label))
    });

    let profile_url = if username.is_empty() {
        format!("{PROFILE_ROOT}/")
    } else {
        format!("{PROFILE_ROOT}/user/{}/", encode_segment(&username))
    };

    ExophaseSummary {
        username,
        display_name,
        player_id: player_id.to_string(),
        user_id: extracted.user_id,
        avatar: extracted.avatar,
        profile_url,
        total_awards,
        total_games: games.len() as u32,
        playtime_minutes,
        completed_games,
        rank: extracted.rank,
        services,
        last_sync: extracted.last_sync,
        fetched_at: 0,
    }
}

#[cfg(windows)]
const EXOPHASE_WEBVIEW_LABEL: &str = "exophase-fetch";

/// Runs on the profile page itself, so the API fetch carries the Cloudflare
/// session cookie and the `https://www.exophase.com` origin the API allows.
#[cfg(windows)]
const EXOPHASE_FETCH_SCRIPT: &str = r#"(() => {
  if (window.__EFX_EXO_STARTED) return 'started';
  window.__EFX_EXO_STARTED = true;
  (async () => {
    const id = String(window.playerProfileId || window.__EFX_ID || '');
    try {
      if (!id) { window.__EFX_EXO = { error: 'no_id' }; return; }
      let summary = null;
      try { summary = window.currentPlayerSummary ? JSON.parse(window.currentPlayerSummary) : null; } catch (_) {}
      const games = [];
      for (let page = 1; page <= 200; page++) {
        const response = await fetch('https://api.exophase.com/public/player/' + encodeURIComponent(id) + '/games?page=' + page + '&environment=&sort=1&showHidden=0', { credentials: 'include', headers: { 'Accept': 'application/json' } });
        if (!response.ok) { window.__EFX_EXO = { error: 'api_' + response.status }; return; }
        const data = await response.json();
        if (!data || data.success !== true) { window.__EFX_EXO = { error: 'api_success' }; return; }
        const batch = data.games || [];
        games.push.apply(games, batch);
        if (batch.length < 50) break;
      }
      let awards = [];
      try {
        const response = await fetch('https://api.exophase.com/public/player/' + encodeURIComponent(id) + '/awards', { credentials: 'include', headers: { 'Accept': 'application/json' } });
        if (response.ok) { const data = await response.json(); awards = data.awards || []; }
      } catch (_) {}
      window.__EFX_EXO = { id: id, summary: summary, games: games, awards: awards };
    } catch (error) {
      window.__EFX_EXO = { error: 'script:' + String(error) };
    }
  })();
  return 'started';
})()"#;

/// Executes one script in a child webview and returns its JSON result.
#[cfg(windows)]
async fn eval_in_webview(webview: &tauri::Webview, script: &str) -> Result<Value, String> {
    use std::sync::{Arc, Mutex};
    use webview2_com::{CoTaskMemPWSTR, ExecuteScriptCompletedHandler};

    let (tx, rx) = tokio::sync::oneshot::channel::<Result<String, String>>();
    let tx = Arc::new(Mutex::new(Some(tx)));
    let script = script.to_string();
    webview
        .with_webview(move |platform| {
            let controller = platform.controller();
            let core = match unsafe { controller.CoreWebView2() } {
                Ok(core) => core,
                Err(error) => {
                    if let Some(sender) = tx.lock().unwrap().take() {
                        let _ = sender.send(Err(format!("webview:{error}")));
                    }
                    return;
                }
            };
            let tx_for_handler = tx.clone();
            let tx_for_failure = tx.clone();
            let handler = ExecuteScriptCompletedHandler::create(Box::new(
                move |result: windows::core::Result<()>, text: String| {
                    if let Some(sender) = tx_for_handler.lock().unwrap().take() {
                        let _ = match result {
                            Ok(()) => sender.send(Ok(text)),
                            Err(error) => sender.send(Err(format!("eval:{error}"))),
                        };
                    }
                    Ok(())
                },
            ));
            let js = CoTaskMemPWSTR::from(script.as_str());
            if let Err(error) = unsafe { core.ExecuteScript(*js.as_ref().as_pcwstr(), &handler) } {
                if let Some(sender) = tx_for_failure.lock().unwrap().take() {
                    let _ = sender.send(Err(format!("eval:{error}")));
                }
            }
        })
        .map_err(|error| format!("webview:{error}"))?;
    let received = tokio::time::timeout(std::time::Duration::from_secs(15), rx).await;
    let inner = received.map_err(|_| "eval:timeout".to_string())?;
    let text = match inner {
        Ok(Ok(text)) => text,
        Ok(Err(error)) => return Err(format!("eval:{error}")),
        Err(error) => return Err(format!("eval:{error}")),
    };
    serde_json::from_str(&text).map_err(|error| format!("eval-json:{error}"))
}

/// Reads the public profile inside a hidden WebView2 child. Cloudflare challenges
/// a plain requester, but the embedded browser solves it exactly like a normal
/// page; the fetch then runs from `www.exophase.com`, which the API allows.
#[cfg(windows)]
async fn fetch_via_webview(app: &tauri::AppHandle, raw_input: &str) -> Result<ExophaseData, String> {
    use std::sync::{Arc, Mutex};

    let input = parse_input(raw_input);
    let page_url = match &input {
        Input::Username(name) => format!("{PROFILE_ROOT}/user/{}/", encode_segment(name)),
        Input::PlayerId(_) => format!("{PROFILE_ROOT}/"),
    };
    let window = app
        .get_window("main")
        .ok_or_else(|| "webview:no-window".to_string())?;
    if let Some(old) = window.get_webview(EXOPHASE_WEBVIEW_LABEL) {
        let _ = old.close();
    }

    let (load_tx, load_rx) = tokio::sync::oneshot::channel::<()>();
    let load_tx = Arc::new(Mutex::new(Some(load_tx)));
    let parsed: url::Url = page_url
        .parse()
        .map_err(|error| format!("webview:{error}"))?;
    let builder = tauri::WebviewBuilder::new(
        EXOPHASE_WEBVIEW_LABEL,
        tauri::WebviewUrl::External(parsed),
    )
    .on_page_load({
        let load_tx = load_tx.clone();
        move |_webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                if let Some(sender) = load_tx.lock().unwrap().take() {
                    let _ = sender.send(());
                }
            }
        }
    });
    let pos = tauri::Position::Logical(tauri::LogicalPosition::new(-10000.0, -10000.0));
    let size = tauri::Size::Logical(tauri::LogicalSize::new(1280.0, 900.0));
    let handle = tokio::task::spawn_blocking(move || window.add_child(builder, pos, size));
    let webview = match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(Ok(view))) => view,
        Ok(Ok(Err(error))) => return Err(format!("webview:{error}")),
        Ok(Err(error)) => return Err(format!("webview:{error}")),
        Err(_) => return Err("webview:timeout".into()),
    };
    let _ = webview.hide();
    // A challenge can finish before it redirects to the profile; the id poll
    // below waits for the real page either way.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(20), load_rx).await;
    let result = read_from_webview(&webview, &input).await;
    let _ = webview.close();
    result
}

#[cfg(windows)]
async fn read_from_webview(
    webview: &tauri::Webview,
    input: &Input,
) -> Result<ExophaseData, String> {
    let id_hint = match input {
        Input::PlayerId(id) => id.clone(),
        Input::Username(_) => String::new(),
    };
    let id_json = serde_json::to_string(&id_hint).map_err(|error| format!("api:{error}"))?;
    let _ = eval_in_webview(
        webview,
        &format!("window.__EFX_ID = {id_json}; window.__EFX_EXO_STARTED = false; window.__EFX_EXO = null; 'ok'"),
    )
    .await;

    if let Input::Username(_) = input {
        let mut found = false;
        for _ in 0..40 {
            if let Ok(value) = eval_in_webview(webview, "String(window.playerProfileId || '')").await {
                if let Some(id) = value.as_str().filter(|id| !id.is_empty()) {
                    let id_json = serde_json::to_string(id).unwrap_or_else(|_| "\"\"".into());
                    let _ = eval_in_webview(webview, &format!("window.__EFX_ID = {id_json}; 'ok'")).await;
                    found = true;
                    break;
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
        }
        if !found {
            return Err("blocked".into());
        }
    }

    let mut result: Option<Value> = None;
    for attempt in 0..120 {
        if attempt % 4 == 0 {
            let _ = eval_in_webview(webview, EXOPHASE_FETCH_SCRIPT).await;
        }
        if let Ok(value) = eval_in_webview(webview, "window.__EFX_EXO || null").await {
            if value.is_object() {
                result = Some(value);
                break;
            }
        }
        tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    }
    let value = result.ok_or_else(|| "blocked".to_string())?;
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(match error {
            "no_id" => "blocked".to_string(),
            other if other.starts_with("api_") => "blocked".to_string(),
            other => format!("api:{other}"),
        });
    }

    let id = value
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    if id.is_empty() {
        return Err("not_found".into());
    }
    let extracted = value
        .get("summary")
        .filter(|summary| summary.is_object())
        .map(summary_from_value);
    let games: Vec<ExophaseGame> = value
        .get("games")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_game).collect())
        .unwrap_or_default();
    let awards: Vec<ExophaseAward> = value
        .get("awards")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(parse_award).collect())
        .unwrap_or_default();
    let summary = build_summary(&id, input, extracted, &games);
    Ok(ExophaseData {
        summary,
        games,
        awards,
    })
}

async fn fetch_via_http(raw_input: &str) -> Result<ExophaseData, String> {
    let client = http()?;
    let input = parse_input(raw_input);
    let (player_id, extracted) = match &input {
        Input::PlayerId(id) => (id.clone(), None),
        Input::Username(name) => {
            let (id, summary) = fetch_profile(&client, name).await?;
            (id, Some(summary))
        }
    };
    let games = fetch_games(&client, &player_id).await?;
    let awards = fetch_awards(&client, &player_id).await.unwrap_or_default();
    let summary = build_summary(&player_id, &input, extracted, &games);
    Ok(ExophaseData {
        summary,
        games,
        awards,
    })
}

async fn fetch_network(app: &tauri::AppHandle, raw_input: &str) -> Result<ExophaseData, String> {
    #[cfg(windows)]
    {
        match fetch_via_webview(app, raw_input).await {
            Ok(data) => return Ok(data),
            // The hidden browser is the only path that can solve Cloudflare.
            // A plain client is still worth a try when child webviews are
            // unavailable (a prewarm/creation failure), not when the page
            // itself was blocked.
            Err(error) if error.starts_with("webview:") => return fetch_via_http(raw_input).await,
            Err(error) => return Err(error),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        fetch_via_http(raw_input).await
    }
}

async fn data_for(app: &tauri::AppHandle, force: bool) -> Result<ExophaseData, String> {    let raw = stored_username(app);
    if raw.is_empty() {
        return Err("not_configured".into());
    }
    let path = cache_path(app);
    if !force {
        if let Some((mut data, fetched_at)) =
            lookup_cache::read::<ExophaseData>(&path, CACHE_SCHEMA)
        {
            if lookup_cache::fresh(fetched_at, CACHE_TTL_SECS) {
                data.summary.fetched_at = fetched_at;
                return Ok(data);
            }
        }
    }

    match fetch_network(app, &raw).await {
        Ok(mut data) => {
            data.summary.fetched_at = lookup_cache::now_secs();
            lookup_cache::write(&path, CACHE_SCHEMA, &data);
            Ok(data)
        }
        Err(error) => {
            // A stale copy is still better than an empty tab when the site is
            // temporarily blocked; the UI shows the age next to the sync line.
            if let Some((mut data, fetched_at)) =
                lookup_cache::read::<ExophaseData>(&path, CACHE_SCHEMA)
            {
                data.summary.fetched_at = fetched_at;
                return Ok(data);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub fn exophase_status(app: tauri::AppHandle) -> ExophaseStatus {
    status_for(&app)
}

#[tauri::command]
pub fn exophase_set_username(
    app: tauri::AppHandle,
    username: String,
) -> Result<ExophaseStatus, String> {
    let trimmed = username.trim().to_string();
    let mut settings = crate::load_settings(&app);
    settings.exophase_username = if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    };
    crate::save_settings(&app, &settings);
    clear_cache(&app);
    Ok(status_for(&app))
}

/// Shows or hides the Profile > Exophase tab. The saved username and cache stay
/// on disk, so turning it back on immediately restores the profile.
#[tauri::command]
pub fn exophase_set_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<ExophaseStatus, String> {
    let mut settings = crate::load_settings(&app);
    settings.exophase_enabled = Some(enabled);
    crate::save_settings(&app, &settings);
    Ok(status_for(&app))
}

#[tauri::command]
pub async fn exophase_get(
    app: tauri::AppHandle,
    force: Option<bool>,
) -> Result<ExophaseData, String> {
    data_for(&app, force.unwrap_or(false)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_player_id_is_read_from_the_page() {
        let html = r#"<script>window.playerProfileId = '2408683';</script>"#;
        assert_eq!(player_id_from_html(html).as_deref(), Some("2408683"));
        let header = r#"<div class="user-header global" data-playerid="315448"></div>"#;
        assert_eq!(player_id_from_html(header).as_deref(), Some("315448"));
    }

    #[test]
    fn a_url_or_a_number_resolves_to_the_right_input() {
        assert!(matches!(
            parse_input("https://www.exophase.com/user/Efxlve/"),
            Input::Username(name) if name == "Efxlve"
        ));
        assert!(matches!(
            parse_input("2408683"),
            Input::PlayerId(id) if id == "2408683"
        ));
        assert!(matches!(
            parse_input("Efxlve"),
            Input::Username(name) if name == "Efxlve"
        ));
    }

    #[test]
    fn the_summary_string_decodes_before_json_parsing() {
        let raw = r#"\u007B\u0022user_id\u0022\u003A315448,\u0022master_playerid\u0022\u003A2408683,\u0022displayname\u0022\u003A\u0022Efxlve\u0022,\u0022rank_ww\u0022\u003A99643\u007D"#;
        let decoded = unescape_js(raw);
        let value: Value = serde_json::from_str(&decoded).expect("decoded summary");
        assert_eq!(value["user_id"], 315448);
        assert_eq!(value["displayname"], "Efxlve");
        assert_eq!(value["rank_ww"], 99643);
    }

    #[test]
    fn the_summary_keeps_an_escaped_unicode_title_intact() {
        let decoded = unescape_js(r#"{"title":"Grand Theft Auto III \u2013 The Definitive Edition"}"#);
        let value: Value = serde_json::from_str(&decoded).expect("decoded title");
        assert_eq!(
            value["title"],
            "Grand Theft Auto III \u{2013} The Definitive Edition"
        );
    }

    #[test]
    fn a_game_reads_its_platform_playtime_and_cover() {
        let raw = serde_json::json!({
            "master_id": 576078,
            "master_playerid": 2751180,
            "earned_awards": 5,
            "total_awards": 29,
            "percent": 15,
            "lastplayed_utc": 1795019744,
            "resource_tile": "https://m.exophase.com/epic/games/t/40jee88.png",
            "playtimeUnits": { "hours": 1, "minutes": 30 },
            "meta": {
                "title": "Grand Theft Auto III - The Definitive Edition",
                "environment_slug": "epic",
                "platforms": [{ "name": "Epic" }],
                "images": {
                    "m": "https://m.exophase.com/epic/games/m/40jee88.png"
                },
                "endpoint_awards": "https://www.exophase.com/game/gta-iii-epic/achievements/"
            }
        });
        let game = parse_game(&raw).expect("game");
        assert_eq!(game.title, "Grand Theft Auto III - The Definitive Edition");
        assert_eq!(game.platform_slug, "epic");
        assert_eq!(game.platform, "Epic");
        assert_eq!(game.playtime_minutes, 90);
        assert_eq!(game.total_awards, 29);
        assert_eq!(game.percent, 15.0);
        assert!(game.cover.ends_with("/games/l/40jee88.png"));
        assert!(game.hero.ends_with("/games/o/40jee88.png"));
    }

    #[test]
    fn the_thumbnail_url_grows_to_the_card_and_hero_sizes() {
        let raw = "https://m.exophase.com/epic/games/m/40jee88.png?hash=1";
        assert_eq!(
            art_at_size(raw, "l"),
            "https://m.exophase.com/epic/games/l/40jee88.png?hash=1"
        );
        assert_eq!(
            art_at_size(raw, "o"),
            "https://m.exophase.com/epic/games/o/40jee88.png?hash=1"
        );
        assert_eq!(
            art_at_size("https://example.com/art.png", "l"),
            "https://example.com/art.png"
        );
        assert_eq!(art_at_size("", "l"), "");
    }

    #[test]
    fn a_summary_with_services_and_rank_parses() {
        let literal = r#"\u007B\u0022user_id\u0022\u003A315448,\u0022master_playerid\u0022\u003A2408683,\u0022displayname\u0022\u003A\u0022Efxlve\u0022,\u0022username\u0022\u003A\u0022Efxlve\u0022,\u0022rank_ww\u0022\u003A99643,\u0022lastsync\u0022\u003A1795175117,\u0022services\u0022\u003A\u005B\u007B\u0022environment_slug\u0022\u003A\u0022steam\u0022,\u0022environment_phrase\u0022\u003A\u0022Steam\u0022,\u0022gamesplayed\u0022\u003A126,\u0022total_awards\u0022\u003A1390,\u0022playtime\u0022\u003A\u00221687.06\u0022\u007D\u005D\u007D"#;
        let html = format!("<script>window.currentPlayerSummary = '{literal}';</script>");
        let summary = parse_summary(&html).expect("summary");
        assert_eq!(summary.user_id, "315448");
        assert_eq!(summary.player_id, "2408683");
        assert_eq!(summary.display_name, "Efxlve");
        assert_eq!(summary.rank, 99643);
        assert_eq!(summary.last_sync, 1795175117);
        assert_eq!(summary.services.len(), 1);
        assert_eq!(summary.services[0].slug, "steam");
        assert_eq!(summary.services[0].games, 126);
        assert_eq!(summary.services[0].playtime_minutes, 101_224);
    }

    #[test]
    fn the_summary_builds_totals_from_the_game_list() {
        let games = vec![
            ExophaseGame {
                master_id: 1,
                player_id: 1,
                title: "One".into(),
                platform_slug: "steam".into(),
                platform: "Steam".into(),
                percent: 100.0,
                earned_awards: 10,
                total_awards: 10,
                playtime_minutes: 60,
                last_played: 0,
                cover: String::new(),
                hero: String::new(),
                url: String::new(),
            },
            ExophaseGame {
                master_id: 2,
                player_id: 2,
                title: "Two".into(),
                platform_slug: "steam".into(),
                platform: "Steam".into(),
                percent: 50.0,
                earned_awards: 5,
                total_awards: 10,
                playtime_minutes: 90,
                last_played: 0,
                cover: String::new(),
                hero: String::new(),
                url: String::new(),
            },
        ];
        let summary = build_summary("123", &Input::PlayerId("123".into()), None, &games);
        assert_eq!(summary.total_games, 2);
        assert_eq!(summary.total_awards, 15);
        assert_eq!(summary.playtime_minutes, 150);
        assert_eq!(summary.completed_games, 1);
        assert_eq!(summary.services.len(), 1);
        assert_eq!(summary.services[0].games, 2);
    }
}
