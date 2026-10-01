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

fn normalize_for_match(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn build_search_candidates(
    app_name: &str,
    title: Option<&str>,
    install_path: Option<&str>,
) -> (Vec<String>, Vec<String>) {
    let mut names: Vec<String> = Vec::new();

    let app_clean = app_name.trim();
    if !app_clean.is_empty() {
        names.push(app_clean.to_string());
        names.push(app_clean.replace(' ', ""));
        names.push(app_clean.replace([':', '-', '_', '\'', '\"', '™', '®', '©'], ""));
    }

    if let Some(t) = title {
        let t_clean = t.trim();
        if !t_clean.is_empty() {
            names.push(t_clean.to_string());
            names.push(t_clean.replace(' ', ""));
            names.push(t_clean.replace([':', '-', '_', '\'', '\"', '™', '®', '©'], ""));

            if let Some((main, sub)) = t_clean.split_once(':') {
                let m = main.trim();
                let s = sub.trim();
                if !m.is_empty() {
                    names.push(m.to_string());
                    names.push(m.replace([':', '-', '_', '\'', '\"', '™', '®', '©'], ""));
                }
                if !s.is_empty() {
                    names.push(s.to_string());
                    names.push(s.replace([':', '-', '_', '\'', '\"', '™', '®', '©'], ""));
                }
            } else if let Some((main, sub)) = t_clean.split_once(" - ") {
                let m = main.trim();
                let s = sub.trim();
                if !m.is_empty() {
                    names.push(m.to_string());
                }
                if !s.is_empty() {
                    names.push(s.to_string());
                }
            }
        }
    }

    if let Some(ip) = install_path {
        let p = Path::new(ip);
        if let Some(fn_os) = p.file_name().and_then(|n| n.to_str()) {
            let fn_trim = fn_os.trim();
            if !fn_trim.is_empty() {
                names.push(fn_trim.to_string());
                names.push(fn_trim.replace([':', '-', '_', '\'', '\"'], ""));
            }
        }
    }

    names.retain(|n| !n.trim().is_empty());
    names.dedup();

    let mut normalized: Vec<String> = names
        .iter()
        .map(|n| normalize_for_match(n))
        .filter(|k| !k.is_empty())
        .collect();
    normalized.dedup();

    (names, normalized)
}

fn is_dir_match(dir_name: &str, names: &[String], normalized: &[String]) -> bool {
    for n in names {
        if n.eq_ignore_ascii_case(dir_name) {
            return true;
        }
    }
    let dir_norm = normalize_for_match(dir_name);
    if !dir_norm.is_empty() {
        for k in normalized {
            if k == &dir_norm {
                return true;
            }
        }
    }
    false
}

fn scan_folder_for_game(
    base: &Path,
    names: &[String],
    normalized: &[String],
    allow_nested: bool,
    require_save_files: bool,
) -> Option<PathBuf> {
    if !base.is_dir() {
        return None;
    }

    let entries = match std::fs::read_dir(base) {
        Ok(e) => e.flatten().collect::<Vec<_>>(),
        Err(_) => return None,
    };

    // 1. Direct children
    for entry in &entries {
        if let Ok(file_type) = entry.file_type() {
            if file_type.is_dir() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if is_dir_match(&name_str, names, normalized) {
                    let path = entry.path();
                    if !require_save_files || has_save_like_files(&path) {
                        return Some(path);
                    }
                }
            }
        }
    }

    // 2. 1-level nested children (Publisher/Studio folder, e.g. CD Projekt Red, Rockstar Games, etc.)
    if allow_nested {
        for entry in &entries {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    let pub_path = entry.path();
                    if let Ok(sub_entries) = std::fs::read_dir(&pub_path) {
                        for sub_entry in sub_entries.flatten() {
                            if let Ok(sub_type) = sub_entry.file_type() {
                                if sub_type.is_dir() {
                                    let sub_name = sub_entry.file_name();
                                    let sub_name_str = sub_name.to_string_lossy();
                                    if is_dir_match(&sub_name_str, names, normalized) {
                                        let path = sub_entry.path();
                                        if !require_save_files || has_save_like_files(&path) {
                                            return Some(path);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

fn check_unreal_or_direct(candidate: &Path) -> Option<PathBuf> {
    let saved_games = candidate.join("Saved").join("SaveGames");
    if saved_games.is_dir() {
        return Some(saved_games);
    }
    let saved = candidate.join("Saved");
    if saved.is_dir() {
        return Some(saved);
    }
    if has_save_like_files(candidate) {
        return Some(candidate.to_path_buf());
    }
    None
}

/// Helper that checks if a directory contains save-related files or subdirectories
fn has_save_like_files(dir: &Path) -> bool {
    let mut dirs_to_check = vec![dir.to_path_buf()];
    let mut depth = 0;

    while let Some(current_dir) = dirs_to_check.pop() {
        if let Ok(entries) = std::fs::read_dir(&current_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                let name_low = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if p.is_file() {
                    if name_low.contains("save")
                        || name_low.ends_with(".sav")
                        || name_low.ends_with(".dat")
                        || name_low.ends_with(".bin")
                        || name_low.ends_with(".json")
                        || name_low.ends_with(".xml")
                        || name_low.ends_with(".profile")
                        || name_low.ends_with(".sl2")
                        || name_low.ends_with(".vdf")
                        || name_low.starts_with("srdr")
                        || name_low.starts_with("sgta")
                    {
                        return true;
                    }
                } else if p.is_dir() && depth < 2 {
                    if name_low.contains("save")
                        || name_low == "profiles"
                        || name_low == "users"
                        || name_low == "data"
                        || (name_low.len() >= 16 && name_low.chars().all(|c| c.is_ascii_hexdigit()))
                    {
                        return true;
                    }
                    dirs_to_check.push(p);
                }
            }
        }
        depth += 1;
        if depth > 3 {
            break;
        }
    }

    if let Ok(mut entries) = std::fs::read_dir(dir) {
        if entries.next().is_some() {
            return true;
        }
    }
    false
}

/// Attempts to automatically discover the local save directory for a game
/// across standard Windows locations (Unreal Engine LocalAppData, Saved Games, Documents, LocalLow, etc.).
pub fn detect_save_path(
    app_name: &str,
    title: Option<&str>,
    install_path: Option<&str>,
) -> Option<String> {
    // 0. Fast-path known save locations for popular titles
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let base = Path::new(&user_profile);
        let title_low = title.unwrap_or("").to_lowercase();
        let app_low = app_name.to_lowercase();

        if app_low == "ginger" || title_low.contains("cyberpunk") {
            let cp_path = base
                .join("Saved Games")
                .join("CD Projekt Red")
                .join("Cyberpunk 2077");
            if cp_path.is_dir() {
                return Some(cp_path.to_string_lossy().to_string());
            }
        }

        if app_low == "heather" || title_low.contains("red dead redemption") {
            let rdr2_path = base
                .join("Documents")
                .join("Rockstar Games")
                .join("Red Dead Redemption 2");
            if rdr2_path.is_dir() {
                return Some(rdr2_path.to_string_lossy().to_string());
            }
        }

        if title_low.contains("grand theft auto") || title_low.contains("gta") {
            for sub in ["GTAV Enhanced", "GTA V", "Grand Theft Auto V"] {
                let gta_path = base.join("Documents").join("Rockstar Games").join(sub);
                if gta_path.is_dir() {
                    return Some(gta_path.to_string_lossy().to_string());
                }
            }
        }

        if title_low.contains("spider-man") || title_low.contains("spiderman") {
            for sub in [
                "Marvel's Spider-Man Remastered",
                "Marvel's Spider-Man Miles Morales",
            ] {
                let sm_path = base.join("Documents").join(sub);
                if sm_path.is_dir() {
                    return Some(sm_path.to_string_lossy().to_string());
                }
            }
        }

        if title_low.contains("uncharted") {
            let uc_path = base
                .join("Saved Games")
                .join("Uncharted Legacy of Thieves Collection");
            if uc_path.is_dir() {
                return Some(uc_path.to_string_lossy().to_string());
            }
        }
    }

    let (names, normalized) = build_search_candidates(app_name, title, install_path);

    // 1. %USERPROFILE%\Saved Games (direct and publisher subfolder)
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let base = Path::new(&user_profile);
        let saved_games_dir = base.join("Saved Games");
        if let Some(found) =
            scan_folder_for_game(&saved_games_dir, &names, &normalized, true, false)
        {
            return Some(found.to_string_lossy().to_string());
        }

        // 2. %USERPROFILE%\Documents\My Games (direct and publisher subfolder)
        let my_games = base.join("Documents").join("My Games");
        if let Some(found) = scan_folder_for_game(&my_games, &names, &normalized, true, false) {
            let inner_saved = found.join("Saved").join("SaveGames");
            if inner_saved.is_dir() {
                return Some(inner_saved.to_string_lossy().to_string());
            }
            let inner_saves = found.join("Saves");
            if inner_saves.is_dir() {
                return Some(inner_saves.to_string_lossy().to_string());
            }
            return Some(found.to_string_lossy().to_string());
        }

        // 3. %USERPROFILE%\Documents (direct and publisher subfolder)
        let docs = base.join("Documents");
        if let Some(found) = scan_folder_for_game(&docs, &names, &normalized, true, true) {
            return Some(found.to_string_lossy().to_string());
        }

        // 4. %USERPROFILE%\AppData\LocalLow (Unity games: <Publisher>\<Game>)
        let locallow = base.join("AppData").join("LocalLow");
        if let Some(found) = scan_folder_for_game(&locallow, &names, &normalized, true, false) {
            return Some(found.to_string_lossy().to_string());
        }
    }

    // 5. %LOCALAPPDATA% (Unreal Engine games, Unity, indie games)
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let base = Path::new(&local_app);
        if let Some(found) = scan_folder_for_game(base, &names, &normalized, true, false) {
            if let Some(ue_path) = check_unreal_or_direct(&found) {
                return Some(ue_path.to_string_lossy().to_string());
            }
        }
    }

    // 6. %APPDATA% (Roaming)
    if let Ok(roaming) = std::env::var("APPDATA") {
        let base = Path::new(&roaming);
        if let Some(found) = scan_folder_for_game(base, &names, &normalized, true, true) {
            return Some(found.to_string_lossy().to_string());
        }
    }

    // 7. Inside install_path
    if let Some(ip) = install_path {
        let p = Path::new(ip);
        if p.is_dir() {
            for sub in ["Saved\\SaveGames", "Saved", "Saves", "save", "Save"] {
                let candidate = p.join(sub);
                if candidate.is_dir() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    None
}

pub fn create_backup(
    app_name: &str,
    save_path_override: Option<&str>,
) -> Result<SaveBackupInfo, String> {
    let installed = super::cache::read_installed(&super::skip::default_config_dir());
    let installed_game = installed.into_iter().find(|g| g.app_name == app_name);

    let cfgs = super::commands::load_all_game_custom_configs();
    let cfg = cfgs.get(app_name);

    let save_path_str = if let Some(sp) = save_path_override.filter(|s| !s.trim().is_empty()) {
        sp.trim().to_string()
    } else if let Some(csp) = cfg
        .and_then(|c| c.custom_save_path.as_deref())
        .filter(|s| !s.trim().is_empty())
    {
        csp.trim().to_string()
    } else if let Some(sp) = installed_game
        .as_ref()
        .and_then(|g| g.save_path.as_deref())
        .filter(|s| !s.trim().is_empty())
    {
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

    let mut dest = PathBuf::from(&info.save_path);
    if !dest.exists() {
        if let Ok(current_user) = std::env::var("USERPROFILE") {
            let path_str = info.save_path.replace('\\', "/");
            if let Some(idx) = path_str.find("/Saved Games/") {
                dest = Path::new(&current_user).join(&path_str[idx + 1..].replace('/', "\\"));
            } else if let Some(idx) = path_str.find("/Documents/") {
                dest = Path::new(&current_user).join(&path_str[idx + 1..].replace('/', "\\"));
            } else if let Some(idx) = path_str.find("/AppData/") {
                dest = Path::new(&current_user).join(&path_str[idx + 1..].replace('/', "\\"));
            }
        }
        if !dest.exists() {
            let installed = super::cache::read_installed(&super::skip::default_config_dir());
            let installed_game = installed.into_iter().find(|g| g.app_name == app_name);
            let title = installed_game.as_ref().map(|g| g.title.as_str());
            let install_path = installed_game.as_ref().map(|g| g.install_path.as_str());
            if let Some(detected) = detect_save_path(app_name, title, install_path) {
                dest = PathBuf::from(detected);
            }
        }
    }

    copy_dir_all(&data_src, &dest).map_err(|e| format!("@t:backup.restoreError\u{1f}{e}"))?;

    Ok(format!(
        "@t:backup.restored\u{1f}{}\u{1f}{}",
        info.file_count, info.formatted_date
    ))
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
        let temp_dir =
            std::env::temp_dir().join(format!("efxlve_test_save_detect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let save_dir = temp_dir.join("Saved").join("SaveGames");
        std::fs::create_dir_all(&save_dir).unwrap();

        let detected = detect_save_path(
            "SampleGame",
            Some("Sample Game"),
            Some(&temp_dir.to_string_lossy()),
        );
        assert!(detected.is_some());
        assert_eq!(detected.unwrap(), save_dir.to_string_lossy().to_string());

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_normalize_for_match() {
        assert_eq!(
            normalize_for_match("UNCHARTED™: Legacy of Thieves Collection"),
            "unchartedlegacyofthievescollection"
        );
        assert_eq!(
            normalize_for_match("Uncharted Legacy of Thieves Collection"),
            "unchartedlegacyofthievescollection"
        );
        assert_eq!(normalize_for_match("Cyberpunk 2077"), "cyberpunk2077");
        assert_eq!(
            normalize_for_match("Marvel's Spider-Man"),
            "marvelsspiderman"
        );
    }

    #[test]
    fn test_scan_nested_publisher() {
        let temp_dir =
            std::env::temp_dir().join(format!("efxlve_test_pub_detect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let game_dir = temp_dir.join("CD Projekt Red").join("Cyberpunk 2077");
        std::fs::create_dir_all(&game_dir).unwrap();

        let (names, normalized) = build_search_candidates("Ginger", Some("Cyberpunk 2077"), None);
        let found = scan_folder_for_game(&temp_dir, &names, &normalized, true, false);
        assert!(found.is_some());
        assert_eq!(found.unwrap(), game_dir);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }
}
