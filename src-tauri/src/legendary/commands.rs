//! Epic/Legendary Tauri commands exposed to the frontend.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{de::DeserializeOwned, Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncReadExt;

use super::{cache, client, cmd_error, downloader, skip, transient_reason, models::*, paths, LegendaryError};
use crate::{load_settings, save_settings};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub needs_download: bool,
    pub alt_bin: Option<String>,
}

fn resolve_or_err(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    let settings = load_settings(app);
    paths::resolve_binary(app, settings.alt_legendary_bin.as_deref()).map_err(cmd_error)
}

/// Writes the full error output to a file and returns a user-friendly message.
/// File: `<app_data>/logs/legendary-error.log` (read for diagnostics).
fn fail(app: &AppHandle, e: LegendaryError) -> String {
    if let LegendaryError::CommandFailed { stderr_full, .. } = &e {
        let path = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("logs")
            .join("legendary-error.log");
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let capped: String = stderr_full.chars().take(30_000).collect();
        let _ = std::fs::write(path, capped);
    }
    cmd_error(e)
}

#[tauri::command]
pub async fn epic_setup_status(app: AppHandle) -> Result<SetupStatus, String> {
    let settings = load_settings(&app);
    let path = paths::resolve_binary(&app, settings.alt_legendary_bin.as_deref()).ok();
    let mut version = None;
    if let Some(ref p) = path {
        version = downloader::binary_version(p).await.ok();
    }
    let needs_download = version.is_none();
    Ok(SetupStatus {
        binary_path: path.map(|p| p.to_string_lossy().to_string()),
        version,
        needs_download,
        alt_bin: settings.alt_legendary_bin,
    })
}

#[tauri::command]
pub async fn epic_ensure_binary(app: AppHandle) -> Result<String, String> {
    let settings = load_settings(&app);
    downloader::ensure_binary(&app, settings.alt_legendary_bin)
        .await
        .map(|p| p.to_string_lossy().to_string())
        .map_err(|e| fail(&app, e))
}

/// Legendary config dir: when the entitlement database exists at the default location
/// there is no need to run `status`, because even `status --offline` fetches
/// missing metadata one by one, can hit 401, and is slow!
async fn config_dir_for(bin: &Path) -> PathBuf {
    let def = skip::default_config_dir();
    if def.join("assets.json").is_file() {
        return def;
    }
    client::run_json::<LegendaryStatus>(bin, &["status", "--offline", "--json"])
        .await
        .map(|st| PathBuf::from(st.config_directory))
        .unwrap_or(def)
}

/// Resilient command runner: on a 401 catalog error it skips the item automatically,
/// and on transient errors (429/network) it waits and retries.
///
/// IMPORTANT: every command that syncs (including `status --offline`) must go through here,
/// because legendary tries to fetch games with missing metadata one by one even in
/// `--offline` mode (the retry path in core.py) and crashes on a broken item.
async fn run_with_recovery<T: DeserializeOwned>(
    app: &AppHandle,
    bin: &Path,
    config_dir: &Path,
    args: &[&str],
) -> Result<T, String> {
    let mut last_err: String;
    let mut time_retries = 0u8;
    let mut total_skips = 0u32;
    let mut repeat_guard: Option<(String, u8)> = None;
    loop {
        match client::run_json_timeout(bin, args, client::LIST_TIMEOUT_SECS).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                // 401 catalog error + URL present -> skip the item automatically and continue.
                // No fixed budget: each skip is progress; it stops via the stall guard.
                if let LegendaryError::CommandFailed { stderr_tail, .. } = &e {
                    if let Some((ns, item)) = skip::parse_401_item(stderr_tail) {
                        let key = format!("{ns}:{item}");
                        let repeats = match &repeat_guard {
                            Some((k, n)) if k == &key => *n + 1,
                            _ => 1,
                        };
                        repeat_guard = Some((key, repeats));
                        if repeats >= 3 {
                            last_err = format!(
                                "{}\nBu oge atlanamiyor ({ns}/{item}).",
                                fail(app, e)
                            );
                            break;
                        }
                        if total_skips >= 60 {
                            last_err = fail(app, e);
                            break;
                        }
                        match skip::skip_item(app, config_dir, &ns, &item) {
                            Ok(app_name) => {
                                total_skips += 1;
                                time_retries = 0;
                                let _ = app.emit(
                                    "legendary-library",
                                    LibraryEvent {
                                        state: "skipped".into(),
                                        attempt: total_skips.min(255) as u8,
                                        message: format!(
                                            "Epic'te erisilemeyen oge atlandi ({app_name}) [toplam {total_skips}] — devam ediliyor..."
                                        ),
                                    },
                                );
                                continue;
                            }
                            Err(skip_err) => {
                                last_err =
                                    format!("{}\nAtlama basarisiz: {}", fail(app, e), skip_err);
                                break;
                            }
                        }
                    }
                }
                // Transient error (429/network) -> wait and retry (up to 3 times).
                let reason = match &e {
                    LegendaryError::CommandFailed { stderr_tail, .. } => {
                        transient_reason(stderr_tail)
                    }
                    _ => None,
                };
                last_err = fail(app, e);
                let Some(reason) = reason else {
                    break;
                };
                if time_retries >= 3 {
                    break;
                }
                time_retries += 1;
                let wait_secs = if time_retries == 1 { 20 } else { 45 };
                let _ = app.emit(
                    "legendary-library",
                    LibraryEvent {
                        state: "retrying".into(),
                        attempt: time_retries,
                        message: format!(
                            "{reason} — {wait_secs} sn sonra tekrar deneniyor ({time_retries}/3)..."
                        ),
                    },
                );
                tokio::time::sleep(Duration::from_secs(wait_secs)).await;
            }
        }
    }
    Err(last_err)
}

#[tauri::command]
pub async fn epic_status(app: AppHandle) -> Result<LegendaryStatus, String> {
    let bin = resolve_or_err(&app)?;
    let config_dir = config_dir_for(&bin).await;
    run_with_recovery(&app, &bin, &config_dir, &["status", "--offline", "--json"]).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryEvent {
    state: String,
    attempt: u8,
    message: String,
}

#[tauri::command]
pub async fn epic_list_games(app: AppHandle) -> Result<Vec<LegendaryGame>, String> {
    let bin = resolve_or_err(&app)?;
    let config_dir = config_dir_for(&bin).await;
    let mut games: Vec<LegendaryGame> =
        run_with_recovery(&app, &bin, &config_dir, &["list", "-T", "--json"]).await?;
    for g in &mut games {
        slim_game(g);
    }
    Ok(games)
}

#[tauri::command]
pub fn epic_list_skipped(app: AppHandle) -> Vec<String> {
    skip::load_skipped(&app)
        .into_iter()
        .map(|s| s.app_name)
        .collect()
}

/// Instant library from the disk cache (no network, no subprocess).
/// The UI shows this first; the `epic_list_games` sync runs in the background.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CachedLibrary {
    pub account: Option<String>,
    pub account_id: Option<String>,
    pub games: Vec<LegendaryGame>,
    pub installed: Vec<InstalledGame>,
    pub skipped: Vec<String>,
}

#[tauri::command]
pub fn epic_cached_library(app: AppHandle) -> CachedLibrary {
    let config = skip::default_config_dir();
    let (account, account_id) = match cache::read_user(&config) {
        Some((name, id)) => (Some(name), id),
        None => (None, None),
    };
    CachedLibrary {
        account,
        account_id,
        games: cache::read_cached_games(&config),
        installed: cache::read_installed(&config),
        skipped: skip::load_skipped(&app)
            .into_iter()
            .map(|s| s.app_name)
            .collect(),
    }
}

#[tauri::command]
pub async fn epic_list_installed(_app: AppHandle) -> Result<Vec<InstalledGame>, String> {
    let config = skip::default_config_dir();
    Ok(cache::read_installed(&config))
}

/// Accepts a raw code or a JSON body containing `authorizationCode`,
/// exactly as legendary does.
fn extract_auth_code(input: &str) -> Result<String, super::LegendaryError> {
    use super::LegendaryError;
    let t = input.trim();
    if t.is_empty() {
        return Err(LegendaryError::ParseError("@t:auth.codeEmpty".into()));
    }
    if t.starts_with('{') {
        let v: serde_json::Value =
            serde_json::from_str(t).map_err(|e| LegendaryError::ParseError(e.to_string()))?;
        return v
            .get("authorizationCode")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| LegendaryError::ParseError("@t:auth.noAuthCode".into()));
    }
    Ok(t.trim_matches('"').trim().to_string())
}

#[tauri::command]
pub async fn epic_login_with_code(app: AppHandle, code: String) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    let code = extract_auth_code(&code).map_err(|e| fail(&app, e))?;
    client::run_unit(&bin, &["auth", "--code", &code])
        .await
        .map_err(|e| fail(&app, e))?;
    let st: LegendaryStatus = client::run_json(&bin, &["status", "--offline", "--json"])
        .await
        .map_err(|e| fail(&app, e))?;
    Ok(st.account)
}

#[tauri::command]
pub async fn epic_import_egl(app: AppHandle) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    client::run_unit(&bin, &["-y", "auth", "--import"])
        .await
        .map_err(|e| fail(&app, e))?;
    let st: LegendaryStatus = client::run_json(&bin, &["status", "--offline", "--json"])
        .await
        .map_err(|e| fail(&app, e))?;
    Ok(st.account)
}

#[tauri::command]
pub async fn epic_logout(app: AppHandle) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    client::run_unit(&bin, &["-y", "auth", "--delete"])
        .await
        .map_err(|e| fail(&app, e))?;
    Ok("@t:auth.loggedOut".into())
}

#[tauri::command]
pub fn epic_get_settings(app: AppHandle) -> crate::EpicSettings {
    load_settings(&app)
}

