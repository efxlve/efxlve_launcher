//! Folder provider: a plain folder the user already syncs (OneDrive, Dropbox,
//! Syncthing, a NAS mount). No account or OAuth setup is involved.

use std::collections::HashSet;
use std::path::{Component, Path, PathBuf};

use crate::cloud_backup::models::{CloudBackupEntry, CloudFolderSuggestion};
use crate::legendary::backup::{backup_key, format_backup_timestamp};

const ROOT: &str = "efxlve_saves";

fn root_dir(base: &str) -> PathBuf {
    Path::new(base).join(ROOT)
}

fn app_dir(base: &str, app_name: &str) -> PathBuf {
    root_dir(base).join(backup_key(app_name))
}

/// Resolves a remote id returned by this module. Absolute paths, `..` and
/// symlinks outside the provider root are rejected before any file operation.
fn resolve(base: &str, remote_id: &str) -> Result<PathBuf, String> {
    let relative = Path::new(remote_id);
    if relative.is_absolute() {
        return Err("Invalid backup path.".to_string());
    }
    let mut clean = PathBuf::new();
    for component in relative.components() {
        match component {
            Component::Normal(part) => clean.push(part),
            _ => return Err("Invalid backup path.".to_string()),
        }
    }
    if clean.as_os_str().is_empty() {
        return Err("Invalid backup path.".to_string());
    }
    let root = root_dir(base);
    let full = Path::new(base).join(clean);
    if !full.starts_with(&root) {
        return Err("Invalid backup path.".to_string());
    }
    Ok(full)
}

/// Checks that the folder exists and is writable, without leaving a probe file.
pub fn test_folder(base: &str) -> Result<String, String> {
    let base = base.trim();
    if base.is_empty() {
        return Err("Choose a folder for save backups.".to_string());
    }
    let root = root_dir(base);
    std::fs::create_dir_all(&root).map_err(|error| format!("Folder is not writable: {error}"))?;
    let probe = root.join(".efxlve-write-test");
    std::fs::write(&probe, b"ok").map_err(|error| format!("Folder is not writable: {error}"))?;
    let _ = std::fs::remove_file(&probe);
    Ok(format!("Folder is ready: {}", root.to_string_lossy()))
}

/// Moves archives created before the safe-key change from the raw game key
/// (gog::123) to the safe folder (gog__123). A raw folder cannot be created on
/// Windows, so this only has work on Unix; a conflict keeps both files instead
/// of overwriting the newer archive.
fn migrate_legacy_dir(base: &str, app_name: &str) {
    let safe = backup_key(app_name);
    if safe == app_name {
        return;
    }
    let root = root_dir(base);
    let legacy = root.join(app_name);
    if !legacy.is_dir() {
        return;
    }
    let target = root.join(&safe);
    if !target.exists() {
        let _ = std::fs::rename(&legacy, &target);
        return;
    }
    let Ok(entries) = std::fs::read_dir(&legacy) else {
        return;
    };
    for entry in entries.flatten() {
        let destination = target.join(entry.file_name());
        if destination.exists() {
            continue;
        }
        if entry.file_type().map(|kind| kind.is_file()).unwrap_or(false) {
            let _ = std::fs::copy(entry.path(), &destination);
            let _ = std::fs::remove_file(entry.path());
        }
    }
    let _ = std::fs::remove_dir(&legacy);
}

pub fn upload_backup_folder(
    base: &str,
    app_name: &str,
    backup_id: &str,
    archive: &Path,
) -> Result<String, String> {
    migrate_legacy_dir(base, app_name);
    let dir = app_dir(base, app_name);
    std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    let file_name = format!("{backup_id}.tar.gz");
    let target = dir.join(&file_name);
    std::fs::copy(archive, &target).map_err(|error| error.to_string())?;
    let relative = format!("{ROOT}/{}/{}", backup_key(app_name), file_name);
    Ok(relative)
}

pub fn list_backups_folder(base: &str, app_name: &str) -> Result<Vec<CloudBackupEntry>, String> {
    migrate_legacy_dir(base, app_name);
    let dir = app_dir(base, app_name);
    let mut list = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(list),
        Err(error) => return Err(error.to_string()),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(backup_id) = file_name.strip_suffix(".tar.gz") else {
            continue;
        };
        let metadata = entry.metadata().ok();
        let timestamp = backup_id
            .parse::<u64>()
            .ok()
            .or_else(|| {
                metadata
                    .as_ref()
                    .and_then(|meta| meta.modified().ok())
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|duration| duration.as_secs())
            })
            .unwrap_or(0);
        let relative = format!("{ROOT}/{}/{}", backup_key(app_name), file_name);
        list.push(CloudBackupEntry {
            backup_id: backup_id.to_string(),
            app_name: app_name.to_string(),
            timestamp,
            formatted_date: format_backup_timestamp(timestamp),
            size_bytes: metadata.as_ref().map(|meta| meta.len()).unwrap_or(0),
            file_count: 0,
            sha256: String::new(),
            provider: "folder".to_string(),
            remote_id: relative,
        });
    }

    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(list)
}

pub fn download_backup_folder(base: &str, remote_id: &str, target: &Path) -> Result<(), String> {
    let source = resolve(base, remote_id)?;
    if !source.is_file() {
        return Err("Backup file was not found in the folder.".to_string());
    }
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::copy(&source, target).map_err(|error| error.to_string())?;
    Ok(())
}

