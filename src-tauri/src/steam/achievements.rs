//! Steam achievements: the client's local stats first, Web API when a key exists.
//!
//! Owns unlock times, rarity tiers, and the per-game cache. Screenshots live
//! in `shots.rs`; the unlock sound lives in `sound.rs`.

mod sound;

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
use sound::play_achievement_notification_sound;

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

/// Steam's own language key for a launcher locale: `display.<field>.<key>` in
/// the client schema, `?l=<key>` on the community and Web API endpoints. Steam
/// ships no Hindi text, so that locale keeps the English answer.
fn steam_language(language: Option<&str>) -> &'static str {
    let raw = language.unwrap_or("en").trim().to_ascii_lowercase();
    if raw.starts_with("zh") {
        return if raw.contains("hant") || raw.ends_with("-tw") || raw.ends_with("-hk") {
            "tchinese"
        } else {
            "schinese"
        };
    }
    match raw.split(|c| c == '-' || c == '_').next().unwrap_or("en") {
        "tr" => "turkish",
        "de" => "german",
        "es" => "spanish",
        "fr" => "french",
        "it" => "italian",
        "ja" => "japanese",
        "ko" => "koreana",
        "pl" => "polish",
        "pt" => "brazilian",
        "ru" => "russian",
        "ar" => "arabic",
        "th" => "thai",
        _ => "english",
    }
}

/// One localized string out of a binary schema `display` block: the requested
/// language wins, then English, then the caller's fallback.
fn localized_display(display: Option<&Vdf>, field: &str, language: &str, fallback: &str) -> String {
    let Some(values) = display.and_then(|block| block.get(field)) else {
        return fallback.to_string();
    };
    values
        .get(language)
        .or_else(|| values.get("english"))
        .and_then(Vdf::as_str)
        .unwrap_or(fallback)
        .to_string()
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

/// The client's per-account stats file for one app: unlock times live here.
pub(super) fn app_stats_file(steam: &Path, account: u64, app_id: &str) -> PathBuf {
    stats_dir(steam).join(format!("UserGameStats_{account}_{app_id}.bin"))
}

/// File modification time in whole seconds, or `None` when it is missing.
fn modified_secs(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|time| time.as_secs())
}

/// True when the client or an emulator rewrote the achievement file after the
/// answer was cached. The TTL alone is not enough: Steam or an emulator can
/// unlock achievements while the launcher runs.
fn stats_file_changed_since(
    app: Option<&tauri::AppHandle>,
    steam: &Path,
    app_id: &str,
    fetched_at: u64,
) -> bool {
    let client_changed = steam_account_id(steam)
        .and_then(|account| modified_secs(&app_stats_file(steam, account, app_id)))
        .map(|at| at > fetched_at)
        .unwrap_or(false);
    if client_changed {
        return true;
    }
    let custom_p = app.and_then(|handle| {
        let cfg = get_achievement_source_config(handle, app_id);
        if cfg.mode == "disabled" {
            return None;
        }
        cfg.custom_path.map(PathBuf::from)
    });
    let remembered = ACHIEVEMENT_DIRS
        .lock()
        .ok()
        .and_then(|lock| lock.as_ref().and_then(|map| map.get(app_id).cloned()));
    let dir = custom_p.or(remembered);
    find_emulator_achievement_file(app_id, dir.as_deref())
        .and_then(|path| modified_secs(&path))
        .map(|at| at > fetched_at)
        .unwrap_or(false)
}

/// True when any app's stats file changed after `fetched_at`; used to discard
/// the whole-library totals cache.
fn stats_dir_changed_since(steam: &Path, fetched_at: u64) -> bool {
    let Ok(entries) = std::fs::read_dir(stats_dir(steam)) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        name.starts_with("UserGameStats_")
            && !name.starts_with("UserGameStatsSchema_")
            && entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|time| time.as_secs() > fetched_at)
                .unwrap_or(false)
    })
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
    let user_file = app_stats_file(steam, account, app_id);
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
    /// Stored entry keys from [SteamAchievements] (e.g. 00000 = "1" or
    /// "ACH_NAME"). The list can be partial: it names the entries that exist,
    /// not every achievement in the schema.
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

    // 1) C:\Users\Public\Documents\Steam (and EMPRESS / OnlineFix / RUNE / TENOKE)
    let public_dir = std::env::var_os("PUBLIC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Users\Public"));
    let pub_docs = public_dir.join("Documents");
    let steam_pub = pub_docs.join("Steam");
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
    for sub in ["EMPRESS", "OnlineFix", "RUNE", "TENOKE", "CODEX"] {
        let p = pub_docs.join(sub);
        if p.is_dir() {
            dirs.push(p);
        }
    }

    // 2) %APPDATA%
    if let Some(appdata) = std::env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(appdata.join("Goldberg SteamEmu Saves"));
        dirs.push(appdata.join("Goldberg SteamEmu Saves").join("settings"));
        dirs.push(appdata.join("GSE Saves"));
        dirs.push(appdata.join("GSE Saves").join("settings"));
        dirs.push(appdata.join("Steam").join("CODEX"));
        dirs.push(appdata.join("RUNE"));
        dirs.push(appdata.join("TENOKE"));
        dirs.push(appdata.join("EMPRESS"));
        dirs.push(appdata.join("OnlineFix"));
        dirs.push(appdata.join("ALI213"));
        dirs.push(appdata.join("SmartSteamEmu"));
        dirs.push(appdata.join("FLT"));
        dirs.push(appdata.join("SKIDROW"));
    }
    // 3) Newer Goldberg builds and portable emulators keep saves elsewhere.
    if let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("Goldberg SteamEmu Saves"));
        dirs.push(local.join("GSE Saves"));
        dirs.push(local.join("SmartSteamEmu"));
        dirs.push(local.join("RUNE"));
        dirs.push(local.join("TENOKE"));
        dirs.push(local.join("EMPRESS"));
        dirs.push(local.join("SKIDROW"));
    }
    if let Some(program_data) = std::env::var_os("PROGRAMDATA").map(PathBuf::from) {
        dirs.push(program_data.join("Goldberg SteamEmu Saves"));
        dirs.push(program_data.join("GSE Saves"));
        dirs.push(program_data.join("Steam"));
    }

    dirs
}

const EMULATOR_ACHIEVEMENT_FILES: &[&str] = &["achievements.ini", "achievements.json", "stats.ini"];

/// File names as they may sit directly in `steam_settings` or one app-id
/// folder below an emulator root.
fn push_achievement_files(dir: &Path, app_id: &str, out: &mut Vec<PathBuf>) {
    for folder in [
        dir.to_path_buf(),
        dir.join("steam_settings"),
        dir.join("SteamData"),
        dir.join("TENOKE").join("SteamData"),
        dir.join("Profile").join("Stats"),
        dir.join("Profile").join(app_id).join("Stats"),
        dir.join(app_id),
        dir.join(app_id).join("steam_settings"),
        dir.join(app_id).join("remote"),
        dir.join(app_id).join("remote").join("settings"),
        dir.join(app_id).join("SteamData"),
        dir.join("steam_settings").join(app_id),
    ] {
        for name in EMULATOR_ACHIEVEMENT_FILES {
            let candidate = folder.join(name);
            if candidate.is_file() {
                out.push(candidate);
            }
        }
    }
}

fn push_thirdparty_steamworks_dirs(base: &Path, out: &mut Vec<PathBuf>) {
    for sw_name in ["Steamworks", "SteamWorks"] {
        let tp = base.join("Engine").join("Binaries").join("ThirdParty").join(sw_name);
        if !tp.is_dir() {
            continue;
        }
        out.push(tp.clone());
        if let Ok(level1) = std::fs::read_dir(&tp) {
            for e1 in level1.flatten() {
                let p1 = e1.path();
                if p1.is_dir() {
                    out.push(p1.clone());
                    if let Ok(level2) = std::fs::read_dir(&p1) {
                        for e2 in level2.flatten() {
                            let p2 = e2.path();
                            if p2.is_dir() {
                                out.push(p2);
                            }
                        }
                    }
                }
            }
        }
    }
}

