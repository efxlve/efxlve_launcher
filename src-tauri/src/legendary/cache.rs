//! Heroic pattern: the library is read from disk FIRST, network sync runs in the background.
//!
//! `metadata/*.json` + `installed.json` + `user.json` are parsed directly,
//! so the UI shows the cache even when the Epic API fails.
//! The on-disk format matches `list --json` output (`Game.__dict__`).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::models::{InstalledGame, LegendaryGame};

#[derive(Debug, Clone, Default, Deserialize)]
struct UserFile {
    // CAUTION: user.json keys are snake_case (account_id),
    // a wrong rename + #[serde(default)] silently yields an empty string!
    #[serde(default)]
    account_id: String,
    #[serde(default, rename = "displayName")]
    display_name: String,
}

/// When signed in (display name, account_id); the profile URL is built from the id:
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

/// Single-file snapshot of the (already slimmed) library.
///
/// Reading and parsing ~900 individual metadata files on a cold start can take
/// seconds on an HDD. This consolidated file lets the UI paint the library
/// almost instantly; the background sync refreshes it.
fn snapshot_path(config: &Path) -> std::path::PathBuf {
    config.join("efxlve_library_snapshot.json")
}

pub fn write_library_snapshot(config: &Path, games: &[LegendaryGame]) {
    if let Ok(json) = serde_json::to_string(games) {
        let _ = std::fs::write(snapshot_path(config), json);
    }
}

pub fn read_library_snapshot(config: &Path) -> Option<Vec<LegendaryGame>> {
    let text = std::fs::read_to_string(snapshot_path(config)).ok()?;
    // An empty file is a real snapshot. Falling through to metadata/*.json
    // would parse the previous account's catalog after a switch.
    serde_json::from_str(&text).ok()
}

/// All game metadata in the cache (broken files are skipped).
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
            if let Ok(mut g) = serde_json::from_str::<LegendaryGame>(&text) {
                if !g.app_name.is_empty() {
                    super::models::slim_game(&mut g);
                    out.push(g);
                }
            }
        }
    }
    out.sort_by(|a, b| a.app_title.to_lowercase().cmp(&b.app_title.to_lowercase()));
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

/// Path to the Epic Games Launcher Data/Manifests folder.
pub fn egl_manifests_dir() -> std::path::PathBuf {
    if let Ok(pd) = std::env::var("ProgramData") {
        let p = Path::new(&pd)
            .join("Epic")
            .join("EpicGamesLauncher")
            .join("Data")
            .join("Manifests");
        if p.is_dir() {
            return p;
        }
    }
    std::path::PathBuf::from(r"C:\ProgramData\Epic\EpicGamesLauncher\Data\Manifests")
}

/// Scans main games installed in the Epic Games Launcher and present on disk.
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
                let main_game = val
                    .get("MainGameAppName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if !main_game.is_empty() {
                    continue;
                }
                let install_loc = val
                    .get("InstallLocation")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                if install_loc.is_empty() || !Path::new(install_loc).exists() {
                    continue;
                }
                let app_name = val
                    .get("AppName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let title = val
                    .get("DisplayName")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                let executable = val
                    .get("LaunchExecutable")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
                // If a launch executable is specified, verify it exists. If it does not,
                // the game files are missing or incomplete (EGL would show "Repair").
                if !executable.is_empty() && !Path::new(install_loc).join(executable).exists() {
                    continue;
                }
                let version = val
                    .get("AppVersionString")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim();
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

/// Deletes all EGL .item manifests in ProgramData for this game (and any of its DLCs).
/// Without this, official Epic Games Store displays "Repair" instead of returning to
/// the uninstalled state, and our launcher re-detects the game on refresh.
pub fn remove_egl_manifests_for_game(app_name: &str) {
    let dir = egl_manifests_dir();
    if !dir.is_dir() {
        return;
    }
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
                let matches_app = val
                    .get("AppName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.eq_ignore_ascii_case(app_name))
                    .unwrap_or(false);
                let matches_main = val
                    .get("MainGameAppName")
                    .and_then(|v| v.as_str())
                    .map(|s| s.eq_ignore_ascii_case(app_name))
                    .unwrap_or(false);
                if matches_app || matches_main {
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
    }
}

/// Explicitly removes a game from legendary's installed.json.
pub fn remove_game_from_installed_json(config: &Path, app_name: &str) {
    let installed_file = config.join("installed.json");
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(mut map) = serde_json::from_str::<HashMap<String, serde_json::Value>>(&text) {
            let before_len = map.len();
            map.retain(|k, _| !k.eq_ignore_ascii_case(app_name));
            if map.len() != before_len {
                if let Ok(json_str) = serde_json::to_string_pretty(&map) {
                    let _ = std::fs::write(&installed_file, json_str);
                }
            }
        }
    }
}

/// Removes cached manifest files and custom game settings for an uninstalled game.
pub fn remove_game_manifests(config: &Path, app_name: &str) {
    let manifests_dir = config.join("manifests");
    if manifests_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(manifests_dir) {
            let prefix = format!("{}_", app_name.to_lowercase());
            for entry in entries.flatten() {
                let p = entry.path();
                if let Some(file_name) = p.file_name().and_then(|n| n.to_str()) {
                    if file_name.to_lowercase().starts_with(&prefix) {
                        let _ = std::fs::remove_file(p);
                    }
                }
            }
        }
    }
    let game_settings = config
        .join("game_settings")
        .join(format!("{app_name}.json"));
    if game_settings.is_file() {
        let _ = std::fs::remove_file(game_settings);
    }
}