pub fn delete_backup_folder(base: &str, remote_id: &str) -> Result<(), String> {
    let path = resolve(base, remote_id)?;
    if path.is_file() {
        std::fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Sync roots the user's desktop clients already created. Detection is
/// read-only; the Folder provider still creates `efxlve_saves` inside the
/// chosen root on Test Connection.
pub fn suggest_sync_folders() -> Vec<CloudFolderSuggestion> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    // On Windows the environment is authoritative: OneDrive can live on another
    // drive and a work account has its own variable.
    #[cfg(windows)]
    for (var, client) in [
        ("OneDrive", "OneDrive"),
        ("OneDriveConsumer", "OneDrive"),
        ("OneDriveCommercial", "OneDrive (work)"),
    ] {
        if let Some(value) = std::env::var_os(var) {
            push_existing(&mut out, &mut seen, client, &PathBuf::from(value));
        }
    }

    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from);
    if let Some(home) = home {
        for (client, relative) in [
            ("OneDrive", "OneDrive"),
            ("Dropbox", "Dropbox"),
            ("Google Drive", "Google Drive"),
            ("Google Drive", "GoogleDrive"),
            ("iCloud Drive", "iCloudDrive"),
            ("Nextcloud", "Nextcloud"),
            ("MEGA", "MEGA"),
            ("MEGA", "Mega"),
            ("MEGA", "MEGAsync"),
        ] {
            push_existing(&mut out, &mut seen, client, &home.join(relative));
        }

        // macOS keeps every client under Library/CloudStorage with an account
        // suffix, e.g. `OneDrive-Contoso`.
        #[cfg(target_os = "macos")]
        if let Ok(entries) = std::fs::read_dir(home.join("Library").join("CloudStorage")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let client = if name.starts_with("OneDrive") {
                    "OneDrive"
                } else if name.starts_with("GoogleDrive") {
                    "Google Drive"
                } else if name.starts_with("Dropbox") {
                    "Dropbox"
                } else if name.starts_with("iCloud") {
                    "iCloud Drive"
                } else {
                    continue;
                };
                push_existing(&mut out, &mut seen, client, &entry.path());
            }
        }
    }

    out
}

fn push_existing(
    out: &mut Vec<CloudFolderSuggestion>,
    seen: &mut HashSet<String>,
    client: &str,
    path: &Path,
) {
    if !path.is_dir() {
        return;
    }
    let text = path.to_string_lossy().to_string();
    let key = if cfg!(windows) {
        text.to_lowercase()
    } else {
        text.clone()
    };
    if !seen.insert(key) {
        return;
    }
    out.push(CloudFolderSuggestion {
        client: client.to_string(),
        path: text,
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_cannot_escape_the_provider_root() {
        assert!(resolve(r"C:\Saves", "../outside.tar.gz").is_err());
        assert!(resolve(r"C:\Saves", r"C:\Windows\x.tar.gz").is_err());
        let inside = resolve(r"C:\Saves", "efxlve_saves/game/1.tar.gz").unwrap();
        assert!(inside.starts_with(root_dir(r"C:\Saves")));
    }

    #[cfg(unix)]
    #[test]
    fn a_legacy_raw_key_folder_is_migrated() {
        let base =
            std::env::temp_dir().join(format!("efxlve-folder-legacy-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let legacy = base.join("efxlve_saves").join("gog::123");
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::write(legacy.join("100.tar.gz"), b"archive").unwrap();

        let base_str = base.to_string_lossy().to_string();
        let listed = list_backups_folder(&base_str, "gog::123").unwrap();
        assert_eq!(listed.len(), 1);
        assert!(base
            .join("efxlve_saves")
            .join("gog__123")
            .join("100.tar.gz")
            .is_file());
        assert!(!legacy.exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn suggestions_skip_missing_folders_and_deduplicate() {
        let root =
            std::env::temp_dir().join(format!("efxlve-folder-suggest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("OneDrive")).unwrap();

        let mut out = Vec::new();
        let mut seen = HashSet::new();
        push_existing(&mut out, &mut seen, "OneDrive", &root.join("OneDrive"));
        push_existing(&mut out, &mut seen, "OneDrive", &root.join("OneDrive"));
        push_existing(&mut out, &mut seen, "MEGA", &root.join("MEGA"));

        assert_eq!(out.len(), 1);
        assert_eq!(out[0].client, "OneDrive");
        assert!(out[0].path.ends_with("OneDrive"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_backup_round_trips_through_the_folder_provider() {
        let base = std::env::temp_dir().join(format!("efxlve-folder-provider-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let archive = base.join("source.tar.gz");
        std::fs::write(&archive, b"archive").unwrap();

        let base_str = base.to_string_lossy().to_string();
        let remote_id = upload_backup_folder(&base_str, "gog::123", "100", &archive).unwrap();
        assert_eq!(remote_id, "efxlve_saves/gog__123/100.tar.gz");

        let listed = list_backups_folder(&base_str, "gog::123").unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].backup_id, "100");

        let copy = base.join("copy.tar.gz");
        download_backup_folder(&base_str, &remote_id, &copy).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), b"archive");

        delete_backup_folder(&base_str, &remote_id).unwrap();
        assert!(list_backups_folder(&base_str, "gog::123").unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&base);
    }
}
