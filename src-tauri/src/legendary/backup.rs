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

/// A filesystem-safe folder name for a game key. Store keys contain `::`
/// (`gog::123`, `steam::456`), which is invalid in a Windows path segment and
/// made every non-Epic local backup fail. Epic names pass through unchanged.
pub fn backup_key(app_name: &str) -> String {
    let mut key = String::with_capacity(app_name.len());
    let mut chars = app_name.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ':' && chars.peek() == Some(&':') {
            chars.next();
            key.push_str("__");
        } else if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
            key.push(c);
        } else {
            key.push('_');
        }
    }
    let trimmed = key.trim_matches(|c| c == '_' || c == '.');
    if trimmed.is_empty() {
        "game".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn app_backup_dir(app_name: &str) -> PathBuf {
    backups_base_dir().join(backup_key(app_name))
}

/// Moves a backup folder created before `backup_key` (`gog::123`, `steam::456`)
/// under the current safe key, so the list keeps showing old backups.
///
/// The legacy name is the raw app key, which used to be a valid Windows folder
/// name for Epic titles and an invalid one for every other store. Only the base
/// directory is touched; separators are rejected so a key can never climb out.
fn migrate_legacy_dir_in(base: &Path, app_name: &str) -> Option<PathBuf> {
    let key = backup_key(app_name);
    if key == app_name
        || app_name.is_empty()
        || app_name == "."
        || app_name == ".."
        || app_name.contains(['/', '\\'])
    {
        return None;
    }
    let legacy = base.join(app_name);
    let target = base.join(&key);
    if !legacy.is_dir() || legacy == target {
        return None;
    }
    if !target.exists() {
        return std::fs::rename(&legacy, &target).ok().map(|_| target);
    }
    // A backup taken after the fix already owns the safe folder: move the old
    // children in without overwriting, then drop the now-empty legacy folder.
    let Ok(entries) = std::fs::read_dir(&legacy) else {
        return None;
    };
    for entry in entries.flatten() {
        let destination = target.join(entry.file_name());
        if !destination.exists() {
            let _ = std::fs::rename(entry.path(), destination);
        }
    }
    let _ = std::fs::remove_dir(&legacy);
    Some(target)
}

fn migrate_legacy_dir(app_name: &str) -> Option<PathBuf> {
    migrate_legacy_dir_in(&backups_base_dir(), app_name)
}

/// Shared by the local list and the folder provider so both show the same date.
pub fn format_backup_timestamp(ts: u64) -> String {
    let days = ts / 86400;
    let rem = ts % 86400;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let approx_year = 1970 + days / 365;
    format!("{approx_year:04} ({hours:02}:{minutes:02} UTC)")
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

/// Copies the current save folder into the local backup store before a restore
/// overwrites it. A failed snapshot aborts the restore: losing the current
/// saves is worse than a refused restore.
fn snapshot_before_restore(app_name: &str, save_path: &Path) -> Result<Option<String>, String> {
    if !save_path.exists() {
        return Ok(None);
    }

    let now_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let mut backup_id = format!("pre-restore-{now_ts}");
    let mut target = app_backup_dir(app_name).join(&backup_id);
    let mut suffix = 1;
    while target.exists() {
        backup_id = format!("pre-restore-{now_ts}-{suffix}");
        target = app_backup_dir(app_name).join(&backup_id);
        suffix += 1;
    }
    std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let (size_bytes, file_count) = copy_dir_all(save_path, &target.join("data"))
        .map_err(|error| format!("@t:backup.copyFailed\u{1f}{error}"))?;
    let info = SaveBackupInfo {
        id: backup_id.clone(),
        app_name: app_name.to_string(),
        timestamp: now_ts,
        formatted_date: format_backup_timestamp(now_ts),
        size_bytes,
        file_count,
        save_path: save_path.to_string_lossy().to_string(),
    };
    let info_json = serde_json::to_string_pretty(&info).map_err(|error| error.to_string())?;
    std::fs::write(target.join("backup_info.json"), info_json).map_err(|error| error.to_string())?;
    Ok(Some(backup_id))
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

/// Attempts to automatically discover the local save directory for a game.
///
/// Windows searches the standard profile locations (Saved Games, Documents,
/// LocalAppData, LocalLow, Roaming). Linux/macOS search the XDG data/config
/// homes, Documents, Unity's `unity3d` tree and the Wine/Proton prefixes the
/// launcher creates.
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

    // Unix: XDG directories, Unity's tree and the launcher's Wine/Proton
    // prefixes. The Windows branches below are harmless there (`USERPROFILE`
    // and the AppData variables are absent), so this is an extra first pass.
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"));
        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        if let Some(found) = detect_save_path_unix(&home, &data_home, &config_home, app_name, title)
        {
            return Some(found);
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

/// Every user directory inside a Wine/Proton prefix (`drive_c/users/<name>`).
#[cfg(any(not(windows), test))]
fn prefix_user_dirs(prefix: &Path) -> Vec<PathBuf> {
    let mut users = Vec::new();
    if let Ok(entries) = std::fs::read_dir(prefix.join("drive_c").join("users")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                users.push(path);
            }
        }
    }
    users
}

/// Runs the ordered root list and returns the first match.
#[cfg(any(not(windows), test))]
fn scan_unix_roots(
    roots: &[(PathBuf, bool, bool)],
    names: &[String],
    normalized: &[String],
) -> Option<String> {
    for (root, nested, require_files) in roots {
        if let Some(found) = scan_folder_for_game(root, names, normalized, *nested, *require_files)
        {
            return Some(found.to_string_lossy().to_string());
        }
    }
    None
}

/// Save locations on Linux/macOS.
///
/// The home, data and config roots are arguments rather than environment reads
/// so the layout can be unit-tested on every platform. Proton keeps the Windows
/// tree under `pfx/drive_c`, and the launcher's own prefixes live under
/// `~/Games/Efxlve/Prefixes`. A prefix named after the game is scanned first;
/// the other prefixes are only touched when it has no saves, which keeps the
/// common case to one directory tree.
#[cfg(any(not(windows), test))]
fn detect_save_path_unix(
    home: &Path,
    data_home: &Path,
    config_home: &Path,
    app_name: &str,
    title: Option<&str>,
) -> Option<String> {
    let (names, normalized) = build_search_candidates(app_name, title, None);

    // `nested` allows one publisher directory; `require_files` only accepts a
    // folder that holds something save-like, so a bare name match in a shared
    // directory does not win over a real save folder.
    let mut standard: Vec<(PathBuf, bool, bool)> = vec![
        (data_home.to_path_buf(), false, false),
        (config_home.join("unity3d"), true, false),
        (home.join("Documents"), true, true),
        (home.join("Saved Games"), true, true),
    ];
    if cfg!(target_os = "macos") {
        standard.push((
            home.join("Library").join("Application Support"),
            true,
            true,
        ));
    }
    if let Some(found) = scan_unix_roots(&standard, &names, &normalized) {
        return Some(found);
    }

    let prefix_root = home.join("Games").join("Efxlve").join("Prefixes");
    let mut prefixes = Vec::new();
    let preferred = prefix_root.join(app_name);
    if preferred.is_dir() {
        prefixes.push(preferred);
    }
    if let Ok(entries) = std::fs::read_dir(&prefix_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && !prefixes.contains(&path) {
                prefixes.push(path);
            }
        }
    }
    // Windows keeps user data in these four folders inside the prefix.
    const SUBDIRS: [&[&str]; 4] = [
        &["AppData", "Local"],
        &["AppData", "LocalLow"],
        &["Documents"],
        &["Saved Games"],
    ];
    for prefix in prefixes {
        // Proton puts the Windows tree under `pfx`; a plain Wine prefix is the
        // tree itself.
        let pfx = prefix.join("pfx");
        let wine_root = if pfx.is_dir() { pfx } else { prefix };
        let mut roots = Vec::new();
        for user in prefix_user_dirs(&wine_root) {
            for sub in SUBDIRS {
                let path = sub
                    .iter()
                    .fold(user.clone(), |path, part| path.join(part));
                roots.push((path, true, true));
            }
        }
        if let Some(found) = scan_unix_roots(&roots, &names, &normalized) {
            return Some(found);
        }
    }
    None
}

/// Deletes the oldest timestamped backups under one game folder, keeping the
/// newest entries. Pre-restore snapshots are safety copies and are never
/// pruned, even when the user asks for a small retention window.
fn prune_local_dir(dir: &Path, keep: u32) {
    if keep == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut backups: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("pre-restore-") {
                return None;
            }
            let timestamp = name.parse::<u64>().ok()?;
            let path = entry.path();
            path.is_dir().then_some((timestamp, path))
        })
        .collect();
    if backups.len() <= keep as usize {
        return;
    }
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in backups.into_iter().skip(keep as usize) {
        let _ = std::fs::remove_dir_all(path);
    }
}

