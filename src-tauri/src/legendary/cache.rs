//! Heroic deseni: kütüphane ÖNCE yerelden okunur, ağ senkronu arka plandadır.
//!
//! `metadata/*.json` + `installed.json` + `user.json` doğrudan parse edilir;
//! böylece Epic API'si aksasa bile arayüz önbelleği gösterir.
//! `list --json` çıktısıyla disk formatı aynıdır (`Game.__dict__`).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use super::models::{InstalledGame, LegendaryGame};

#[derive(Debug, Clone, Default, Deserialize)]
struct UserFile {
    // DİKKAT: user.json anahtarları snake_case'dir (account_id),
    // yanlış rename + #[serde(default)] sessizce boş string verir!
    #[serde(default)]
    account_id: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
}

/// Giriş yapılmışsa (görünen ad, account_id); profil URL'si id'den kurulur:
/// `https://store.epicgames.com/u/<account_id>`
pub fn read_user(config: &Path) -> Option<(String, Option<String>)> {
    let text = std::fs::read_to_string(config.join("user.json")).ok()?;
    let u: UserFile = serde_json::from_str(&text).ok()?;
    let name = u.display_name.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let id = u.account_id.trim().to_string();
    Some((name, if id.is_empty() { None } else { Some(id) }))
}

/// Önbellekteki tüm oyun metadataları (bozuk dosyalar atlanır).
pub fn read_cached_games(config: &Path) -> Vec<LegendaryGame> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(config.join("metadata")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(g) = serde_json::from_str::<LegendaryGame>(&text) {
                if !g.app_name.is_empty() {
                    out.push(g);
                }
            }
        }
    }
    out.sort_by(|a, b| {
        a.app_title
            .to_lowercase()
            .cmp(&b.app_title.to_lowercase())
    });
    out
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EglDetectedGame {
    pub app_name: String,
    pub title: String,
    pub install_path: String,
    pub executable: String,
    pub version: String,
    pub install_size: u64,
}

/// Epic Games Launcher Data/Manifests klasörü yolu.
pub fn egl_manifests_dir() -> std::path::PathBuf {
    if let Ok(pd) = std::env::var("ProgramData") {
        let p = Path::new(&pd).join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests");
        if p.is_dir() {
            return p;
        }
    }
    std::path::PathBuf::from(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests")
}

/// Epic Games Launcher'da kurulu ve diskte mevcut ana oyunları tarar.
pub fn read_egl_installed_games() -> Vec<EglDetectedGame> {
    let dir = egl_manifests_dir();
    if !dir.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("item") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) {
                // DLC'leri atla (sadece ana oyunlar)
                let main_game = val.get("MainGameAppName").and_then(|v| v.as_str()).unwrap_or("").trim();
                if !main_game.is_empty() {
                    continue;
                }
                let install_loc = val.get("InstallLocation").and_then(|v| v.as_str()).unwrap_or("").trim();
                if install_loc.is_empty() || !Path::new(install_loc).exists() {
                    continue;
                }
                let app_name = val.get("AppName").and_then(|v| v.as_str()).unwrap_or("").trim();
                let title = val.get("DisplayName").and_then(|v| v.as_str()).unwrap_or("").trim();
                let executable = val.get("LaunchExecutable").and_then(|v| v.as_str()).unwrap_or("").trim();
                let version = val.get("AppVersionString").and_then(|v| v.as_str()).unwrap_or("").trim();
                let install_size = val.get("InstallSize").and_then(|v| v.as_u64()).unwrap_or(0);

                if !app_name.is_empty() && !title.is_empty() {
                    out.push(EglDetectedGame {
                        app_name: app_name.to_string(),
                        title: title.to_string(),
                        install_path: install_loc.to_string(),
                        executable: executable.to_string(),
                        version: version.to_string(),
                        install_size,
                    });
                }
            }
        }
    }
    out
}

#[cfg(windows)]
fn query_registry_path(reg_path: &str, reg_key: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let full_key = format!("HKLM\\{}", reg_path);
    let output = std::process::Command::new("reg")
        .args(["query", &full_key, "/v", reg_key])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8_lossy(&output.stdout);
    for line in text.lines() {
        if line.contains("REG_SZ") || line.contains("REG_EXPAND_SZ") {
            if let Some(pos) = line.find("REG_") {
                let rest = &line[pos..];
                let parts: Vec<&str> = rest.split_whitespace().collect();
                if parts.len() >= 2 {
                    let val = parts[1..].join(" ");
                    let val = val.trim();
                    if !val.is_empty() {
                        return Some(val.to_string());
                    }
                }
            }
        }
    }
    None
}

#[cfg(not(windows))]
fn query_registry_path(_reg_path: &str, _reg_key: &str) -> Option<String> {
    None
}

