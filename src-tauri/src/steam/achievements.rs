//! Steam achievements: the client's local stats first, Web API when a key exists.
//!
//! Owns unlock times, rarity tiers, and the per-game cache. Screenshots live
//! in `shots.rs`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use tauri::Emitter;

use super::catalog::{steam_get_api_key, strip_html};
use super::runtime::steam_install_path;
use super::users::active_steam_id;
use super::vdf::Vdf;

pub(super) fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

pub(super) fn transport_error(context: &str, error: reqwest::Error) -> String {
    format!("{context}: {}", error.without_url())
}

/* ---------- Achievements (opt-in, needs a Steam Web API key) ---------- */

use crate::legendary::models::{
    AchievementItem, AchievementRarity, AchievementTier, GameAchievementSummary,
    GameAchievementsResponse,
};

/// Unix seconds → `YYYY-MM-DD` (civil date, no date crate needed).
pub fn unix_date(seconds: i64) -> String {
    if seconds <= 0 {
        return String::new();
    }
    let days = seconds / 86_400;
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!("{year:04}-{month:02}-{day:02}")
}

/// Tier by global unlock rate: Steam has no fixed tiers, so rarity stands in.
pub(super) fn tier_for_percent(percent: f64) -> AchievementTier {
    let (name, hex) = if percent <= 5.0 {
        ("gold", "#d4a72c")
    } else if percent <= 25.0 {
        ("silver", "#a9adb7")
    } else {
        ("bronze", "#b07a4f")
    };
    AchievementTier {
        name: name.into(),
        hex_color: hex.into(),
        min: None,
        max: None,
    }
}

/// How long one game's achievement payload stays fresh.
pub(super) const ACHIEVEMENTS_TTL_SECS: u64 = 60 * 60;

pub(super) fn achievements_cache_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam")
        .join("achievements");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/* ---------- Local achievement cache (offline, no Web API key) ---------- */

/// Valve binary KeyValues (`KeyValues::ReadAsBinary`): `[type][key]\0[payload]`,
/// where type 0 opens a subtree that ends with type 8. Scalars are normalized
/// to strings so the text-VDF helpers (`get` / `as_str` / `entries`) work as is.
pub(super) fn parse_binary_vdf(data: &[u8]) -> Option<Vdf> {
    let mut pos = 0usize;
    Some(Vdf::Obj(read_binary_object(data, &mut pos)?))
}

pub(super) fn read_binary_cstring(data: &[u8], pos: &mut usize) -> Option<String> {
    let start = *pos;
    while *pos < data.len() && data[*pos] != 0 {
        *pos += 1;
    }
    if *pos >= data.len() {
        return None;
    }
    let text = String::from_utf8_lossy(&data[start..*pos]).into_owned();
    *pos += 1;
    Some(text)
}

pub(super) fn read_binary_object(data: &[u8], pos: &mut usize) -> Option<Vec<(String, Vdf)>> {
    let mut entries = Vec::new();
    loop {
        // A truncated file ends the current object instead of failing the parse.
        let Some(&tag) = data.get(*pos) else {
            return Some(entries);
        };
        *pos += 1;
        if tag == 8 {
            return Some(entries);
        }
        let key = read_binary_cstring(data, pos)?;
        let value = match tag {
            0 => Vdf::Obj(read_binary_object(data, pos)?),
            1 => Vdf::Str(read_binary_cstring(data, pos)?),
            2 => {
                let v = i32::from_le_bytes(data.get(*pos..*pos + 4)?.try_into().ok()?);
                *pos += 4;
                Vdf::Str(v.to_string())
            }
            3 => {
                let v = f32::from_le_bytes(data.get(*pos..*pos + 4)?.try_into().ok()?);
                *pos += 4;
                Vdf::Str(v.to_string())
            }
            4 | 6 => {
                let v = u32::from_le_bytes(data.get(*pos..*pos + 4)?.try_into().ok()?);
                *pos += 4;
                Vdf::Str(v.to_string())
            }
            5 => {
                let mut out = String::new();
                while *pos + 1 < data.len() {
                    let unit = u16::from_le_bytes([data[*pos], data[*pos + 1]]);
                    *pos += 2;
                    if unit == 0 {
                        break;
                    }
                    out.push(char::from_u32(u32::from(unit)).unwrap_or('?'));
                }
                Vdf::Str(out)
            }
            7 => {
                let v = u64::from_le_bytes(data.get(*pos..*pos + 8)?.try_into().ok()?);
                *pos += 8;
                Vdf::Str(v.to_string())
            }
            _ => return None,
        };
        entries.push((key, value));
    }
}

/// 32-bit account id the Steam client uses in `userdata` and stats file names.
pub(super) fn steam_account_id(steam: &Path) -> Option<u64> {
    let id64: u64 = active_steam_id(steam)?.parse().ok()?;
    Some(id64.saturating_sub(76_561_197_960_265_728))
}

pub(super) fn stats_dir(steam: &Path) -> PathBuf {
    steam.join("appcache").join("stats")
}

/// Public global unlock rates (no Web API key needed) → `name` → percent.
pub(super) fn parse_global_percentages(
    payload: &serde_json::Value,
) -> std::collections::HashMap<String, f64> {
    let mut out = std::collections::HashMap::new();
    let Some(items) = payload
        .get("achievementpercentages")
        .and_then(|p| p.get("achievements"))
        .and_then(|a| a.as_array())
    else {
        return out;
    };
    for entry in items {
        let Some(name) = entry.get("name").and_then(|v| v.as_str()) else {
            continue;
        };
        // Valve returns the rate as a number or as a string, depending on the app.
        let percent = entry.get("percent").and_then(|v| {
            v.as_f64()
                .or_else(|| v.as_str().and_then(|s| s.parse().ok()))
        });
        if let Some(percent) = percent {
            out.insert(name.to_string(), percent);
        }
    }
    out
}

/// Best-effort rarity for the local path: the endpoint is public but optional,
/// so a failure (offline, rate limit) simply leaves tiers unset.
pub(super) async fn fetch_global_percentages(
    app_id: &str,
) -> std::collections::HashMap<String, f64> {
    let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .user_agent("efxlve-launcher")
        .build()
    else {
        return std::collections::HashMap::new();
    };
    let url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid={app_id}"
    );
    let Ok(response) = client.get(&url).send().await else {
        return std::collections::HashMap::new();
    };
    let Ok(payload) = response.json::<serde_json::Value>().await else {
        return std::collections::HashMap::new();
    };
    parse_global_percentages(&payload)
}

/// Applies rarity/tier to an already-built achievement list.
pub(super) fn apply_rarity(
    response: &mut GameAchievementsResponse,
    percentages: &std::collections::HashMap<String, f64>,
) {
    for item in response
        .achievements
        .iter_mut()
        .chain(response.hidden.iter_mut())
    {
        if let Some(percent) = percentages.get(&item.name) {
            item.tier = Some(tier_for_percent(*percent));
            item.rarity = Some(AchievementRarity {
                percent: Some(*percent),
            });
        }
    }
}

/// Achievement icon file name → the community CDN URL the Web API path also uses.
pub(super) fn steam_icon_url(app_id: &str, file: &str) -> String {
    if file.is_empty() {
        String::new()
    } else {
        format!("https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{app_id}/{file}")
    }
}

