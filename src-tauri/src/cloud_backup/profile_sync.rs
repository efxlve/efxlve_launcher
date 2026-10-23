//! Launcher profile export/import: custom games, collections, playtime,
//! achievements, notes, themes and settings in one `.efxprofile` archive.
//!
//! Credentials, API keys, Steam sessions and absolute install paths are kept out
//! of the archive. A cloud upload uses the already-configured save provider and
//! stores the archive under a reserved key, so it never appears as a game.

use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::cloud_backup::archive::{pack_backup_dir, unpack_backup_tar_gz};
use crate::cloud_backup::manager;
use crate::cloud_backup::models::CloudBackupEntry;
use crate::legendary::skip::default_config_dir;

const FORMAT: u64 = 1;
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 128 * 1024 * 1024;

/// Files the launcher owns outside the save-backup folders. Directories are
/// walked file by file so the manifest can list every restored path.
const CONFIG_FILES: &[&str] = &[
    "collections.json",
    "playtime.json",
    "epic_playtime.json",
    "efxlve_game_settings.json",
    "achievements.json",
];
const CONFIG_DIRS: &[&str] = &["metadata"];
const APPDATA_FILES: &[&str] = &[
    "custom_games.json",
    "notes.json",
    "gog/achievements_cache.json",
];
const APPDATA_DIRS: &[&str] = &["achievements", "steam/achievements"];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileRestoreResult {
    pub files_restored: usize,
    pub local_storage: Value,
    pub safety_archive: String,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve the app data folder: {error}"))
}

fn stage_dir() -> PathBuf {
    std::env::temp_dir().join(format!(
        "efxlve_profile_stage_{}_{}",
        std::process::id(),
        now_secs()
    ))
}

fn unpack_dir() -> PathBuf {
    std::env::temp_dir().join(format!(
        "efxlve_profile_unpack_{}_{}",
        std::process::id(),
        now_secs()
    ))
}

fn copy_budgeted(
    src: &Path,
    dst: &Path,
    manifest_rel: &str,
    files: &mut Vec<String>,
    budget: &mut u64,
) {
    if !src.is_file() {
        return;
    }
    let Ok(meta) = src.metadata() else {
        return;
    };
    if meta.len() > MAX_FILE_BYTES || meta.len() > *budget {
        return;
    }
    if let Some(parent) = dst.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::copy(src, dst).is_ok() {
        *budget = budget.saturating_sub(meta.len());
        files.push(manifest_rel.to_string());
    }
}

fn copy_tree(
    src: &Path,
    dst: &Path,
    manifest_prefix: &str,
    files: &mut Vec<String>,
    budget: &mut u64,
) {
    let Ok(entries) = fs::read_dir(src) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().to_string();
        let rel = format!("{manifest_prefix}/{name}");
        if file_type.is_dir() {
            copy_tree(&entry.path(), &dst.join(&name), &rel, files, budget);
        } else if file_type.is_file() {
            copy_budgeted(&entry.path(), &dst.join(&name), &rel, files, budget);
        }
    }
}

/// Removes secrets and machine-specific paths before settings leave the machine.
fn sanitize_settings(value: &mut Value) {
    let Some(map) = value.as_object_mut() else {
        return;
    };
    map.retain(|key, _| !is_secret_key(key) && !is_machine_path_key(key));
    for child in map.values_mut() {
        if child.is_object() {
            sanitize_settings(child);
        }
    }
}

fn is_secret_key(key: &str) -> bool {
    let lower = key.to_ascii_lowercase();
    ["token", "secret", "password", "webhook", "apikey", "api_key"]
        .iter()
        .any(|needle| lower.contains(needle))
        || lower.ends_with("_key")
        || lower == "key"
}

fn is_machine_path_key(key: &str) -> bool {
    matches!(
        key,
        "install_dir"
            | "gog_install_dir"
            | "amazon_install_dir"
            | "compat_runner_path"
            | "screenshot_dir"
            | "screenshot_extra_roots"
            | "screenshot_hidden_roots"
    )
}

fn sanitized_settings(app_data: &Path) -> Option<Value> {
    let text = fs::read_to_string(app_data.join("settings.json")).ok()?;
    let mut value: Value = serde_json::from_str(&text).ok()?;
    sanitize_settings(&mut value);
    Some(value)
}

/// Builds a temporary directory with `profile.json`, `localstorage.json` and the
/// selected files. The caller removes it when done.
pub fn build_stage(app: &AppHandle, local_storage: &Value) -> Result<PathBuf, String> {
    let config = default_config_dir();
    let appdata = app_data_dir(app)?;
    build_stage_in(&config, &appdata, local_storage)
}

