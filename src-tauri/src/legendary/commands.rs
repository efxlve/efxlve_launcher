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
pub async fn epic_list_installed(app: AppHandle) -> Result<Vec<InstalledGame>, String> {
    let bin = resolve_or_err(&app)?;
    client::run_json(&bin, &["list-installed", "--json"])
        .await
        .map_err(|e| fail(&app, e))
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
}