#[tauri::command]
pub fn epic_set_alt_bin(app: AppHandle, path: Option<String>) -> Result<crate::EpicSettings, String> {
    let mut s = load_settings(&app);
    s.alt_legendary_bin = path.and_then(|p| {
        let t = p.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    save_settings(&app, &s);
    Ok(s)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdnProbe {
    pub host: String,
    pub url: String,
    pub ms: u64,
}

/// Measures time-to-first-byte for each unique CDN host in `base_urls`.
/// Used to pick the fastest CDN (`--preferred-cdn`) before installing.
#[tauri::command]
pub async fn epic_measure_cdns(base_urls: Vec<String>) -> Result<Vec<CdnProbe>, String> {
    use std::collections::HashSet;
    use std::time::{Duration, Instant};

    let mut seen = HashSet::new();
    let mut targets: Vec<(String, String)> = Vec::new();
    for raw in base_urls {
        let parsed = match url::Url::parse(&raw) {
            Ok(u) => u,
            Err(_) => continue,
        };
        if let Some(host) = parsed.host_str() {
            let host = host.to_string();
            if seen.insert(host.clone()) {
                targets.push((host, raw));
            }
        }
    }
    if targets.is_empty() {
        return Ok(Vec::new());
    }

    let mut handles = Vec::with_capacity(targets.len());
    for (host, url) in targets {
        handles.push(tokio::spawn(async move {
            let client = reqwest::Client::builder()
                .timeout(Duration::from_secs(4))
                .build()
                .ok()?;
            let start = Instant::now();
            let ok = client
                .get(&url)
                .header("Range", "bytes=0-0")
                .send()
                .await
                .is_ok();
            if !ok {
                return None;
            }
            Some(CdnProbe {
                host,
                url,
                ms: start.elapsed().as_millis() as u64,
            })
        }));
    }

    let mut probes = Vec::new();
    for h in handles {
        if let Ok(Some(p)) = h.await {
            probes.push(p);
        }
    }
    probes.sort_by_key(|p| p.ms);
    Ok(probes)
}

/// Persists the preferred CDN hostname (empty clears it).
#[tauri::command]
pub fn epic_set_preferred_cdn(app: AppHandle, host: Option<String>) -> Result<(), String> {
    let mut s = load_settings(&app);
    s.preferred_cdn = host.and_then(|h| {
        let t = h.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    save_settings(&app, &s);
    Ok(())
}

/// Removes legendary's temporary, metadata and manifest files.
#[tauri::command]
pub async fn epic_cleanup_cache(app: AppHandle) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    client::run_unit(&bin, &["cleanup"])
        .await
        .map_err(|e| fail(&app, e))?;
    Ok("@t:dl.cacheCleared".into())
}

/// Fills in achievement hidden/is_base flags from the metadata file and fills
/// in any missing description/name/icons.
pub fn enrich_achievements_from_metadata(resp: &mut GameAchievementsResponse, app_name: &str) {
    let config = skip::default_config_dir();
    let meta_path = config.join("metadata").join(format!("{app_name}.json"));
    if !meta_path.is_file() {
        return;
    }
    if let Ok(content) = std::fs::read_to_string(&meta_path) {
        if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
            if let Some(ach_meta) = val.get("achievements") {
                if let Some(arr) = ach_meta.get("achievements").and_then(|a| a.as_array()) {
                    for item in arr {
                        if let Some(meta_ach) = item.get("achievement") {
                            let name = meta_ach.get("name").and_then(|v| v.as_str()).unwrap_or_default();
                            if name.is_empty() {
                                continue;
                            }
                            let hidden = meta_ach.get("hidden").and_then(|v| v.as_bool()).unwrap_or(false);
                            let is_base = meta_ach
                                .get("isBase")
                                .or_else(|| meta_ach.get("is_base"))
                                .and_then(|v| v.as_bool())
                                .unwrap_or(true);
                            let unlocked_name = meta_ach
                                .get("unlockedDisplayName")
                                .or_else(|| meta_ach.get("unlocked_display_name"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            let unlocked_desc = meta_ach
                                .get("unlockedDescription")
                                .or_else(|| meta_ach.get("unlocked_description"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();
                            let unlocked_icon = meta_ach
                                .get("unlockedIconLink")
                                .or_else(|| meta_ach.get("unlocked_icon_link"))
                                .and_then(|v| v.as_str())
                                .unwrap_or_default();

                            if let Some(target) = resp.achievements.iter_mut().find(|a| a.name == name) {
                                if hidden {
                                    target.hidden = true;
                                }
                                target.is_base = is_base;
                                if target.display_name.trim().is_empty() && !unlocked_name.is_empty() {
                                    target.display_name = unlocked_name.to_string();
                                }
                                if target.description.trim().is_empty() && !unlocked_desc.is_empty() {
                                    target.description = unlocked_desc.to_string();
                                }
                                if target.icon_link.trim().is_empty() && !unlocked_icon.is_empty() {
                                    target.icon_link = unlocked_icon.to_string();
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

#[tauri::command]
pub async fn epic_get_achievements(
    app: AppHandle,
    app_name: String,
    force_refresh: Option<bool>,
) -> Result<GameAchievementsResponse, String> {
    let cache_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("achievements");
    let cache_file = cache_dir.join(format!("{app_name}.json"));

    if !force_refresh.unwrap_or(false) && cache_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&cache_file) {
            if let Ok(mut data) = serde_json::from_str::<GameAchievementsResponse>(&content) {
                data.consolidate();
                enrich_achievements_from_metadata(&mut data, &app_name);
                data.consolidate();
                if !data.achievements.is_empty() || data.supported == Some(false) {
                    return Ok(data);
                }
            }
        }
    }

    let bin = resolve_or_err(&app)?;
    let resp_res = client::run_json::<GameAchievementsResponse>(&bin, &["achievements", "--json", &app_name]).await;

    let resp = match resp_res {
        Ok(mut r) => {
            r.consolidate();
            enrich_achievements_from_metadata(&mut r, &app_name);
            r.consolidate();
            r.supported = Some(r.total_achievements > 0);
            r
        }
        Err(e) => {
            let s = e.to_string();
            // For games without achievements, legendary returns empty output, "No achievements" or a NoneType AttributeError.
            if s.contains("@t:err.emptyOutput")
                || s.contains("No achievements")
                || s.contains("AttributeError")
                || s.contains("NoneType")
            {
                let mut empty_resp = GameAchievementsResponse::default();
                empty_resp.supported = Some(false);
                empty_resp
            } else {
                return Err(fail(&app, e));
            }
        }
    };

    let _ = std::fs::create_dir_all(&cache_dir);
    if let Ok(json_str) = serde_json::to_string_pretty(&resp) {
        let _ = std::fs::write(&cache_file, json_str);
    }

    Ok(resp)
}

#[tauri::command]
pub fn epic_get_achievements_summary(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, GameAchievementSummary>, String> {
    let config = skip::default_config_dir();
    let cache_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("achievements");
    Ok(scan_achievements_summary(&config, &cache_dir))
}

pub fn scan_achievements_summary(
    config: &std::path::Path,
    cache_dir: &std::path::Path,
) -> std::collections::HashMap<String, GameAchievementSummary> {
    use std::collections::HashMap;

    let mut out: HashMap<String, GameAchievementSummary> = HashMap::new();

    // 1. First scan legendary's own cached achievements.json file
    // (stored per namespace: e.g. "carnation", "2e92a78949e2474aa89271b8b893f3b0")
    // Values: (total_unlocked, total_xp, has_plat, base_unlocked, base_user_xp)
    let mut user_ach_map: HashMap<String, (u32, u32, bool, u32, u32)> = HashMap::new();
    let leg_ach_file = config.join("achievements.json");
    if leg_ach_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&leg_ach_file) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(obj) = val.as_object() {
                    for (ns_key, data) in obj {
                        let total_unlocked = data
                            .get("totalUnlocked")
                            .and_then(|v| v.as_u64())
                            .or_else(|| {
                                data.get("achievementSets")
                                    .and_then(|s| s.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|x| {
                                                x.get("totalUnlocked").and_then(|u| u.as_u64())
                                            })
                                            .sum()
                                    })
                            })
                            .unwrap_or(0) as u32;

                        let total_xp = data
                            .get("totalXP")
                            .and_then(|v| v.as_u64())
                            .or_else(|| {
                                data.get("achievementSets")
                                    .and_then(|s| s.as_array())
                                    .map(|arr| {
                                        arr.iter()
                                            .filter_map(|x| {
                                                x.get("totalXP").and_then(|u| u.as_u64())
                                            })
                                            .sum()
                                    })
                            })
                            .unwrap_or(0) as u32;

                        let (base_unlocked, base_user_xp) = data
                            .get("achievementSets")
                            .and_then(|s| s.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .find(|s| {
                                        s.get("isBase")
                                            .or_else(|| s.get("is_base"))
                                            .and_then(|b| b.as_bool())
                                            .unwrap_or(false)
                                    })
                                    .map(|s| {
                                        let u = s.get("totalUnlocked").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                        let x = s.get("totalXP").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                        (u, x)
                                    })
                                    .unwrap_or((0, 0))
                            })
                            .unwrap_or((0, 0));

                        let has_plat = data
                            .get("playerAwards")
                            .or_else(|| data.get("user_awards"))
                            .and_then(|a| a.as_array())
                            .map(|arr| {
                                arr.iter().any(|aw| {
                                    aw.get("awardType")
                                        .and_then(|t| t.as_str())
                                        .map(|s| s.eq_ignore_ascii_case("PLATINUM"))
                                        .unwrap_or(false)
                                    })
                            })
                            .unwrap_or(false);

                        user_ach_map.insert(
                            ns_key.to_lowercase(),
                            (total_unlocked, total_xp, has_plat, base_unlocked, base_user_xp),
                        );
                    }
                }
            }
        }
    }

    // 2. Match each game's total achievement and XP counts from the metadata folder
    let metadata_dir = config.join("metadata");
    if metadata_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(metadata_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let app_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if app_name.is_empty() {
                    continue;
                }
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                        if let Some(ach) = val.get("achievements") {
                            let total = ach
                                .get("total_achievements")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32;
                            let total_xp = ach
                                .get("total_product_xp")
                                .and_then(|v| v.as_u64())
                                .unwrap_or(0) as u32;
                            if total > 0 {
                                let ns = ach
                                    .get("namespace")
                                    .or_else(|| val.get("namespace"))
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&app_name)
                                    .to_lowercase();

                                let (base_total, _base_xp) = ach
                                    .get("achievement_sets")
                                    .or_else(|| ach.get("achievementSets"))
                                    .and_then(|s| s.as_array())
                                    .map(|sets| {
                                        sets.iter()
                                            .find(|s| {
                                                s.get("isBase")
                                                    .or_else(|| s.get("is_base"))
                                                    .and_then(|b| b.as_bool())
                                                    .unwrap_or(false)
                                            })
                                            .map(|s| {
                                                let cnt = s
                                                    .get("totalAchievements")
                                                    .or_else(|| s.get("total_achievements"))
                                                    .and_then(|v| v.as_u64())
                                                    .unwrap_or(0) as u32;
                                                let xp = s.get("totalXP").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
                                                (cnt, xp)
                                            })
                                            .unwrap_or((0, 0))
                                    })
                                    .unwrap_or((0, 0));

                                let (user_unlocked, user_xp, has_plat, base_unlocked, _base_user_xp) = user_ach_map
                                    .get(&ns)
                                    .or_else(|| user_ach_map.get(&app_name.to_lowercase()))
                                    .copied()
                                    .unwrap_or((0, 0, false, 0, 0));

                                let base_plat = base_total > 0 && base_unlocked >= base_total;
                                let all_plat = total > 0 && user_unlocked >= total;
                                let is_platinum = base_plat || all_plat || has_plat;

                                out.insert(
                                    app_name.clone(),
                                    GameAchievementSummary {
                                        app_name: app_name.clone(),
                                        user_unlocked,
                                        total_achievements: total,
                                        user_xp,
                                        total_xp,
                                        is_platinum,
                                        supported: true,
                                        base_achievements: base_total,
                                        base_unlocked,
                                    },
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    // 3. Also merge cache files saved on demand from the detail drawer
    if cache_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(cache_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let app_name = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or_default()
                    .to_string();
                if let Ok(content) = std::fs::read_to_string(&path) {
                    if let Ok(mut data) = serde_json::from_str::<GameAchievementsResponse>(&content) {
                        data.consolidate();
                        enrich_achievements_from_metadata(&mut data, &app_name);
                        data.consolidate();
                        let total = if data.total_achievements > 0 {
                            data.total_achievements
                        } else {
                            data.achievements.len() as u32
                        };
                        let is_plat = data.is_platinum;
                        out.entry(app_name.clone())
                            .and_modify(|s| {
                                s.user_unlocked = data.user_unlocked;
                                s.user_xp = data.user_xp;
                                s.is_platinum = is_plat;
                                s.base_achievements = data.base_achievements;
                                s.base_unlocked = data.base_unlocked;
                            })
                            .or_insert(GameAchievementSummary {
                                app_name,
                                user_unlocked: data.user_unlocked,
                                total_achievements: total,
                                user_xp: data.user_xp,
                                total_xp: data.total_xp,
                                is_platinum: is_plat,
                                supported: true,
                                base_achievements: data.base_achievements,
                                base_unlocked: data.base_unlocked,
                            });
                    }
                }
            }
        }
    }

    out
}

/// Derives possible URL slug candidates from the Epic Games Store title and local metadata.
pub fn generate_slug_candidates(
    title: &str,
    folder_name: Option<&str>,
    custom_slug: Option<&str>,
) -> Vec<String> {
    let clean = |s: &str| -> String {
        s.to_lowercase()
            .chars()
            .map(|c| match c {
                'ç' | 'Ç' => 'c',
                'ğ' | 'Ğ' => 'g',
                'ı' | 'İ' => 'i',
                'ö' | 'Ö' => 'o',
                'ş' | 'Ş' => 's',
                'ü' | 'Ü' => 'u',
                // Unicode quotes, apostrophes, dashes, special symbols
                '’' | '‘' | '“' | '”' | '\'' | '"' | '`' | '™' | '®' | '©' | ':' | '!' | '?'
                | '.' | ',' | '-' | '–' | '—' | '_' | '(' | ')' | '[' | ']' | '{' | '}'
                | '/' | '\\' | '|' | '+' | '&' | '\u{00a0}' => ' ',
                _ => c,
            })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join("-")
    };

    let split_camel_or_case = |s: &str| -> String {
        let mut res = String::new();
        let chars: Vec<char> = s.chars().collect();
        for i in 0..chars.len() {
            if i > 0 {
                let prev = chars[i - 1];
                let curr = chars[i];
                let lower_to_upper = prev.is_alphabetic() && prev.is_lowercase() && curr.is_uppercase();
                let letter_to_digit = prev.is_alphabetic() && curr.is_ascii_digit();
                let digit_to_letter = prev.is_ascii_digit() && curr.is_alphabetic();
                if lower_to_upper || letter_to_digit || digit_to_letter {
                    res.push(' ');
                }
            }
            res.push(chars[i]);
        }
        res
    };

    let mut list = Vec::new();
    let mut add = |s: &str| {
        let c = clean(s);
        if c.len() > 1 && !list.contains(&c) {
            list.push(c);
        }
    };

    if let Some(cs) = custom_slug {
        add(cs);
    }

    add(title);

    if let Some(fn_str) = folder_name {
        add(fn_str);
        add(&split_camel_or_case(fn_str));
    }

    // 1. Strip the colon (subtitle) and dashes: "The Dungeon of Naheulbeuk: The Amulet of Chaos" -> "the-dungeon-of-naheulbeuk"
    if let Some(pos) = title.find(':') {
        add(&title[..pos]);
    }
    if let Some(pos) = title.find(" - ") {
        add(&title[..pos]);
    }
    if let Some(pos) = title.find(" – ") {
        add(&title[..pos]);
    }

    // 2. Produce an alternative by stripping known publisher and series prefixes
    let lower = title.to_lowercase();
    let prefixes = [
        "tom clancy's ",
        "tom clancy’s ",
        "tom clancys ",
        "sid meier's ",
        "sid meier’s ",
        "sid meiers ",
        "marvel's ",
        "marvel’s ",
        "marvels ",
        "disney's ",
        "disney’s ",
        "disneys ",
        "disney ",
        "warhammer 40,000: ",
        "warhammer 40000: ",
        "warhammer: ",
        "warhammer ",
        "ea sports ",
        "star wars: ",
        "star wars™: ",
        "star wars™ ",
        "star wars ",
        "the lord of the rings: ",
        "the lord of the rings ",
        "lego® ",
        "lego ",
        "a game of thrones: ",
        "grand theft auto: ",
    ];

    for p in prefixes {
        if lower.starts_with(p) {
            let rest = &title[p.len()..];
            add(rest);
            if let Some(pos) = rest.find(':') {
                add(&rest[..pos]);
            }
        }
    }

    // 3. Produce an alternative by stripping known edition suffixes
    let suffixes = [
        "standard edition",
        "definitive edition",
        "enhanced edition",
        "deluxe edition",
        "special edition",
        "complete edition",
        "complete journey",
        "game of the year edition",
        "game of the year",
        "goty edition",
        "goty",
        "anniversary edition",
        "zen edition",
        "pre-game editor",
        "editor",
        "digital edition",
        "next stop",
    ];

    for suffix in suffixes {
        if let Some(pos) = lower.find(suffix) {
            let prefix = &title[..pos].trim().trim_end_matches(&['-', ':', '–', '—'][..]);
            add(prefix);
        }
    }

    list
}

/// Fetches and returns HowLongToBeat data.
#[tauri::command]
pub async fn epic_get_hltb(
    title: String,
    app_name: String,
    force_refresh: Option<bool>,
) -> Result<crate::legendary::hltb::HltbData, String> {
    let force = force_refresh.unwrap_or(false);
    Ok(crate::legendary::hltb::get_hltb_data(&title, &app_name, force).await)
}

/// Fetches and returns critic and review data (OpenCritic, Metacritic, IGDB).
#[tauri::command]
pub async fn epic_get_critic(
    title: String,
    app_name: String,
    force_refresh: Option<bool>,
) -> Result<crate::legendary::critic::CriticData, String> {
    let force = force_refresh.unwrap_or(false);
    Ok(crate::legendary::critic::get_critic_data(&title, &app_name, force).await)
}

/// Fetches system requirements from the Epic Games Store content API and caches them to disk.
#[tauri::command]
pub async fn epic_get_system_requirements(
    _app: AppHandle,
    title: String,
    app_name: String,
    force_refresh: Option<bool>,
) -> Result<GameRequirementsResponse, String> {
    let config_dir = skip::default_config_dir();
    let specs_dir = config_dir.join("specs");
    let cache_file = specs_dir.join(format!("{}.json", app_name));
    let force = force_refresh.unwrap_or(false);

    // 1. Check the disk cache first (only supported, fresh entries with the new schema)
    if !force && cache_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&cache_file) {
            if let Ok(cached) = serde_json::from_str::<GameRequirementsResponse>(&content) {
                if cached.supported && content.contains("\"short_description\"") {
                    return Ok(cached);
                }
            }
        }
    }

    // 2. Scan FolderName and custom slug from the local metadata file
    let meta_file = config_dir.join("metadata").join(format!("{}.json", app_name));
    let mut folder_name: Option<String> = None;
    let mut custom_slug: Option<String> = None;

    if meta_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&meta_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let meta = v.get("metadata").unwrap_or(&v);
                if let Some(cattr) = meta.get("customAttributes") {
                    if let Some(fn_val) = cattr.get("FolderName").and_then(|x| x.get("value")).and_then(|x| x.as_str()) {
                        folder_name = Some(fn_val.to_string());
                    }
                    if let Some(ps_val) = cattr.get("com.epicgames.app.productSlug").and_then(|x| x.get("value")).and_then(|x| x.as_str()) {
                        custom_slug = Some(ps_val.to_string());
                    }
                }
                if custom_slug.is_none() {
                    if let Some(ps) = meta.get("productSlug").and_then(|x| x.as_str()) {
                        custom_slug = Some(ps.to_string());
                    } else if let Some(us) = meta.get("urlSlug").and_then(|x| x.as_str()) {
                        custom_slug = Some(us.to_string());
                    }
                }
            }
        }
    }

    // 3. Prepare slug candidates
    let slugs = generate_slug_candidates(&title, folder_name.as_deref(), custom_slug.as_deref());
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;

    let locales = ["tr-TR", "en-US"];

    for slug in &slugs {
        for locale in &locales {
            let url = format!(
                "https://store-content-ipv4.ak.epicgames.com/api/{}/content/products/{}",
                locale, slug
            );

            let resp = match client
                .get(&url)
                .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                .send()
                .await
            {
                Ok(r) if r.status().is_success() => r,
                _ => continue,
            };

            let text = match resp.text().await {
                Ok(t) => t,
                Err(_) => continue,
            };

            if let Ok(body) = serde_json::from_str::<serde_json::Value>(&text) {
                if let Some(pages) = body.get("pages").and_then(|p| p.as_array()) {
                    for page in pages {
                        let page_data = page.get("data");
                        let reqs = page_data.and_then(|d| d.get("requirements"));

                        let mut store_desc: Option<String> = None;
                        let mut store_short_desc: Option<String> = None;
                        let mut store_tags: Vec<String> = Vec::new();

                        if let Some(about) = page_data.and_then(|d| d.get("about")) {
                            if let Some(sd) = about.get("shortDescription").and_then(|s| s.as_str()) {
                                if !sd.trim().is_empty() {
                                    store_short_desc = Some(sd.trim().to_string());
                                }
                            }
                            if let Some(desc) = about.get("description").and_then(|s| s.as_str()) {
                                if !desc.trim().is_empty() {
                                    store_desc = Some(desc.trim().to_string());
                                }
                            }
                        }

                        if let Some(tags_arr) = page_data.and_then(|d| d.get("meta")).and_then(|m| m.get("tags")).and_then(|t| t.as_array()) {
                            store_tags = tags_arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect();
                        }

                        let languages = reqs
                            .and_then(|r| r.get("languages"))
                            .and_then(|l| l.as_array())
                            .map(|arr| {
                                arr.iter()
                                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                    .collect()
                            })
                            .unwrap_or_default();

                        let mut systems = Vec::new();
                        if let Some(sys_arr) = reqs.and_then(|r| r.get("systems")).and_then(|s| s.as_array()) {
                            for sys_val in sys_arr {
                                let sys_type = sys_val
                                    .get("systemType")
                                    .and_then(|t| t.as_str())
                                    .unwrap_or("Windows")
                                    .to_string();

                                let mut details = Vec::new();
                                if let Some(det_arr) = sys_val.get("details").and_then(|d| d.as_array()) {
                                    for det in det_arr {
                                        let det_title = det
                                            .get("title")
                                            .and_then(|t| t.as_str())
                                            .unwrap_or("")
                                            .to_string();
                                        if det_title.is_empty() {
                                            continue;
                                        }
                                        let minimum = det
                                            .get("minimum")
                                            .and_then(|m| m.as_str())
                                            .map(|s| s.to_string());
                                        let recommended = det
                                            .get("recommended")
                                            .and_then(|r| r.as_str())
                                            .map(|s| s.to_string());
                                        details.push(SystemDetailItem {
                                            title: det_title,
                                            minimum,
                                            recommended,
                                        });
                                    }
                                }

                                if !details.is_empty() {
                                    systems.push(SystemRequirement {
                                        system_type: sys_type,
                                        details,
                                    });
                                }
                            }
                        }

                        if !systems.is_empty() || store_short_desc.is_some() || store_desc.is_some() {
                            let result = GameRequirementsResponse {
                                supported: true,
                                systems,
                                languages,
                                app_name: app_name.clone(),
                                description: store_desc,
                                short_description: store_short_desc,
                                tags: store_tags,
                            };

                            let _ = std::fs::create_dir_all(&specs_dir);
                            if let Ok(json_str) = serde_json::to_string(&result) {
                                let _ = std::fs::write(&cache_file, json_str);
                            }

                            return Ok(result);
                        }
                    }
                }
            }
        }
    }

    // If not found, return supported: false gracefully (do not lock failures to disk permanently)
    let fallback = GameRequirementsResponse {
        supported: false,
        systems: vec![],
        languages: vec![],
        app_name: app_name.clone(),
        description: None,
        short_description: None,
        tags: vec![],
    };

    Ok(fallback)
}

/// Detects games installed through the Epic Games Launcher.
#[tauri::command]
pub async fn epic_detect_egl_games(_app: AppHandle) -> Result<Vec<cache::EglDetectedGame>, String> {
    Ok(cache::read_egl_installed_games())
}

/// Persistently syncs games detected in the Epic Games Launcher into installed.json.
#[tauri::command]
pub async fn epic_sync_egl_installed(_app: AppHandle) -> Result<u32, String> {
    let config = skip::default_config_dir();
    let installed_path = config.join("installed.json");
    let mut map: std::collections::HashMap<String, InstalledGame> = match std::fs::read_to_string(&installed_path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => std::collections::HashMap::new(),
    };

    let egl_games = cache::read_egl_installed_games();
    let mut imported_count = 0;

    for egl in egl_games {
        if !map.contains_key(&egl.app_name) {
            map.insert(
                egl.app_name.clone(),
                InstalledGame {
                    app_name: egl.app_name,
                    title: egl.title,
                    version: egl.version,
                    install_path: egl.install_path,
                    install_size: egl.install_size,
                    executable: egl.executable,
                    can_run_offline: true,
                    egl_guid: String::new(),
                    launch_parameters: String::new(),
                    manifest_path: String::new(),
                    needs_verification: false,
                    platform: "Windows".to_string(),
                    prereq_info: None,
                    uninstaller: None,
                    requires_ot: false,
                    save_path: None,
                    is_preloaded: false,
                    is_dlc: false,
                    base_urls: vec![],
                    install_tags: vec![],
                },
            );
            imported_count += 1;
        }
    }

    if imported_count > 0 {
        let json_str = serde_json::to_string_pretty(&map).map_err(|e| e.to_string())?;
        std::fs::write(&installed_path, json_str).map_err(|e| e.to_string())?;
    }

    Ok(imported_count)
}

/* ---------- Third-party launchers (EA App, Ubisoft Connect, Rockstar) ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyLauncher {
    pub id: String,
    pub name: String,
    pub installed: bool,
    pub version: Option<String>,
    pub install_path: Option<String>,
    pub download_url: String,
}

/// Scans the `Uninstall` keys in the Windows registry and returns
/// (DisplayName, DisplayVersion, InstallLocation) triples.
fn scan_uninstall_registry() -> Vec<(String, Option<String>, Option<String>)> {
    fn reg_value(rest: &str) -> Option<String> {
        for marker in ["REG_EXPAND_SZ", "REG_SZ"] {
            if let Some(idx) = rest.find(marker) {
                return Some(rest[idx + marker.len()..].trim().to_string());
            }
        }
        None
    }

    let roots = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ];

    let mut result = Vec::new();
    for root in roots {
        let output = match std::process::Command::new("reg")
            .args(["query", root, "/s"])
            .output()
        {
            Ok(o) if o.status.success() => o,
            _ => continue,
        };
        let text = String::from_utf8_lossy(&output.stdout);
        let mut name: Option<String> = None;
        let mut version: Option<String> = None;
        let mut location: Option<String> = None;

        for line in text.lines() {
            if line.starts_with("HKEY_") {
                if let Some(n) = name.take() {
                    result.push((n, version.take(), location.take()));
                }
                version = None;
                location = None;
            } else {
                let trimmed = line.trim();
                if let Some(rest) = trimmed.strip_prefix("DisplayName") {
                    name = reg_value(rest);
                } else if let Some(rest) = trimmed.strip_prefix("DisplayVersion") {
                    version = reg_value(rest);
                } else if let Some(rest) = trimmed.strip_prefix("InstallLocation") {
                    location = reg_value(rest);
                }
            }
        }
        if let Some(n) = name.take() {
            result.push((n, version.take(), location.take()));
        }
    }
    result
}

/// Detects installed third-party game launchers (EA App, Ubisoft Connect,
/// Rockstar Games Launcher) and returns them with version and install path.
#[tauri::command]
pub async fn epic_third_party_launchers() -> Vec<ThirdPartyLauncher> {
    // `reg query /s` walks every uninstall entry, which is slow. Run it on a
    // blocking thread so it never stalls the main thread / UI.
    tauri::async_runtime::spawn_blocking(epic_third_party_launchers_blocking)
        .await
        .unwrap_or_default()
}

fn epic_third_party_launchers_blocking() -> Vec<ThirdPartyLauncher> {
    let entries = scan_uninstall_registry();
    let defs: [(&str, &str, &[&str], &str); 3] = [
        (
            "ea",
            "EA App",
            &["ea app", "origin"],
            "https://www.ea.com/ea-app",
        ),
        (
            "ubisoft",
            "Ubisoft Connect",
            &["ubisoft connect", "uplay"],
            "https://ubisoftconnect.com/",
        ),
        (
            "rockstar",
            "Rockstar Games Launcher",
            &["rockstar games launcher"],
            "https://socialclub.rockstargames.com/rockstar-games-launcher",
        ),
    ];

    defs.iter()
        .map(|(id, name, keys, url)| {
            let found = entries.iter().find(|(n, _, _)| {
                let low = n.to_lowercase();
                keys.iter().any(|k| low.contains(k))
            });
            ThirdPartyLauncher {
                id: (*id).to_string(),
                name: (*name).to_string(),
                installed: found.is_some(),
                version: found.and_then(|(_, v, _)| v.clone()),
                install_path: found.and_then(|(_, _, l)| l.clone()),
                download_url: (*url).to_string(),
            }
        })
        .collect()
}

/* ---------- Game management & verification ---------- */

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyProgressPayload {
    pub id: String,
    pub current: u64,
    pub total: u64,
    pub percent: f64,
    pub speed: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyCompletePayload {
    pub id: String,
    pub success: bool,
    pub message: String,
}

pub struct ParsedVerifyProgress {
    pub current: u64,
    pub total: u64,
    pub percent: f64,
    pub speed: String,
    pub detail: String,
}

pub fn parse_verify_progress(line: &str) -> Option<ParsedVerifyProgress> {
    let clean = line.trim();
    if clean.is_empty() {
        return None;
    }

    // 1. Standart genel ilerleme: Verification progress: 97/236 (26.2%) [0.6 MiB/s]
    if let Some(idx) = clean.find("Verification progress:") {
        let sub = clean[idx + "Verification progress:".len()..].trim();
        let slash = sub.find('/')?;
        let cur: u64 = sub[..slash].trim().parse().ok()?;
        let rest = sub[slash + 1..].trim();
        let space = rest.find(' ')?;
        let total: u64 = rest[..space].trim().parse().ok()?;
        let paren_open = rest.find('(')?;
        let paren_close = rest.find("%)")?;
        let pct: f64 = rest[paren_open + 1..paren_close].trim().parse().ok()?;
        let bracket_open = rest.find('[')?;
        let bracket_close = rest.find(']')?;
        let speed = rest[bracket_open + 1..bracket_close].trim().to_string();
        return Some(ParsedVerifyProgress {
            current: cur,
            total,
            percent: pct,
            speed,
            detail: format!("{cur}/{total} (%{pct:.1})"),
        });
    }

    // 2. Large-file verify progress: => Verifying large file "path/file.ext": 58% (4873.0/8419.3 MiB) [536.4 MiB/s]
    if let Some(idx) = clean.find("Verifying large file") {
        let sub = clean[idx + "Verifying large file".len()..].trim();
        let mut filename = String::new();
        if let Some(q1) = sub.find('"') {
            if let Some(q2) = sub[q1 + 1..].find('"') {
                let path = &sub[q1 + 1..q1 + 1 + q2];
                filename = std::path::Path::new(path)
                    .file_name()
                    .and_then(|f| f.to_str())
                    .unwrap_or(path)
                    .to_string();
            }
        }
        let colon = sub.rfind(':')?;
        let after_colon = sub[colon + 1..].trim();
        let pct_idx = after_colon.find('%')?;
        let pct: f64 = after_colon[..pct_idx].trim().parse().ok()?;

        let speed = if let (Some(b1), Some(b2)) = (after_colon.find('['), after_colon.find(']')) {
            after_colon[b1 + 1..b2].trim().to_string()
        } else {
            "—".to_string()
        };

        let size_str = if let (Some(p1), Some(p2)) = (after_colon.find('('), after_colon.find(')')) {
            after_colon[p1 + 1..p2].trim().to_string()
        } else {
            String::new()
        };

        let detail = if !filename.is_empty() && !size_str.is_empty() {
            format!("{filename} ({size_str})")
        } else if !filename.is_empty() {
            format!("{filename} (%{pct:.0})")
        } else {
            format!("%{pct:.1}")
        };

        return Some(ParsedVerifyProgress {
            current: pct as u64,
            total: 100,
            percent: pct,
            speed,
            detail,
        });
    }

    None
}

#[tauri::command]
pub async fn epic_verify_game(app: AppHandle, app_name: String) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;

    // EGL ile kurulu oyunlarda manifest eksikse otomatik .egstore'dan kopyala
    let config_dir = skip::default_config_dir();
    let installed_file = config_dir.join("installed.json");
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text) {
            if let Some(g) = map.get(&app_name) {
                cache::ensure_egl_manifest(&config_dir, &g.app_name, &g.install_path, &g.version, &g.platform);
            }
        }
    }

    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["verify", &app_name]);
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let app_h = app.clone();
    let id_stdout = app_name.clone();
    let stdout_task = tokio::spawn(async move {
        if let Some(mut pipe) = stdout {
            let mut buf = [0u8; 4096];
            let mut remainder = String::new();
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                remainder.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(pos) = remainder.find(|c| c == '\r' || c == '\n' || c == '\t') {
                    let part = remainder[..pos].to_string();
                    remainder = remainder[pos + 1..].to_string();
                    if let Some(p) = parse_verify_progress(&part) {
                        let _ = app_h.emit(
                            "verify-progress",
                            VerifyProgressPayload {
                                id: id_stdout.clone(),
                                current: p.current,
                                total: p.total,
                                percent: p.percent,
                                speed: p.speed,
                                detail: p.detail,
                            },
                        );
                    }
                }
            }
            if let Some(p) = parse_verify_progress(&remainder) {
                let _ = app_h.emit(
                    "verify-progress",
                    VerifyProgressPayload {
                        id: id_stdout.clone(),
                        current: p.current,
                        total: p.total,
                        percent: p.percent,
                        speed: p.speed,
                        detail: p.detail,
                    },
                );
            }
        }
    });

    let app_h2 = app.clone();
    let id_stderr = app_name.clone();
    let (err_tx, mut err_rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let stderr_task = tokio::spawn(async move {
        if let Some(mut pipe) = stderr {
            let mut buf = [0u8; 4096];
            let mut remainder = String::new();
            while let Ok(n) = pipe.read(&mut buf).await {
                if n == 0 {
                    break;
                }
                remainder.push_str(&String::from_utf8_lossy(&buf[..n]));
                while let Some(pos) = remainder.find(|c| c == '\r' || c == '\n' || c == '\t') {
                    let part = remainder[..pos].to_string();
                    remainder = remainder[pos + 1..].to_string();
                    if part.contains("CRITICAL:") || part.contains("ERROR:") {
                        let _ = err_tx.send(part.clone());
                    }
                    if let Some(p) = parse_verify_progress(&part) {
                        let _ = app_h2.emit(
                            "verify-progress",
                            VerifyProgressPayload {
                                id: id_stderr.clone(),
                                current: p.current,
                                total: p.total,
                                percent: p.percent,
                                speed: p.speed,
                                detail: p.detail,
                            },
                        );
                    }
                }
            }
        }
    });

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let _ = stdout_task.await;
    let _ = stderr_task.await;

    // Critical error check (e.g. missing manifest)
    let mut critical_error: Option<String> = None;
    while let Ok(msg) = err_rx.try_recv() {
        critical_error = Some(msg);
    }

    if status.success() && critical_error.is_none() {
        let msg = "@t:verify.successDetail".to_string();
        let _ = app.emit("verify-complete", VerifyCompletePayload {
            id: app_name.clone(),
            success: true,
            message: msg.clone(),
        });
        Ok(msg)
    } else {
        let raw_err = critical_error.unwrap_or_else(|| "@t:verify.problem".to_string());
        let msg = if raw_err.contains("Manifest appears to be missing") {
            "@t:verify.manifestMissing".to_string()
        } else {
            raw_err
        };
        let _ = app.emit("verify-complete", VerifyCompletePayload {
            id: app_name.clone(),
            success: false,
            message: msg.clone(),
        });
        Err(msg)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameLocalSettings {
    pub app_name: String,
    pub title: String,
    pub launch_parameters: String,
    pub auto_update: bool,
    pub high_priority: bool,
    pub cloud_saves_enabled: bool,
    pub last_cloud_sync: Option<String>,
    pub install_size: u64,
    pub install_path: String,
    pub version: String,
    /// Optional wrapper command passed to `legendary launch --wrapper`.
    #[serde(default)]
    pub wrapper: String,
    /// Extra environment variables exported to the game process.
    #[serde(default)]
    pub env_vars: std::collections::HashMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameCustomConfig {
    pub auto_update: Option<bool>,
    pub high_priority: Option<bool>,
    pub cloud_saves_enabled: Option<bool>,
    pub last_cloud_sync: Option<String>,
    pub wrapper: Option<String>,
    pub env_vars: Option<std::collections::HashMap<String, String>>,
}

pub fn load_all_game_custom_configs() -> std::collections::HashMap<String, GameCustomConfig> {
    let config = skip::default_config_dir();
    let p = config.join("efxlve_game_settings.json");
    if let Ok(text) = std::fs::read_to_string(&p) {
        serde_json::from_str(&text).unwrap_or_default()
    } else {
        std::collections::HashMap::new()
    }
}

fn save_all_game_custom_configs(map: &std::collections::HashMap<String, GameCustomConfig>) {
    let config = skip::default_config_dir();
    let p = config.join("efxlve_game_settings.json");
    if let Ok(json) = serde_json::to_string_pretty(map) {
        let _ = std::fs::write(p, json);
    }
}

pub fn update_game_last_cloud_sync(app_name: &str, timestamp: &str) {
    let mut map = load_all_game_custom_configs();
    let mut entry = map.remove(app_name).unwrap_or_default();
    entry.last_cloud_sync = Some(timestamp.to_string());
    map.insert(app_name.to_string(), entry);
    save_all_game_custom_configs(&map);
}

#[tauri::command]
pub fn epic_get_game_settings(app_name: String) -> Result<GameLocalSettings, String> {
    let config = skip::default_config_dir();
    let installed_file = config.join("installed.json");

    // Fast path: direct read of installed.json (instant, 0ms)
    let mut entry: Option<InstalledGame> = None;
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text) {
            entry = map.get(&app_name).cloned();
        }
    }

    if entry.is_none() {
        for egl in cache::read_egl_installed_games() {
            if egl.app_name == app_name {
                entry = Some(InstalledGame {
                    app_name: egl.app_name,
                    title: egl.title,
                    version: egl.version,
                    install_path: egl.install_path,
                    install_size: egl.install_size,
                    executable: egl.executable,
                    can_run_offline: true,
                    egl_guid: String::new(),
                    launch_parameters: String::new(),
                    manifest_path: String::new(),
                    needs_verification: false,
                    platform: "Windows".to_string(),
                    prereq_info: None,
                    uninstaller: None,
                    requires_ot: false,
                    save_path: None,
                    is_preloaded: false,
                    is_dlc: false,
                    base_urls: vec![],
                    install_tags: vec![],
                });
                break;
            }
        }
    }

    let cfgs = load_all_game_custom_configs();
    let cfg = cfgs.get(&app_name);

    Ok(GameLocalSettings {
        app_name: app_name.clone(),
        title: entry.as_ref().map(|e| e.title.clone()).unwrap_or_else(|| app_name.clone()),
        launch_parameters: entry.as_ref().map(|e| e.launch_parameters.clone()).unwrap_or_default(),
        auto_update: cfg.and_then(|c| c.auto_update).unwrap_or(true),
        high_priority: cfg.and_then(|c| c.high_priority).unwrap_or(false),
        cloud_saves_enabled: cfg.and_then(|c| c.cloud_saves_enabled).unwrap_or(true),
        last_cloud_sync: cfg.and_then(|c| c.last_cloud_sync.clone()),
        install_size: entry.as_ref().map(|e| e.install_size).unwrap_or(0),
        install_path: entry.as_ref().map(|e| e.install_path.clone()).unwrap_or_default(),
        version: entry.as_ref().map(|e| e.version.clone()).unwrap_or_default(),
        wrapper: cfg.and_then(|c| c.wrapper.clone()).unwrap_or_default(),
        env_vars: cfg.and_then(|c| c.env_vars.clone()).unwrap_or_default(),
    })
}

#[tauri::command]
pub fn epic_save_game_settings(settings: GameLocalSettings) -> Result<(), String> {
    let config = skip::default_config_dir();
    let installed_file = config.join("installed.json");

    // 1. Update launch_parameters in installed.json
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(mut map) = serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text) {
            if let Some(entry) = map.get_mut(&settings.app_name) {
                entry.launch_parameters = settings.launch_parameters.trim().to_string();
                if let Ok(out) = serde_json::to_string_pretty(&map) {
                    let _ = std::fs::write(&installed_file, out);
                }
            }
        }
    }

    // 2. Update the settings in efxlve_game_settings.json
    let mut cfgs = load_all_game_custom_configs();
    cfgs.insert(
        settings.app_name,
        GameCustomConfig {
            auto_update: Some(settings.auto_update),
            high_priority: Some(settings.high_priority),
            cloud_saves_enabled: Some(settings.cloud_saves_enabled),
            last_cloud_sync: settings.last_cloud_sync,
            wrapper: Some(settings.wrapper.trim().to_string()),
            env_vars: Some(settings.env_vars),
        },
    );
    save_all_game_custom_configs(&cfgs);
    Ok(())
}