/// `group:bit` → unlock time, straight from the client's stats file.
pub(super) fn read_unlock_times(
    steam: &Path,
    app_id: &str,
) -> std::collections::HashMap<String, i64> {
    let mut unlock_times = std::collections::HashMap::new();
    let Some(account) = steam_account_id(steam) else {
        return unlock_times;
    };
    let user_file = stats_dir(steam).join(format!("UserGameStats_{account}_{app_id}.bin"));
    let Ok(bytes) = std::fs::read(user_file) else {
        return unlock_times;
    };
    let Some(user) = parse_binary_vdf(&bytes) else {
        return unlock_times;
    };
    if let Some(cache) = user.get("cache") {
        for (group_id, group) in cache.entries() {
            if let Some(times) = group.get("AchievementTimes") {
                for (bit_id, time) in times.entries() {
                    let value = time
                        .as_str()
                        .and_then(|v| v.parse::<i64>().ok())
                        .unwrap_or(0);
                    unlock_times.insert(format!("{group_id}:{bit_id}"), value);
                }
            }
        }
    }
    unlock_times
}

/* ---------- Emulator achievements (RUNE, CODEX, Goldberg, etc.) ---------- */

#[derive(Debug, Clone, Default)]
pub struct EmulatorAchievementEntry {
    #[allow(dead_code)]
    pub key: String,
    pub achieved: bool,
    pub unlock_time: i64,
    pub cur_progress: f64,
    pub max_progress: f64,
}

#[derive(Debug, Clone, Default)]
pub struct ParsedEmulatorAchievements {
    /// Entries indexed by lowercased section/key name
    pub entries: std::collections::HashMap<String, EmulatorAchievementEntry>,
    /// Order mapping from [SteamAchievements] (e.g. 00000 = "1" or "ACH_NAME")
    pub order_mapping: Vec<String>,
    /// Unlocked count from [SteamAchievements] Count= if present
    pub count: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AchievementSourceConfig {
    /// "auto" | "custom" | "disabled"
    pub mode: String,
    pub custom_path: Option<String>,
    pub detected_path: Option<String>,
}

/// Parses scene/emulator `achievements.ini` (RUNE, CODEX, PLAZA, etc.).
pub fn parse_achievements_ini(text: &str) -> ParsedEmulatorAchievements {
    let mut parsed = ParsedEmulatorAchievements::default();
    let mut current_section = String::new();
    let mut current_entry = EmulatorAchievementEntry::default();

    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with(';') || line.starts_with('#') {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            if !current_section.is_empty() && !current_section.eq_ignore_ascii_case("SteamAchievements") {
                parsed.entries.insert(current_section.to_lowercase(), current_entry.clone());
            }
            current_section = line[1..line.len() - 1].trim().to_string();
            current_entry = EmulatorAchievementEntry {
                key: current_section.clone(),
                ..Default::default()
            };
            continue;
        }

        if let Some((k, v)) = line.split_once('=') {
            let key = k.trim();
            let val = v.trim();
            if current_section.eq_ignore_ascii_case("SteamAchievements") {
                if key.eq_ignore_ascii_case("Count") {
                    parsed.count = val.parse::<u32>().ok();
                } else {
                    parsed.order_mapping.push(val.to_string());
                }
            } else if key.eq_ignore_ascii_case("Achieved") {
                // RUNE writes 1, some builds write 1.000000 or true.
                current_entry.achieved = val.eq_ignore_ascii_case("true")
                    || val
                        .parse::<f64>()
                        .map(|value| value > 0.0)
                        .unwrap_or(false);
            } else if key.eq_ignore_ascii_case("UnlockTime") {
                current_entry.unlock_time = val.parse::<i64>().unwrap_or(0);
            } else if key.eq_ignore_ascii_case("CurProgress") {
                current_entry.cur_progress = val.parse::<f64>().unwrap_or(0.0);
            } else if key.eq_ignore_ascii_case("MaxProgress") {
                current_entry.max_progress = val.parse::<f64>().unwrap_or(0.0);
            }
        }
    }
    if !current_section.is_empty() && !current_section.eq_ignore_ascii_case("SteamAchievements") {
        parsed.entries.insert(current_section.to_lowercase(), current_entry);
    }
    parsed
}

/// Parses Goldberg emulator `achievements.json`.
pub fn parse_goldberg_achievements(text: &str) -> ParsedEmulatorAchievements {
    let mut parsed = ParsedEmulatorAchievements::default();
    let Ok(val) = serde_json::from_str::<serde_json::Value>(text) else {
        return parsed;
    };
    if let Some(map) = val.as_object() {
        for (k, v) in map {
            let earned = v.get("earned").and_then(|e| e.as_bool()).unwrap_or(false);
            let earned_time = v.get("earned_time").and_then(|t| t.as_i64()).unwrap_or(0);
            parsed.entries.insert(
                k.to_lowercase(),
                EmulatorAchievementEntry {
                    key: k.clone(),
                    achieved: earned,
                    unlock_time: earned_time,
                    cur_progress: 0.0,
                    max_progress: 0.0,
                },
            );
        }
    } else if let Some(arr) = val.as_array() {
        for item in arr {
            let name = item.get("name").and_then(|n| n.as_str()).unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let earned = item.get("earned").and_then(|e| e.as_bool()).unwrap_or(false);
            let earned_time = item.get("earned_time").and_then(|t| t.as_i64()).unwrap_or(0);
            parsed.entries.insert(
                name.to_lowercase(),
                EmulatorAchievementEntry {
                    key: name.to_string(),
                    achieved: earned,
                    unlock_time: earned_time,
                    cur_progress: 0.0,
                    max_progress: 0.0,
                },
            );
        }
    }
    parsed
}

/// Known root folders where scene emulators store achievement files on Windows.
pub fn candidate_emulator_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    // 1) C:\Users\Public\Documents\Steam
    let public_dir = std::env::var_os("PUBLIC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\Public"));
    let steam_pub = public_dir.join("Documents").join("Steam");
    if steam_pub.is_dir() {
        dirs.push(steam_pub.clone());
        if let Ok(entries) = std::fs::read_dir(&steam_pub) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    dirs.push(p);
                }
            }
        }
    }

    // 2) %APPDATA%
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(appdata.join("Goldberg SteamEmu Saves"));
        dirs.push(appdata.join("ALI213"));
        dirs.push(appdata.join("SmartSteamEmu"));
        dirs.push(appdata.join("FLT"));
    }

    dirs
}