/// Copies the manifest of EGL-installed games from the .egstore folder to the legendary manifests dir
pub fn ensure_egl_manifest(
    config: &Path,
    app_name: &str,
    install_path: &str,
    version: &str,
    platform: &str,
) {
    let manifests_dir = config.join("manifests");
    let _ = std::fs::create_dir_all(&manifests_dir);
    let target_name = format!("{}_{}_{}.manifest", app_name, platform, version);
    let target_file = manifests_dir.join(&target_name);
    if target_file.exists() {
        return;
    }
    let egstore = Path::new(install_path).join(".egstore");
    if egstore.is_dir() {
        if let Ok(entries) = std::fs::read_dir(egstore) {
            for entry in entries.flatten() {
                let p = entry.path();
                if p.extension().and_then(|e| e.to_str()) == Some("manifest") {
                    if let Ok(len) = p.metadata().map(|m| m.len()) {
                        if len > 1024 {
                            let _ = std::fs::copy(&p, &target_file);
                            break;
                        }
                    }
                }
            }
        }
    }
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

/// Scans the registry for games handed off to third-party launchers (Ubisoft Connect, EA App).
///
/// Only an entry's `customAttributes` decides whether it is a candidate, and walking
/// `metadata/*.json` to rebuild that for ~800 games costs seconds on the boot path
/// (measured: 3.0 s for 820 files). A caller that already holds the parsed catalog —
/// the library snapshot — passes it in; the directory walk stays as the fallback for
/// the first run, before any snapshot exists.
pub fn read_third_party_installed_games(
    config: &Path,
    already_installed: &HashMap<String, InstalledGame>,
    catalog: Option<&[LegendaryGame]>,
) -> Vec<InstalledGame> {
    let candidates: Vec<(String, String, Option<Value>)> = match catalog {
        Some(games) => games
            .iter()
            .map(|g| {
                (
                    g.app_name.trim().to_string(),
                    g.app_title.trim().to_string(),
                    g.metadata.get("customAttributes").cloned(),
                )
            })
            .collect(),
        None => metadata_candidates(config),
    };

    // Only entries that declare a registry location can be installed by another
    // launcher; everything else is dropped before any work happens.
    let jobs: Vec<(String, String, Option<Value>)> = candidates
        .into_iter()
        .filter(|(app_name, _, _)| {
            !app_name.is_empty() && !already_installed.contains_key(app_name)
        })
        .collect();

    // Each probe starts a `reg query` process (~30 ms here), so ~24 candidates cost
    // 0.7 s of the boot path when run one by one. The probes are independent and
    // IO-bound, so they are fanned out across a few threads and kept in input order.
    let mut probes: Vec<Option<String>> = vec![None; jobs.len()];
    std::thread::scope(|scope| {
        let workers = std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
            .clamp(2, 8)
            .min(jobs.len().max(1));
        let chunk = jobs.len().div_ceil(workers).max(1);
        let handles: Vec<_> = probes
            .chunks_mut(chunk)
            .zip(jobs.chunks(chunk))
            .map(|(slot_chunk, job_chunk)| {
                scope.spawn(move || {
                    for (slot, (_, _, attrs)) in slot_chunk.iter_mut().zip(job_chunk) {
                        *slot = attrs.as_ref().and_then(probe_install_location);
                    }
                })
            })
            .collect();
        for handle in handles {
            let _ = handle.join();
        }
    });

    let mut out = Vec::new();
    for ((app_name, title, _), install_path) in jobs.into_iter().zip(probes) {
        let Some(install_path) = install_path else {
            continue;
        };
        out.push(InstalledGame {
            title: if title.is_empty() {
                app_name.clone()
            } else {
                title
            },
            app_name,
            version: "1.0".to_string(),
            install_path,
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

    out
}

/// Install folder declared by a catalog entry's registry attributes, when the key
/// exists and still points at a folder on disk.
fn probe_install_location(attrs: &Value) -> Option<String> {
    let reg_path = attrs
        .get("RegistryPath")
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let reg_key = attrs
        .get("RegistryKey")
        .and_then(|v| v.get("value"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if reg_path.is_empty() || reg_key.is_empty() {
        return None;
    }
    let install_path = query_registry_path(reg_path, reg_key)?;
    Path::new(&install_path).is_dir().then_some(install_path)
}

/// Fallback candidate source for `read_third_party_installed_games`: the raw
/// `metadata/*.json` files, used only until a library snapshot exists.
fn metadata_candidates(config: &Path) -> Vec<(String, String, Option<Value>)> {
    let mut out = Vec::new();
    let meta_dir = config.join("metadata");
    let Ok(entries) = std::fs::read_dir(meta_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        let app_name = val
            .get("app_name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        if app_name.is_empty() {
            continue;
        }
        let title = val
            .get("app_title")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let attrs = val
            .get("metadata")
            .and_then(|m| m.get("customAttributes"))
            .cloned();
        out.push((app_name.to_string(), title.to_string(), attrs));
    }
    out
}

/// Read installed games: installed.json + EGL manifests + third-party registry.
pub fn read_installed(config: &Path) -> Vec<InstalledGame> {
    // Third-party detection wants the catalog, and the snapshot is the consolidated
    // copy of it: parsing that one file (~0.35 s for 820 games) is much cheaper than
    // walking `metadata/*.json` (~1.6 s measured). The walk stays as the fallback for
    // a first run, before any snapshot exists.
    let snapshot = read_library_snapshot(config);
    read_installed_with_catalog(config, snapshot.as_deref())
}

/// `read_installed` with an already-parsed catalog: see
/// `read_third_party_installed_games` for why the boot path passes the snapshot in.
pub fn read_installed_with_catalog(
    config: &Path,
    catalog: Option<&[LegendaryGame]>,
) -> Vec<InstalledGame> {
    let installed_file = config.join("installed.json");
    let mut map: HashMap<String, InstalledGame> = HashMap::new();
    if let Ok(text) = std::fs::read_to_string(&installed_file) {
        if let Ok(loaded) = serde_json::from_str::<HashMap<String, InstalledGame>>(&text) {
            map = loaded;
        }
    }

    let mut changed = false;

    // Prune stale entries whose install directory no longer exists on a mounted drive.
    let keys: Vec<String> = map.keys().cloned().collect();
    for key in keys {
        if let Some(game) = map.get(&key) {
            let path_str = game.install_path.trim();
            if !path_str.is_empty() {
                let p = Path::new(path_str);
                if p.is_absolute() {
                    let drive_present = p
                        .components()
                        .next()
                        .map(|c| Path::new(&c).exists())
                        .unwrap_or(false);
                    if drive_present && !p.exists() {
                        map.remove(&key);
                        changed = true;
                    }
                }
            }
        }
    }

    // 1. Read the Epic Games Launcher manifests and add the missing ones
    for egl in read_egl_installed_games() {
        ensure_egl_manifest(
            config,
            &egl.app_name,
            &egl.install_path,
            &egl.version,
            "Windows",
        );
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

    // Auto-sync: persistently record newly detected EGL games into installed.json
    if changed {
        if let Ok(json_str) = serde_json::to_string_pretty(&map) {
            let _ = std::fs::write(&installed_file, json_str);
        }
    }

    // 2. Detect games installed via third-party launchers (Ubisoft Connect, EA, ...) from the registry
    // CAUTION: third-party games are NOT persisted to installed.json! (no legendary manifest -> python TypeError)
    let mut extra_tp = Vec::new();
    for tp in read_third_party_installed_games(config, &map, catalog) {
        if !map.contains_key(&tp.app_name) {
            extra_tp.push(tp);
        }
    }

    let mut v: Vec<_> = map.into_values().collect();
    v.extend(extra_tp);
    v.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    v
}

/// Copies legendary's freshly installed version and size into the Epic Games
/// Launcher `.item` for this app (and any of its DLCs).
///
/// EGL decides "update available" by comparing the `.item`'s `AppVersionString`
/// with the catalog. legendary rewrites `installed.json` but never touches the
/// `.item`, so without this sync the official launcher offers the very same
/// update again right after this launcher already installed it.
pub fn sync_egl_manifest_version(config: &Path, app_name: &str) {
    let dir = egl_manifests_dir();
    if !dir.is_dir() {
        return;
    }
    let installed = read_installed(config);
    let find = |name: &str| {
        installed
            .iter()
            .find(|g| g.app_name.eq_ignore_ascii_case(name))
    };
    let Some(main) = find(app_name) else {
        return;
    };
    let main_version = main.version.clone();
    let main_size = main.install_size;

    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("item") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };

        let item_app = val
            .get("AppName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let main_of_item = val
            .get("MainGameAppName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        let (version, size) = if item_app.eq_ignore_ascii_case(app_name) {
            (main_version.clone(), main_size)
        } else if main_of_item.eq_ignore_ascii_case(app_name) {
            match find(&item_app) {
                Some(dlc) => (dlc.version.clone(), dlc.install_size),
                None => continue,
            }
        } else {
            continue;
        };

        if apply_installed_version(&mut val, &version, size) {
            if let Ok(new_text) = serde_json::to_string_pretty(&val) {
                let _ = std::fs::write(&path, new_text);
            }
        }
    }
}

/// Writes the installed version/size into one `.item` object. Returns true when
/// a field actually changed. Split out so it can be unit-tested without EGL.
fn apply_installed_version(val: &mut serde_json::Value, version: &str, install_size: u64) -> bool {
    let Some(obj) = val.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if !version.is_empty() && obj.get("AppVersionString").and_then(|v| v.as_str()) != Some(version)
    {
        obj.insert(
            "AppVersionString".to_string(),
            serde_json::Value::String(version.to_string()),
        );
        changed = true;
    }
    if obj.get("InstallSize").and_then(|v| v.as_u64()) != Some(install_size) {
        obj.insert(
            "InstallSize".to_string(),
            serde_json::Value::from(install_size),
        );
        changed = true;
    }
    if obj.get("bNeedsValidation").and_then(|v| v.as_bool()) == Some(true) {
        obj.insert(
            "bNeedsValidation".to_string(),
            serde_json::Value::Bool(false),
        );
        changed = true;
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// user.json uses its REAL key layout (snake_case!).
    /// A mistake like `rename = "accountId"` would silently produce an empty id.
    const SAMPLE_USER: &str = r#"{
        "account_id": "00000000000000000000000000000000",
        "displayName": "Efxlve",
        "app": "EpicGamesLauncher"
    }"#;

    #[test]
    fn parses_user_display_name_and_id() {
        let u: UserFile = serde_json::from_str(SAMPLE_USER).expect("parse edilmeli");
        assert_eq!(u.display_name, "Efxlve");
        assert_eq!(u.account_id, "00000000000000000000000000000000");
    }

    #[test]
    fn test_read_egl_installed_games_parses() {
        // The folder can be an empty leftover after the Epic Launcher is
        // uninstalled or its games were removed; the check only makes sense
        // when at least one manifest still points at a folder on disk.
        let dir = egl_manifests_dir();
        let installed_manifest = std::fs::read_dir(&dir)
            .map(|entries| {
                entries.flatten().any(|entry| {
                    let path = entry.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("item") {
                        return false;
                    }
                    let Ok(text) = std::fs::read_to_string(&path) else {
                        return false;
                    };
                    let Ok(val) = serde_json::from_str::<serde_json::Value>(&text) else {
                        return false;
                    };
                    let main = val
                        .get("MainGameAppName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    let loc = val
                        .get("InstallLocation")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    main.is_empty() && !loc.is_empty() && Path::new(loc).is_dir()
                })
            })
            .unwrap_or(false);
        if !installed_manifest {
            return;
        }
        let games = read_egl_installed_games();
        assert!(
            !games.is_empty(),
            "If an installed EGL manifest exists there must be at least one game"
        );
        let has_cyberpunk_or_rdr = games
            .iter()
            .any(|g| g.app_name == "Ginger" || g.app_name == "Heather");
        assert!(has_cyberpunk_or_rdr, "Cyberpunk or RDR2 must be detected");
    }

    #[test]
    fn library_snapshot_round_trips() {
        let dir = std::env::temp_dir().join(format!("efxlve-snap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let games = vec![LegendaryGame {
            app_name: "snap-game".into(),
            app_title: "Snap Game".into(),
            ..Default::default()
        }];
        write_library_snapshot(&dir, &games);
        let back = read_library_snapshot(&dir).expect("snapshot should round-trip");
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].app_name, "snap-game");
        std::fs::write(snapshot_path(&dir), "[]").unwrap();
        let empty = read_library_snapshot(&dir).expect("empty snapshot stays present");
        assert!(empty.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_read_installed_merges_all() {
        let config = crate::legendary::skip::default_config_dir();
        let installed = read_installed(&config);
        if egl_manifests_dir().is_dir() {
            assert!(
                installed.len() >= 6,
                "At least 6 installed games (EGL + Legendary) must be found"
            );
            let has_spider_or_wand = installed.iter().any(|g| {
                g.app_name.contains("be23672deb69402781cd47cc2919caf4")
                    || g.title.contains("Spider-Man")
                    || g.title == "Wand"
            });
            assert!(
                has_spider_or_wand,
                "Spider-Man or Wand must be in the installed list"
            );
        }
    }

    #[test]
    fn test_remove_game_from_installed_json() {
        let dir = std::env::temp_dir().join(format!("efxlve_test_cache_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let json_path = dir.join("installed.json");
        let initial =
            r#"{"ReadyOrNot": {"app_name": "ReadyOrNot"}, "Cyberpunk": {"app_name": "Cyberpunk"}}"#;
        std::fs::write(&json_path, initial).unwrap();

        remove_game_from_installed_json(&dir, "ReadyOrNot");

        let text = std::fs::read_to_string(&json_path).unwrap();
        assert!(!text.contains("ReadyOrNot"));
        assert!(text.contains("Cyberpunk"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_apply_installed_version_updates_item_fields() {
        let mut val = serde_json::json!({
            "AppName": "Ginger",
            "AppVersionString": "2.31_hotfix",
            "InstallSize": 66400731896u64,
            "bNeedsValidation": true
        });

        assert!(apply_installed_version(
            &mut val,
            "2.32_hotfix",
            117213238008
        ));
        assert_eq!(val["AppVersionString"], "2.32_hotfix");
        assert_eq!(val["InstallSize"], 117213238008u64);
        assert_eq!(val["bNeedsValidation"], false);

        // Re-running with the same values must be a no-op (no needless writes).
        assert!(!apply_installed_version(
            &mut val,
            "2.32_hotfix",
            117213238008
        ));

        // An unknown version must not clobber whatever EGL already stored.
        assert!(!apply_installed_version(&mut val, "", 117213238008));
        assert_eq!(val["AppVersionString"], "2.32_hotfix");
    }

    /// A third-party probe needs BOTH registry halves; anything else is skipped
    /// before a `reg query` process is ever started.
    #[test]
    fn third_party_probe_requires_both_registry_halves() {
        let both = serde_json::json!({
            "RegistryPath": { "value": "SOFTWARE\\Ubisoft\\Launcher\\Installs\\1234" },
            "RegistryKey": { "value": "InstallDir" }
        });
        // A path that does not exist on any machine must return None, not panic.
        assert_eq!(probe_install_location(&both), None);

        let path_only = serde_json::json!({ "RegistryPath": { "value": "SOFTWARE\\X" } });
        assert_eq!(probe_install_location(&path_only), None);
        let key_only = serde_json::json!({ "RegistryKey": { "value": "InstallDir" } });
        assert_eq!(probe_install_location(&key_only), None);
        assert_eq!(probe_install_location(&serde_json::json!({})), None);
    }

    /// The metadata walk is the fallback before a snapshot exists: it must find the
    /// `customAttributes` that decide third-party detection, and skip broken files.
    #[test]
    fn metadata_candidates_reads_registry_attributes_and_skips_broken_files() {
        let dir = std::env::temp_dir().join(format!("efxlve_cache_test_{}", std::process::id()));
        let meta = dir.join("metadata");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&meta).unwrap();
        std::fs::write(
            meta.join("game.json"),
            r#"{"app_name":"Ubisoft1","app_title":"A Ubisoft Game","metadata":{"customAttributes":{"RegistryPath":{"value":"SOFTWARE\\Ubisoft"},"RegistryKey":{"value":"InstallDir"}}}}"#,
        )
        .unwrap();
        std::fs::write(meta.join("broken.json"), "{not json").unwrap();
        std::fs::write(meta.join("ignored.txt"), "not metadata").unwrap();

        let found = metadata_candidates(&dir);
        assert_eq!(found.len(), 1, "only the readable catalog entry counts");
        let (app_name, title, attrs) = &found[0];
        assert_eq!(app_name, "Ubisoft1");
        assert_eq!(title, "A Ubisoft Game");
        assert!(attrs.as_ref().unwrap().get("RegistryPath").is_some());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