/// The Steamworks DLL a game imports. Unity builds keep it next to the exe,
/// Unreal ones under `Engine/Binaries/ThirdParty/Steamworks/<version>/<arch>`,
/// and a handful of studios ship it in a `bin`/`x64` subfolder.
fn find_steamworks_dll(install_dir: &Path) -> Option<PathBuf> {
    let mut dirs = vec![install_dir.to_path_buf()];
    for rel in [
        PathBuf::from("Binaries").join("Win64"),
        PathBuf::from("Binaries").join("Win32"),
        PathBuf::from("Win64"),
        PathBuf::from("Win32"),
        PathBuf::from("x64"),
        PathBuf::from("bin").join("x64"),
        PathBuf::from("bin"),
    ] {
        dirs.push(install_dir.join(rel));
    }
    // The game module usually sits one folder below the install root.
    if let Ok(entries) = std::fs::read_dir(install_dir) {
        for entry in entries.flatten().take(64) {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            dirs.push(path.clone());
            for rel in [
                PathBuf::from("Binaries").join("Win64"),
                PathBuf::from("Binaries").join("Win32"),
                PathBuf::from("Win64"),
                PathBuf::from("x64"),
            ] {
                dirs.push(path.join(rel));
            }
        }
    }
    push_thirdparty_steamworks_dirs(install_dir, &mut dirs);
    for dir in dirs {
        for name in ["steam_api64.dll", "steam_api.dll"] {
            let candidate = dir.join(name);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

/// The remembered folder is the executable's folder or the game install root;
/// Unreal/Unity builds often keep `steam_settings` or `SteamData` 1–4 levels
/// above the shipping binary or inside `Engine/Binaries/ThirdParty/Steamworks`.
fn push_achievement_files_near(dir: &Path, app_id: &str, out: &mut Vec<PathBuf>) {
    let mut search_dirs = vec![dir.to_path_buf()];
    let mut current = dir;
    for _ in 0..4 {
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
        search_dirs.push(current.to_path_buf());
    }
    let roots = search_dirs.clone();
    for root in &roots {
        for bin_rel in [
            PathBuf::from("Binaries").join("Win64"),
            PathBuf::from("Binaries").join("Win32"),
            PathBuf::from("Win64"),
            PathBuf::from("x64"),
        ] {
            let sub = root.join(bin_rel);
            if sub.is_dir() {
                search_dirs.push(sub);
            }
        }
        push_thirdparty_steamworks_dirs(root, &mut search_dirs);
    }
    for candidate_dir in search_dirs {
        push_achievement_files(&candidate_dir, app_id, out);
    }
}

fn parse_valid_app_id(raw: &str) -> Option<String> {
    let cleaned = raw
        .trim()
        .trim_start_matches('\u{feff}')
        .trim_matches('"')
        .trim_matches('\'')
        .trim();
    let token = cleaned.split_whitespace().next().unwrap_or("");
    if token.is_empty() || !token.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let num = token.parse::<u64>().ok()?;
    if num > 0 {
        Some(num.to_string())
    } else {
        None
    }
}

fn parse_app_id_from_ini(text: &str) -> Option<String> {
    for line in text.lines() {
        let trimmed = line.trim().trim_start_matches('\u{feff}');
        if trimmed.is_empty() || trimmed.starts_with(';') || trimmed.starts_with('#') || trimmed.starts_with('[') {
            continue;
        }
        let Some((key, val)) = trimmed.split_once('=') else {
            continue;
        };
        let key_norm = key.trim().to_ascii_lowercase();
        if matches!(
            key_norm.as_str(),
            "appid" | "app_id" | "steamappid" | "gameid" | "dlc001"
        ) && key_norm != "dlc001"
        {
            let val_clean = val.split(';').next().unwrap_or(val).split('#').next().unwrap_or(val);
            if let Some(id) = parse_valid_app_id(val_clean) {
                return Some(id);
            }
        }
    }
    None
}

/// Detects a Steam AppID near a game executable or install folder by inspecting
/// `steam_appid.txt` and scene/emulator `.ini` files (`steam_emu.ini`,
/// `tenoke.ini`, `codex.ini`, `rune.ini`, `flt.ini`, `ali213.ini`, `hlm.ini`,
/// `SmartSteamEmu.ini`, `OnlineFix.ini`, `steam_settings/configs.main.ini`, etc.).
pub fn detect_steam_app_id_for_exe(exe_or_dir: &Path) -> Option<String> {
    let base = if exe_or_dir.is_file()
        || exe_or_dir
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
    {
        exe_or_dir.parent().unwrap_or(exe_or_dir)
    } else {
        exe_or_dir
    };

    let mut search_dirs = vec![base.to_path_buf()];
    let mut current = base;
    for _ in 0..4 {
        let Some(parent) = current.parent() else {
            break;
        };
        current = parent;
        search_dirs.push(current.to_path_buf());
    }
    let roots = search_dirs.clone();
    for root in &roots {
        for bin_rel in [
            PathBuf::from("Binaries").join("Win64"),
            PathBuf::from("Binaries").join("Win32"),
            PathBuf::from("Win64"),
            PathBuf::from("x64"),
        ] {
            let sub = root.join(bin_rel);
            if sub.is_dir() {
                search_dirs.push(sub);
            }
        }
        push_thirdparty_steamworks_dirs(root, &mut search_dirs);
    }

    const TXT_REL_PATHS: &[&[&str]] = &[
        &["steam_appid.txt"],
        &["steam_settings", "steam_appid.txt"],
        &["SteamData", "steam_appid.txt"],
        &["TENOKE", "steam_appid.txt"],
        &["TENOKE", "SteamData", "steam_appid.txt"],
        &["Profile", "steam_appid.txt"],
    ];
    const INI_REL_PATHS: &[&[&str]] = &[
        &["steam_emu.ini"],
        &["tenoke.ini"],
        &["codex.ini"],
        &["rune.ini"],
        &["flt.ini"],
        &["ali213.ini"],
        &["hlm.ini"],
        &["cpy.ini"],
        &["skidrow.ini"],
        &["OnlineFix.ini"],
        &["SmartSteamEmu.ini"],
        &["steam_settings", "steam_emu.ini"],
        &["steam_settings", "configs.main.ini"],
        &["steam_settings", "configs.app.ini"],
        &["TENOKE", "tenoke.ini"],
        &["SteamData", "steam_emu.ini"],
    ];

    for dir in &search_dirs {
        for rel in TXT_REL_PATHS {
            let mut p = dir.clone();
            for seg in *rel {
                p.push(seg);
            }
            if let Ok(bytes) = std::fs::read(&p) {
                let text = String::from_utf8_lossy(&bytes);
                if let Some(id) = parse_valid_app_id(&text) {
                    return Some(id);
                }
            }
        }
        for rel in INI_REL_PATHS {
            let mut p = dir.clone();
            for seg in *rel {
                p.push(seg);
            }
            if let Ok(bytes) = std::fs::read(&p) {
                let text = String::from_utf8_lossy(&bytes);
                if let Some(id) = parse_app_id_from_ini(&text) {
                    return Some(id);
                }
            }
        }
    }
    None
}

fn steam_app_install_dir(steam: &Path, app_id: &str) -> Option<PathBuf> {
    let manifest_name = format!("appmanifest_{app_id}.acf");
    for steamapps in super::library::library_folders(steam) {
        let Ok(text) = std::fs::read_to_string(steamapps.join(&manifest_name)) else {
            continue;
        };
        if let Some(game) = super::library::parse_app_manifest(&text, &steamapps) {
            if !game.install_dir.trim().is_empty() {
                let dir = steamapps.join("common").join(game.install_dir.trim());
                if dir.is_dir() {
                    return Some(dir);
                }
            }
        }
    }
    None
}

/// A definitions template carries names and icons but no unlock state. When a
/// progress file is present it wins, so `steam_settings` never hides the real
/// save file from the watcher.
fn achievement_file_has_progress(path: &Path) -> bool {
    let Ok(bytes) = std::fs::read(path) else {
        return false;
    };
    let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
    text.contains("achieved=") || text.contains("\"earned\"")
}

fn achievement_file_modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// Picks the file the emulator is currently maintaining: a progress file beats
/// a definition template, and the newest write wins among the rest.
fn newest_achievement_file(files: Vec<PathBuf>) -> Option<PathBuf> {
    let candidates: Vec<(PathBuf, bool, u64)> = files
        .into_iter()
        .map(|path| {
            let progress = achievement_file_has_progress(&path);
            let modified = achievement_file_modified_ms(&path);
            (path, progress, modified)
        })
        .collect();
    let has_progress = candidates.iter().any(|(_, progress, _)| *progress);
    candidates
        .into_iter()
        .filter(|(_, progress, _)| !has_progress || *progress)
        .max_by_key(|(_, _, modified)| *modified)
        .map(|(path, _, _)| path)
}

/// Locates the achievements file for a Steam AppID.
pub fn find_emulator_achievement_file(app_id: &str, custom_path: Option<&Path>) -> Option<PathBuf> {
    if let Some(p) = custom_path {
        if p.is_file() {
            return Some(p.to_path_buf());
        }
    }

    let mut files = Vec::new();
    if let Some(p) = custom_path.filter(|p| p.is_dir()) {
        push_achievement_files_near(p, app_id, &mut files);
    } else if let Some(steam) = steam_install_path() {
        if let Some(install_dir) = steam_app_install_dir(&steam, app_id) {
            push_achievement_files_near(&install_dir, app_id, &mut files);
        }
    }
    for base in candidate_emulator_dirs() {
        push_achievement_files(&base, app_id, &mut files);
    }

    newest_achievement_file(files)
}

fn emulator_entry_state(entry: &EmulatorAchievementEntry) -> Option<(bool, i64, f64)> {
    if !entry.achieved && entry.unlock_time <= 0 {
        return None;
    }
    let progress = if entry.max_progress > 0.0 {
        (entry.cur_progress / entry.max_progress).clamp(0.0, 1.0)
    } else {
        1.0
    };
    Some((true, entry.unlock_time, progress))
}

/// Matches schema item against emulator achievement entries.
fn is_emulator_unlocked(
    parsed: &ParsedEmulatorAchievements,
    api_name: &str,
    index: usize,
    bit_id: &str,
) -> Option<(bool, i64, f64)> {
    // 1) The section key is the API name. This covers RUNE/CODEX files whose
    // sections are the names from the Steam schema, including purely numeric
    // names such as Kunitsu-Gami's `[1]`, `[2]`, `[31]`.
    let api_lower = api_name.to_lowercase();
    if let Some(entry) = parsed.entries.get(&api_lower) {
        return emulator_entry_state(entry);
    }

    // 2) A `[SteamAchievements]` list names every stored entry. It is a partial
    // list of section keys, not a positional map: a file with three unlocks
    // lists three keys (`00000=1`, `00001=2`, `00002=31`). Falling back to the
    // schema position there unlocked neighbouring entries (`[2]` also matched
    // achievement 3, `[31]` matched achievement 32).
    if !parsed.order_mapping.is_empty() {
        return None;
    }

    // 3) Legacy files without a mapping use one-based or zero-based section
    // numbers, so the position is the only link to the schema. That does not
    // apply when the API name itself is numeric: the section already is the
    // API name, and reading the position as well would unlock its neighbours.
    if api_name.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let one_based = (index + 1).to_string();
    let zero_based = index.to_string();
    let bit_str = bit_id.to_string();
    for key in [&one_based, &zero_based, &bit_str] {
        if let Some(entry) = parsed.entries.get(key) {
            if let Some(state) = emulator_entry_state(entry) {
                return Some(state);
            }
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
    let remembered = ACHIEVEMENT_DIRS
        .lock()
        .ok()
        .and_then(|lock| lock.as_ref().and_then(|map| map.get(app_id).cloned()));
    config.detected_path =
        find_emulator_achievement_file(app_id, custom.or(remembered.as_deref()))
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
    /// Language the page was read in; empty on caches written before the
    /// launcher asked for one (English).
    #[serde(default)]
    lang: String,
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
    language: &str,
) -> Option<CommunitySchemaCache> {
    let text = std::fs::read_to_string(community_schema_cache_path(app, app_id)).ok()?;
    let cached = serde_json::from_str::<CommunitySchemaCache>(&text).ok()?;
    let same_language =
        cached.lang == language || (cached.lang.is_empty() && language == "english");
    same_language.then_some(cached)
}

async fn fetch_community_schema(
    app: &tauri::AppHandle,
    app_id: &str,
    force: bool,
    language: &str,
) -> Option<Vec<CommunityAchievement>> {
    let cached = read_community_schema_cache(app, app_id, language);
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
    let url = format!("https://steamcommunity.com/stats/{app_id}/achievements?l={language}");
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
                lang: language.to_string(),
                achievements: achievements.clone(),
            };
            if let Ok(text) = serde_json::to_string(&cache) {
                let _ = std::fs::write(community_schema_cache_path(app, app_id), text);
            }
            Some(achievements)
        }
        // Offline: a stale definition list in the same language is still better
        // than no icons.
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
        // The community page publishes no stats bit ids; only the position is
        // known. Do not pass it as `bit_id`, or a numeric section can match the
        // wrong achievement.
        let state = is_emulator_unlocked(emu, &entry.api_name, index, "");
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

/// Builds achievement items directly from raw emulator entries when neither a
/// Steam client schema nor the public community schema is reachable.
fn build_raw_emulator_achievements(emu: &ParsedEmulatorAchievements) -> GameAchievementsResponse {
    let mut items: Vec<AchievementItem> = Vec::new();
    let mut keys: Vec<&String> = emu.entries.keys().collect();
    keys.sort();
    for key in keys {
        let Some(entry) = emu.entries.get(key) else {
            continue;
        };
        let (unlocked, unlock_time, progress) =
            emulator_entry_state(entry).unwrap_or((false, 0, 0.0));
        items.push(AchievementItem {
            name: entry.key.clone(),
            display_name: entry.key.clone(),
            description: String::new(),
            unlocked,
            progress,
            unlock_date: if unlocked {
                Some(unix_date(unlock_time))
            } else {
                None
            },
            is_base: true,
            ..Default::default()
        });
    }
    let total = items.len() as u32;
    let unlocked = items.iter().filter(|item| item.unlocked).count() as u32;
    GameAchievementsResponse {
        achievements: items,
        hidden: Vec::new(),
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
    language: &str,
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
            let display_name = localized_display(display, "name", language, &api_name);
            let description = localized_display(display, "desc", language, "");
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
    read_local_achievements_with_app(None, steam, app_id, "english")
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
    /// Language the text was fetched in; empty on caches written before the
    /// launcher asked for one (English).
    #[serde(default)]
    lang: String,
    response: GameAchievementsResponse,
}

/// Writes the on-disk answer that the drawer, the library summary and the TTL
/// read, and returns it. The watcher calls this too, so an unlock in a running
/// game reaches the library without reopening the page.
fn write_achievements_cache(
    app: &tauri::AppHandle,
    app_id: &str,
    response: &GameAchievementsResponse,
    language: &str,
) -> GameAchievementsResponse {
    let path = achievements_cache_dir(app).join(format!("{app_id}.json"));
    let mut merged = response.clone();
    // A Web API answer carries rarity the local read has no source for. The
    // fresh unlocks always win; only the tier metadata is carried over.
    if let Some(previous) = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<CachedAchievements>(&text).ok())
        .filter(|cached| {
            // Only a same-language answer may donate its text; a language
            // switch must not drag the old strings back in.
            (cached.lang == language || (cached.lang.is_empty() && language == "english"))
                && cached.response.achievements.len() == merged.achievements.len()
                && cached.response.total_achievements == merged.total_achievements
        })
        .map(|cached| cached.response)
    {
        {
            let old: std::collections::HashMap<&str, &AchievementItem> = previous
                .achievements
                .iter()
                .map(|item| (item.name.as_str(), item))
                .collect();
            for item in merged.achievements.iter_mut() {
                if item.tier.is_some() {
                    continue;
                }
                if let Some(old) = old.get(item.name.as_str()) {
                    item.tier = old.tier.clone();
                    item.rarity = old.rarity.clone();
                }
            }
        }
        // A fetch that started before an unlock can finish after the watcher
        // wrote it; the cached count must never move backwards.
        if previous.user_unlocked > merged.user_unlocked {
            merged = previous;
        }
    }
    let cached = CachedAchievements {
        fetched_at: now_secs(),
        lang: language.to_string(),
        response: merged.clone(),
    };
    if let Ok(text) = serde_json::to_string(&cached) {
        let _ = std::fs::write(path, text);
    }
    merged
}

/// Achievements for one Steam game. Read from the Steam client's own cache
/// first (offline, no key); the optional Web API key still answers for games
/// whose local schema is missing.
#[tauri::command]
pub async fn steam_get_achievements(
    app: tauri::AppHandle,
    app_id: String,
    force: Option<bool>,
    language: Option<String>,
) -> Result<GameAchievementsResponse, String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let language = steam_language(language.as_deref());
    let cache = achievements_cache_dir(&app).join(format!("{app_id}.json"));
    if force != Some(true) {
        if let Ok(text) = std::fs::read_to_string(&cache) {
            if let Ok(cached) = serde_json::from_str::<CachedAchievements>(&text) {
                let same_language =
                    cached.lang == language || (cached.lang.is_empty() && language == "english");
                let within_ttl = same_language
                    && now_secs().saturating_sub(cached.fetched_at) < ACHIEVEMENTS_TTL_SECS;
                // The client rewrites its stats file mid-session; when that file
                // is newer than the answer, the TTL alone would keep the old
                // unlocks for an hour.
                let unchanged = steam_install_path()
                    .map(|steam| {
                        !stats_file_changed_since(Some(&app), &steam, &app_id, cached.fetched_at)
                    })
                    .unwrap_or(true);
                if within_ttl && unchanged {
                    return Ok(cached.response);
                }
            }
        }
    }

    // 1) The Steam client's own cache: instant, offline, no key, no rate limit.
    if let Some(mut response) = steam_install_path()
        .and_then(|path| read_local_achievements_with_app(Some(&app), &path, &app_id, language))
    {
        // Global unlock rates are public, so even the local path gets rarity.
        let percentages = fetch_global_percentages(&app_id).await;
        if !percentages.is_empty() {
            apply_rarity(&mut response, &percentages);
        }
        return Ok(write_achievements_cache(&app, &app_id, &response, language));
    }

    // 1b) Public Steam Community schema + local emulator unlocks when the Steam
    // client has no `UserGameStatsSchema_<app>.bin` on disk and no Web API key
    // is configured (or an emulator file is present).
    let api_key = steam_get_api_key(app.clone());
    let emu_present = read_emulator_achievements(Some(&app), &app_id);
    if api_key.is_none() || emu_present.is_some() {
        if let Some(schema) =
            fetch_community_schema(&app, &app_id, force == Some(true), language).await
        {
            let mut response =
                build_emulator_achievements(&schema, &emu_present.unwrap_or_default());
            if response.total_achievements > 0 {
                let percentages = fetch_global_percentages(&app_id).await;
                if !percentages.is_empty() {
                    apply_rarity(&mut response, &percentages);
                }
            }
            return Ok(write_achievements_cache(&app, &app_id, &response, language));
        } else if let Some(ref emu) = emu_present {
            return Ok(write_achievements_cache(
                &app,
                &app_id,
                &build_raw_emulator_achievements(emu),
                language,
            ));
        }
    }

    // 2) Web API fallback (adds global rarity) when no local schema exists.
    let key = api_key
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
        "https://api.steampowered.com/ISteamUserStats/GetSchemaForGame/v2/?key={key}&appid={app_id}&l={language}"
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
        "https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v1/?key={key}&steamid={steam_id}&appid={app_id}&l={language}"
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
    Ok(write_achievements_cache(&app, &app_id, &response, language))
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
    language: Option<String>,
) -> Result<GameAchievementsResponse, String> {
    let language = steam_language(language.as_deref());
    let root_buf = install_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(|dir| {
            let path = Path::new(dir);
            if path.is_file() {
                path.parent().unwrap_or(path).to_path_buf()
            } else {
                path.to_path_buf()
            }
        });
    let app_id = if !app_id.trim().is_empty() && app_id.trim().chars().all(|c| c.is_ascii_digit()) {
        app_id.trim().to_string()
    } else if let Some(ref root) = root_buf {
        detect_steam_app_id_for_exe(root).unwrap_or_default()
    } else {
        String::new()
    };
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    if let Some(ref root) = root_buf {
        remember_achievement_dir(&app_id, root);
    }
    let config = get_achievement_source_config(&app, &app_id);
    // "Disabled" means emulator files are ignored, not that the game has no
    // achievements at all: the Steam client's own stats still count.
    if config.mode == "disabled" {
        if let Some(local) = steam_install_path().and_then(|steam| {
            read_local_achievements_with_app(Some(&app), &steam, &app_id, language)
        }) {
            return Ok(local);
        }
    }

    let community = fetch_community_schema(&app, &app_id, force == Some(true), language).await;
    let emu = read_emulator_achievements(Some(&app), &app_id);
    let mut response = match (community, emu) {
        (Some(schema), Some(emu)) => build_emulator_achievements(&schema, &emu),
        (Some(schema), None) => build_emulator_achievements(&schema, &Default::default()),
        // No community answer (offline first run): the Steam client schema is
        // still a useful definition source when the game also exists on Steam.
        (None, maybe_emu) => steam_install_path()
            .and_then(|steam| {
                read_local_achievements_with_app(Some(&app), &steam, &app_id, language)
            })
            .or_else(|| maybe_emu.as_ref().map(build_raw_emulator_achievements))
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

fn normalize_install_root(install_dir: Option<&Path>) -> Option<PathBuf> {
    let path = install_dir?;
    if path.is_file() {
        return path.parent().map(Path::to_path_buf);
    }
    path.is_dir().then(|| path.to_path_buf())
}

/// What an install folder says about Steam achievements without a Steam login:
/// whether it imports the Steamworks DLL and whether a local emulator already
/// left an achievement file on disk. Read-only; it never starts the game.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementProbe {
    /// Steam AppID named by `steam_appid.txt` or an emulator ini; empty when
    /// the install does not carry one.
    pub app_id: String,
    pub steamworks: bool,
    /// The Steamworks DLL the game imports, when one was found.
    pub dll: Option<String>,
    /// The achievement file the emulator currently maintains, when one exists.
    pub emulator: Option<String>,
}

fn probe_installation(app_id: Option<&str>, install_dir: Option<&Path>) -> AchievementProbe {
    let root = normalize_install_root(install_dir);
    let mut resolved = app_id
        .map(str::trim)
        .filter(|id| !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()))
        .unwrap_or("")
        .to_string();
    if resolved.is_empty() {
        if let Some(root) = root.as_deref() {
            resolved = detect_steam_app_id_for_exe(root).unwrap_or_default();
        }
    }

    let dll = root.as_deref().and_then(find_steamworks_dll);
    let mut emulator = if resolved.is_empty() {
        None
    } else {
        find_emulator_achievement_file(&resolved, root.as_deref())
    };
    // Without an AppID the global save folders cannot be named, but a
    // `steam_settings` folder next to the exe still tells us the file is there.
    if emulator.is_none() {
        if let Some(root) = root.as_deref() {
            let mut files = Vec::new();
            push_achievement_files_near(root, &resolved, &mut files);
            emulator = newest_achievement_file(files);
        }
    }

    AchievementProbe {
        app_id: resolved,
        steamworks: dll.is_some(),
        dll: dll.map(|path| path.to_string_lossy().to_string()),
        emulator: emulator.map(|path| path.to_string_lossy().to_string()),
    }
}

/// Tells the game page whether an achievement source exists for an installed
/// store game: the Steamworks DLL it imports and any local emulator file.
#[tauri::command]
pub fn steam_achievement_probe(
    app_id: Option<String>,
    install_dir: Option<String>,
) -> AchievementProbe {
    let install = install_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(Path::new);
    probe_installation(app_id.as_deref(), install)
}

/// Writes `steam_settings/achievements.json` for a Goldberg-style emulator from
/// the public Steam Community schema. Earned flags already in the file are
/// kept, so a second run refreshes the text without resetting progress.
#[tauri::command]
pub async fn steam_write_emulator_achievements(
    app: tauri::AppHandle,
    app_id: String,
    install_dir: String,
    language: Option<String>,
) -> Result<String, String> {
    let app_id = app_id.trim();
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let root = normalize_install_root(Some(Path::new(install_dir.trim())))
        .ok_or("The game install folder was not found")?;
    // A generated file belongs to a game that imports Steamworks or already
    // carries an emulator settings folder; never write into an arbitrary path.
    if find_steamworks_dll(&root).is_none() && !root.join("steam_settings").is_dir() {
        return Err("This folder does not look like a game with Steamworks".into());
    }
    let language = steam_language(language.as_deref());
    let schema = fetch_community_schema(&app, app_id, false, language)
        .await
        .filter(|items| !items.is_empty())
        .ok_or("No achievement definitions could be read for this game")?;

    let dir = root.join("steam_settings");
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    // Goldberg needs the AppID next to its settings to pick the right save
    // folder. Never overwrite a value the player already has, and leave a root
    // `steam_appid.txt` alone: that one is what the DLL reads first.
    let appid_path = dir.join("steam_appid.txt");
    if !appid_path.is_file() && !root.join("steam_appid.txt").is_file() {
        std::fs::write(&appid_path, format!("{app_id}\n")).map_err(|error| error.to_string())?;
    }
    let path = dir.join("achievements.json");
    let existing = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<serde_json::Value>(&text).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();

    let definitions = emulator_definitions_json(&schema, &existing);
    let text = serde_json::to_string_pretty(&definitions).map_err(|error| error.to_string())?;
    std::fs::write(&path, text).map_err(|error| error.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

/// The Goldberg definition shape for one schema list. An entry already in the
/// file keeps its earned flag, so re-running the generator only refreshes text.
fn emulator_definitions_json(
    schema: &[CommunityAchievement],
    existing: &serde_json::Map<String, serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut definitions = serde_json::Map::new();
    for entry in schema {
        let prior = existing.get(&entry.api_name);
        let earned = prior
            .and_then(|value| value.get("earned"))
            .and_then(|value| value.as_bool())
            .unwrap_or(false);
        let earned_time = prior
            .and_then(|value| value.get("earned_time"))
            .and_then(|value| value.as_i64())
            .unwrap_or(0);
        definitions.insert(
            entry.api_name.clone(),
            serde_json::json!({
                "name": entry.name,
                "description": entry.description,
                "icon": entry.icon_achieved,
                "icon_gray": entry.icon_unachieved,
                "earned": earned,
                "earned_time": earned_time,
            }),
        );
    }
    definitions
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

/// Per-game achievement switch written by the game page bell. The watcher
/// consults it at unlock time; an id missing from the map stays enabled.
static GAME_NOTIFICATIONS: StdMutex<Option<std::collections::HashMap<String, bool>>> =
    StdMutex::new(None);

#[tauri::command]
pub fn steam_set_achievement_notifications(app_id: String, enabled: bool) {
    if let Ok(mut lock) = GAME_NOTIFICATIONS.lock() {
        lock.get_or_insert_with(std::collections::HashMap::new)
            .insert(app_id, enabled);
    }
}

fn achievement_game_notifications_enabled(app_id: &str) -> bool {
    GAME_NOTIFICATIONS
        .lock()
        .ok()
        .and_then(|lock| lock.as_ref().and_then(|map| map.get(app_id).copied()))
        .unwrap_or(true)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementUnlockedPayload {
    pub app_id: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub icon_url: String,
    /// False when the user silenced notifications; the UI still records the
    /// unlock so the achievement list stays correct.
    #[serde(default)]
    pub notification: bool,
    /// True when the in-game toast card played, so the launcher's own small
    /// toast stays quiet instead of showing the same unlock twice.
    #[serde(default)]
    pub card: bool,
    #[serde(default)]
    pub rarity_percent: Option<f64>,
    #[serde(default)]
    pub tier: Option<String>,
    #[serde(default)]
    pub unlocked_count: Option<u32>,
    #[serde(default)]
    pub total_count: Option<u32>,
    /// Screenshot saved for this unlock (a "souvenir" of the moment), when the
    /// setting is on and the capture succeeded.
    #[serde(default)]
    pub screenshot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AchievementNotificationOptions {
    pub enabled: bool,
    pub sound: bool,
    pub overlay: bool,
    pub volume: u8,
    pub duration_ms: u64,
    /// top-right, top-left, bottom-right, or bottom-left.
    #[serde(default = "default_notification_position")]
    pub position: String,
    /// compact, normal, large, or huge.
    #[serde(default = "default_notification_size")]
    pub size: String,
    /// True when a user-picked sound exists; the watcher then plays it
    /// natively instead of the system beep.
    #[serde(default)]
    pub custom_sound: bool,
    #[serde(default)]
    pub custom_sound_name: Option<String>,
    /// "gold", "launcher", "rarity", "cyber", "emerald", "crimson", or "amethyst".
    #[serde(default = "default_card_theme")]
    pub card_theme: String,
    /// "prism", "cyber", "shatter", "jackpot", "xbox", "playstation", or "epic".
    #[serde(default = "default_anim_style")]
    pub anim_style: String,
    /// "auto", "collapse", "glide", "fold", "laser", "implode", or "zoom".
    #[serde(default = "default_exit_style")]
    pub exit_style: String,
    /// Muted store keys ("steam", "epic", "gog", "ubisoft", "ea", "xbox", "custom").
    #[serde(default)]
    pub disabled_stores: Vec<String>,
    /// 0 announces every unlock; 5, 10 or 25 announce only achievements whose
    /// global unlock rate is at or below that percent. A store that ships no
    /// rarity figure is always announced: there is nothing to measure.
    #[serde(default)]
    pub min_rarity_percent: u8,
    /// Save a screenshot of the moment to the game's screenshot folder when a
    /// burst of achievements unlocks.
    #[serde(default)]
    pub unlock_screenshots: bool,
}

impl Default for AchievementNotificationOptions {
    fn default() -> Self {
        Self {
            enabled: true,
            sound: true,
            overlay: true,
            volume: 100,
            duration_ms: 5000,
            position: default_notification_position(),
            size: default_notification_size(),
            custom_sound: false,
            custom_sound_name: None,
            card_theme: default_card_theme(),
            anim_style: default_anim_style(),
            exit_style: default_exit_style(),
            disabled_stores: Vec::new(),
            min_rarity_percent: 0,
            unlock_screenshots: false,
        }
    }
}

fn default_card_theme() -> String {
    "gold".to_string()
}

fn normalize_card_theme(value: Option<&str>) -> String {
    match value {
        Some("launcher") => "launcher",
        Some("rarity") => "rarity",
        Some("cyber") => "cyber",
        Some("emerald") => "emerald",
        Some("crimson") => "crimson",
        Some("amethyst") => "amethyst",
        _ => "gold",
    }
    .to_string()
}

fn default_anim_style() -> String {
    "prism".to_string()
}

fn normalize_anim_style(value: Option<&str>) -> String {
    match value {
        Some("cyber") => "cyber",
        Some("shatter") => "shatter",
        Some("jackpot") => "jackpot",
        Some("xbox") => "xbox",
        Some("playstation") => "playstation",
        Some("epic") => "epic",
        _ => "prism",
    }
    .to_string()
}

fn default_exit_style() -> String {
    "auto".to_string()
}

fn normalize_exit_style(value: Option<&str>) -> String {
    match value {
        Some("collapse") => "collapse",
        Some("glide") => "glide",
        Some("fold") => "fold",
        Some("laser") => "laser",
        Some("implode") => "implode",
        Some("zoom") => "zoom",
        _ => "auto",
    }
    .to_string()
}

fn normalize_disabled_stores(stores: &[String]) -> Vec<String> {
    let mut out = Vec::new();
    for raw in stores {
        let key = raw.trim().to_ascii_lowercase();
        if matches!(
            key.as_str(),
            "steam" | "epic" | "gog" | "ubisoft" | "ea" | "xbox" | "amazon" | "custom"
        ) && !out.contains(&key)
        {
            out.push(key);
        }
    }
    out
}

/// The rarity threshold is a fixed choice, not a free number: 0, 5, 10 or 25.
fn normalize_min_rarity(value: Option<u8>) -> u8 {
    match value {
        Some(25) => 25,
        Some(10) => 10,
        Some(5) => 5,
        _ => 0,
    }
}

/// True when a card may be shown for this rarity. A store without a figure
/// always passes: the launcher must not hide an unlock it cannot measure.
fn rarity_allows_notification(
    options: &AchievementNotificationOptions,
    rarity_percent: Option<f64>,
) -> bool {
    if options.min_rarity_percent == 0 {
        return true;
    }
    match rarity_percent {
        Some(percent) if percent > 0.0 => percent <= f64::from(options.min_rarity_percent),
        _ => true,
    }
}

/// The `launcher` card palette, resolved from the live theme tokens by the
/// frontend. The other themes are resolved by the toast page from the same TS
/// palette function the Settings preview uses.
static CARD_COLORS: StdMutex<Option<crate::overlay::toast::ToastPalette>> = StdMutex::new(None);

/// Pushed once at boot and after every theme change.
#[tauri::command]
pub fn achievement_set_notification_colors(colors: crate::overlay::toast::ToastPalette) {
    if let Ok(mut slot) = CARD_COLORS.lock() {
        *slot = Some(colors);
    }
}

fn launcher_palette() -> crate::overlay::toast::ToastPalette {
    CARD_COLORS
        .lock()
        .ok()
        .and_then(|slot| slot.clone())
        .unwrap_or_else(|| crate::overlay::toast::ToastPalette {
            background: "#0d0f14".into(),
            accent: "#f59e0b".into(),
            border: "#785018".into(),
            icon: "#fbbf24".into(),
            title: "#ffffff".into(),
            body: "#acb2b8".into(),
        })
}

fn default_notification_size() -> String {
    "normal".to_string()
}

fn normalize_notification_size(value: Option<&str>) -> String {
    match value {
        Some("small" | "compact") => "small",
        Some("large") => "large",
        _ => "normal",
    }
    .to_string()
}

fn default_notification_position() -> String {
    "top-right".to_string()
}

/// Keeps the persisted value inside the four supported card corners.
fn normalize_notification_position(value: Option<&str>) -> String {
    match value {
        Some("top-left") => "top-left",
        Some("center-top") => "center-top",
        Some("top-right") => "top-right",
        Some("bottom-left") => "bottom-left",
        Some("center-bottom") => "center-bottom",
        Some("bottom-right") => "bottom-right",
        _ => "top-right",
    }
    .to_string()
}

pub fn achievement_notification_options(app: &tauri::AppHandle) -> AchievementNotificationOptions {
    let settings = crate::load_settings(app);
    let sound_path = settings
        .achievement_notifications_sound_path
        .as_deref()
        .filter(|path| !path.trim().is_empty() && Path::new(path).is_file());
    let custom_sound = sound_path.is_some();
    AchievementNotificationOptions {
        enabled: settings.achievement_notifications_enabled.unwrap_or(true),
        sound: settings.achievement_notifications_sound.unwrap_or(true),
        overlay: settings.achievement_notifications_overlay.unwrap_or(true),
        volume: settings.achievement_notifications_volume.unwrap_or(100).min(100),
        duration_ms: settings
            .achievement_notifications_duration_ms
            .unwrap_or(5000)
            .clamp(2000, 15000),
        position: normalize_notification_position(
            settings.achievement_notifications_position.as_deref(),
        ),
        size: normalize_notification_size(
            settings.achievement_notifications_size.as_deref(),
        ),
        custom_sound,
        custom_sound_name: if custom_sound {
            settings.achievement_notifications_sound_name.clone().or_else(|| {
                sound_path.and_then(|path| {
                    Path::new(path)
                        .file_name()
                        .and_then(|name| name.to_str())
                        .map(str::to_string)
                })
            })
        } else {
            None
        },
        card_theme: normalize_card_theme(
            settings.achievement_notifications_card_theme.as_deref(),
        ),
        anim_style: normalize_anim_style(
            settings.achievement_notifications_anim_style.as_deref(),
        ),
        exit_style: normalize_exit_style(
            settings.achievement_notifications_exit_style.as_deref(),
        ),
        disabled_stores: normalize_disabled_stores(
            &settings.achievement_notifications_disabled_stores,
        ),
        min_rarity_percent: normalize_min_rarity(
            settings.achievement_notifications_min_rarity,
        ),
        unlock_screenshots: settings.achievement_unlock_screenshots.unwrap_or(false),
    }
}

#[tauri::command]
pub fn achievement_get_notification_options(
    app: tauri::AppHandle,
) -> AchievementNotificationOptions {
    achievement_notification_options(&app)
}

#[tauri::command]
pub fn achievement_set_notification_options(
    app: tauri::AppHandle,
    options: AchievementNotificationOptions,
) -> Result<(), String> {
    let mut settings = crate::load_settings(&app);
    settings.achievement_notifications_enabled = Some(options.enabled);
    settings.achievement_notifications_sound = Some(options.sound);
    settings.achievement_notifications_overlay = Some(options.overlay);
    settings.achievement_notifications_volume = Some(options.volume.min(100));
    settings.achievement_notifications_duration_ms = Some(options.duration_ms.clamp(2000, 15000));
    settings.achievement_notifications_position =
        Some(normalize_notification_position(Some(options.position.as_str())));
    settings.achievement_notifications_size =
        Some(normalize_notification_size(Some(options.size.as_str())));
    settings.achievement_notifications_card_theme = Some(normalize_card_theme(Some(
        options.card_theme.as_str(),
    )));
    settings.achievement_notifications_anim_style = Some(normalize_anim_style(Some(
        options.anim_style.as_str(),
    )));
    settings.achievement_notifications_exit_style = Some(normalize_exit_style(Some(
        options.exit_style.as_str(),
    )));
    settings.achievement_notifications_disabled_stores =
        normalize_disabled_stores(&options.disabled_stores);
    settings.achievement_notifications_min_rarity = Some(normalize_min_rarity(Some(
        options.min_rarity_percent,
    )));
    settings.achievement_unlock_screenshots = Some(options.unlock_screenshots);
    crate::save_settings(&app, &settings);
    Ok(())
}

fn achievement_sound_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("sounds");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

#[tauri::command]
pub async fn achievement_pick_custom_sound(
    app: tauri::AppHandle,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let chosen = tokio::task::spawn_blocking(move || {
            let script = r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Windows.Forms;
$f = New-Object System.Windows.Forms.OpenFileDialog;
$f.Title = 'Select notification sound';
$f.Filter = 'Audio (*.wav;*.mp3;*.ogg;*.flac;*.m4a;*.aac)|*.wav;*.mp3;*.ogg;*.flac;*.m4a;*.aac';
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $f.FileName }
"#;
            let mut cmd = std::process::Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", script]);
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000);
            let output = cmd.output().map_err(|error| error.to_string())?;
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok::<Option<String>, String>(if path.is_empty() { None } else { Some(path) })
        })
        .await
        .map_err(|error| error.to_string())??;
        let Some(chosen) = chosen else {
            return Ok(None);
        };
        let source = PathBuf::from(&chosen);
        if !source.is_file() {
            return Err("The selected sound file does not exist".into());
        }
        let extension = source
            .extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or("")
            .to_lowercase();
        if !matches!(extension.as_str(), "wav" | "mp3" | "ogg" | "flac" | "m4a" | "aac") {
            return Err("Choose a WAV, MP3, OGG, FLAC, M4A, or AAC audio file".into());
        }
        let metadata = std::fs::metadata(&source).map_err(|error| error.to_string())?;
        if metadata.len() > 10 * 1024 * 1024 {
            return Err("The notification sound must be smaller than 10 MB".into());
        }
        let source_file = std::fs::File::open(&source).map_err(|error| error.to_string())?;
        if rodio::Decoder::try_from(source_file).is_err() {
            return Err("This audio file is not supported".into());
        }
        let target = achievement_sound_dir(&app).join(format!(
            "achievement-{}.{}",
            now_secs(),
            extension
        ));
        std::fs::copy(&source, &target).map_err(|error| error.to_string())?;
        let mut settings = crate::load_settings(&app);
        if let Some(old) = settings.achievement_notifications_sound_path.take() {
            if Path::new(&old) != target.as_path() {
                let _ = std::fs::remove_file(old);
            }
        }
        settings.achievement_notifications_sound_path =
            Some(target.to_string_lossy().to_string());
        settings.achievement_notifications_sound_name = source
            .file_name()
            .and_then(|name| name.to_str())
            .map(str::to_string);
        crate::save_settings(&app, &settings);
        Ok(settings.achievement_notifications_sound_name)
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(None)
    }
}

#[tauri::command]
pub fn achievement_clear_custom_sound(app: tauri::AppHandle) -> Result<(), String> {
    let mut settings = crate::load_settings(&app);
    if let Some(path) = settings.achievement_notifications_sound_path.take() {
        let _ = std::fs::remove_file(path);
    }
    settings.achievement_notifications_sound_name = None;
    crate::save_settings(&app, &settings);
    Ok(())
}

/// Settings store key for a launcher game key or a bare Steam AppID.
fn notification_store_key(app_id: &str) -> &'static str {
    if app_id.starts_with("gog::") {
        "gog"
    } else if app_id.starts_with("ubisoft::") {
        "ubisoft"
    } else if app_id.starts_with("ea::") {
        "ea"
    } else if app_id.starts_with("xbox::") {
        "xbox"
    } else if app_id.starts_with("amazon::") {
        "amazon"
    } else if app_id.starts_with("custom::") {
        "custom"
    } else if app_id.starts_with("steam::")
        || (!app_id.is_empty() && app_id.chars().all(|c| c.is_ascii_digit()))
    {
        "steam"
    } else {
        "epic"
    }
}

/// Settings > Achievements: preview the current notification settings. The
/// payload goes through the same frontend listener as a real unlock.
#[tauri::command]
pub fn achievement_test_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    rarity_tier: Option<u8>,
    app_id: Option<String>,
    ach_name: Option<String>,
    icon_url: Option<String>,
    unlocked_count: Option<u32>,
    total_count: Option<u32>,
    is_real_unlock: Option<bool>,
) {
    let options = achievement_notification_options(&app);
    let real_unlock = is_real_unlock == Some(true);
    let tier = rarity_tier.unwrap_or(2).min(4);
    let resolved_app_id = app_id.unwrap_or_else(|| "0".into());
    let store_key = notification_store_key(&resolved_app_id);
    let store_enabled = !options.disabled_stores.iter().any(|s| s == store_key);
    let should_notify = if real_unlock {
        options.enabled && store_enabled
    } else {
        true
    };
    let (default_pct, tier_name, default_unlocked, default_total) = match tier {
        0 => (Some(64.2), Some("bronze".to_string()), Some(11), Some(34)),
        1 => (Some(21.8), Some("silver".to_string()), Some(19), Some(34)),
        2 => (Some(8.4), Some("gold".to_string()), Some(25), Some(34)),
        3 => (Some(1.8), Some("ultra".to_string()), Some(31), Some(34)),
        _ => (Some(0.4), Some("platinum".to_string()), Some(34), Some(34)),
    };
    let unlocked = unlocked_count.or(default_unlocked).unwrap_or(0);
    let total = total_count.or(default_total).unwrap_or(0);
    if should_notify {
        if options.overlay {
            let generation = crate::overlay::toast::show(
                &app,
                toast_payload(&options, tier, unlocked, total, default_pct, &title, &body),
            );
            if let Some(ref url) = icon_url {
                attach_achievement_icon(&app, url, generation);
            }
        }
        play_achievement_notification_sound(&app, &options, tier);
    }
    let payload = AchievementUnlockedPayload {
        app_id: resolved_app_id,
        name: ach_name.unwrap_or_else(|| "TEST_ACHIEVEMENT".into()),
        display_name: title,
        description: body,
        icon_url: icon_url.unwrap_or_default(),
        notification: if real_unlock { should_notify } else { false },
        card: should_notify && options.overlay,
        rarity_percent: default_pct,
        tier: tier_name,
        unlocked_count: Some(unlocked),
        total_count: Some(total),
        screenshot: None,
    };
    let _ = app.emit("achievement-unlocked", payload);
}

/// Captures the moment for a non-Steam unlock. The frontend poll asks once per
/// burst; the capture itself refuses when the game is not in the foreground.
#[tauri::command]
pub async fn achievement_capture_souvenir(
    app: tauri::AppHandle,
    app_name: String,
    title: Option<String>,
) -> Option<String> {
    if !achievement_notification_options(&app).unlock_screenshots {
        return None;
    }
    tauri::async_runtime::spawn_blocking(move || {
        crate::legendary::screenshots::capture_game_screenshot_sync(
            &app_name,
            title.as_deref().unwrap_or(""),
        )
        .ok()
        .map(|item| item.file_path)
    })
    .await
    .ok()
    .flatten()
}

/// One payload shape for real unlocks, the Settings test and system hints.
fn toast_payload(
    options: &AchievementNotificationOptions,
    tier: u8,
    unlocked: u32,
    total: u32,
    rarity_percent: Option<f64>,
    title: &str,
    body: &str,
) -> crate::overlay::toast::ToastPayload {
    crate::overlay::toast::ToastPayload {
        generation: 0,
        title: title.to_string(),
        body: body.to_string(),
        tier,
        unlocked,
        total,
        rarity_percent,
        theme: options.card_theme.clone(),
        size: options.size.clone(),
        position: options.position.clone(),
        style: options.anim_style.clone(),
        exit_style: options.exit_style.clone(),
        hold_ms: options.duration_ms.clamp(2_000, 15_000),
        palette: launcher_palette(),
        tagless: false,
        icon: None,
        batch: 0,
        batch_names: Vec::new(),
    }
}

/// Game-start / overlay hints: the same card, without the rarity line.
pub fn show_system_hint(app: &tauri::AppHandle, title: &str, body: &str) {
    let options = achievement_notification_options(app);
    let mut payload = toast_payload(&options, 2, 0, 0, None, title, body);
    payload.theme = "launcher".to_string();
    payload.tagless = true;
    payload.hold_ms = 5_200;
    crate::overlay::toast::show(app, payload);
}


/// One achievement snapshot for the live watcher: the Steam client's own stats
/// when available, otherwise the emulator file plus the public definition list.
fn watcher_snapshot(
    app: &tauri::AppHandle,
    app_id: &str,
    steam: Option<&Path>,
    community: Option<&[CommunityAchievement]>,
    emulator_only: bool,
    language: &str,
) -> Option<GameAchievementsResponse> {
    if !emulator_only {
        if let Some(steam) = steam {
            if let Some(response) =
                read_local_achievements_with_app(Some(app), steam, app_id, language)
            {
                return Some(response);
            }
        }
    }
    let emu = read_emulator_achievements(Some(app), app_id);
    if let Some(schema) = community {
        return Some(build_emulator_achievements(
            schema,
            &emu.unwrap_or_default(),
        ));
    }
    emu.map(|parsed| build_raw_emulator_achievements(&parsed))
}

/// Starts the watch for a Steam client game.
#[tauri::command]
pub fn steam_start_achievement_watcher(
    app: tauri::AppHandle,
    app_id: String,
    language: Option<String>,
) {
    start_achievement_watcher(
        app,
        app_id,
        false,
        steam_language(language.as_deref()),
        None,
    );
}

/// Frontend entry point for external custom launches and store games that read
/// their achievements from a local emulator: registers the install root (some
/// emulators keep achievements next to the exe) and starts the watch.
///
/// `payload_app_id` is the launcher key (`ABZU`, `gog::1207658924`) the unlock
/// event names; the cache and the watcher slot stay on the Steam AppID.
#[tauri::command]
pub fn steam_start_emulator_watcher(
    app: tauri::AppHandle,
    app_id: String,
    install_dir: Option<String>,
    language: Option<String>,
    payload_app_id: Option<String>,
) {
    let language = steam_language(language.as_deref());
    let root_buf = install_dir
        .as_deref()
        .map(str::trim)
        .filter(|dir| !dir.is_empty())
        .map(|dir| {
            let path = Path::new(dir);
            if path.is_file() {
                path.parent().unwrap_or(path).to_path_buf()
            } else {
                path.to_path_buf()
            }
        });
    let resolved_app_id =
        if !app_id.trim().is_empty() && app_id.trim().chars().all(|c| c.is_ascii_digit()) {
            app_id.trim().to_string()
        } else if let Some(ref root) = root_buf {
            detect_steam_app_id_for_exe(root).unwrap_or_default()
        } else {
            String::new()
        };
    if resolved_app_id.is_empty() {
        return;
    }
    if let Some(ref root) = root_buf {
        remember_achievement_dir(&resolved_app_id, root);
    }
    let payload_app_id = payload_app_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    // "Disabled (Steam client only)" must fall back to the client watcher.
    let emulator_only = get_achievement_source_config(&app, &resolved_app_id).mode != "disabled";
    start_achievement_watcher(app, resolved_app_id, emulator_only, language, payload_app_id);
}

/// The card paints the achievement's own icon when the picture cache answers in
/// time; a missing picture leaves the trophy medallion.
fn attach_achievement_icon(app: &tauri::AppHandle, icon_url: &str, generation: u64) {
    if generation == 0 || icon_url.trim().is_empty() {
        return;
    }
    let app = app.clone();
    let url = icon_url.to_string();
    std::thread::spawn(move || {
        let cached = tauri::async_runtime::block_on(crate::image_cache::cache_image(&app, &url));
        if let Some(path) = cached {
            crate::overlay::toast::set_icon(&app, generation, &path);
        }
    });
}

fn classify_achievement_rarity_tier(
    rarity_percent: Option<f64>,
    tier_name: Option<&str>,
    unlocked_count: u32,
    total_count: u32,
) -> (u8, String) {
    if total_count > 0 && unlocked_count >= total_count {
        return (4, "platinum".to_string());
    }
    if let Some(pct) = rarity_percent {
        if pct <= 3.5 {
            return (3, "ultra".to_string());
        } else if pct <= 12.0 {
            return (2, "gold".to_string());
        } else if pct <= 30.0 {
            return (1, "silver".to_string());
        } else {
            return (0, "bronze".to_string());
        }
    }
    match tier_name.unwrap_or("bronze") {
        "platinum" => (4, "platinum".to_string()),
        "ultra" | "diamond" => (3, "ultra".to_string()),
        "gold" => (2, "gold".to_string()),
        "silver" => (1, "silver".to_string()),
        _ => (0, "bronze".to_string()),
    }
}

/// One souvenir screenshot per burst, and at most one every 15 seconds: a game
/// that unlocks steadily must not fill the folder with near-identical frames.
static LAST_UNLOCK_SHOT_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn unlock_screenshot_allowed() -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0);
    let last = LAST_UNLOCK_SHOT_MS.load(Ordering::SeqCst);
    if now.saturating_sub(last) < 15_000 {
        return false;
    }
    LAST_UNLOCK_SHOT_MS.store(now, Ordering::SeqCst);
    true
}

/// Saves the current frame to the running game's screenshot folder. The empty
/// app name asks the capture code to use the launcher's active session.
fn capture_unlock_souvenir() -> Option<String> {
    crate::legendary::screenshots::capture_game_screenshot_sync("", "")
        .ok()
        .map(|item| item.file_path)
}

/// Emits the card, sound and frontend event for every achievement that was not
/// in `unlocked_set` yet.
///
/// A save load can unlock a whole set in one poll. One card per achievement
/// used to overwrite the previous one (the toast window shows a single card),
/// so the player saw only the last unlock. The burst now shares one card that
/// names the count, while every achievement still gets its own frontend event.
fn emit_new_achievement_unlocks(
    app: &tauri::AppHandle,
    app_id: &str,
    payload_app_id: Option<&str>,
    response: &GameAchievementsResponse,
    unlocked_set: &mut std::collections::HashSet<String>,
    write_cache: bool,
    language: &str,
) {
    // The cache stays keyed by the Steam AppID, while the card and the frontend
    // event name the launcher key (`gog::1207658924`) so the store page updates.
    let payload_key = payload_app_id.unwrap_or(app_id);
    let total_count = response
        .total_achievements
        .max(response.achievements.len() as u32);

    // Collect first: the card decision needs the whole burst.
    let mut newly: Vec<&AchievementItem> = Vec::new();
    for ach in &response.achievements {
        if !ach.unlocked || unlocked_set.contains(&ach.name) {
            continue;
        }
        unlocked_set.insert(ach.name.clone());
        newly.push(ach);
    }
    if newly.is_empty() {
        return;
    }

    let options = achievement_notification_options(app);
    let store_key = if write_cache {
        "steam"
    } else if payload_app_id.is_some() {
        // A store game bridged through a local emulator keeps its own mute.
        notification_store_key(payload_key)
    } else {
        "custom"
    };
    let store_enabled = !options.disabled_stores.iter().any(|s| s == store_key);
    let game_enabled = achievement_game_notifications_enabled(payload_key);
    let base_notify = options.enabled && store_enabled && game_enabled;

    // Achievements that earn a visible card. The threshold only filters what it
    // can measure; a store without a rarity figure always passes.
    let announced: Vec<&AchievementItem> = newly
        .iter()
        .copied()
        .filter(|ach| {
            rarity_allows_notification(
                &options,
                ach.rarity.as_ref().and_then(|r| r.percent),
            )
        })
        .collect();

    let unlocked_count = (unlocked_set.len() as u32).min(total_count.max(1));
    let lead_name = announced.first().map(|ach| ach.name.clone());
    // A souvenir of the moment: one frame per burst, at most every 15 seconds.
    // The capture refuses when the game window is not foreground, so an
    // alt-tabbed desktop never ends up in the game's gallery. The store and
    // game mutes still apply; the master card switch does not, because a saved
    // frame is not a notification.
    let souvenir = if options.unlock_screenshots
        && store_enabled
        && game_enabled
        && !announced.is_empty()
        && unlock_screenshot_allowed()
    {
        capture_unlock_souvenir()
    } else {
        None
    };
    if base_notify && !announced.is_empty() {
        let tier_of = |ach: &AchievementItem| {
            classify_achievement_rarity_tier(
                ach.rarity.as_ref().and_then(|r| r.percent),
                ach.tier.as_ref().map(|t| t.name.as_str()),
                unlocked_count,
                total_count,
            )
            .0
        };
        // One chime for the burst, tuned to its rarest member.
        let card_tier = announced.iter().map(|ach| tier_of(ach)).max().unwrap_or(2);
        let rarest = announced
            .iter()
            .filter_map(|ach| ach.rarity.as_ref().and_then(|r| r.percent))
            .fold(None::<f64>, |acc, pct| Some(acc.map_or(pct, |best| best.min(pct))));
        let lead = announced[0];
        let lead_display = if lead.display_name.trim().is_empty() {
            lead.name.clone()
        } else {
            lead.display_name.clone()
        };

        if options.overlay {
            let mut payload = toast_payload(
                &options,
                card_tier,
                unlocked_count,
                total_count,
                rarest,
                &lead_display,
                &lead.description,
            );
            if announced.len() > 1 {
                payload.batch = announced.len() as u32;
                payload.batch_names = announced
                    .iter()
                    .map(|ach| {
                        if ach.display_name.trim().is_empty() {
                            ach.name.clone()
                        } else {
                            ach.display_name.clone()
                        }
                    })
                    .collect();
            }
            let generation = crate::overlay::toast::show(app, payload);
            attach_achievement_icon(app, &lead.icon_link, generation);
        }
        play_achievement_notification_sound(app, &options, card_tier);
    }

    // Every new unlock still reaches the lists and the bell, whether or not a
    // card played for it.
    for ach in &newly {
        let display = if ach.display_name.trim().is_empty() {
            ach.name.clone()
        } else {
            ach.display_name.clone()
        };
        let rarity_percent = ach.rarity.as_ref().and_then(|r| r.percent);
        let (_, resolved_tier_name) = classify_achievement_rarity_tier(
            rarity_percent,
            ach.tier.as_ref().map(|t| t.name.as_str()),
            unlocked_count,
            total_count,
        );
        let notified = base_notify && announced.iter().any(|entry| entry.name == ach.name);
        let payload = AchievementUnlockedPayload {
            app_id: payload_key.to_string(),
            name: ach.name.clone(),
            display_name: display,
            description: ach.description.clone(),
            icon_url: ach.icon_link.clone(),
            notification: notified,
            card: notified && options.overlay,
            rarity_percent,
            tier: Some(resolved_tier_name),
            unlocked_count: Some(unlocked_count),
            total_count: Some(total_count),
            screenshot: if lead_name.as_deref() == Some(ach.name.as_str()) {
                souvenir.clone()
            } else {
                None
            },
        };
        let _ = app.emit("achievement-unlocked", payload);
    }
    // The drawer and the library summary read this file; an unlock must land
    // there without waiting for the next page open. Emulator-only titles have
    // no Steam client entry, so they keep their own store.
    if write_cache {
        let _ = write_achievements_cache(app, app_id, response, language);
    }
}

/// Cheap change detector for the watcher: the Steam stats file (the client
/// writes it on every unlock) and the emulator achievement file. Without it the
/// loop parsed the schema and scanned emulator folders every 800 ms for a fact
/// that had not changed.
fn file_stamp(path: &Path) -> (u64, u64) {
    std::fs::metadata(path)
        .map(|meta| {
            let modified = meta
                .modified()
                .ok()
                .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|duration| duration.as_millis() as u64)
                .unwrap_or(0);
            (modified, meta.len())
        })
        .unwrap_or((0, 0))
}