#[tauri::command]
pub async fn epic_sync_saves(app: AppHandle, app_name: String) -> Result<String, String> {
    let bin = resolve_or_err(&app)?;
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.args(["sync-saves", &app_name]);
    let out = cmd.output().await.map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!("{stdout}\n{stderr}");

    if out.status.success() {
        // Record the last sync time
        let now = {
            let local_now = std::time::SystemTime::now();
            let since_epoch = local_now.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs();
            let rem_secs = since_epoch % 86400;
            let hours = (rem_secs / 3600) + 3; // TR UTC+3
            let minutes = (rem_secs % 3600) / 60;
            format!("@t:manage.todayAt\u{1f}{:02}:{:02}", hours % 24, minutes)
        };
        update_game_last_cloud_sync(&app_name, &now);

        Ok("@t:manage.cloudSyncedOk".to_string())
    } else {
        Err(transient_reason(&combined).unwrap_or(&combined).to_string())
    }
}

#[tauri::command]
pub async fn epic_create_desktop_shortcut(_app: AppHandle, app_name: String) -> Result<String, String> {
    let config = skip::default_config_dir();
    let installed_file = config.join("installed.json");

    let mut entry: Option<InstalledGame> = None;
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, InstalledGame>>(&text) {
            entry = map.get(&app_name).cloned();
        }
    }

    if entry.is_none() {
        let installed = cache::read_installed(&config);
        entry = installed.into_iter().find(|g| g.app_name == app_name);
    }

    let entry = entry.ok_or_else(|| "@t:manage.notInstalled".to_string())?;

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let target_exe = if !entry.executable.is_empty() {
            std::path::Path::new(&entry.install_path).join(&entry.executable)
        } else {
            let mut found = None;
            if let Ok(entries) = std::fs::read_dir(&entry.install_path) {
                for e in entries.flatten() {
                    let p = e.path();
                    if p.extension().and_then(|x| x.to_str()) == Some("exe") {
                        found = Some(p);
                        break;
                    }
                }
            }
            found.unwrap_or_else(|| std::path::PathBuf::from(&entry.install_path))
        };

        let title_clean = entry.title.replace(['\\', '/', ':', '*', '?', '"', '<', '>', '|'], " ");
        let ps = format!(
            "$ws = New-Object -ComObject WScript.Shell; $d = [Environment]::GetFolderPath('Desktop'); $lnk = Join-Path $d '{}.lnk'; $s = $ws.CreateShortcut($lnk); $s.TargetPath = '{}'; $s.WorkingDirectory = '{}'; $s.Save()",
            title_clean.trim(),
            target_exe.to_string_lossy().replace('\'', "''"),
            entry.install_path.replace('\'', "''")
        );

        let output = tokio::process::Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .await
            .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(format!("@t:manage.shortcutCreated\u{1f}{}", entry.title))
        } else {
            let err = String::from_utf8_lossy(&output.stderr);
            Err(format!("@t:manage.shortcutCreateFailed\u{1f}{}", err))
        }
    }
    #[cfg(not(windows))]
    {
        Err("@t:manage.shortcutWindowsOnly".to_string())
    }
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDlcItem {
    pub app_id: String,
    pub title: String,
    pub installed: bool,
    pub size: u64,
    pub image: Option<String>,
    #[serde(default = "default_true")]
    pub downloadable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameDlcResponse {
    pub app_name: String,
    pub game_title: String,
    pub dlcs: Vec<GameDlcItem>,
}

#[tauri::command]
pub async fn epic_get_game_dlcs(app_name: String) -> Result<GameDlcResponse, String> {
    let config = skip::default_config_dir();
    let meta_path = config.join("metadata").join(format!("{app_name}.json"));
    if !meta_path.is_file() {
        return Ok(GameDlcResponse {
            app_name: app_name.clone(),
            game_title: app_name,
            dlcs: Vec::new(),
        });
    }

    let meta_raw = std::fs::read_to_string(&meta_path).map_err(|e| e.to_string())?;
    let val: serde_json::Value = serde_json::from_str(&meta_raw).map_err(|e| e.to_string())?;

    let game_title = val
        .get("app_title")
        .and_then(|v| v.as_str())
        .or_else(|| val.pointer("/metadata/title").and_then(|v| v.as_str()))
        .unwrap_or(&app_name)
        .to_string();

    let main_catalog_id = val
        .pointer("/metadata/id")
        .and_then(|v| v.as_str())
        .or_else(|| val.get("id").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    // 1. Read installed.json
    let installed_path = config.join("installed.json");
    let installed_map: serde_json::Value = if installed_path.is_file() {
        std::fs::read_to_string(&installed_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    } else {
        serde_json::Value::Null
    };

    // 2. Read EGL manifests
    #[derive(Deserialize)]
    #[serde(rename_all = "PascalCase")]
    struct EglItemCheck {
        app_name: Option<String>,
        display_name: Option<String>,
        main_game_app_name: Option<String>,
        install_size: Option<u64>,
    }
    let mut egl_items: Vec<EglItemCheck> = Vec::new();
    let egl_manifests_dir = std::path::Path::new(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests");
    if egl_manifests_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(egl_manifests_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|x| x.to_str()) == Some("item") {
                    if let Ok(content) = std::fs::read_to_string(&p) {
                        if let Ok(item) = serde_json::from_str::<EglItemCheck>(&content) {
                            egl_items.push(item);
                        }
                    }
                }
            }
        }
    }

    // 3. Read entitlements.json (licenses the user bought/owns)
    let entitlements_path = config.join("entitlements.json");
    let mut owned_catalog_item_ids = std::collections::HashSet::new();
    let mut owned_entitlement_names = std::collections::HashSet::new();

    if entitlements_path.is_file() {
        if let Ok(ent_str) = std::fs::read_to_string(&entitlements_path) {
            if let Ok(ent_arr) = serde_json::from_str::<Vec<serde_json::Value>>(&ent_str) {
                for e in ent_arr {
                    let status = e.get("status").and_then(|v| v.as_str()).unwrap_or("ACTIVE");
                    if status == "ACTIVE" || status.is_empty() {
                        if let Some(id) = e.get("catalogItemId").and_then(|v| v.as_str()) {
                            if !id.trim().is_empty() {
                                owned_catalog_item_ids.insert(id.trim().to_string());
                            }
                        }
                        if let Some(id) = e.get("entitlementName").and_then(|v| v.as_str()) {
                            if !id.trim().is_empty() {
                                owned_entitlement_names.insert(id.trim().to_string());
                            }
                        }
                        if let Some(id) = e.get("id").and_then(|v| v.as_str()) {
                            if !id.trim().is_empty() {
                                owned_catalog_item_ids.insert(id.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // 4. Read assets.json (downloadable packages and CDN assets)
    let assets_path = config.join("assets.json");
    let mut asset_app_names = std::collections::HashSet::new();
    let mut asset_catalog_item_ids = std::collections::HashSet::new();
    let mut asset_ids = std::collections::HashSet::new();

    if assets_path.is_file() {
        if let Ok(assets_str) = std::fs::read_to_string(&assets_path) {
            if let Ok(assets_map) = serde_json::from_str::<std::collections::HashMap<String, Vec<serde_json::Value>>>(&assets_str) {
                for (_plat, list) in assets_map {
                    for a in list {
                        if let Some(app) = a.get("app_name").and_then(|v| v.as_str()) {
                            if !app.trim().is_empty() {
                                asset_app_names.insert(app.trim().to_string());
                            }
                        }
                        if let Some(cat) = a.get("catalog_item_id").and_then(|v| v.as_str()) {
                            if !cat.trim().is_empty() {
                                asset_catalog_item_ids.insert(cat.trim().to_string());
                            }
                        }
                        if let Some(aid) = a.get("asset_id").and_then(|v| v.as_str()) {
                            if !aid.trim().is_empty() {
                                asset_ids.insert(aid.trim().to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    let has_ownership_records = !owned_catalog_item_ids.is_empty() || !asset_app_names.is_empty();

    let mut dlcs = Vec::new();
    let mut seen_keys = std::collections::HashSet::new();

    if let Some(items) = val.pointer("/metadata/dlcItemList").and_then(|v| v.as_array()) {
        for item in items {
            let title = item.get("title").and_then(|v| v.as_str()).unwrap_or("").trim();
            if title.is_empty() {
                continue;
            }
            let title_lower = title.to_lowercase();
            // Skip internal test / placeholder audience entries (except meaningful package names)
            if (title_lower.ends_with("audience") || title_lower.starts_with("audience "))
                && !title_lower.contains("chapter")
                && !title_lower.contains("pack")
            {
                continue;
            }

            let item_id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").trim();
            let ent_name = item.get("entitlementName").and_then(|v| v.as_str()).unwrap_or("").trim();
            let rel_app_id = item
                .pointer("/releaseInfo/0/appId")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            // Ana oyunun kendisi DLC olarak listelenmemeli
            if (!main_catalog_id.is_empty() && (item_id == main_catalog_id || ent_name == main_catalog_id))
                || (!rel_app_id.is_empty() && rel_app_id == app_name)
            {
                continue;
            }

            let app_id = if !rel_app_id.is_empty() {
                rel_app_id
            } else if !item_id.is_empty() {
                item_id
            } else {
                ent_name
            };

            if app_id.is_empty() {
                continue;
            }

            // Prevent duplicate entries
            let dedup_key = format!("{}:{}", title.to_lowercase(), app_id.to_lowercase());
            if !seen_keys.insert(dedup_key) {
                continue;
            }

            // Kurulu olma durumu
            let is_in_legendary = installed_map.get(app_id).is_some()
                || (!item_id.is_empty() && installed_map.get(item_id).is_some());
            let matching_egl = egl_items.iter().find(|e| {
                e.app_name.as_deref() == Some(app_id)
                    || (!item_id.is_empty() && e.app_name.as_deref() == Some(item_id))
                    || (e.main_game_app_name.as_deref() == Some(&app_name)
                        && e.display_name.as_deref() == Some(title))
            });
            let is_installed = is_in_legendary || matching_egl.is_some();

            // Ownership check: ONLY what the user owns!
            let is_entitled = (!item_id.is_empty() && (owned_catalog_item_ids.contains(item_id) || owned_entitlement_names.contains(item_id)))
                || (!ent_name.is_empty() && (owned_catalog_item_ids.contains(ent_name) || owned_entitlement_names.contains(ent_name)))
                || (!rel_app_id.is_empty() && (owned_catalog_item_ids.contains(rel_app_id) || owned_entitlement_names.contains(rel_app_id)));

            let is_asset = (!rel_app_id.is_empty() && (asset_app_names.contains(rel_app_id) || asset_ids.contains(rel_app_id)))
                || (!item_id.is_empty() && asset_catalog_item_ids.contains(item_id));

            let has_manifest = config.join("metadata").join(format!("{app_id}.json")).is_file();

            let is_owned = if has_ownership_records {
                is_entitled || is_asset || is_installed
            } else {
                is_installed || has_manifest
            };

            if !is_owned {
                continue;
            }

            // Downloadable state: can the Legendary CLI download this package independently?
            // Those with an entry in the assets list, a manifest on disk or already installed are downloadable;
            // account-bound in-game packs (e.g. DBD chapters) are shown as "Active on account".
            let is_downloadable = is_asset || has_manifest || is_installed;

            // Boyut hesaplama
            let mut size = matching_egl.and_then(|e| e.install_size).unwrap_or(0);
            if size == 0 {
                if let Some(g) = installed_map.get(app_id) {
                    size = g.get("install_size").and_then(|v| v.as_u64()).unwrap_or(0);
                }
            }
            if size == 0 {
                let dlc_meta_path = config.join("metadata").join(format!("{app_id}.json"));
                if dlc_meta_path.is_file() {
                    if let Ok(d_str) = std::fs::read_to_string(&dlc_meta_path) {
                        if let Ok(d_val) = serde_json::from_str::<serde_json::Value>(&d_str) {
                            if let Some(arr) = d_val.pointer("/manifest/tag_disk_size").and_then(|v| v.as_array()) {
                                for t in arr {
                                    size += t.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                                }
                            }
                        }
                    }
                }
            }

            // Cover image
            let mut image = None;
            if let Some(imgs) = item.get("keyImages").and_then(|v| v.as_array()) {
                for preferred in &["DieselGameBox", "OfferImageWide", "DieselGameBoxTall", "Thumbnail"] {
                    if let Some(img) = imgs.iter().find(|i| i.get("type").and_then(|t| t.as_str()) == Some(*preferred)) {
                        image = img.get("url").and_then(|u| u.as_str()).map(|s| s.to_string());
                        if image.is_some() {
                            break;
                        }
                    }
                }
                if image.is_none() {
                    image = imgs.first().and_then(|i| i.get("url")).and_then(|u| u.as_str()).map(|s| s.to_string());
                }
            }

            dlcs.push(GameDlcItem {
                app_id: app_id.to_string(),
                title: title.to_string(),
                installed: is_installed,
                size,
                image,
                downloadable: is_downloadable,
            });
        }
    }

    // Also add DLCs that are not in dlcItemList but installed via EGL or manually
    for e in &egl_items {
        if e.main_game_app_name.as_deref() == Some(&app_name) {
            let e_app = e.app_name.as_deref().unwrap_or("");
            let e_title = e.display_name.as_deref().unwrap_or(e_app);
            if !e_app.is_empty() && !e_title.is_empty() {
                let dedup_key = format!("{}:{}", e_title.to_lowercase(), e_app.to_lowercase());
                if seen_keys.insert(dedup_key) {
                    dlcs.push(GameDlcItem {
                        app_id: e_app.to_string(),
                        title: e_title.to_string(),
                        installed: true,
                        size: e.install_size.unwrap_or(0),
                        image: None,
                        downloadable: true,
                    });
                }
            }
        }
    }

    Ok(GameDlcResponse {
        app_name,
        game_title,
        dlcs,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallOptionTag {
    pub tag: String,
    pub label: String,
    pub size: u64,
    pub download_size: u64,
    pub category: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameInstallOptions {
    pub app_name: String,
    pub title: String,
    pub base_size: u64,
    pub base_download_size: u64,
    pub tags: Vec<InstallOptionTag>,
    pub dlcs: Vec<GameDlcItem>,
    pub has_options: bool,
}

fn map_tag_label(tag: &str) -> (&'static str, &'static str) {
    match tag {
        "voice_de_de" => ("Deutsch", "languages"),
        "voice_fr_fr" => ("français", "languages"),
        "voice_es_es" => ("español (España)", "languages"),
        "voice_es_mx" => ("español (Latinoamérica)", "languages"),
        "voice_it_it" => ("italiano", "languages"),
        "voice_ja_jp" => ("日本語", "languages"),
        "voice_ko_kr" => ("한국어", "languages"),
        "voice_pl_pl" => ("polski", "languages"),
        "voice_pt_br" => ("português (Brasil)", "languages"),
        "voice_ru_ru" => ("русский", "languages"),
        "voice_zh_cn" => ("简体中文", "languages"),
        "voice_zh_tw" => ("繁體中文", "languages"),
        "voice_en_us" => ("English (US)", "languages"),
        "hires_textures" | "hi_res_textures" => ("@t:dlc.catHires", "extras"),
        "bonus_content" => ("@t:dlc.catBonus", "extras"),
        _ => {
            if tag.starts_with("voice_") || tag.contains("lang") {
                ("@t:dlc.catExtraLanguage", "languages")
            } else {
                ("@t:dlc.catExtraPack", "extras")
            }
        }
    }
}

#[tauri::command]
pub async fn epic_get_install_options(
    app: AppHandle,
    app_name: String,
) -> Result<GameInstallOptions, String> {
    let dlc_res = epic_get_game_dlcs(app_name.clone()).await?;
    let bin = resolve_or_err(&app)?;

    let mut base_size = 0u64;
    let mut base_download_size = 0u64;
    let mut tags = Vec::new();

    // Call legendary info --offline --json
    if let Ok(val) = client::run_json::<serde_json::Value>(&bin, &["info", &app_name, "--offline", "--json"]).await {
        if let Some(manifest) = val.get("manifest") {
            let disk_tags = manifest.get("tag_disk_size").and_then(|v| v.as_array());
            let dl_tags = manifest.get("tag_download_size").and_then(|v| v.as_array());

            if let Some(d_tags) = disk_tags {
                for item in d_tags {
                    let tag_name = item.get("tag").and_then(|v| v.as_str()).unwrap_or("");
                    let size = item.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
                    let dl_size = dl_tags
                        .and_then(|arr| arr.iter().find(|x| x.get("tag").and_then(|t| t.as_str()) == Some(tag_name)))
                        .and_then(|x| x.get("size").and_then(|v| v.as_u64()))
                        .unwrap_or(size);

                    if tag_name.is_empty() {
                        base_size = size;
                        base_download_size = dl_size;
                    } else {
                        let (label, category) = map_tag_label(tag_name);
                        tags.push(InstallOptionTag {
                            tag: tag_name.to_string(),
                            label: label.to_string(),
                            size,
                            download_size: dl_size,
                            category: category.to_string(),
                        });
                    }
                }
            }
        }
    }

    let dlcs: Vec<GameDlcItem> = dlc_res.dlcs.into_iter().filter(|d| d.downloadable).collect();
    let has_options = !tags.is_empty() || !dlcs.is_empty();

    Ok(GameInstallOptions {
        app_name,
        title: dlc_res.game_title,
        base_size,
        base_download_size,
        tags,
        dlcs,
        has_options,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameUpdateInfo {
    pub app_name: String,
    pub title: String,
    pub installed_version: String,
    pub latest_version: String,
}

#[tauri::command]
pub async fn epic_check_updates() -> Result<Vec<GameUpdateInfo>, String> {
    let config = skip::default_config_dir();
    let installed_path = config.join("installed.json");
    if !installed_path.is_file() {
        return Ok(Vec::new());
    }

    let installed_raw = std::fs::read_to_string(&installed_path).map_err(|e| e.to_string())?;
    let installed_map: serde_json::Value = serde_json::from_str(&installed_raw).map_err(|e| e.to_string())?;

    let meta_dir = config.join("metadata");
    let mut updates = Vec::new();

    if let Some(obj) = installed_map.as_object() {
        for (app_name, val) in obj {
            let installed_ver = val.get("version").and_then(|v| v.as_str()).unwrap_or("").trim();
            let title = val.get("title").and_then(|v| v.as_str()).unwrap_or(app_name).to_string();

            let meta_path = meta_dir.join(format!("{app_name}.json"));
            if meta_path.is_file() {
                if let Ok(meta_raw) = std::fs::read_to_string(&meta_path) {
                    if let Ok(meta_val) = serde_json::from_str::<serde_json::Value>(&meta_raw) {
                        let latest_ver = meta_val
                            .pointer("/asset_infos/Windows/build_version")
                            .and_then(|v| v.as_str())
                            .or_else(|| meta_val.pointer("/metadata/customAttributes/BuildVersion/value").and_then(|v| v.as_str()))
                            .unwrap_or("")
                            .trim();

                        if !installed_ver.is_empty() && !latest_ver.is_empty() && installed_ver != latest_ver {
                            updates.push(GameUpdateInfo {
                                app_name: app_name.clone(),
                                title,
                                installed_version: installed_ver.to_string(),
                                latest_version: latest_ver.to_string(),
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(updates)
}

/// Returns the playtime of all games.
#[tauri::command]
pub fn epic_get_playtimes() -> std::collections::HashMap<String, super::playtime::PlaytimeRecord> {
    super::playtime::get_playtimes()
}

/// Updates/edits a game's playtime and last activity.
#[tauri::command]
pub fn epic_set_playtime(
    app_name: String,
    total_seconds: u64,
    last_played: Option<String>,
) -> Result<super::playtime::PlaytimeRecord, String> {
    super::playtime::set_game_playtime(&app_name, total_seconds, last_played)
}

/// Returns the download network profile ("max", "balanced", "low").
#[tauri::command]
pub fn epic_get_network_profile(app: AppHandle) -> String {
    let s = crate::load_settings(&app);
    s.network_profile.unwrap_or_else(|| "balanced".to_string())
}

/// Saves the download network profile ("max", "balanced", "low").
#[tauri::command]
pub fn epic_set_network_profile(app: AppHandle, profile: String) -> Result<(), String> {
    let mut s = crate::load_settings(&app);
    s.network_profile = Some(profile);
    crate::save_settings(&app, &s);
    Ok(())
}

/// Returns the offline mode state.
#[tauri::command]
pub fn epic_get_offline_mode(app: AppHandle) -> bool {
    let s = crate::load_settings(&app);
    s.offline_mode.unwrap_or(false)
}

/// Saves the offline mode state.
#[tauri::command]
pub fn epic_set_offline_mode(app: AppHandle, enabled: bool) -> Result<(), String> {
    let mut s = crate::load_settings(&app);
    s.offline_mode = Some(enabled);
    crate::save_settings(&app, &s);
    Ok(())
}

/// Backs up a game's saves.
#[tauri::command]
pub fn epic_backup_save(app_name: String) -> Result<super::backup::SaveBackupInfo, String> {
    super::backup::create_backup(&app_name, None)
}

/// Bir oyunun mevcut yedeklerini listeler.
#[tauri::command]
pub fn epic_list_backups(app_name: String) -> Vec<super::backup::SaveBackupInfo> {
    super::backup::list_backups(&app_name)
}

/// Restores a backup to the game.
#[tauri::command]
pub fn epic_restore_backup(app_name: String, backup_id: String) -> Result<String, String> {
    super::backup::restore_backup(&app_name, &backup_id)
}

/// Deletes a backup.
#[tauri::command]
pub fn epic_delete_backup(app_name: String, backup_id: String) -> Result<(), String> {
    super::backup::delete_backup(&app_name, &backup_id)
}

/// Opens the backup folder in Windows Explorer.
#[tauri::command]
pub fn epic_open_backup_folder(app_name: String) -> Result<String, String> {
    let dir = super::backup::app_backup_dir(&app_name);
    if !dir.exists() {
        let _ = std::fs::create_dir_all(&dir);
    }
    std::process::Command::new("explorer")
        .arg(&dir)
        .spawn()
        .map_err(|e| format!("@t:manage.folderOpenFailed\u{1f}{e}"))?;
    Ok("@t:manage.backupFolderOpened".to_string())
}

// -------------------------------------------------------------
// COLLECTION (CATEGORY) MANAGEMENT
// -------------------------------------------------------------

/// Lists all collections
#[tauri::command]
pub fn epic_get_collections() -> Result<Vec<super::collections::GameCollection>, String> {
    super::collections::read_collections()
}

/// Creates a new collection or updates an existing one
#[tauri::command]
pub fn epic_save_collection(
    id: Option<String>,
    name: String,
    app_names: Vec<String>,
    emoji: Option<String>,
) -> Result<super::collections::GameCollection, String> {
    super::collections::save_collection(id, name, app_names, emoji)
}

/// Koleksiyonu siler
#[tauri::command]
pub fn epic_delete_collection(id: String) -> Result<(), String> {
    super::collections::delete_collection(&id)
}

/// Updates the collections a specific game belongs to
#[tauri::command]
pub fn epic_set_game_collections(
    app_name: String,
    collection_ids: Vec<String>,
) -> Result<(), String> {
    super::collections::set_game_collections(&app_name, &collection_ids)
}

/// Imports collections from the Epic Games Launcher LevelDB log
#[tauri::command]
pub fn epic_import_egl_collections() -> Result<Vec<super::collections::GameCollection>, String> {
    super::collections::import_egl_collections()
}

// -------------------------------------------------------------
// PLAYER PROFILE (NATIVE PROFILE VIEW)
// -------------------------------------------------------------

/// Fetches the user profile and achievements from the official Epic Games GraphQL API
#[tauri::command]
pub async fn epic_get_player_profile(
    force_refresh: Option<bool>,
) -> Result<super::profile::EpicPlayerProfile, String> {
    let config = super::skip::default_config_dir();
    super::profile::fetch_player_profile(&config, force_refresh.unwrap_or(false)).await
}

// -------------------------------------------------------------
// MOVE GAME FILES
// -------------------------------------------------------------

/// Lists all local disk drives (C:, D:, ...) and their free space
#[tauri::command]
pub fn epic_get_system_drives() -> Vec<super::move_game::SystemDriveInfo> {
    super::move_game::get_system_drives()
}

/// Opens the native Windows folder picker ("Browse")
#[tauri::command]
pub async fn epic_select_folder_dialog(
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    super::move_game::select_folder_dialog(default_path, title).await
}

/// Moves a game to another folder/drive
#[tauri::command]
pub async fn epic_move_game(
    app: AppHandle,
    app_name: String,
    target_base_path: String,
) -> Result<super::move_game::MoveGameResult, String> {
    let config = super::skip::default_config_dir();
    super::move_game::move_game_folder(app, &config, app_name, target_base_path).await
}

/// Cancels an in-progress game move
#[tauri::command]
pub async fn epic_cancel_move_game(app_name: String) -> bool {
    super::move_game::cancel_move_game(&app_name).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_achievements_carnation() {
        let config = skip::default_config_dir();
        let cache_dir = std::env::temp_dir().join("test_ach_cache");
        let summaries = scan_achievements_summary(&config, &cache_dir);
        for (k, v) in &summaries {
            if v.is_platinum {
                println!("PLATINUM GAME: {} => {:?}", k, v);
            }
        }
        if let Some(carnation) = summaries.get("Carnation") {
            assert_eq!(carnation.total_achievements, 48);
            assert_eq!(carnation.user_unlocked, 48);
            assert_eq!(carnation.is_platinum, true);
        }
    }

    #[test]
    #[ignore = "requires live legendary binary and network"]
    fn test_run_json_achievements_carnation() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let bin = std::path::PathBuf::from("legendary");
            let mut resp: GameAchievementsResponse = client::run_json(&bin, &["achievements", "--json", "Carnation"])
                .await
                .expect("parse edilmeli");
            resp.consolidate();
            println!("TEST RUN CARNATION: achievements.len() = {}", resp.achievements.len());
            println!("TEST RUN CARNATION: user_unlocked = {}", resp.user_unlocked);
            assert_eq!(resp.achievements.len(), 48);
        });
    }

    #[test]
    fn test_enrich_achievements_ginger() {
        let config = skip::default_config_dir();
        if !config.join("metadata").join("Ginger.json").is_file() {
            return;
        }
        let mut resp = GameAchievementsResponse {
            achievements: vec![
                AchievementItem {
                    name: "TheTower".to_string(),
                    display_name: "".to_string(),
                    description: "".to_string(),
                    hidden: false,
                    is_base: true,
                    ..Default::default()
                },
                AchievementItem {
                    name: "BornToBeWild".to_string(),
                    display_name: "".to_string(),
                    description: "".to_string(),
                    hidden: false,
                    is_base: true,
                    ..Default::default()
                },
            ],
            ..Default::default()
        };
        enrich_achievements_from_metadata(&mut resp, "Ginger");
        let b = resp.achievements.iter().find(|a| a.name == "BornToBeWild").unwrap();
        assert!(b.hidden, "BornToBeWild must be marked as a hidden achievement");
        assert!(!b.display_name.is_empty(), "The name must be filled from metadata");

        let t = resp.achievements.iter().find(|a| a.name == "TheTower").unwrap();
        assert!(t.hidden, "TheTower must be hidden");
        assert!(!t.is_base, "TheTower Phantom Liberty DLC'sine aittir (is_base: false)");
        assert!(!t.display_name.is_empty(), "TheTower title must not be empty");
    }

    #[test]
    fn test_generate_slug_candidates() {
        let slugs1 = generate_slug_candidates("Absolute Drift: Zen Edition", None, None);
        assert!(slugs1.contains(&"absolute-drift-zen-edition".to_string()));
        assert!(slugs1.contains(&"absolute-drift".to_string()));

        let slugs2 = generate_slug_candidates("art of rally Standard Edition", Some("artofrally"), None);
        assert!(slugs2.contains(&"art-of-rally-standard-edition".to_string()));
        assert!(slugs2.contains(&"art-of-rally".to_string()));

        let slugs3 = generate_slug_candidates("Mortal Shell™", Some("MortalShell"), None);
        assert_eq!(slugs3[0], "mortal-shell");

        let slugs4 = generate_slug_candidates("Tom Clancy’s Rainbow Six Siege", Some("RainbowSixSiege"), None);
        assert!(slugs4.contains(&"rainbow-six-siege".to_string()), "Rainbow Six Siege slug candidates must include 'rainbow-six-siege'");

        let slugs5 = generate_slug_candidates("The Dungeon Of Naheulbeuk: The Amulet Of Chaos", Some("DungeonOfNaheulbeuk"), None);
        assert!(slugs5.contains(&"the-dungeon-of-naheulbeuk".to_string()));
    }

    #[test]
    fn test_parse_verify_progress() {
        let line1 = "Verification progress: 220/236 (84.5%) [204.2 MiB/s]";
        let res1 = parse_verify_progress(line1);
        assert!(res1.is_some());
        let p1 = res1.unwrap();
        assert_eq!(p1.current, 220);
        assert_eq!(p1.total, 236);
        assert!((p1.percent - 84.5).abs() < 0.01);
        assert_eq!(p1.speed, "204.2 MiB/s");

        let line2 = "=> Verifying large file \"archive/pc/content/audio_2_soundbanks.archive\": 58% (4873.0/8419.3 MiB) [536.4 MiB/s]";
        let res2 = parse_verify_progress(line2);
        assert!(res2.is_some());
        let p2 = res2.unwrap();
        assert_eq!(p2.percent, 58.0);
        assert_eq!(p2.speed, "536.4 MiB/s");
        assert!(p2.detail.contains("audio_2_soundbanks.archive"));
        assert!(p2.detail.contains("4873.0/8419.3 MiB"));
    }

    #[test]
    fn test_epic_get_game_settings() {
        let res = epic_get_game_settings("19927295d6e3467887d4e830d8c85963".to_string());
        assert!(res.is_ok());
        let st = res.unwrap();
        assert_eq!(st.app_name, "19927295d6e3467887d4e830d8c85963");
        assert!(st.auto_update);
    }

    #[test]
    fn test_map_tag_label() {
        let (label_de, cat_de) = map_tag_label("voice_de_de");
        assert_eq!(label_de, "Deutsch");
        assert_eq!(cat_de, "languages");

        let (label_fr, cat_fr) = map_tag_label("voice_fr_fr");
        assert_eq!(label_fr, "français");
        assert_eq!(cat_fr, "languages");

        let (label_tex, cat_tex) = map_tag_label("hires_textures");
        assert_eq!(label_tex, "@t:dlc.catHires");
        assert_eq!(cat_tex, "extras");
    }

    #[test]
    fn test_epic_get_game_dlcs_ginger() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let res = epic_get_game_dlcs("Ginger".to_string()).await.unwrap();
            assert_eq!(res.game_title, "Cyberpunk 2077");
            let phantom = res.dlcs.iter().find(|d| d.title.contains("Phantom Liberty"));
            assert!(phantom.is_some(), "Phantom Liberty DLC must be found");
            assert!(phantom.unwrap().installed, "Phantom Liberty must be installed");
            assert!(phantom.unwrap().size > 0, "Phantom Liberty size must be greater than 0");
            assert!(phantom.unwrap().downloadable, "Phantom Liberty must be downloadable");
        });
    }

    #[test]
    fn test_epic_get_game_dlcs_brill_only_owned() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let res = epic_get_game_dlcs("Brill".to_string()).await.unwrap();
            assert_eq!(res.game_title, "Dead by Daylight");
            // Only the 4 DLCs the user owns must be returned (not the 74 catalog DLCs!)
            assert!(res.dlcs.len() <= 6, "Only owned DLCs must be returned, found: {}", res.dlcs.len());
            // Unowned DLCs (e.g. Castlevania or Doomed Course or unreleased) must NEVER be returned!
            let unowned = res.dlcs.iter().find(|d| {
                d.title.contains("Castlevania")
                    || d.title.contains("Doomed Course")
                    || d.app_id == "a2a562015e724c0ea4ba052c62c9cdee"
            });
            assert!(unowned.is_none(), "Unowned store DLCs must absolutely be filtered out!");
            // One of the owned DLCs (e.g. Halloween Chapter or Silent Hill) must be found
            let halloween = res.dlcs.iter().find(|d| d.title.contains("Halloween") || d.title.contains("Silent Hill"));
            assert!(halloween.is_some(), "A DLC owned by the user must be listed");
            // Dead by Daylight DLCs are account licenses, so downloadable must be false
            if let Some(h) = halloween {
                assert!(!h.downloadable, "DBD account-license DLCs must have downloadable: false");
            }
        });
    }
}