/// 3. parti başlatıcı (Ubisoft Connect, EA App vb.) katalog metadatasındaki RegistryPath/RegistryKey üzerinden kurulu oyunları tespit eder.
pub fn read_third_party_installed_games(
    config: &Path,
    existing_map: &HashMap<String, InstalledGame>,
) -> Vec<InstalledGame> {
    let meta_dir = config.join("metadata");
    if !meta_dir.is_dir() {
        return Vec::new();
    }

    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(meta_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let file_stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
            if file_stem.is_empty() || existing_map.contains_key(file_stem) {
                continue;
            }

            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };

            let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
                continue;
            };

            let app_name = val.get("app_name")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(file_stem);

            if existing_map.contains_key(app_name) {
                continue;
            }

            let custom_attrs = val.get("metadata")
                .and_then(|m| m.get("customAttributes"))
                .and_then(|c| c.as_object());

            let Some(attrs) = custom_attrs else {
                continue;
            };

            let reg_path = attrs.get("RegistryPath")
                .and_then(|o| o.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            let reg_key = attrs.get("RegistryKey")
                .and_then(|o| o.get("value"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim();

            if reg_path.is_empty() || reg_key.is_empty() {
                continue;
            }

            if let Some(install_dir) = query_registry_path(reg_path, reg_key) {
                let clean_dir = install_dir.trim_end_matches(['\\', '/']);
                if Path::new(clean_dir).is_dir() {
                    let title = val.get("metadata")
                        .and_then(|m| m.get("title"))
                        .and_then(|v| v.as_str())
                        .or_else(|| val.get("app_title").and_then(|v| v.as_str()))
                        .unwrap_or(app_name);

                    out.push(InstalledGame {
                        app_name: app_name.to_string(),
                        title: title.to_string(),
                        version: "1.0".to_string(),
                        install_path: clean_dir.to_string(),
                        install_size: 0,
                        executable: String::new(),
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
                }
            }
        }
    }
    out
}

/// Kurulu oyunlar (`installed.json` + Epic Games Launcher'da algılanan oyunlar + 3. parti registry oyunları).
pub fn read_installed(config: &Path) -> Vec<InstalledGame> {
    let installed_file = config.join("installed.json");
    let mut map: HashMap<String, InstalledGame> = match std::fs::read_to_string(&installed_file) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
        Err(_) => HashMap::new(),
    };

    let mut changed = false;

    // 1. Epic Games Launcher'da kurulu olup henüz installed.json'da bulunmayan oyunları otomatik dahil et
    for egl in read_egl_installed_games() {
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
            changed = true;
        }
    }

    // 2. 3. parti başlatıcı (Ubisoft Connect, EA vb.) ile kurulu oyunları Registry'den algıla
    for tp in read_third_party_installed_games(config, &map) {
        if !map.contains_key(&tp.app_name) {
            map.insert(tp.app_name.clone(), tp);
            changed = true;
        }
    }

    // Otomatik senkron: yeni algılanan oyunları installed.json kütüğüne kalıcı işle
    if changed {
        if let Ok(json_str) = serde_json::to_string_pretty(&map) {
            let _ = std::fs::write(&installed_file, json_str);
        }
    }

    let mut v: Vec<_> = map.into_values().collect();
    v.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    v
}

#[cfg(test)]
mod tests {
    use super::*;

    /// user.json GERÇEK anahtar düzenini kullanır (snake_case!).
    /// `rename = "accountId"` gibi bir hata sessizce boş id üretirdi.
    const SAMPLE_USER: &str = r#"{
        "account_id": "4cff91c2292944e9a8548f46a1c95ef0",
        "displayName": "Efxlve",
        "app": "EpicGamesLauncher"
    }"#;

    #[test]
    fn parses_user_display_name_and_id() {
        let u: UserFile = serde_json::from_str(SAMPLE_USER).expect("parse edilmeli");
        assert_eq!(u.display_name, "Efxlve");
        assert_eq!(u.account_id, "4cff91c2292944e9a8548f46a1c95ef0");
    }

    #[test]
    fn test_read_egl_installed_games_parses() {
        let games = read_egl_installed_games();
        if egl_manifests_dir().is_dir() {
            assert!(!games.is_empty(), "EGL klasörü mevcutsa en az bir oyun bulunmalı");
            let has_cyberpunk_or_rdr = games.iter().any(|g| g.app_name == "Ginger" || g.app_name == "Heather");
            assert!(has_cyberpunk_or_rdr, "Cyberpunk veya RDR2 algılanabilmeli");
        }
    }

    #[test]
    fn test_read_installed_merges_all() {
        let config = crate::legendary::skip::default_config_dir();
        let installed = read_installed(&config);
        if egl_manifests_dir().is_dir() {
            assert!(installed.len() >= 6, "En az 6 kurulu oyun (EGL + Legendary) bulunmalı");
            let has_spider_or_wand = installed.iter().any(|g| g.app_name.contains("be23672deb69402781cd47cc2919caf4") || g.title.contains("Spider-Man") || g.title == "Wand");
            assert!(has_spider_or_wand, "Spider-Man veya Wand kurulu listesinde yer almalı");
        }
    }
}