fn watcher_stamp(
    steam: Option<&Path>,
    account: Option<u64>,
    app_id: &str,
    emulator_file: Option<&Path>,
) -> (u64, u64, u64, u64) {
    let stats = steam
        .zip(account)
        .map(|(root, id)| app_stats_file(root, id, app_id))
        .map(|path| file_stamp(&path))
        .unwrap_or((0, 0));
    let emulator = emulator_file.map(file_stamp).unwrap_or((0, 0));
    (stats.0, stats.1, emulator.0, emulator.1)
}

/// The emulator file a watcher should watch, honoring the per-game source
/// config. Resolved once; the loop refreshes it while it is missing (the game
/// writes its first unlock after launch).
fn watcher_emulator_file(app: &tauri::AppHandle, app_id: &str) -> Option<PathBuf> {
    let overrides = load_source_overrides(app);
    let config = overrides.get(app_id).cloned().unwrap_or_default();
    let mode = if config.mode.is_empty() {
        "auto"
    } else {
        config.mode.as_str()
    };
    if mode == "disabled" {
        return None;
    }
    let custom = config.custom_path.as_deref().map(Path::new);
    let remembered = ACHIEVEMENT_DIRS
        .lock()
        .ok()
        .and_then(|lock| lock.as_ref().and_then(|map| map.get(app_id).cloned()));
    find_emulator_achievement_file(app_id, custom.or(remembered.as_deref()))
}