fn build_stage_in(
    config: &Path,
    appdata: &Path,
    local_storage: &Value,
) -> Result<PathBuf, String> {
    let stage = stage_dir();
    let _ = fs::remove_dir_all(&stage);
    let config_root = stage.join("files").join("config");
    let appdata_root = stage.join("files").join("appdata");
    fs::create_dir_all(&config_root).map_err(|e| e.to_string())?;
    fs::create_dir_all(&appdata_root).map_err(|e| e.to_string())?;

    let mut files = Vec::new();
    let mut budget = MAX_TOTAL_BYTES;

    for rel in CONFIG_FILES {
        let src = config.join(rel);
        let dst = config_root.join(rel);
        copy_budgeted(
            &src,
            &dst,
            &format!("files/config/{rel}"),
            &mut files,
            &mut budget,
        );
    }
    for rel in CONFIG_DIRS {
        copy_tree(
            &config.join(rel),
            &config_root.join(rel),
            &format!("files/config/{rel}"),
            &mut files,
            &mut budget,
        );
    }
    for rel in APPDATA_FILES {
        let src = appdata.join(rel);
        let dst = appdata_root.join(rel);
        copy_budgeted(
            &src,
            &dst,
            &format!("files/appdata/{rel}"),
            &mut files,
            &mut budget,
        );
    }
    for rel in APPDATA_DIRS {
        copy_tree(
            &appdata.join(rel),
            &appdata_root.join(rel),
            &format!("files/appdata/{rel}"),
            &mut files,
            &mut budget,
        );
    }
    if let Some(settings) = sanitized_settings(&appdata) {
        let target = appdata_root.join("settings.json");
        let text = serde_json::to_vec_pretty(&settings).map_err(|e| e.to_string())?;
        if fs::write(&target, text).is_ok() {
            files.push("files/appdata/settings.json".to_string());
        }
    }

    let manifest = json!({
        "format": FORMAT,
        "createdAt": now_secs(),
        "appVersion": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "files": files,
        "secretsExcluded": true,
        "pathsExcluded": true,
    });
    fs::write(
        stage.join("profile.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::write(
        stage.join("localstorage.json"),
        serde_json::to_vec_pretty(local_storage).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(stage)
}

fn cleanup(path: &Path) {
    let _ = fs::remove_dir_all(path);
}

/// Writes the profile archive to a user-picked folder and returns its path.
pub fn export_to_file(
    app: &AppHandle,
    folder: &str,
    local_storage: &Value,
) -> Result<String, String> {
    let folder = PathBuf::from(folder.trim());
    if !folder.is_dir() {
        return Err("Choose an existing folder for the export.".to_string());
    }
    let stage = build_stage(app, local_storage)?;
    let target = folder.join(format!("efxlve_profile_{}.efxprofile", now_secs()));
    let result = pack_backup_dir(&stage, &target).map(|_| target.display().to_string());
    cleanup(&stage);
    result
}

/// Packs the profile and uploads it through the active save provider.
pub async fn upload_to_cloud(
    app: &AppHandle,
    local_storage: &Value,
) -> Result<CloudBackupEntry, String> {
    let stage = build_stage(app, local_storage)?;
    let backup_id = now_secs().to_string();
    let archive = std::env::temp_dir().join(format!("efxlve_profile_{backup_id}.tar.gz"));
    let result = pack_backup_dir(&stage, &archive);
    cleanup(&stage);
    result?;
    let upload = manager::upload_profile_archive(&archive, &backup_id).await;
    let _ = fs::remove_file(&archive);
    upload
}

fn safe_relative(rel: &str) -> Option<PathBuf> {
    let path = Path::new(rel);
    if path.is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => return None,
        }
    }
    (!clean.as_os_str().is_empty()).then_some(clean)
}

fn merge_json(base: &mut Value, incoming: &Value) {
    match (base.as_object_mut(), incoming.as_object()) {
        (Some(base_map), Some(incoming_map)) => {
            for (key, value) in incoming_map {
                if value.is_object() {
                    if let Some(slot) = base_map.get_mut(key) {
                        merge_json(slot, value);
                        continue;
                    }
                }
                base_map.insert(key.clone(), value.clone());
            }
        }
        _ => *base = incoming.clone(),
    }
}

