//! "Move to a new PC": one folder with the launcher profile and every game's
//! newest save archive, plus a manifest that the import side reads back.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::AppHandle;

use crate::cloud_backup::profile_sync;
use crate::legendary::backup;

const FORMAT: u64 = 1;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationExport {
    pub folder: String,
    pub games: usize,
    pub profile: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationImport {
    pub games: usize,
    pub profile_restored: bool,
    pub local_storage: Value,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Only a relative path inside the migration folder is accepted.
fn safe_join(root: &Path, rel: &str) -> Option<PathBuf> {
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
    if clean.as_os_str().is_empty() {
        None
    } else {
        Some(root.join(clean))
    }
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Writes the profile plus one archive per game that already has a local
/// backup. Returns the created folder, which is what the import side expects.
pub fn export_migration(
    app: &AppHandle,
    folder: &str,
    local_storage: &Value,
    password: Option<String>,
    titles: HashMap<String, String>,
) -> Result<MigrationExport, String> {
    let root = PathBuf::from(folder.trim());
    if !root.is_dir() {
        return Err("@t:backup.exportFolderMissing".to_string());
    }
    let target = root.join(format!("efxlve-migration-{}", now_secs()));
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;
    let target_text = target.to_string_lossy().to_string();
    let profile = profile_sync::export_to_file(app, &target_text, local_storage, password.clone())?;

    let mut latest: HashMap<String, backup::SaveBackupInfo> = HashMap::new();
    for info in backup::list_all_backups() {
        latest.entry(info.app_name.clone()).or_insert(info);
    }
    let mut saves = Vec::new();
    for (key, info) in latest {
        let title = titles.get(&key).cloned().unwrap_or_else(|| key.clone());
        let archive =
            backup::export_backup(&key, &info.id, &target_text, &title, password.as_deref())?;
        saves.push(json!({
            "key": key,
            "title": title,
            "file": file_name_of(&archive),
            "timestamp": info.timestamp,
        }));
    }
    let game_count = saves.len();
    let manifest = json!({
        "format": FORMAT,
        "createdAt": now_secs(),
        "profile": file_name_of(&profile),
        "saves": saves,
    });
    std::fs::write(
        target.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(MigrationExport {
        folder: target_text,
        games: game_count,
        profile,
    })
}

/// Imports every save in the manifest, then the launcher profile. The caller
/// applies `local_storage` and relaunches.
pub fn import_migration(
    app: &AppHandle,
    folder: &str,
    password: Option<String>,
) -> Result<MigrationImport, String> {
    let picked = PathBuf::from(folder.trim());
    let root = if picked.join("manifest.json").is_file() {
        picked
    } else {
        let mut found = None;
        if let Ok(entries) = std::fs::read_dir(&picked) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.join("manifest.json").is_file() {
                    found = Some(path);
                    break;
                }
            }
        }
        found.ok_or_else(|| "@t:backup.notAMigrationFolder".to_string())?
    };

    let manifest: Value = serde_json::from_slice(
        &std::fs::read(root.join("manifest.json"))
            .map_err(|_| "@t:backup.notAMigrationFolder".to_string())?,
    )
    .map_err(|_| "@t:backup.notAMigrationFolder".to_string())?;
    if manifest.get("format").and_then(Value::as_u64) != Some(FORMAT) {
        return Err("@t:backup.unsupportedMigration".to_string());
    }
    let profile_name = manifest
        .get("profile")
        .and_then(Value::as_str)
        .ok_or_else(|| "@t:backup.notAMigrationFolder".to_string())?;
    let profile_path = safe_join(&root, profile_name)
        .ok_or_else(|| "@t:backup.notAMigrationFolder".to_string())?;

    let mut games = 0usize;
    if let Some(saves) = manifest.get("saves").and_then(Value::as_array) {
        for save in saves {
            let key = save
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "@t:backup.notAMigrationFolder".to_string())?;
            let file = save
                .get("file")
                .and_then(Value::as_str)
                .ok_or_else(|| "@t:backup.notAMigrationFolder".to_string())?;
            let path = safe_join(&root, file)
                .ok_or_else(|| "@t:backup.notAMigrationFolder".to_string())?;
            backup::import_backup(key, &path.to_string_lossy(), password.as_deref())?;
            games += 1;
        }
    }

    let restored = profile_sync::import_file(app, &profile_path.to_string_lossy(), password)?;
    Ok(MigrationImport {
        games,
        profile_restored: true,
        local_storage: restored.local_storage,
    })
}
