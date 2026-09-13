//! Frontend'e açılan Epic/Legendary Tauri komutları.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{de::DeserializeOwned, Serialize};
use tauri::{AppHandle, Emitter, Manager};

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

/// Tam hata çıktısını dosyaya yazıp kullanıcı dostu metni döndürür.
/// Dosya: `<app_data>/logs/legendary-error.log` (tanı için okunur).
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

/// legendary config dizini: varsayılan konumda varlık veritabanı varsa
/// `status` koşturmaya gerek yok — çünkü `status --offline` bile eksik
/// metadataları tek tek çekip 401 yiyebilir, hem de yavaş!
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

/// Kurtarmalı komut koşturucu: 401 katalog hatasında öğeyi otomatik atlar,
/// geçici hatalarda (429/ağ) bekleyip dener.
///
/// ÖNEMLİ: `status --offline` dahil sync yapan her komut buradan geçmelidir —
/// legendary eksik metadatası olan oyunları `--offline` modda bile tek tek
/// çekmeye kalkar (core.py'deki retry yolu) ve bozuk öğede çöker.
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
                // 401 katalog hatası + URL varsa → öğeyi otomatik atla ve devam et.
                // Sabit bütçe yok: her atlama ilerlemedir; takılma korumasıyla durur.
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
                // Geçici hata (429/ağ) → bekleyip tekrar dene (en fazla 3).
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
    run_with_recovery(&app, &bin, &config_dir, &["list", "-T", "--json"]).await
}

#[tauri::command]
pub fn epic_list_skipped(app: AppHandle) -> Vec<String> {
    skip::load_skipped(&app)
        .into_iter()
        .map(|s| s.app_name)
        .collect()
}

/// Diskteki önbellekten anlık kütüphane (ağ yok, subprocess yok).
/// Arayüz önce bunu gösterir; `epic_list_games` senkronu arka planda koşar.
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

/// legendary'nin kabul ettiği gibi ham kod veya `authorizationCode`
/// içeren JSON gövdesini kabul eder.
fn extract_auth_code(input: &str) -> Result<String, super::LegendaryError> {
    use super::LegendaryError;
    let t = input.trim();
    if t.is_empty() {
        return Err(LegendaryError::ParseError("kod boş".into()));
    }
    if t.starts_with('{') {
        let v: serde_json::Value =
            serde_json::from_str(t).map_err(|e| LegendaryError::ParseError(e.to_string()))?;
        return v
            .get("authorizationCode")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| LegendaryError::ParseError("JSON içinde authorizationCode yok".into()));
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
    Ok("Epic oturumu kapatıldı".into())
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

/// Metadata dosyasından başarımların gizlilik (hidden) ve ana oyun (is_base)
/// bilgilerini tamamlar; boş kalan açıklama/isim/ikonları doldurur.
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
            // Legendary başarımı olmayan oyunlar için boş çıktı, "No achievements" veya NoneType AttributeError verir.
            if s.contains("boş çıktı")
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

    // 1. Önce legendary'nin kendi önbelleğindeki achievements.json dosyasını tara
    // (namespace bazlı saklanır: örn. "carnation", "2e92a78949e2474aa89271b8b893f3b0")
    // Değerler: (total_unlocked, total_xp, has_plat, base_unlocked, base_user_xp)
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

    // 2. Metadata klasöründen oyunların toplam başarım ve XP sayılarını eşleştir
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

    // 3. Detay çekmecesinden on-demand kaydedilen önbellek dosyalarını da birleştir
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

/// Epic Games Store başlığından ve yerel metadatadan olası URL slug adaylarını türetir.
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
                // Unicode tırnaklar, apostroflar, tireler, özel semboller
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

    // 1. İki nokta (alt başlık) ve tire temizleme: "The Dungeon of Naheulbeuk: The Amulet of Chaos" -> "the-dungeon-of-naheulbeuk"
    if let Some(pos) = title.find(':') {
        add(&title[..pos]);
    }
    if let Some(pos) = title.find(" - ") {
        add(&title[..pos]);
    }
    if let Some(pos) = title.find(" – ") {
        add(&title[..pos]);
    }

    // 2. Bilinen yayıncı ve seri ön eklerini ayıklayarak alternatif üret
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

    // 3. Bilinen edisyon takılarını temizleyerek alternatif üret
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

/// Epic Games Store genel içerik API'sinden sistem gereksinimlerini çeker ve diske önbelleğe alır.
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

    // 1. Önce disk önbelleğine bak (sadece desteklenen ve taze olanlar veya zorlama yoksa)
    if !force && cache_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&cache_file) {
            if let Ok(cached) = serde_json::from_str::<GameRequirementsResponse>(&content) {
                if cached.supported {
                    return Ok(cached);
                }
            }
        }
    }

    // 2. Yerel metadata dosyasından FolderName ve custom slug tara
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

    // 3. Slug adaylarını hazırla
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
                        if let Some(reqs) = page.get("data").and_then(|d| d.get("requirements")) {
                            let languages = reqs
                                .get("languages")
                                .and_then(|l| l.as_array())
                                .map(|arr| {
                                    arr.iter()
                                        .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                        .collect()
                                })
                                .unwrap_or_default();

                            let mut systems = Vec::new();
                            if let Some(sys_arr) = reqs.get("systems").and_then(|s| s.as_array()) {
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

                            if !systems.is_empty() {
                                let result = GameRequirementsResponse {
                                    supported: true,
                                    systems,
                                    languages,
                                    app_name: app_name.clone(),
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
    }

    // Bulunamadıysa supported: false olarak zarifçe dön (başarısız durumları kalıcı diske kilitleme)
    let fallback = GameRequirementsResponse {
        supported: false,
        systems: vec![],
        languages: vec![],
        app_name: app_name.clone(),
    };

    Ok(fallback)
}

/// Epic Games Launcher üzerinde kurulu oyunları tespit eder.
#[tauri::command]
pub async fn epic_detect_egl_games(_app: AppHandle) -> Result<Vec<cache::EglDetectedGame>, String> {
    Ok(cache::read_egl_installed_games())
}

/// Epic Games Launcher'da algılanan oyunları kalıcı olarak installed.json'a eşitler.
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
        assert!(b.hidden, "BornToBeWild gizli başarım olarak işaretlenmeli");
        assert!(!b.display_name.is_empty(), "İsim metadata'dan doldurulmalı");

        let t = resp.achievements.iter().find(|a| a.name == "TheTower").unwrap();
        assert!(t.hidden, "TheTower gizli olmalı");
        assert!(!t.is_base, "TheTower Phantom Liberty DLC'sine aittir (is_base: false)");
        assert!(!t.display_name.is_empty(), "TheTower başlığı boş kalmamalı");
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
        assert!(slugs4.contains(&"rainbow-six-siege".to_string()), "Rainbow Six Siege slug adayı 'rainbow-six-siege' içermeli");

        let slugs5 = generate_slug_candidates("The Dungeon Of Naheulbeuk: The Amulet Of Chaos", Some("DungeonOfNaheulbeuk"), None);
        assert!(slugs5.contains(&"the-dungeon-of-naheulbeuk".to_string()));
    }
}

