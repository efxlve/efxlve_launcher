//! Local save backup and restore manager.
//!
//! Backups are kept under `%USERPROFILE%\.config\legendary\backups\<app_name>\<backup_id>\`.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveBackupInfo {
    pub id: String,
    pub app_name: String,
    pub timestamp: u64,
    pub formatted_date: String,
    pub size_bytes: u64,
    pub file_count: usize,
    pub save_path: String,
}

pub fn backups_base_dir() -> PathBuf {
    super::skip::default_config_dir().join("backups")
}

pub fn app_backup_dir(app_name: &str) -> PathBuf {
    backups_base_dir().join(app_name)
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<(u64, usize)> {
    let mut total_bytes = 0u64;
    let mut file_count = 0usize;

    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    if src.is_file() {
        let n = std::fs::copy(src, dst.join(src.file_name().unwrap_or_default()))?;
        return Ok((n, 1));
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());

        if ty.is_dir() {
            let (sub_bytes, sub_count) = copy_dir_all(&from, &to)?;
            total_bytes += sub_bytes;
            file_count += sub_count;
        } else {
            let bytes = std::fs::copy(&from, &to)?;
            total_bytes += bytes;
            file_count += 1;
        }
    }

    Ok((total_bytes, file_count))
}

pub fn create_backup(app_name: &str, save_path_override: Option<&str>) -> Result<SaveBackupInfo, String> {
    let save_path_str = if let Some(sp) = save_path_override {
        sp.to_string()
    } else {
        // installed.json'dan save_path oku
        let installed = super::cache::read_installed(&super::skip::default_config_dir());
        installed
            .into_iter()
            .find(|g| g.app_name == app_name)
            .and_then(|g| g.save_path)
            .ok_or_else(|| "@t:backup.noSaveDir".to_string())?
    };

    let source = PathBuf::from(&save_path_str);
    if !source.exists() {
        return Err(format!("@t:backup.saveDirMissing\u{1f}{save_path_str}"));
    }

    let now_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let backup_id = format!("{now_ts}");
    let target = app_backup_dir(app_name).join(&backup_id);
    std::fs::create_dir_all(&target).map_err(|e| e.to_string())?;

    let (size_bytes, file_count) = copy_dir_all(&source, &target.join("data"))
        .map_err(|e| format!("@t:backup.copyFailed\u{1f}{e}"))?;

    let days = now_ts / 86400;
    let rem = now_ts % 86400;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let approx_year = 1970 + days / 365;
    let formatted_date = format!("{approx_year:04} ({hours:02}:{minutes:02} UTC)");

    let info = SaveBackupInfo {
        id: backup_id,
        app_name: app_name.to_string(),
        timestamp: now_ts,
        formatted_date,
        size_bytes,
        file_count,
        save_path: save_path_str,
    };

    let info_json = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    let _ = std::fs::write(target.join("backup_info.json"), info_json);

    Ok(info)
}

pub fn list_backups(app_name: &str) -> Vec<SaveBackupInfo> {
    let dir = app_backup_dir(app_name);
    let mut list = Vec::new();

    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    let info_path = entry.path().join("backup_info.json");
                    if let Ok(content) = std::fs::read_to_string(&info_path) {
                        if let Ok(info) = serde_json::from_str::<SaveBackupInfo>(&content) {
                            list.push(info);
                        }
                    }
                }
            }
        }
    }

    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    list
}

pub fn restore_backup(app_name: &str, backup_id: &str) -> Result<String, String> {
    let backup_dir = app_backup_dir(app_name).join(backup_id);
    let info_path = backup_dir.join("backup_info.json");
    if !info_path.exists() {
        return Err("@t:backup.infoNotFound".to_string());
    }

    let content = std::fs::read_to_string(&info_path).map_err(|e| e.to_string())?;
    let info: SaveBackupInfo = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let data_src = backup_dir.join("data");
    if !data_src.exists() {
        return Err("@t:backup.dataFolderNotFound".to_string());
    }

    let dest = PathBuf::from(&info.save_path);
    copy_dir_all(&data_src, &dest)
        .map_err(|e| format!("@t:backup.restoreError\u{1f}{e}"))?;

    Ok(format!("@t:backup.restored\u{1f}{}\u{1f}{}", info.file_count, info.formatted_date))
}

pub fn delete_backup(app_name: &str, backup_id: &str) -> Result<(), String> {
    let target = app_backup_dir(app_name).join(backup_id);
    if target.exists() {
        std::fs::remove_dir_all(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_backup_info_serialize() {
        let info = SaveBackupInfo {
            id: "12345".into(),
            app_name: "test_game".into(),
            timestamp: 123456789,
            formatted_date: "2026 (12:00 UTC)".into(),
            size_bytes: 1024,
            file_count: 3,
            save_path: "C:\\Saves".into(),
        };

        let json = serde_json::to_string(&info).unwrap();
        let parsed: SaveBackupInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "12345");
        assert_eq!(parsed.file_count, 3);
    }
}