fn start_achievement_watcher(
    app: tauri::AppHandle,
    app_id: String,
    emulator_only: bool,
    language: &'static str,
    payload_app_id: Option<String>,
) {
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
    let payload_key = payload_app_id;

    std::thread::spawn(move || {
        let steam = steam_install_path();
        let local_snapshot = if emulator_only {
            None
        } else {
            steam.as_deref().and_then(|path| {
                read_local_achievements_with_app(Some(&app_handle), path, &target_app_id, language)
            })
        };
        // A custom game usually has no Steam client schema. Only ask the public
        // page when the local snapshot is missing; the answer is cached on disk.
        let community = if local_snapshot.is_none() {
            tauri::async_runtime::block_on(fetch_community_schema(
                &app_handle,
                &target_app_id,
                false,
                language,
            ))
        } else {
            None
        };

        // One metadata read per tick, and the full parse only when one of the
        // two files the unlock lands in actually changed. The baseline stamp is
        // taken before the snapshot, so an unlock between the two is caught by
        // the next tick instead of waiting for the safety rebuild.
        let account = steam.as_deref().and_then(steam_account_id);
        let mut emulator_file = watcher_emulator_file(&app_handle, &target_app_id);
        let mut last_stamp = watcher_stamp(
            steam.as_deref(),
            account,
            &target_app_id,
            emulator_file.as_deref(),
        );

        let initial = local_snapshot.or_else(|| {
            watcher_snapshot(
                &app_handle,
                &target_app_id,
                steam.as_deref(),
                community.as_deref(),
                emulator_only,
                language,
            )
        });
        // Local stats and emulator files were already checked synchronously at
        // launch; if no achievement file existed yet on disk, the baseline is 0
        // unlocked achievements (`initialised = true`).
        let initialised = true;
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

        let mut ticks: u64 = 0;

        while running_flag.load(Ordering::Relaxed) {
            std::thread::sleep(std::time::Duration::from_millis(800));
            if !running_flag.load(Ordering::Relaxed) {
                break;
            }
            ticks += 1;

            // The emulator file can appear after launch and later be replaced
            // under a new name; look again while the cached path is missing.
            if ticks % 4 == 0 && emulator_file.is_none() {
                emulator_file = watcher_emulator_file(&app_handle, &target_app_id);
            }

            let stamp = watcher_stamp(
                steam.as_deref(),
                account,
                &target_app_id,
                emulator_file.as_deref(),
            );
            // 12 ticks (~10 s) is the safety net for a file rewritten with the
            // same size and a rounded timestamp: the parse still happens, just
            // not twelve times in a row.
            let forced = ticks % 12 == 0;
            if stamp == last_stamp && !forced {
                continue;
            }
            last_stamp = stamp;

            let Some(response) = watcher_snapshot(
                &app_handle,
                &target_app_id,
                steam.as_deref(),
                community.as_deref(),
                emulator_only,
                language,
            ) else {
                continue;
            };
            emit_new_achievement_unlocks(
                &app_handle,
                &target_app_id,
                payload_key.as_deref(),
                &response,
                &mut unlocked_set,
                !emulator_only,
                language,
            );
        }

        // The emulator may flush its achievement file while the process exits.
        // A new watcher for the same app owns the slot when the map points at a
        // different flag; only the final stop leaves the slot empty.
        let replaced_by_newer = ACTIVE_WATCHERS
            .lock()
            .ok()
            .and_then(|lock| {
                lock.as_ref()
                    .and_then(|map| map.get(&target_app_id))
                    .map(|flag| !Arc::ptr_eq(flag, &running_flag))
            })
            .unwrap_or(false);
        if initialised && !replaced_by_newer {
            if let Some(response) = watcher_snapshot(
                &app_handle,
                &target_app_id,
                steam.as_deref(),
                community.as_deref(),
                emulator_only,
                language,
            ) {
                emit_new_achievement_unlocks(
                    &app_handle,
                    &target_app_id,
                    payload_key.as_deref(),
                    &response,
                    &mut unlocked_set,
                    !emulator_only,
                    language,
                );
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
    let steam = steam_install_path();
    let account = steam.as_deref().and_then(steam_account_id);
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
            // A cached answer older than the client's stats file is stale: the
            // stats scan below owns that app until the next fetch rewrites it.
            if let (Some(steam), Some(account)) = (steam.as_deref(), account) {
                let stats = app_stats_file(steam, account, &app_id);
                if modified_secs(&stats).map(|at| at > cached.fetched_at).unwrap_or(false) {
                    continue;
                }
            }
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
                progress_known: true,
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
        .filter(|cached| now_secs().saturating_sub(cached.fetched_at) < ACH_TOTALS_TTL_SECS)
        // Any unlock in any game changes the scan; the per-app check above
        // cannot see a game whose page was never opened.
        .filter(|cached| {
            steam
                .as_deref()
                .map(|steam| !stats_dir_changed_since(steam, cached.fetched_at))
                .unwrap_or(true)
        });
    let totals = match cached {
        Some(cached) => cached.totals,
        None => match steam.as_deref() {
            Some(steam) => {
                let totals = read_local_achievement_totals(steam);
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
                progress_known: true,
                ..Default::default()
            },
        );
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(windows)]
    use super::sound::synthesize_dopamine_chime_wav;

    use crate::legendary::models::{AchievementItem, GameAchievementsResponse};
    use super::super::runtime::steam_install_path;

    #[test]
    fn a_missing_card_theme_falls_back_to_gold() {
        assert_eq!(normalize_card_theme(None), "gold");
        assert_eq!(normalize_card_theme(Some("launcher")), "launcher");
        assert_eq!(normalize_card_theme(Some("neon")), "gold");
    }

    #[test]
    fn the_rarity_threshold_only_filters_what_it_can_measure() {
        let mut options = AchievementNotificationOptions::default();
        assert!(rarity_allows_notification(&options, Some(80.0)));
        assert!(rarity_allows_notification(&options, None));

        options.min_rarity_percent = 10;
        assert!(rarity_allows_notification(&options, Some(4.2)));
        assert!(rarity_allows_notification(&options, Some(10.0)));
        assert!(!rarity_allows_notification(&options, Some(10.5)));
        assert!(!rarity_allows_notification(&options, Some(80.0)));
        // A store with no rarity figure is never hidden by the threshold.
        assert!(rarity_allows_notification(&options, None));
        assert!(rarity_allows_notification(&options, Some(0.0)));
    }

    #[test]
    fn the_rarity_threshold_is_one_of_four_choices() {
        assert_eq!(normalize_min_rarity(Some(25)), 25);
        assert_eq!(normalize_min_rarity(Some(10)), 10);
        assert_eq!(normalize_min_rarity(Some(5)), 5);
        assert_eq!(normalize_min_rarity(Some(12)), 0);
        assert_eq!(normalize_min_rarity(None), 0);
    }

    #[test]
    fn the_watcher_stamp_changes_when_the_unlock_file_is_rewritten() {
        let dir = std::env::temp_dir().join(format!("efx-stamp-{}", std::process::id()));
        let path = dir.join("UserGameStats_1_2.bin");
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(&path, b"one").expect("first write");
        let first = file_stamp(&path);
        std::fs::write(&path, b"two!").expect("second write");
        let second = file_stamp(&path);
        assert_ne!(first, second, "a rewritten stats file must invalidate the skip");
        let _ = std::fs::remove_dir_all(&dir);
    }


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
    fn sparse_numeric_sections_do_not_unlock_their_neighbours() {
        let parsed = parse_achievements_ini(
            "[1]\nAchieved=1\nUnlockTime=1700000000\n\
             [2]\nAchieved=1\nUnlockTime=1700000001\n\
             [31]\nAchieved=1\nUnlockTime=1700000002\n\
             [SteamAchievements]\n00000=1\n00001=2\n00002=31\nCount=3\n",
        );
        assert!(is_emulator_unlocked(&parsed, "1", 0, "0").is_some());
        assert!(is_emulator_unlocked(&parsed, "2", 1, "1").is_some());
        assert!(is_emulator_unlocked(&parsed, "31", 30, "30").is_some());
        assert_eq!(is_emulator_unlocked(&parsed, "3", 2, "2"), None);
        assert_eq!(is_emulator_unlocked(&parsed, "32", 31, "31"), None);
    }

    #[test]
    fn emulator_build_unlocks_only_the_sections_named_in_the_file() {
        let schema: Vec<CommunityAchievement> = ["1", "2", "3", "31", "32"]
            .iter()
            .map(|api_name| CommunityAchievement {
                api_name: api_name.to_string(),
                name: api_name.to_string(),
                description: String::new(),
                hidden: false,
                icon_achieved: String::new(),
                icon_unachieved: String::new(),
            })
            .collect();
        let emu = parse_achievements_ini(
            "[1]\nAchieved=1\nUnlockTime=1700000000\n\
             [2]\nAchieved=1\nUnlockTime=1700000001\n\
             [31]\nAchieved=1\nUnlockTime=1700000002\n\
             [SteamAchievements]\n00000=1\n00001=2\n00002=31\nCount=3\n",
        );
        let response = build_emulator_achievements(&schema, &emu);
        assert_eq!(response.user_unlocked, 3);
        let unlocked: Vec<&str> = response
            .achievements
            .iter()
            .filter(|ach| ach.unlocked)
            .map(|ach| ach.name.as_str())
            .collect();
        assert_eq!(unlocked, ["1", "2", "31"]);
    }

    #[test]
    fn emulator_file_search_reads_steam_settings_next_to_the_game() {
        let root = std::env::temp_dir().join(format!(
            "efxlve-achievements-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let settings = root.join("steam_settings");
        std::fs::create_dir_all(&settings).expect("create settings dir");
        let file = settings.join("achievements.ini");
        std::fs::write(&file, "[1]\nAchieved=1\nUnlockTime=1700000000\n").expect("write file");

        let exe_dir = root.join("Binaries").join("Win64");
        std::fs::create_dir_all(&exe_dir).expect("create exe dir");

        let found = find_emulator_achievement_file("999999999", Some(&exe_dir));
        assert_eq!(found.as_deref(), Some(file.as_path()));

        let _ = std::fs::remove_dir_all(&root);
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

    #[test]
    fn steam_language_follows_the_launcher_locale() {
        assert_eq!(steam_language(Some("tr")), "turkish");
        assert_eq!(steam_language(Some("pt-BR")), "brazilian");
        assert_eq!(steam_language(Some("zh-Hans")), "schinese");
        assert_eq!(steam_language(Some("zh-Hant")), "tchinese");
        assert_eq!(steam_language(Some("ko")), "koreana");
        // Steam ships no Hindi text; the English schema is the fallback.
        assert_eq!(steam_language(Some("hi")), "english");
        assert_eq!(steam_language(Some("unknown")), "english");
        assert_eq!(steam_language(None), "english");
    }

    #[test]
    fn schema_display_text_follows_the_requested_language() {
        // display -> name -> { english, turkish }
        let mut data: Vec<u8> = Vec::new();
        data.push(0);
        data.extend_from_slice(b"1\0");
        data.push(0);
        data.extend_from_slice(b"display\0");
        data.push(0);
        data.extend_from_slice(b"name\0");
        data.push(1);
        data.extend_from_slice(b"english\0");
        data.extend_from_slice(b"Prism Unfurl\0");
        data.push(1);
        data.extend_from_slice(b"turkish\0");
        data.extend_from_slice(b"Prizma\0");
        data.push(8); // end name
        data.push(8); // end display
        data.push(8); // end 1
        data.push(8); // end root object

        let root = parse_binary_vdf(&data).expect("parsed");
        let display = root.get("1").and_then(|app| app.get("display"));
        assert_eq!(
            localized_display(display, "name", "turkish", "fallback"),
            "Prizma"
        );
        // A language the schema does not carry falls back to English.
        assert_eq!(
            localized_display(display, "name", "german", "fallback"),
            "Prism Unfurl"
        );
        // A missing field falls back to the caller's value.
        assert_eq!(
            localized_display(display, "desc", "turkish", "fallback"),
            "fallback"
        );
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

    #[test]
    fn anim_style_and_rarity_tier_normalize_cleanly() {
        assert_eq!(normalize_card_theme(Some("rarity")), "rarity");
        assert_eq!(normalize_card_theme(Some("cyber")), "cyber");
        assert_eq!(normalize_card_theme(Some("emerald")), "emerald");
        assert_eq!(normalize_card_theme(Some("crimson")), "crimson");
        assert_eq!(normalize_card_theme(Some("amethyst")), "amethyst");
        assert_eq!(normalize_anim_style(None), "prism");
        assert_eq!(normalize_anim_style(Some("cyber")), "cyber");
        assert_eq!(normalize_anim_style(Some("shatter")), "shatter");
        assert_eq!(normalize_anim_style(Some("jackpot")), "jackpot");
        assert_eq!(normalize_anim_style(Some("xbox")), "xbox");
        assert_eq!(normalize_anim_style(Some("playstation")), "playstation");
        assert_eq!(normalize_anim_style(Some("epic")), "epic");
        assert_eq!(normalize_anim_style(Some("unknown")), "prism");
        assert_eq!(normalize_exit_style(None), "auto");
        assert_eq!(normalize_exit_style(Some("collapse")), "collapse");
        assert_eq!(normalize_exit_style(Some("glide")), "glide");
        assert_eq!(normalize_exit_style(Some("fold")), "fold");
        assert_eq!(normalize_exit_style(Some("laser")), "laser");
        assert_eq!(normalize_exit_style(Some("implode")), "implode");
        assert_eq!(normalize_exit_style(Some("zoom")), "zoom");
        assert_eq!(
            normalize_disabled_stores(&[
                "Steam".into(),
                "EPIC".into(),
                "steam".into(),
                "invalid".into()
            ]),
            vec!["steam".to_string(), "epic".to_string()]
        );

        assert_eq!(
            classify_achievement_rarity_tier(Some(1.5), Some("gold"), 5, 34),
            (3, "ultra".to_string())
        );
        assert_eq!(
            classify_achievement_rarity_tier(Some(50.0), Some("bronze"), 34, 34),
            (4, "platinum".to_string())
        );
    }

    #[cfg(windows)]
    #[test]
    fn synthesized_dopamine_chime_produces_valid_riff_wav() {
        let wav = synthesize_dopamine_chime_wav("prism", 3);
        assert!(wav.len() > 44);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }

    #[test]
    fn detects_steam_app_id_near_executables_and_inis() {
        let root = std::env::temp_dir().join(format!(
            "efxlve-detect-appid-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let exe_dir = root.join("Game").join("Binaries").join("Win64");
        let third_party = root
            .join("Engine")
            .join("Binaries")
            .join("ThirdParty")
            .join("Steamworks")
            .join("Steamv153a")
            .join("Win64");
        std::fs::create_dir_all(&exe_dir).expect("create exe_dir");
        std::fs::create_dir_all(&third_party).expect("create third_party");

        let ini = third_party.join("steam_emu.ini");
        std::fs::write(&ini, "[Settings]\n# comment\nAppId = 1874000 ; Life is Strange\n")
            .expect("write ini");
        let exe = exe_dir.join("Game-Win64-Shipping.exe");
        assert_eq!(
            detect_steam_app_id_for_exe(&exe).as_deref(),
            Some("1874000")
        );

        let appid_txt = root.join("steam_appid.txt");
        std::fs::write(&appid_txt, "\u{feff}319630\r\n").expect("write txt");
        assert_eq!(
            detect_steam_app_id_for_exe(&exe).as_deref(),
            Some("319630")
        );

        let _ = std::fs::remove_dir_all(&root);
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

    #[test]
    fn probe_reads_the_steamworks_dll_and_the_local_emulator_file() {
        let root = std::env::temp_dir().join(format!(
            "efxlve-achievement-probe-{}-{}",
            std::process::id(),
            now_secs()
        ));
        let third_party = root
            .join("Engine")
            .join("Binaries")
            .join("ThirdParty")
            .join("Steamworks")
            .join("Steamv132")
            .join("Win64");
        std::fs::create_dir_all(&third_party).expect("create steamworks dir");
        std::fs::write(third_party.join("steam_api64.dll"), [0u8; 32]).expect("write dll");
        let settings = root.join("steam_settings");
        std::fs::create_dir_all(&settings).expect("create settings dir");
        std::fs::write(settings.join("steam_appid.txt"), "987654321").expect("write appid");
        std::fs::write(
            settings.join("achievements.json"),
            r#"{"ACH_ONE":{"name":"One","earned":false,"earned_time":0}}"#,
        )
        .expect("write achievements");

        let probe = probe_installation(None, Some(&root));
        assert!(probe.steamworks);
        assert_eq!(probe.app_id, "987654321");
        assert!(probe
            .dll
            .as_deref()
            .is_some_and(|path| path.ends_with("steam_api64.dll")));
        assert!(probe
            .emulator
            .as_deref()
            .is_some_and(|path| path.ends_with("achievements.json")));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn generated_definitions_keep_an_existing_earned_flag() {
        let schema = vec![
            CommunityAchievement {
                api_name: "ACH_ONE".into(),
                name: "First".into(),
                description: "Do the first thing".into(),
                hidden: false,
                icon_achieved: "https://cdn/one.png".into(),
                icon_unachieved: "https://cdn/one_gray.png".into(),
            },
            CommunityAchievement {
                api_name: "ACH_TWO".into(),
                name: "Second".into(),
                description: String::new(),
                hidden: true,
                icon_achieved: String::new(),
                icon_unachieved: String::new(),
            },
        ];
        let existing: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(r#"{"ACH_ONE":{"earned":true,"earned_time":1700000000}}"#)
                .expect("existing definitions");
        let definitions = emulator_definitions_json(&schema, &existing);
        let one = definitions.get("ACH_ONE").expect("first achievement");
        assert_eq!(one["earned"], serde_json::json!(true));
        assert_eq!(one["earned_time"], serde_json::json!(1_700_000_000i64));
        assert_eq!(one["name"], serde_json::json!("First"));
        assert_eq!(one["icon"], serde_json::json!("https://cdn/one.png"));
        let two = definitions.get("ACH_TWO").expect("second achievement");
        assert_eq!(two["earned"], serde_json::json!(false));
        assert_eq!(two["icon_gray"], serde_json::json!(""));
        assert_eq!(definitions.len(), 2);
    }
}
