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
    run_with_recovery(&app, &bin, &config_dir, &["list", "--json"]).await
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
