//! Steam achievements: the client's local stats first, Web API when a key exists.
//!
//! Owns unlock times, rarity tiers, and the per-game cache. Screenshots live
//! in `shots.rs`.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::catalog::steam_get_api_key;
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

/// Achievements straight from the Steam client's own cache:
/// `appcache/stats/UserGameStatsSchema_<app>.bin` (definitions, icons) and
/// `UserGameStats_<account>_<app>.bin` (unlock times). Works offline, needs no
/// Web API key and no public profile; `None` when the client has no schema.
pub fn read_local_achievements(steam: &Path, app_id: &str) -> Option<GameAchievementsResponse> {
    let schema_bytes =
        std::fs::read(stats_dir(steam).join(format!("UserGameStatsSchema_{app_id}.bin"))).ok()?;
    let schema = parse_binary_vdf(&schema_bytes)?;
    let stats = schema.get(app_id)?.get("stats")?;
    let unlock_times = read_unlock_times(steam, app_id);

    let mut groups: Vec<&(String, Vdf)> = stats.entries().iter().collect();
    groups.sort_by_key(|(id, _)| id.parse::<u32>().unwrap_or(u32::MAX));

    let mut items: Vec<AchievementItem> = Vec::new();
    let mut hidden_items: Vec<AchievementItem> = Vec::new();
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
            let unlock_time = unlock_times
                .get(&format!("{group_id}:{bit_id}"))
                .copied()
                .unwrap_or(0);
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
                progress: if unlocked { 1.0 } else { 0.0 },
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
        is_platinum: unlocked == total,
        supported: Some(true),
        ..Default::default()
    })
}

/// Unlocked/total counts for every game the client keeps stats for.
///
/// The total comes from the schema's bit definitions: the stats file's
/// `AchievementTimes` only holds entries that have a recorded time and can even
/// carry leftovers from a predecessor app (CS:GO bits under CS2), so using it
/// as the total made every game look 100% complete.
pub(super) fn read_local_achievement_totals(steam: &Path) -> Vec<(String, u32, u32)> {
    let Some(account) = steam_account_id(steam) else {
        return Vec::new();
    };
    let Ok(entries) = std::fs::read_dir(stats_dir(steam)) else {
        return Vec::new();
    };
    let prefix = format!("UserGameStats_{account}_");
    let mut out = Vec::new();
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

        let (mut total, mut unlocked) = (0u32, 0u32);
        for (group_id, group) in stats.entries() {
            let Some(bits) = group.get("bits") else {
                continue;
            };
            for (bit_id, _) in bits.entries() {
                total += 1;
                if unlock_times
                    .get(&format!("{group_id}:{bit_id}"))
                    .map(|time| *time > 0)
                    .unwrap_or(false)
                {
                    unlocked += 1;
                }
            }
        }
        if total > 0 {
            out.push((app_id.to_string(), unlocked, total));
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
        steam_install_path().and_then(|path| read_local_achievements(&path, &app_id))
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
pub fn steam_get_achievements_summary(
    app: tauri::AppHandle,
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
