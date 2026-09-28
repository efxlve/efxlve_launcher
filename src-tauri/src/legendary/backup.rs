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

/// Attempts to automatically discover the local save directory for a game
/// across standard Windows locations (Unreal Engine LocalAppData, Saved Games, Documents, etc.).
pub fn detect_save_path(app_name: &str, title: Option<&str>, install_path: Option<&str>) -> Option<String> {
    let mut names: Vec<String> = Vec::new();
    if !app_name.trim().is_empty() {
        names.push(app_name.trim().to_string());
        names.push(app_name.trim().replace(' ', ""));
        names.push(app_name.trim().replace([':', '-', '_', '\''], ""));
    }
    if let Some(t) = title {
        let t_trim = t.trim();
        if !t_trim.is_empty() {
            names.push(t_trim.to_string());
            names.push(t_trim.replace(' ', ""));
            names.push(t_trim.replace([':', '-', '_', '\''], ""));
        }
    }
    names.dedup();

    // 1. %LOCALAPPDATA% (Unreal Engine games, Unity, indie games)
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let base = Path::new(&local_app);
        for name in &names {
            let candidate_saved = base.join(name).join("Saved").join("SaveGames");
            if candidate_saved.is_dir() {
                return Some(candidate_saved.to_string_lossy().to_string());
            }
            let candidate_saved_root = base.join(name).join("Saved");
            if candidate_saved_root.is_dir() {
                return Some(candidate_saved_root.to_string_lossy().to_string());
            }
            let candidate_direct = base.join(name);
            if candidate_direct.is_dir() && has_save_like_files(&candidate_direct) {
                return Some(candidate_direct.to_string_lossy().to_string());
            }
        }
    }

    // 2. %USERPROFILE%\Saved Games
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let base = Path::new(&user_profile);
        let saved_games_dir = base.join("Saved Games");
        if saved_games_dir.is_dir() {
            for name in &names {
                let candidate = saved_games_dir.join(name);
                if candidate.is_dir() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }

        // 3. %USERPROFILE%\Documents\My Games
        let my_games = base.join("Documents").join("My Games");
        if my_games.is_dir() {
            for name in &names {
                let candidate = my_games.join(name);
                if candidate.is_dir() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }

        // 4. %USERPROFILE%\Documents\<Name>
        let docs = base.join("Documents");
        if docs.is_dir() {
            for name in &names {
                let candidate = docs.join(name);
                if candidate.is_dir() && has_save_like_files(&candidate) {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    // 5. %APPDATA%
    if let Ok(roaming) = std::env::var("APPDATA") {
        let base = Path::new(&roaming);
        for name in &names {
            let candidate = base.join(name);
            if candidate.is_dir() && has_save_like_files(&candidate) {
                return Some(candidate.to_string_lossy().to_string());
            }
        }
    }

    // 6. Inside install_path
    if let Some(ip) = install_path {
        let p = Path::new(ip);
        if p.is_dir() {
            for sub in ["Saved\\SaveGames", "Saved", "Saves"] {
                let candidate = p.join(sub);
                if candidate.is_dir() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    None
}

/// Helper that checks if a directory contains save-related files or subdirectories
fn has_save_like_files(dir: &Path) -> bool {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            let name_low = p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_lowercase();
            if name_low.contains("save") || name_low.ends_with(".sav") || name_low.ends_with(".dat") {
                return true;
            }
        }
    }
    false
}

pub fn create_backup(app_name: &str, save_path_override: Option<&str>) -> Result<SaveBackupInfo, String> {
    let installed = super::cache::read_installed(&super::skip::default_config_dir());
    let installed_game = installed.into_iter().find(|g| g.app_name == app_name);

    let cfgs = super::commands::load_all_game_custom_configs();
    let cfg = cfgs.get(app_name);

    let save_path_str = if let Some(sp) = save_path_override.filter(|s| !s.trim().is_empty()) {
        sp.trim().to_string()
    } else if let Some(csp) = cfg.and_then(|c| c.custom_save_path.as_deref()).filter(|s| !s.trim().is_empty()) {
        csp.trim().to_string()
    } else if let Some(sp) = installed_game.as_ref().and_then(|g| g.save_path.as_deref()).filter(|s| !s.trim().is_empty()) {
        sp.trim().to_string()
    } else {
        let title = installed_game.as_ref().map(|g| g.title.as_str());
        let install_path = installed_game.as_ref().map(|g| g.install_path.as_str());
        detect_save_path(app_name, title, install_path)
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

    #[test]
    fn test_detect_save_path_candidates() {
        let temp_dir = std::env::temp_dir().join(format!("efxlve_test_save_detect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let save_dir = temp_dir.join("Saved").join("SaveGames");
        std::fs::create_dir_all(&save_dir).unwrap();

        let detected = detect_save_path("SampleGame", Some("Sample Game"), Some(&temp_dir.to_string_lossy()));
        assert!(detected.is_some());
        assert_eq!(detected.unwrap(), save_dir.to_string_lossy().to_string());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