pub fn create_backup(
    app_name: &str,
    save_path_override: Option<&str>,
) -> Result<SaveBackupInfo, String> {
    migrate_legacy_dir(app_name);
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

    let formatted_date = format_backup_timestamp(now_ts);

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

    // Local retention shares the cloud setting; snapshots stay untouched.
    let keep = crate::cloud_backup::manager::load_settings().retention_count;
    prune_local_dir(&app_backup_dir(app_name), keep);

    Ok(info)
}

pub fn list_backups(app_name: &str) -> Vec<SaveBackupInfo> {
    migrate_legacy_dir(app_name);
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
    migrate_legacy_dir(app_name);
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
        let cfgs = super::commands::load_all_game_custom_configs();
        let custom = cfgs
            .get(app_name)
            .and_then(|cfg| cfg.custom_save_path.as_deref())
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .map(PathBuf::from)
            .filter(|path| path.exists());
        if let Some(path) = custom {
            dest = path;
        } else if let Ok(current_user) =
            std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))
        {
            let path_str = info.save_path.replace('\\', "/");
            if let Some(idx) = path_str.find("/Saved Games/") {
                dest = Path::new(&current_user).join(&path_str[idx + 1..].replace('/', std::path::MAIN_SEPARATOR_STR));
            } else if let Some(idx) = path_str.find("/Documents/") {
                dest = Path::new(&current_user).join(&path_str[idx + 1..].replace('/', std::path::MAIN_SEPARATOR_STR));
            } else if let Some(idx) = path_str.find("/AppData/") {
                dest = Path::new(&current_user).join(&path_str[idx + 1..].replace('/', std::path::MAIN_SEPARATOR_STR));
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

    // Keep the current saves before overwriting them. The snapshot stays in the
    // local backup list, so a wrong restore can be undone from the same panel.
    snapshot_before_restore(app_name, &dest)?;

    copy_dir_all(&data_src, &dest).map_err(|e| format!("@t:backup.restoreError\u{1f}{e}"))?;

    Ok(format!(
        "@t:backup.restored\u{1f}{}\u{1f}{}",
        info.file_count, info.formatted_date
    ))
}

pub fn delete_backup(app_name: &str, backup_id: &str) -> Result<(), String> {
    migrate_legacy_dir(app_name);
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
    fn backup_key_keeps_epic_names_and_sanitizes_store_keys() {
        assert_eq!(backup_key("Ginger"), "Ginger");
        assert_eq!(backup_key("gog::12345"), "gog__12345");
        assert_eq!(backup_key("steam::570"), "steam__570");
        assert_eq!(backup_key("amazon::B0/../x"), "amazon__B0_.._x");
        assert_eq!(backup_key(":::"), "game");
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
        // Windows can hand back the same directory as an 8.3 short path
        // (RUNNER~1) or its long name (runneradmin). Canonicalize both sides
        // before comparing; this is also true on the GitHub runner.
        let detected = std::fs::canonicalize(detected.unwrap()).unwrap();
        let expected = std::fs::canonicalize(&save_dir).unwrap();
        assert_eq!(detected, expected);

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

    /// Local backups from before `backup_key` used the raw store key as the
    /// folder name. A space stands in for the `::` key here: Windows cannot
    /// create a `::` folder (that was the bug), while the sanitizing rule is
    /// the same. The real `::` name is covered on Unix below.
    #[test]
    fn legacy_store_backup_folders_move_to_the_safe_key() {
        let base = std::env::temp_dir().join(format!("efxlve_legacy_backup_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let legacy = base.join("gog 123");
        let backup = legacy.join("1700000000");
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(backup.join("backup_info.json"), b"{}").unwrap();

        let moved = migrate_legacy_dir_in(&base, "gog 123").expect("moved");
        assert_eq!(moved, base.join("gog_123"));
        assert!(base.join("gog_123").join("1700000000").is_dir());
        assert!(!legacy.exists(), "the raw folder is gone");
        // Epic names already are the safe key: there is nothing to migrate.
        assert_eq!(migrate_legacy_dir_in(&base, "Ginger"), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Both names may exist when a backup was taken before and after the fix;
    /// the old children move into the safe folder and nothing is overwritten.
    #[test]
    fn legacy_backups_merge_into_an_existing_safe_folder() {
        let base = std::env::temp_dir().join(format!("efxlve_legacy_merge_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("gog 123").join("1700000000")).unwrap();
        std::fs::create_dir_all(base.join("gog_123").join("1700000001")).unwrap();

        let moved = migrate_legacy_dir_in(&base, "gog 123").expect("merged");
        assert_eq!(moved, base.join("gog_123"));
        assert!(base.join("gog_123").join("1700000000").is_dir());
        assert!(base.join("gog_123").join("1700000001").is_dir());
        assert!(!base.join("gog 123").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The real legacy name on Linux/macOS, where a `::` folder is legal.
    #[cfg(unix)]
    #[test]
    fn legacy_colon_keys_migrate_on_unix() {
        let base =
            std::env::temp_dir().join(format!("efxlve_legacy_colon_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("gog::123").join("1700000000")).unwrap();

        let moved = migrate_legacy_dir_in(&base, "gog::123").expect("moved");
        assert_eq!(moved, base.join("gog__123"));
        assert!(base.join("gog__123").join("1700000000").is_dir());
        assert!(!base.join("gog::123").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn legacy_migration_rejects_path_separators() {
        let base = std::env::temp_dir().join(format!("efxlve_legacy_traversal_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        assert_eq!(migrate_legacy_dir_in(&base, "../outside"), None);
        assert_eq!(migrate_legacy_dir_in(&base, "gog/123"), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Local retention keeps the newest timestamped backups and never removes
    /// a pre-restore snapshot.
    #[test]
    fn local_retention_keeps_the_newest_and_the_snapshot() {
        let dir = std::env::temp_dir().join(format!("efxlve_local_retention_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("100")).unwrap();
        std::fs::create_dir_all(dir.join("200")).unwrap();
        std::fs::create_dir_all(dir.join("pre-restore-300")).unwrap();

        prune_local_dir(&dir, 1);
        assert!(!dir.join("100").exists());
        assert!(dir.join("200").exists());
        assert!(dir.join("pre-restore-300").exists());

        // 0 means unlimited: a second call must not delete anything.
        prune_local_dir(&dir, 0);
        assert!(dir.join("200").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    fn unix_fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "efxlve_unix_saves_{name}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let data = root.join("data");
        let config = root.join("config");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        (home, data, config)
    }

    #[test]
    fn unix_detection_finds_a_unity_save_tree() {
        let (home, data, config) = unix_fixture("unity");
        let game = config.join("unity3d").join("Studio").join("Sample Game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("profile.sav"), b"save").unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found.unwrap(), game.to_string_lossy());

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn unix_detection_finds_an_xdg_data_save() {
        let (home, data, config) = unix_fixture("xdg");
        let game = data.join("Sample Game");
        std::fs::create_dir_all(&game).unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found.unwrap(), game.to_string_lossy());

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn unix_detection_reads_the_proton_prefix_appdata() {
        let (home, data, config) = unix_fixture("proton");
        let local = home
            .join("Games")
            .join("Efxlve")
            .join("Prefixes")
            .join("SampleGame")
            .join("pfx")
            .join("drive_c")
            .join("users")
            .join("steamuser")
            .join("AppData")
            .join("Local")
            .join("Sample Game");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("savegame.dat"), b"save").unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found.unwrap(), local.to_string_lossy());

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn unix_detection_falls_back_to_another_prefix() {
        let (home, data, config) = unix_fixture("other_prefix");
        // A custom prefix name does not match the app key; the scan still has to
        // find the saves inside it.
        let local = home
            .join("Games")
            .join("Efxlve")
            .join("Prefixes")
            .join("CustomPrefix")
            .join("pfx")
            .join("drive_c")
            .join("users")
            .join("steamuser")
            .join("AppData")
            .join("Local")
            .join("Sample Game");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("savegame.dat"), b"save").unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found.unwrap(), local.to_string_lossy());

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn unix_detection_ignores_an_empty_documents_folder() {        let (home, data, config) = unix_fixture("empty");
        // A publisher folder that matches the game name but is empty is not a
        // save location; the Documents pass requires save-like content.
        let docs = home.join("Documents").join("Studio").join("Sample Game");
        std::fs::create_dir_all(&docs).unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found, None);

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }
}