/// Locates the achievements file for a Steam AppID.
pub fn find_emulator_achievement_file(app_id: &str, custom_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = custom_path {
        if p.is_file() {
            return Some(p.to_path_buf());
        }
        if p.is_dir() {
            for name in &["achievements.ini", "achievements.json", "stats.ini"] {
                let candidate = p.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
            let sub = p.join(app_id);
            for name in &["achievements.ini", "achievements.json", "stats.ini"] {
                let candidate = sub.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }

    for base in candidate_emulator_dirs() {
        let app_dir = base.join(app_id);
        for file_name in &["achievements.ini", "achievements.json", "stats.ini"] {
            let candidate = app_dir.join(file_name);
            if candidate.is_file() {
                return Some(candidate);
            }
            let candidate_settings = app_dir.join("steam_settings").join(file_name);
            if candidate_settings.is_file() {
                return Some(candidate_settings);
            }
        }
    }

    None
}

/// Matches schema item against emulator achievement entries.
fn is_emulator_unlocked(
    parsed: &ParsedEmulatorAchievements,
    api_name: &str,
    index: usize,
    bit_id: &str,
) -> Option<(bool, i64, f64)> {
    let api_lower = api_name.to_lowercase();
    let one_based = (index + 1).to_string();
    let zero_based = index.to_string();
    let bit_str = bit_id.to_string();

    // 1) Direct api_name match (e.g. [ACH_KILL_BOSS])
    if let Some(entry) = parsed.entries.get(&api_lower) {
        if entry.achieved || entry.unlock_time > 0 {
            let prog = if entry.max_progress > 0.0 {
                (entry.cur_progress / entry.max_progress).clamp(0.0, 1.0)
            } else {
                1.0
            };
            return Some((true, entry.unlock_time, prog));
        }
    }
    // 2) 1-based index match (e.g. [1] for 1st achievement in schema, as in RUNE)
    if let Some(entry) = parsed.entries.get(&one_based) {
        if entry.achieved || entry.unlock_time > 0 {
            let prog = if entry.max_progress > 0.0 {
                (entry.cur_progress / entry.max_progress).clamp(0.0, 1.0)
            } else {
                1.0
            };
            return Some((true, entry.unlock_time, prog));
        }
    }
    // 3) 0-based index match (e.g. [0])
    if let Some(entry) = parsed.entries.get(&zero_based) {
        if entry.achieved || entry.unlock_time > 0 {
            let prog = if entry.max_progress > 0.0 {
                (entry.cur_progress / entry.max_progress).clamp(0.0, 1.0)
            } else {
                1.0
            };
            return Some((true, entry.unlock_time, prog));
        }
    }
    // 4) bit_id match
    if let Some(entry) = parsed.entries.get(&bit_str) {
        if entry.achieved || entry.unlock_time > 0 {
            let prog = if entry.max_progress > 0.0 {
                (entry.cur_progress / entry.max_progress).clamp(0.0, 1.0)
            } else {
                1.0
            };
            return Some((true, entry.unlock_time, prog));
        }
    }
    // 5) Order mapping from [SteamAchievements]. The mapping only says which
    // entry belongs to which achievement; the entry itself still has to be
    // achieved, otherwise every mapped achievement (the whole set) was shown
    // as unlocked.
    for mapped in &parsed.order_mapping {
        let mapped_lower = mapped.to_lowercase();
        if mapped_lower == api_lower || mapped == &one_based || mapped == &zero_based || mapped == &bit_str {
            if let Some(entry) = parsed.entries.get(&mapped_lower) {
                if entry.achieved || entry.unlock_time > 0 {
                    let prog = if entry.max_progress > 0.0 {
                        (entry.cur_progress / entry.max_progress).clamp(0.0, 1.0)
                    } else {
                        1.0
                    };
                    return Some((true, entry.unlock_time, prog));
                }
            }
            return None;
        }
    }
    None
}

fn source_overrides_path(app: &tauri::AppHandle) -> PathBuf {
    achievements_cache_dir(app).join("source_overrides.json")
}

pub fn load_source_overrides(
    app: &tauri::AppHandle,
) -> std::collections::HashMap<String, AchievementSourceConfig> {
    let path = source_overrides_path(app);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_source_overrides(
    app: &tauri::AppHandle,
    overrides: &std::collections::HashMap<String, AchievementSourceConfig>,
) -> Result<(), String> {
    let path = source_overrides_path(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(overrides).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

pub fn get_achievement_source_config(
    app: &tauri::AppHandle,
    app_id: &str,
) -> AchievementSourceConfig {
    let overrides = load_source_overrides(app);
    let mut config = overrides.get(app_id).cloned().unwrap_or_default();
    if config.mode.is_empty() {
        config.mode = "auto".to_string();
    }
    let custom = config
        .custom_path
        .as_ref()
        .filter(|p| !p.trim().is_empty())
        .map(Path::new);
    config.detected_path = find_emulator_achievement_file(app_id, custom)
        .map(|p| p.to_string_lossy().to_string());
    config
}

/// Install folders the launcher has launched, keyed by Steam app id. Some
/// emulators keep `steam_settings/achievements.ini` next to the game exe, which
/// is not one of the global candidate roots.
static ACHIEVEMENT_DIRS: StdMutex<Option<std::collections::HashMap<String, PathBuf>>> =
    StdMutex::new(None);

pub fn remember_achievement_dir(app_id: &str, dir: &Path) {
    if app_id.is_empty() {
        return;
    }
    if let Ok(mut lock) = ACHIEVEMENT_DIRS.lock() {
        lock.get_or_insert_with(std::collections::HashMap::new)
            .insert(app_id.to_string(), dir.to_path_buf());
    }
}

pub fn read_emulator_achievements(
    app: Option<&tauri::AppHandle>,
    app_id: &str,
) -> Option<ParsedEmulatorAchievements> {
    let (custom_path, _mode) = match app {
        Some(handle) => {
            let cfg = get_achievement_source_config(handle, app_id);
            if cfg.mode == "disabled" {
                return None;
            }
            (cfg.custom_path, cfg.mode)
        }
        None => (None, "auto".to_string()),
    };

    let remembered = ACHIEVEMENT_DIRS
        .lock()
        .ok()
        .and_then(|lock| lock.as_ref().and_then(|map| map.get(app_id).cloned()));
    let custom_p = custom_path
        .as_deref()
        .map(Path::new)
        .or(remembered.as_deref());
    let file_path = find_emulator_achievement_file(app_id, custom_p)?;
    let content = std::fs::read_to_string(&file_path).ok()?;
    let parsed = if file_path.extension().and_then(|s| s.to_str()) == Some("json") {
        parse_goldberg_achievements(&content)
    } else {
        parse_achievements_ini(&content)
    };
    Some(parsed)
}

/* ---------- Public Steam Community schema (no API key) ---------- */

/// One achievement definition from the public Steam Community stats page.
/// Scene/emulator releases usually carry no Steam client schema, but the
/// community page publishes the same names, descriptions and icons.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunityAchievement {
    pub api_name: String,
    pub name: String,
    pub description: String,
    pub hidden: bool,
    pub icon_achieved: String,
    pub icon_unachieved: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommunitySchemaCache {
    fetched_at: u64,
    achievements: Vec<CommunityAchievement>,
}

/// Definitions change only with store metadata updates; a week is plenty.
const COMMUNITY_SCHEMA_TTL_SECS: u64 = 7 * 24 * 60 * 60;

/// Parses the achievement schema out of the SSR payload of
/// `steamcommunity.com/stats/<appid>/achievements`.
pub fn parse_community_schema(html: &str) -> Option<Vec<CommunityAchievement>> {
    let marker = html.find("id=\"valve-ssr-data\"")?;
    let open = marker + html[marker..].find('>')? + 1;
    let close = open + html[open..].find("</script>")?;
    let document: serde_json::Value = serde_json::from_str(&html[open..close]).ok()?;
    let query_data = document
        .get("renderContext")?
        .get("queryData")?
        .as_str()?;
    let queries: serde_json::Value = serde_json::from_str(query_data).ok()?;
    for query in queries.get("queries")?.as_array()? {
        let Some(data) = query.get("state").and_then(|state| state.get("data")) else {
            continue;
        };
        let Some(groups) = data.get("groups").and_then(|groups| groups.as_array()) else {
            continue;
        };
        let mut out = Vec::new();
        for group in groups {
            let Some(items) = group.get("achievements").and_then(|items| items.as_array()) else {
                continue;
            };
            for item in items {
                let api_name = item
                    .get("api_name")
                    .and_then(|value| value.as_str())
                    .unwrap_or("")
                    .trim();
                if api_name.is_empty() {
                    continue;
                }
                out.push(CommunityAchievement {
                    api_name: api_name.to_string(),
                    name: strip_html(
                        item.get("name").and_then(|value| value.as_str()).unwrap_or(""),
                    ),
                    description: strip_html(
                        item.get("description")
                            .and_then(|value| value.as_str())
                            .unwrap_or(""),
                    ),
                    hidden: item
                        .get("hidden")
                        .and_then(|value| value.as_bool())
                        .unwrap_or(false),
                    icon_achieved: item
                        .get("icon_achieved")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string(),
                    icon_unachieved: item
                        .get("icon_unachieved")
                        .and_then(|value| value.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    None
}

fn community_schema_cache_path(app: &tauri::AppHandle, app_id: &str) -> PathBuf {
    achievements_cache_dir(app).join(format!("community_{app_id}.json"))
}

fn read_community_schema_cache(
    app: &tauri::AppHandle,
    app_id: &str,
) -> Option<CommunitySchemaCache> {
    let text = std::fs::read_to_string(community_schema_cache_path(app, app_id)).ok()?;
    serde_json::from_str(&text).ok()
}

async fn fetch_community_schema(
    app: &tauri::AppHandle,
    app_id: &str,
    force: bool,
) -> Option<Vec<CommunityAchievement>> {
    let cached = read_community_schema_cache(app, app_id);
    if !force {
        if let Some(ref cached) = cached {
            if now_secs().saturating_sub(cached.fetched_at) < COMMUNITY_SCHEMA_TTL_SECS {
                return Some(cached.achievements.clone());
            }
        }
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("efxlve-launcher")
        .build()
        .ok()?;
    let url = format!("https://steamcommunity.com/stats/{app_id}/achievements?l=english");
    let fetched = match client.get(&url).send().await {
        Ok(response) if response.status().is_success() => match response.text().await {
            Ok(html) => parse_community_schema(&html),
            Err(_) => None,
        },
        _ => None,
    };

    match fetched {
        Some(achievements) => {
            let cache = CommunitySchemaCache {
                fetched_at: now_secs(),
                achievements: achievements.clone(),
            };
            if let Ok(text) = serde_json::to_string(&cache) {
                let _ = std::fs::write(community_schema_cache_path(app, app_id), text);
            }
            Some(achievements)
        }
        // Offline: a stale definition list is still better than no icons.
        None => cached.map(|cached| cached.achievements),
    }
}

/// Builds the achievement card directly from emulator state and the public
/// community definitions, without reading any Steam client file.
fn build_emulator_achievements(
    schema: &[CommunityAchievement],
    emu: &ParsedEmulatorAchievements,
) -> GameAchievementsResponse {
    let mut items: Vec<AchievementItem> = Vec::new();
    let mut hidden_items: Vec<AchievementItem> = Vec::new();
    for (index, entry) in schema.iter().enumerate() {
        let state = is_emulator_unlocked(emu, &entry.api_name, index, &index.to_string());
        let (unlocked, unlock_time, progress) = state.unwrap_or((false, 0, 0.0));
        let icon = if unlocked {
            &entry.icon_achieved
        } else {
            &entry.icon_unachieved
        };
        let item = AchievementItem {
            name: entry.api_name.clone(),
            display_name: entry.name.clone(),
            description: entry.description.clone(),
            unlocked,
            progress,
            unlock_date: if unlocked {
                Some(unix_date(unlock_time))
            } else {
                None
            },
            icon_link: if icon.is_empty() {
                entry.icon_achieved.clone()
            } else {
                icon.clone()
            },
            hidden: entry.hidden,
            is_base: true,
            ..Default::default()
        };
        if entry.hidden {
            hidden_items.push(item.clone());
        }
        items.push(item);
    }
    let total = items.len() as u32;
    let unlocked = items.iter().filter(|item| item.unlocked).count() as u32;
    GameAchievementsResponse {
        achievements: items,
        hidden: hidden_items,
        user_unlocked: unlocked,
        total_achievements: total,
        is_platinum: total > 0 && unlocked == total,
        supported: Some(total > 0),
        ..Default::default()
    }
}

/// Achievements straight from the Steam client's own cache:
/// `appcache/stats/UserGameStatsSchema_<app>.bin` (definitions, icons) and
/// `UserGameStats_<account>_<app>.bin` (unlock times) plus emulator achievements.
pub fn read_local_achievements_with_app(
    app: Option<&tauri::AppHandle>,
    steam: &Path,
    app_id: &str,
) -> Option<GameAchievementsResponse> {
    let schema_bytes =
        std::fs::read(stats_dir(steam).join(format!("UserGameStatsSchema_{app_id}.bin"))).ok()?;
    let schema = parse_binary_vdf(&schema_bytes)?;
    let stats = schema.get(app_id)?.get("stats")?;
    let unlock_times = read_unlock_times(steam, app_id);
    let emu_data = read_emulator_achievements(app, app_id);

    let mut groups: Vec<&(String, Vdf)> = stats.entries().iter().collect();
    groups.sort_by_key(|(id, _)| id.parse::<u32>().unwrap_or(u32::MAX));

    let mut items: Vec<AchievementItem> = Vec::new();
    let mut hidden_items: Vec<AchievementItem> = Vec::new();
    let mut ach_index = 0usize;

    for (group_id, group) in groups {
        let Some(bits) = group.get("bits") else {
            continue;
        };
        let mut bit_ids: Vec<&(String, Vdf)> = bits.entries().iter().collect();
        bit_ids.sort_by_key(|(id, _)| id.parse::<u32>().unwrap_or(u32::MAX));
        for (bit_id, bit) in bit_ids {
            let api_name = bit
                .get("name")
                .and_then(Vdf::as_str)
                .unwrap_or("")
                .to_string();
            if api_name.is_empty() {
                continue;
            }
            let display = bit.get("display");
            let display_name = display
                .and_then(|d| d.get("name"))
                .and_then(|n| n.get("english"))
                .and_then(Vdf::as_str)
                .unwrap_or(&api_name)
                .to_string();
            let description = display
                .and_then(|d| d.get("desc"))
                .and_then(|n| n.get("english"))
                .and_then(Vdf::as_str)
                .unwrap_or("")
                .to_string();
            let hidden = display
                .and_then(|d| d.get("hidden"))
                .and_then(Vdf::as_str)
                .map(|v| v != "0")
                .unwrap_or(false);

            let mut unlock_time = unlock_times
                .get(&format!("{group_id}:{bit_id}"))
                .copied()
                .unwrap_or(0);
            let mut cur_prog = if unlock_time > 0 { 1.0 } else { 0.0 };

            if unlock_time == 0 {
                if let Some(ref emu) = emu_data {
                    if let Some((unlocked, t, prog)) =
                        is_emulator_unlocked(emu, &api_name, ach_index, bit_id)
                    {
                        if unlocked {
                            unlock_time = if t > 0 { t } else { 1 };
                            cur_prog = prog;
                        }
                    }
                }
            }

            let unlocked = unlock_time > 0;
            let icon = display
                .and_then(|d| d.get("icon"))
                .and_then(Vdf::as_str)
                .unwrap_or("");
            let icon_gray = display
                .and_then(|d| d.get("icon_gray"))
                .and_then(Vdf::as_str)
                .unwrap_or("");
            let file = if unlocked && !icon.is_empty() {
                icon
            } else if !icon_gray.is_empty() {
                icon_gray
            } else {
                icon
            };
            let item = AchievementItem {
                name: api_name,
                display_name,
                description,
                unlocked,
                progress: cur_prog,
                unlock_date: if unlocked {
                    Some(unix_date(unlock_time))
                } else {
                    None
                },
                icon_link: steam_icon_url(app_id, file),
                hidden,
                // The local schema does not mark base/DLC groups; Steam
                // achievements are presented as one base-game set.
                is_base: true,
                ..Default::default()
            };
            if hidden {
                hidden_items.push(item.clone());
            }
            items.push(item);
            ach_index += 1;
        }
    }
    if items.is_empty() {
        return None;
    }

    let total = items.len() as u32;
    let unlocked = items.iter().filter(|i| i.unlocked).count() as u32;
    Some(GameAchievementsResponse {
        achievements: items,
        hidden: hidden_items,
        user_unlocked: unlocked,
        total_achievements: total,
        // Steam has no platinum trophy: a full set counts as the completed state.
        is_platinum: unlocked == total && total > 0,
        supported: Some(true),
        ..Default::default()
    })
}

/// Achievements straight from the Steam client's own cache:
/// `appcache/stats/UserGameStatsSchema_<app>.bin` (definitions, icons) and
/// `UserGameStats_<account>_<app>.bin` (unlock times). Works offline, needs no
/// Web API key and no public profile; `None` when the client has no schema.
#[allow(dead_code)]
pub fn read_local_achievements(steam: &Path, app_id: &str) -> Option<GameAchievementsResponse> {
    read_local_achievements_with_app(None, steam, app_id)
}

/// Unlocked/total counts for every game the client keeps stats for.
///
/// The total comes from the schema's bit definitions: the stats file's
/// `AchievementTimes` only holds entries that have a recorded time and can even
/// carry leftovers from a predecessor app (CS:GO bits under CS2), so using it
/// as the total made every game look 100% complete.
pub(super) fn read_local_achievement_totals(steam: &Path) -> Vec<(String, u32, u32)> {
    let Ok(entries) = std::fs::read_dir(stats_dir(steam)) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut seen_apps = std::collections::HashSet::new();

    // Pass 1: games with user stats
    if let Some(account) = steam_account_id(steam) {
        let prefix = format!("UserGameStats_{account}_");
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(rest) = name.strip_prefix(&prefix) else {
                continue;
            };
            let Some(app_id) = rest.strip_suffix(".bin") else {
                continue;
            };
            if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            seen_apps.insert(app_id.to_string());
            let Ok(schema_bytes) =
                std::fs::read(stats_dir(steam).join(format!("UserGameStatsSchema_{app_id}.bin")))
            else {
                continue;
            };
            let Some(schema) = parse_binary_vdf(&schema_bytes) else {
                continue;
            };
            let Some(stats) = schema.get(app_id).and_then(|app| app.get("stats")) else {
                continue;
            };
            let unlock_times = read_unlock_times(steam, app_id);
            let emu_data = read_emulator_achievements(None, app_id);

            let (mut total, mut unlocked) = (0u32, 0u32);
            let mut ach_idx = 0usize;
            for (group_id, group) in stats.entries() {
                let Some(bits) = group.get("bits") else {
                    continue;
                };
                for (bit_id, bit) in bits.entries() {
                    total += 1;
                    let bit_unlocked = unlock_times
                        .get(&format!("{group_id}:{bit_id}"))
                        .map(|time| *time > 0)
                        .unwrap_or(false);
                    if bit_unlocked {
                        unlocked += 1;
                    } else if let Some(ref emu) = emu_data {
                        let api_name = bit.get("name").and_then(Vdf::as_str).unwrap_or("");
                        if let Some((u, _, _)) = is_emulator_unlocked(emu, api_name, ach_idx, bit_id) {
                            if u {
                                unlocked += 1;
                            }
                        }
                    }
                    ach_idx += 1;
                }
            }
            if total > 0 {
                out.push((app_id.to_string(), unlocked, total));
            }
        }
    }

    // Pass 2: games with schemas only (e.g. LuaTools, games without client stats)
    if let Ok(schema_entries) = std::fs::read_dir(stats_dir(steam)) {
        for entry in schema_entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            let Some(rest) = name.strip_prefix("UserGameStatsSchema_") else {
                continue;
            };
            let Some(app_id) = rest.strip_suffix(".bin") else {
                continue;
            };
            if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) || seen_apps.contains(app_id) {
                continue;
            }
            let emu_data = read_emulator_achievements(None, app_id);
            let Ok(schema_bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            let Some(schema) = parse_binary_vdf(&schema_bytes) else {
                continue;
            };
            let Some(stats) = schema.get(app_id).and_then(|app| app.get("stats")) else {
                continue;
            };

            let (mut total, mut unlocked) = (0u32, 0u32);
            let mut ach_idx = 0usize;
            for (_group_id, group) in stats.entries() {
                let Some(bits) = group.get("bits") else {
                    continue;
                };
                for (bit_id, bit) in bits.entries() {
                    total += 1;
                    if let Some(ref emu) = emu_data {
                        let api_name = bit.get("name").and_then(Vdf::as_str).unwrap_or("");
                        if let Some((u, _, _)) = is_emulator_unlocked(emu, api_name, ach_idx, bit_id) {
                            if u {
                                unlocked += 1;
                            }
                        }
                    }
                    ach_idx += 1;
                }
            }
            if total > 0 {
                out.push((app_id.to_string(), unlocked, total));
            }
        }
    }

    out
}

#[derive(Serialize, Deserialize)]
pub(super) struct CachedAchievements {
    fetched_at: u64,
    response: GameAchievementsResponse,
}

/// Achievements for one Steam game. Read from the Steam client's own cache
/// first (offline, no key); the optional Web API key still answers for games
/// whose local schema is missing.
#[tauri::command]
pub async fn steam_get_achievements(
    app: tauri::AppHandle,
    app_id: String,
    force: Option<bool>,
) -> Result<GameAchievementsResponse, String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let cache = achievements_cache_dir(&app).join(format!("{app_id}.json"));
    if force != Some(true) {
        if let Ok(text) = std::fs::read_to_string(&cache) {
            if let Ok(cached) = serde_json::from_str::<CachedAchievements>(&text) {
                if now_secs().saturating_sub(cached.fetched_at) < ACHIEVEMENTS_TTL_SECS {
                    return Ok(cached.response);
                }
            }
        }
    }

    // 1) The Steam client's own cache: instant, offline, no key, no rate limit.
    if let Some(mut response) =
        steam_install_path().and_then(|path| read_local_achievements_with_app(Some(&app), &path, &app_id))
    {
        // Global unlock rates are public, so even the local path gets rarity.
        let percentages = fetch_global_percentages(&app_id).await;
        if !percentages.is_empty() {
            apply_rarity(&mut response, &percentages);
        }
        let cached = CachedAchievements {
            fetched_at: now_secs(),
            response: response.clone(),
        };
        if let Ok(text) = serde_json::to_string(&cached) {
            let _ = std::fs::write(&cache, text);
        }
        return Ok(response);
    }

    // 2) Web API fallback (adds global rarity) when no local schema exists.
    let key = steam_get_api_key(app.clone())
        .ok_or("Steam has no local achievement data for this game and no Web API key is set")?;
    let steam_path = steam_install_path().ok_or("Steam is not installed")?;
    let steam_id = active_steam_id(&steam_path).ok_or("Steam account could not be read")?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(12))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|e| e.to_string())?;

    // 1) Schema: display names, descriptions and icons.
    let schema_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key={key}&appid={app_id}&l=english"
    );
    let schema: serde_json::Value = client
        .get(&schema_url)
        .send()
        .await
        .map_err(|e| transport_error("Steam could not be reached", e))?
        .json()
        .await
        .map_err(|e| transport_error("Steam answered with an unexpected payload", e))?;
    let entries = schema
        .get("game")
        .and_then(|g| g.get("availableGameStats"))
        .and_then(|s| s.get("achievements"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();
    if entries.is_empty() {
        return Ok(GameAchievementsResponse {
            supported: Some(false),
            ..Default::default()
        });
    }

    // 2) The player's own unlocks.
    let player_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key={key}&steamid={steam_id}&appid={app_id}&l=english"
    );
    let player: serde_json::Value = client
        .get(&player_url)
        .send()
        .await
        .map_err(|e| transport_error("Steam could not be reached", e))?
        .json()
        .await
        .map_err(|e| transport_error("Steam answered with an unexpected payload", e))?;
    let stats = player.get("playerstats");
    if stats
        .and_then(|s| s.get("success"))
        .and_then(|v| v.as_bool())
        != Some(true)
    {
        return Err(
            "Steam does not share this profile's achievements; make the profile public".into(),
        );
    }
    let player_items = stats
        .and_then(|s| s.get("achievements"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();

    // 3) Global unlock rates for rarity (no key required, best effort).
    let percent_url = format!(
        "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid={app_id}"
    );
    let percentages = match client.get(&percent_url).send().await {
        Ok(response) => response
            .json::<serde_json::Value>()
            .await
            .unwrap_or(serde_json::Value::Null),
        Err(_) => serde_json::Value::Null,
    };
    let percent_items = percentages
        .get("achievementpercentages")
        .and_then(|p| p.get("achievements"))
        .and_then(|a| a.as_array())
        .cloned()
        .unwrap_or_default();

    let mut items: Vec<AchievementItem> = Vec::new();
    let mut hidden_items: Vec<AchievementItem> = Vec::new();
    let mut unlocked = 0u32;
    for entry in &entries {
        let api_name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
        if api_name.is_empty() {
            continue;
        }
        let player_entry = player_items
            .iter()
            .find(|p| p.get("apiname").and_then(|v| v.as_str()) == Some(api_name));
        let achieved = player_entry
            .and_then(|p| p.get("achieved"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0)
            == 1;
        let unlock_time = player_entry
            .and_then(|p| p.get("unlocktime"))
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        if achieved {
            unlocked += 1;
        }
        let percent = percent_items
            .iter()
            .find(|p| p.get("name").and_then(|v| v.as_str()) == Some(api_name))
            .and_then(|p| p.get("percent"))
            .and_then(|v| v.as_f64());
        let icon = entry.get("icon").and_then(|v| v.as_str()).unwrap_or("");
        let icon_gray = entry.get("icongray").and_then(|v| v.as_str()).unwrap_or("");
        let file = if achieved && !icon.is_empty() {
            icon
        } else if !icon_gray.is_empty() {
            icon_gray
        } else {
            icon
        };
        let hidden_flag = entry.get("hidden").and_then(|v| v.as_i64()).unwrap_or(0) == 1;
        let item = AchievementItem {
            name: api_name.to_string(),
            display_name: entry
                .get("displayName")
                .and_then(|v| v.as_str())
                .unwrap_or(api_name)
                .to_string(),
            description: entry
                .get("description")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            unlocked: achieved,
            progress: if achieved { 1.0 } else { 0.0 },
            unlock_date: if achieved {
                Some(unix_date(unlock_time))
            } else {
                None
            },
            icon_link: if file.is_empty() {
                String::new()
            } else {
                format!("https://cdn.cloudflare.steamstatic.com/steamcommunity/public/images/apps/{app_id}/{file}")
            },
            tier: percent.map(tier_for_percent),
            rarity: percent.map(|p| AchievementRarity { percent: Some(p) }),
            hidden: hidden_flag,
            // The Web API does not mark base/DLC groups either.
            is_base: true,
            ..Default::default()
        };
        if hidden_flag {
            hidden_items.push(item.clone());
        }
        items.push(item);
    }

    let total = items.len() as u32;
    let response = GameAchievementsResponse {
        achievements: items,
        hidden: hidden_items,
        user_unlocked: unlocked,
        total_achievements: total,
        // Steam has no platinum trophy: a full set counts as the completed state.
        is_platinum: total > 0 && unlocked == total,
        supported: Some(true),
        ..Default::default()
    };
    let cached = CachedAchievements {
        fetched_at: now_secs(),
        response: response.clone(),
    };
    if let Ok(text) = serde_json::to_string(&cached) {
        let _ = std::fs::write(&cache, text);
    }
    Ok(response)
}

/// Achievements for a custom/emulator-owned title: definitions come from the
/// public Steam Community page (no API key, no Steam client), unlocks come from
/// the scene/emulator `achievements.ini`/`.json` file on this PC.
#[tauri::command]
pub async fn steam_get_emulator_achievements(
    app: tauri::AppHandle,
    app_id: String,
    force: Option<bool>,
    install_dir: Option<String>,
) -> Result<GameAchievementsResponse, String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    if let Some(dir) = install_dir.filter(|dir| !dir.trim().is_empty()) {
        let path = Path::new(dir.trim());
        let root = if path.is_file() {
            path.parent().unwrap_or(path)
        } else {
            path
        };
        remember_achievement_dir(&app_id, root);
    }
    let config = get_achievement_source_config(&app, &app_id);
    // "Disabled" means emulator files are ignored, not that the game has no
    // achievements at all: the Steam client's own stats still count.
    if config.mode == "disabled" {
        if let Some(local) = steam_install_path().and_then(|steam| {
            read_local_achievements_with_app(Some(&app), &steam, &app_id)
        }) {
            return Ok(local);
        }
    }

    let community = fetch_community_schema(&app, &app_id, force == Some(true)).await;
    let emu = read_emulator_achievements(Some(&app), &app_id);
    let mut response = match (community, emu) {
        (Some(schema), Some(emu)) => build_emulator_achievements(&schema, &emu),
        (Some(schema), None) => build_emulator_achievements(&schema, &Default::default()),
        // No community answer (offline first run): the Steam client schema is
        // still a useful definition source when the game also exists on Steam.
        (None, _) => steam_install_path()
            .and_then(|steam| read_local_achievements_with_app(Some(&app), &steam, &app_id))
            .unwrap_or_else(|| GameAchievementsResponse {
                supported: Some(false),
                ..Default::default()
            }),
    };

    if response.total_achievements > 0 {
        let percentages = fetch_global_percentages(&app_id).await;
        apply_rarity(&mut response, &percentages);
    }
    Ok(response)
}

/// How long the local totals scan stays fresh (parsing 150+ schemas is I/O heavy).
pub(super) const ACH_TOTALS_TTL_SECS: u64 = 30 * 60;

#[derive(Serialize, Deserialize)]
pub(super) struct CachedTotals {
    fetched_at: u64,
    totals: Vec<(String, u32, u32)>,
}

pub(super) fn totals_cache_path(app: &tauri::AppHandle) -> PathBuf {
    achievements_cache_dir(app).with_file_name("achievement_totals.json")
}

/// Achievement summaries for the library covers: the per-game disk cache plus
/// the Steam client's own stats files (offline, no network, no key).
#[tauri::command]
pub async fn steam_get_achievements_summary(
    app: tauri::AppHandle,
) -> std::collections::HashMap<String, GameAchievementSummary> {
    // Directory scans plus JSON parses: keep the main thread free.
    tokio::task::spawn_blocking(move || steam_achievements_summary_for(&app))
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn steam_get_achievement_source(
    app: tauri::AppHandle,
    app_id: String,
) -> AchievementSourceConfig {
    get_achievement_source_config(&app, &app_id)
}

#[tauri::command]
pub fn steam_set_achievement_source(
    app: tauri::AppHandle,
    app_id: String,
    mode: String,
    custom_path: Option<String>,
) -> Result<(), String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let mut overrides = load_source_overrides(&app);
    let mut config = overrides.get(&app_id).cloned().unwrap_or_default();
    config.mode = mode;
    config.custom_path = custom_path.filter(|p| !p.trim().is_empty());
    overrides.insert(app_id.clone(), config);
    save_source_overrides(&app, &overrides)?;

    // Evict per-game achievement cache so next reload gets fresh data
    let cache = achievements_cache_dir(&app).join(format!("{app_id}.json"));
    let _ = std::fs::remove_file(cache);

    // Evict totals cache so summary updates
    let totals_cache = totals_cache_path(&app);
    let _ = std::fs::remove_file(totals_cache);

    Ok(())
}

#[tauri::command]
pub fn steam_detect_achievement_path(app_id: String) -> Option<String> {
    find_emulator_achievement_file(&app_id, None).map(|p| p.to_string_lossy().to_string())
}

static ACTIVE_WATCHERS: StdMutex<Option<std::collections::HashMap<String, Arc<AtomicBool>>>> = StdMutex::new(None);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementUnlockedPayload {
    pub app_id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub icon_url: String,
}

#[cfg(windows)]
#[link(name = "user32")]
extern "system" {
    fn MessageBeep(uType: u32) -> i32;
}

/// One achievement snapshot for the live watcher: the Steam client's own stats
/// when available, otherwise the emulator file plus the public definition list.
fn watcher_snapshot(
    app: &tauri::AppHandle,
    app_id: &str,
    steam: Option<&Path>,
    community: Option<&[CommunityAchievement]>,
    emulator_only: bool,
) -> Option<GameAchievementsResponse> {
    if !emulator_only {
        if let Some(steam) = steam {
            if let Some(response) = read_local_achievements_with_app(Some(app), steam, app_id) {
                return Some(response);
            }
        }
    }
    let emu = read_emulator_achievements(Some(app), app_id)?;
    community.map(|schema| build_emulator_achievements(schema, &emu))
}

/// Starts the watch for a Steam client game.
#[tauri::command]
pub fn steam_start_achievement_watcher(app: tauri::AppHandle, app_id: String) {
    start_achievement_watcher(app, app_id, false);
}

/// Starts the watch for a custom game: the emulator file is the truth, even
/// when the same AppID also has Steam client stats on this PC.
pub fn steam_start_custom_achievement_watcher(app: tauri::AppHandle, app_id: String) {
    // "Disabled (Steam client only)" must fall back to the client watcher.
    let emulator_only = get_achievement_source_config(&app, &app_id).mode != "disabled";
    start_achievement_watcher(app, app_id, emulator_only);
}

fn start_achievement_watcher(app: tauri::AppHandle, app_id: String, emulator_only: bool) {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return;
    }

    let mut lock = ACTIVE_WATCHERS.lock().unwrap();
    let map = lock.get_or_insert_with(std::collections::HashMap::new);

    if let Some(flag) = map.get(&app_id) {
        flag.store(false, Ordering::SeqCst);
    }

    let running_flag = Arc::new(AtomicBool::new(true));
    map.insert(app_id.clone(), running_flag.clone());

    let app_handle = app.clone();
    let target_app_id = app_id.clone();

    std::thread::spawn(move || {
        let steam = steam_install_path();
        let local_snapshot = if emulator_only {
            None
        } else {
            steam.as_deref().and_then(|path| {
                read_local_achievements_with_app(Some(&app_handle), path, &target_app_id)
            })
        };
        // A custom game usually has no Steam client schema. Only ask the public
        // page when the local snapshot is missing; the answer is cached on disk.
        let community = if local_snapshot.is_none() {
            tauri::async_runtime::block_on(fetch_community_schema(
                &app_handle,
                &target_app_id,
                false,
            ))
        } else {
            None
        };

        let initial = local_snapshot.or_else(|| {
            watcher_snapshot(
                &app_handle,
                &target_app_id,
                steam.as_deref(),
                community.as_deref(),
                emulator_only,
            )
        });
        let mut initialised = initial.is_some();
        let mut unlocked_set: std::collections::HashSet<String> = initial
            .map(|response| {
                response
                    .achievements
                    .into_iter()
                    .filter(|ach| ach.unlocked)
                    .map(|ach| ach.name)
                    .collect()
            })
            .unwrap_or_default();

        while running_flag.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(1500));
            if !running_flag.load(Ordering::Relaxed) {
                break;
            }

            let Some(response) = watcher_snapshot(
                &app_handle,
                &target_app_id,
                steam.as_deref(),
                community.as_deref(),
                emulator_only,
            ) else {
                continue;
            };
            // The first successful read is the baseline, not a burst of old unlocks.
            if !initialised {
                for ach in response.achievements {
                    if ach.unlocked {
                        unlocked_set.insert(ach.name);
                    }
                }
                initialised = true;
                continue;
            }
            for ach in response.achievements {
                if ach.unlocked && !unlocked_set.contains(&ach.name) {
                    unlocked_set.insert(ach.name.clone());

                    // 1. Native in-game HUD toast card
                    let display = if ach.display_name.trim().is_empty() {
                        ach.name.clone()
                    } else {
                        ach.display_name.clone()
                    };
                    let title_text = format!("🏆 {display}");
                    crate::overlay::hud::notify(&title_text, &ach.description);

                    // 2. Play Windows notification sound
                    #[cfg(windows)]
                    unsafe {
                        MessageBeep(0x00000040); // MB_ICONASTERISK
                    }

                    // 3. Emit event to frontend
                    let payload = AchievementUnlockedPayload {
                        app_id: target_app_id.clone(),
                        name: ach.name,
                        display_name: display,
                        description: ach.description,
                        icon_url: ach.icon_link,
                    };
                    let _ = app_handle.emit("achievement-unlocked", payload);
                }
            }
        }
    });
}

#[tauri::command]
pub fn steam_stop_achievement_watcher(app_id: String) {
    if let Ok(mut lock) = ACTIVE_WATCHERS.lock() {
        if let Some(map) = lock.as_mut() {
            if let Some(flag) = map.remove(&app_id) {
                flag.store(false, Ordering::SeqCst);
            }
        }
    }
}


fn steam_achievements_summary_for(
    app: &tauri::AppHandle,
) -> std::collections::HashMap<String, GameAchievementSummary> {
    let mut out = std::collections::HashMap::new();
    if let Ok(entries) = std::fs::read_dir(achievements_cache_dir(&app)) {
        for entry in entries.flatten() {
            let path = entry.path();
            let app_id = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            let Ok(cached) = serde_json::from_str::<CachedAchievements>(&text) else {
                continue;
            };
            let response = cached.response;
            if response.total_achievements == 0 {
                continue;
            }
            let summary = GameAchievementSummary {
                app_name: format!("steam::{app_id}"),
                user_unlocked: response.user_unlocked,
                total_achievements: response.total_achievements,
                is_platinum: response.is_platinum,
                supported: true,
                ..Default::default()
            };
            out.insert(format!("steam::{app_id}"), summary);
        }
    }

    // The client's stats files cover games whose page was never opened; the
    // cache above wins when both exist.
    let cache_path = totals_cache_path(&app);
    let cached = std::fs::read_to_string(&cache_path)
        .ok()
        .and_then(|text| serde_json::from_str::<CachedTotals>(&text).ok())
        .filter(|cached| now_secs().saturating_sub(cached.fetched_at) < ACH_TOTALS_TTL_SECS);
    let totals = match cached {
        Some(cached) => cached.totals,
        None => match steam_install_path() {
            Some(steam) => {
                let totals = read_local_achievement_totals(&steam);
                let fresh = CachedTotals {
                    fetched_at: now_secs(),
                    totals: totals.clone(),
                };
                if let Ok(text) = serde_json::to_string(&fresh) {
                    let _ = std::fs::write(&cache_path, text);
                }
                totals
            }
            None => Vec::new(),
        },
    };
    for (app_id, unlocked, total) in totals {
        let key = format!("steam::{app_id}");
        if out.contains_key(&key) {
            continue;
        }
        out.insert(
            key.clone(),
            GameAchievementSummary {
                app_name: key,
                user_unlocked: unlocked,
                total_achievements: total,
                is_platinum: unlocked == total,
                supported: true,
                ..Default::default()
            },
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::legendary::models::{AchievementItem, GameAchievementsResponse};
    use super::super::runtime::steam_install_path;


    #[test]
    fn global_percentages_apply_rarity_to_local_achievements() {
        let payload = serde_json::json!({
            "achievementpercentages": {
                "achievements": [
                    { "name": "AC_1", "percent": 3.5 },
                    { "name": "AC_2", "percent": "40.0" }
                ]
            }
        });
        let percentages = parse_global_percentages(&payload);
        assert_eq!(percentages.get("AC_1"), Some(&3.5));
        assert_eq!(percentages.get("AC_2"), Some(&40.0));

        let mut response = GameAchievementsResponse {
            achievements: vec![
                AchievementItem {
                    name: "AC_1".into(),
                    ..Default::default()
                },
                AchievementItem {
                    name: "AC_2".into(),
                    ..Default::default()
                },
                AchievementItem {
                    name: "AC_3".into(),
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        apply_rarity(&mut response, &percentages);
        assert_eq!(
            response.achievements[0]
                .tier
                .as_ref()
                .map(|t| t.name.as_str()),
            Some("gold")
        );
        assert_eq!(
            response.achievements[1]
                .tier
                .as_ref()
                .map(|t| t.name.as_str()),
            Some("bronze")
        );
        assert_eq!(
            response.achievements[1]
                .rarity
                .as_ref()
                .and_then(|r| r.percent),
            Some(40.0)
        );
        assert!(response.achievements[2].tier.is_none());
    }
    #[test]
    fn community_schema_reads_public_page_payload() {
        let query = serde_json::json!({
            "queries": [
                { "state": { "data": null } },
                { "state": { "data": { "groups": [
                    { "achievements": [
                        {
                            "api_name": "ACH_ONE",
                            "name": "First &amp; Best",
                            "description": "Finish it.",
                            "hidden": false,
                            "icon_achieved": "https://cdn/one.jpg",
                            "icon_unachieved": "https://cdn/one_bw.jpg"
                        }
                    ] }
                ] } } }
            ]
        });
        let document = serde_json::json!({
            "renderContext": { "queryData": query.to_string() }
        });
        let html = format!(
            "<html><script type=\"application/json\" id=\"valve-ssr-data\" nonce=\"x\">{}</script></html>",
            document
        );
        let parsed = parse_community_schema(&html).expect("schema parsed");
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].api_name, "ACH_ONE");
        assert_eq!(parsed[0].name, "First & Best");
        assert_eq!(parsed[0].description, "Finish it.");
        assert_eq!(parsed[0].icon_achieved, "https://cdn/one.jpg");
    }

    #[tokio::test]
    #[ignore]
    async fn live_community_schema_page() {
        let client = reqwest::Client::builder()
            .user_agent("efxlve-launcher")
            .build()
            .expect("client");
        let html = client
            .get("https://steamcommunity.com/stats/220/achievements?l=english")
            .send()
            .await
            .expect("response")
            .text()
            .await
            .expect("html");
        let parsed = parse_community_schema(&html).expect("schema");
        assert!(parsed.len() > 10);
        assert!(parsed
            .iter()
            .any(|achievement| achievement.api_name == "HL2_HIT_CANCOP_WITHCAN"));
    }

    #[test]
    fn emulator_schema_merges_local_unlocks() {
        let schema = vec![CommunityAchievement {
            api_name: "ACH_ONE".into(),
            name: "First".into(),
            description: "Do the thing.".into(),
            hidden: false,
            icon_achieved: "on.jpg".into(),
            icon_unachieved: "off.jpg".into(),
        }];
        let emu = parse_achievements_ini("[ACH_ONE]\nAchieved=1\nUnlockTime=1700000000\n");
        let response = build_emulator_achievements(&schema, &emu);
        assert_eq!(response.total_achievements, 1);
        assert_eq!(response.user_unlocked, 1);
        assert!(response.achievements[0].unlocked);
        assert_eq!(response.achievements[0].display_name, "First");
        assert_eq!(response.achievements[0].icon_link, "on.jpg");
        assert_eq!(response.achievements[0].unlock_date.as_deref(), Some("2023-11-14"));
    }

    #[test]
    fn emulator_ini_accepts_float_achieved_values() {
        let parsed = parse_achievements_ini("[ACH_ONE]\nAchieved=1.000000\nUnlockTime=1700000000\n");
        assert_eq!(
            is_emulator_unlocked(&parsed, "ACH_ONE", 0, "0"),
            Some((true, 1_700_000_000, 1.0))
        );
    }

    #[test]
    fn order_mapping_only_unlocks_achieved_entries() {
        let locked = parse_achievements_ini(
            "[SteamAchievements]\n0=ACH_ONE\n[ACH_ONE]\nAchieved=0\nUnlockTime=0\n",
        );
        assert_eq!(is_emulator_unlocked(&locked, "ACH_ONE", 0, "0"), None);

        let unlocked = parse_achievements_ini(
            "[SteamAchievements]\n0=ACH_ONE\n[ACH_ONE]\nAchieved=1\nUnlockTime=1700000000\n",
        );
        assert_eq!(
            is_emulator_unlocked(&unlocked, "ACH_ONE", 0, "0"),
            Some((true, 1_700_000_000, 1.0))
        );
    }

    #[test]
    fn unix_seconds_become_civil_dates() {
        assert_eq!(unix_date(0), "");
        assert_eq!(unix_date(1_700_000_000), "2023-11-14");
        assert_eq!(unix_date(1_600_000_000), "2020-09-13");
    }
    #[test]
    fn tiers_follow_the_global_unlock_rate() {
        assert_eq!(tier_for_percent(1.5).name, "gold");
        assert_eq!(tier_for_percent(12.0).name, "silver");
        assert_eq!(tier_for_percent(60.0).name, "bronze");
    }
    /// Live check for the SteamID and the achievement pipeline (needs the key).
    /// Run: `cargo test live_steam_achievements -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_steam_achievements() {
        let Some(path) = steam_install_path() else {
            println!("Steam is not installed on this machine");
            return;
        };
        println!("active steam id: {:?}", active_steam_id(&path));
    }
    #[test]
    fn binary_vdf_reads_nested_objects_and_scalars() {
        // Valve KeyValues binary: [type][key]\0[payload]; 0 = subtree, 8 = end.
        let mut data: Vec<u8> = Vec::new();
        data.push(0);
        data.extend_from_slice(b"319630\0");
        data.push(0);
        data.extend_from_slice(b"stats\0");
        data.push(0);
        data.extend_from_slice(b"1\0");
        data.push(0);
        data.extend_from_slice(b"bits\0");
        data.push(0);
        data.extend_from_slice(b"0\0");
        data.push(1); // string
        data.extend_from_slice(b"name\0");
        data.extend_from_slice(b"AC_1\0");
        data.push(2); // int32
        data.extend_from_slice(b"hidden\0");
        data.extend_from_slice(&1i32.to_le_bytes());
        data.push(8); // end bits
        data.push(8); // end group 1
        data.push(8); // end stats
        data.push(8); // end 319630
        data.push(8); // end root object

        let root = parse_binary_vdf(&data).expect("parsed");
        let bit = root
            .get("319630")
            .and_then(|app| app.get("stats"))
            .and_then(|stats| stats.get("1"))
            .and_then(|group| group.get("bits"))
            .and_then(|bits| bits.get("0"))
            .expect("achievement bit");
        assert_eq!(bit.get("name").and_then(Vdf::as_str), Some("AC_1"));
        assert_eq!(bit.get("hidden").and_then(Vdf::as_str), Some("1"));
        assert!(parse_binary_vdf(b"garbage").is_none());
        assert!(parse_binary_vdf(&[0, 1, 2]).is_none());
    }
    /// Live check of the local achievement cache (needs the Steam client).
    /// Run: `cargo test live_steam_local_achievements -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_steam_local_achievements() {
        let Some(steam) = steam_install_path() else {
            println!("Steam is not installed on this machine");
            return;
        };
        println!("steam: {}", steam.display());
        match read_local_achievements(&steam, "319630") {
            Some(response) => println!(
                "319630 (Life is Strange): {}/{} unlocked",
                response.user_unlocked, response.total_achievements
            ),
            None => println!("319630: no local schema"),
        }
        let started = std::time::Instant::now();
        let totals = read_local_achievement_totals(&steam);
        println!(
            "games with local achievement stats: {} in {} ms",
            totals.len(),
            started.elapsed().as_millis()
        );
        for app in ["730", "1240440", "319630", "620", "1097150", "227300"] {
            if let Some((_, unlocked, total)) = totals.iter().find(|(id, _, _)| id == app) {
                println!("  {app}: {unlocked}/{total}");
            }
        }
    }
}