fn restore_settings(src: &Path, target: &Path) -> Result<(), String> {
    let mut incoming: Value = serde_json::from_slice(
        &fs::read(src).map_err(|error| format!("Could not read settings: {error}"))?,
    )
    .map_err(|error| format!("Imported settings are not valid JSON: {error}"))?;
    sanitize_settings(&mut incoming);
    let mut current = if target.is_file() {
        fs::read(target)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .unwrap_or_else(|| json!({}))
    } else {
        json!({})
    };
    merge_json(&mut current, &incoming);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(
        target,
        serde_json::to_vec_pretty(&current).map_err(|e| e.to_string())?,
    )
    .map_err(|error| format!("Could not write settings: {error}"))
}

fn restore_from_dir(app: &AppHandle, unpack: &Path) -> Result<ProfileRestoreResult, String> {
    let config = default_config_dir();
    let appdata = app_data_dir(app)?;
    restore_from_dir_in(&config, &appdata, unpack)
}

fn restore_from_dir_in(
    config: &Path,
    appdata: &Path,
    unpack: &Path,
) -> Result<ProfileRestoreResult, String> {
    let manifest: Value = serde_json::from_slice(
        &fs::read(unpack.join("profile.json"))
            .map_err(|_| "The archive is not an Efxlve profile.".to_string())?,
    )
    .map_err(|_| "The profile manifest is not valid JSON.".to_string())?;
    let format = manifest.get("format").and_then(Value::as_u64).unwrap_or(0);
    if format != FORMAT {
        return Err(format!(
            "Unsupported profile format {format}; this launcher reads format {FORMAT}."
        ));
    }

    let local_storage = fs::read(unpack.join("localstorage.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));

    // Safety copy first: a bad archive can always be rolled back.
    let safety_dir = config.join("profile_backups");
    let safety_archive = safety_dir.join(format!("pre_restore_{}.efxprofile", now_secs()));
    let safety_path = match build_stage_in(config, appdata, &json!({})) {
        Ok(current) => {
            let _ = fs::create_dir_all(&safety_dir);
            let written = pack_backup_dir(&current, &safety_archive).is_ok();
            cleanup(&current);
            if written {
                safety_archive.display().to_string()
            } else {
                String::new()
            }
        }
        Err(_) => String::new(),
    };

    let mut restored = 0usize;
    let mut touched: Vec<PathBuf> = Vec::new();
    if let Some(entries) = manifest.get("files").and_then(Value::as_array) {
        for entry in entries {
            let Some(rel) = entry.as_str() else {
                continue;
            };
            if safe_relative(rel).is_none() {
                continue;
            }
            let text = rel;
            let (source, target_root, rest) = if let Some(rest) = text.strip_prefix("files/config/") {
                (unpack.join(rel), &config, rest)
            } else if let Some(rest) = text.strip_prefix("files/appdata/") {
                (unpack.join(rel), &appdata, rest)
            } else {
                continue;
            };
            let Ok(meta) = fs::symlink_metadata(&source) else {
                continue;
            };
            if !meta.file_type().is_file() {
                continue;
            }
            let Ok(canon_source) = source.canonicalize() else {
                continue;
            };
            let Ok(canon_root) = unpack.canonicalize() else {
                continue;
            };
            if !canon_source.starts_with(&canon_root) {
                continue;
            }
            let target = target_root.join(rest);
            if touched.contains(&target) {
                continue;
            }
            if rest == "settings.json" {
                restore_settings(&source, &target)?;
            } else {
                if let Some(parent) = target.parent() {
                    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
                }
                fs::copy(&source, &target)
                    .map_err(|error| format!("Could not restore {}: {error}", target.display()))?;
            }
            restored += 1;
            touched.push(target);
        }
    }

    Ok(ProfileRestoreResult {
        files_restored: restored,
        local_storage,
        safety_archive: safety_path,
    })
}

pub fn import_file(app: &AppHandle, archive: &str) -> Result<ProfileRestoreResult, String> {
    let path = Path::new(archive);
    let size = fs::metadata(path)
        .map_err(|error| format!("Could not read the profile archive: {error}"))?
        .len();
    if size > 256 * 1024 * 1024 {
        return Err("The profile archive is larger than 256 MB.".to_string());
    }
    let unpack = unpack_dir();
    let _ = fs::remove_dir_all(&unpack);
    let result = unpack_backup_tar_gz(Path::new(archive), &unpack)
        .and_then(|_| restore_from_dir(app, &unpack));
    cleanup(&unpack);
    result
}

pub async fn restore_from_cloud(
    app: &AppHandle,
    remote_id: &str,
    backup_id: &str,
) -> Result<ProfileRestoreResult, String> {
    let archive = manager::download_cloud_archive(remote_id, backup_id).await?;
    let result = import_file(app, &archive.display().to_string());
    let _ = fs::remove_file(&archive);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secret_and_path_keys_are_removed_from_settings() {
        let mut value = json!({
            "steamgrid_api_key": "secret",
            "steam_api_key": "secret",
            "discord_webhook": "secret",
            "install_dir": "D:/Games",
            "offline_mode": true,
            "compat_runner": "GE-Proton",
            "nested": { "token": "x", "keep": 1 }
        });
        sanitize_settings(&mut value);
        assert!(value.get("steamgrid_api_key").is_none());
        assert!(value.get("discord_webhook").is_none());
        assert!(value.get("install_dir").is_none());
        assert_eq!(value.get("offline_mode"), Some(&json!(true)));
        assert_eq!(value.get("compat_runner"), Some(&json!("GE-Proton")));
        assert_eq!(value.pointer("/nested/keep"), Some(&json!(1)));
        assert!(value.pointer("/nested/token").is_none());
    }

    #[test]
    fn archive_paths_cannot_escape_the_profile_roots() {
        assert!(safe_relative("files/config/collections.json").is_some());
        assert!(safe_relative("../outside").is_none());
        assert!(safe_relative("files/config/../../outside").is_none());
        assert!(safe_relative("/absolute").is_none());
    }

    #[test]
    fn settings_merge_keeps_existing_secrets() {
        let mut current = json!({ "steam_api_key": "keep", "offline_mode": false });
        let incoming = json!({ "offline_mode": true, "nested": { "a": 1 } });
        merge_json(&mut current, &incoming);
        assert_eq!(current.get("steam_api_key"), Some(&json!("keep")));
        assert_eq!(current.get("offline_mode"), Some(&json!(true)));
    }

    #[test]
    fn profile_archive_restores_files_and_merges_settings() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_profile_roundtrip_{}_{}",
            std::process::id(),
            now_secs()
        ));
        let config = root.join("config");
        let appdata = root.join("appdata");
        std::fs::create_dir_all(&config).unwrap();
        std::fs::create_dir_all(&appdata).unwrap();
        std::fs::write(config.join("collections.json"), r#"{"collections":[]}"#).unwrap();
        std::fs::write(
            appdata.join("custom_games.json"),
            r#"[{"id":"custom::1","title":"Imported"}]"#,
        )
        .unwrap();
        std::fs::write(
            appdata.join("settings.json"),
            r#"{"steam_api_key":"secret","offline_mode":false,"install_dir":"D:/Games","compat_runner":"GE"}"#,
        )
        .unwrap();

        let local_storage = json!({"efxlve-lang": "tr", "efxlve-custom-themes": "[]"});
        let stage = build_stage_in(&config, &appdata, &local_storage).unwrap();
        // The export must not carry the API key or the absolute install path.
        let exported: Value =
            serde_json::from_slice(&std::fs::read(stage.join("files/appdata/settings.json")).unwrap())
                .unwrap();
        assert!(exported.get("steam_api_key").is_none());
        assert!(exported.get("install_dir").is_none());
        assert_eq!(exported.get("compat_runner"), Some(&json!("GE")));

        let archive = root.join("profile.tar.gz");
        pack_backup_dir(&stage, &archive).unwrap();
        cleanup(&stage);

        let unpack = root.join("unpack");
        unpack_backup_tar_gz(&archive, &unpack).unwrap();

        // The current settings have a secret the archive must not erase.
        std::fs::write(
            appdata.join("settings.json"),
            r#"{"steam_api_key":"keep","offline_mode":false}"#,
        )
        .unwrap();
        let result = restore_from_dir_in(&config, &appdata, &unpack).unwrap();
        assert!(result.files_restored >= 2);
        assert_eq!(result.local_storage.get("efxlve-lang"), Some(&json!("tr")));
        assert_eq!(
            std::fs::read_to_string(config.join("collections.json")).unwrap(),
            r#"{"collections":[]}"#
        );
        assert_eq!(
            std::fs::read_to_string(appdata.join("custom_games.json")).unwrap(),
            r#"[{"id":"custom::1","title":"Imported"}]"#
        );
        let merged: Value =
            serde_json::from_slice(&std::fs::read(appdata.join("settings.json")).unwrap()).unwrap();
        assert_eq!(merged.get("steam_api_key"), Some(&json!("keep")));
        assert_eq!(merged.get("offline_mode"), Some(&json!(false)));
        assert!(result.safety_archive.is_empty() || Path::new(&result.safety_archive).is_file());

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn manifest_roundtrip_is_an_object() {
        let value = json!({"format": FORMAT, "files": [], "secretsExcluded": true});
        assert_eq!(value.get("format").and_then(Value::as_u64), Some(1));
    }
}
