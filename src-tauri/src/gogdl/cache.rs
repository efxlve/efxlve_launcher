use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

use super::models::{GogAuthTokens, GogCachedLibrary, GogGameSummary, GogInstalledInfo};
use super::paths::{auth_json_path, installed_json_path, library_snapshot_path};
use super::GogError;

pub const GOG_CLIENT_ID: &str = "46899977096215655";

/// Read saved GOG OAuth2 tokens from disk.
/// Supports both the gogdl dictionary format `{"46899977096215655": {...}}` and direct format.
pub fn load_auth_tokens(app: &AppHandle) -> Option<GogAuthTokens> {
    let path = auth_json_path(app);
    let bytes = fs::read(&path).ok()?;
    if let Ok(map) = serde_json::from_slice::<HashMap<String, GogAuthTokens>>(&bytes) {
        if let Some(tokens) = map.get(GOG_CLIENT_ID) {
            return Some(tokens.clone());
        }
    }
    serde_json::from_slice(&bytes).ok()
}

/// Persist GOG OAuth2 tokens to disk in gogdl-compatible dictionary format.
pub fn save_auth_tokens(app: &AppHandle, tokens: &GogAuthTokens) -> Result<(), GogError> {
    let path = auth_json_path(app);
    let mut map = HashMap::new();
    let mut t = tokens.clone();
    if t.login_time.is_none() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0);
        t.login_time = Some(now);
    }
    map.insert(GOG_CLIENT_ID.to_string(), t);
    let json = serde_json::to_vec_pretty(&map)?;
    fs::write(&path, json).map_err(|e| GogError::Io(e.to_string()))
}

/// Remove saved GOG OAuth2 tokens from disk (logout).
pub fn clear_auth_tokens(app: &AppHandle) {
    let path = auth_json_path(app);
    let _ = fs::remove_file(path);
}

/// Parses `goggame-<id>.info` in the target directory, when it exists.
pub fn scan_gog_info(target_dir: &Path, game_id: &str) -> Option<GogInstalledInfo> {
    let info_path = target_dir.join(format!("goggame-{game_id}.info"));
    if !info_path.is_file() {
        return None;
    }
    let text = fs::read_to_string(&info_path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&text).ok()?;

    let title = val
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();
    let build_id = val
        .get("buildId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut exe: Option<String> = None;

    if let Some(tasks) = val.get("playTasks").and_then(|v| v.as_array()) {
        for t in tasks {
            let is_primary = t
                .get("isPrimary")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let path = t.get("path").and_then(|v| v.as_str());
            if let Some(p) = path {
                if is_primary || exe.is_none() {
                    exe = Some(p.to_string());
                    if is_primary {
                        break;
                    }
                }
            }
        }
    }

    Some(GogInstalledInfo {
        game_id: game_id.to_string(),
        title,
        install_path: target_dir.to_string_lossy().to_string(),
        version,
        install_size: 0,
        executable: exe,
        build_id,
    })
}

/// The folder that owns `goggame-<id>.info`: the root itself or one of its
/// direct children. One level covers gogdl's appended install folder; two
/// matches are ambiguous, so nothing is chosen.
pub fn locate_game_folder(root: &Path, game_id: &str) -> Option<PathBuf> {
    let info = format!("goggame-{game_id}.info");
    if root.join(&info).is_file() {
        return Some(root.to_path_buf());
    }
    let mut found: Option<PathBuf> = None;
    for entry in fs::read_dir(root).ok()?.flatten() {
        let path = entry.path();
        if path.is_dir() && path.join(&info).is_file() {
            if found.is_some() {
                return None;
            }
            found = Some(path);
        }
    }
    found
}

/// Load registered GOG game installations from disk. Records written by older
/// builds can point at the parent of gogdl's install folder; they are moved to
/// the folder that owns the `.info` file so launch, update and uninstall see
/// the real files.
pub fn load_installed_games(app: &AppHandle) -> HashMap<String, GogInstalledInfo> {
    let path = installed_json_path(app);
    let Ok(bytes) = fs::read(&path) else {
        return HashMap::new();
    };
    let Ok(mut map) = serde_json::from_slice::<HashMap<String, GogInstalledInfo>>(&bytes) else {
        return HashMap::new();
    };
    if migrate_legacy_paths(&mut map) {
        // Best effort: a failed write retries on the next load.
        let _ = save_installed_games(app, &map);
    }
    map
}

fn migrate_legacy_paths(map: &mut HashMap<String, GogInstalledInfo>) -> bool {
    let mut changed = false;
    for (id, info) in map.iter_mut() {
        let recorded = PathBuf::from(info.install_path.trim());
        if recorded.join(format!("goggame-{id}.info")).is_file() {
            continue;
        }
        let Some(actual) = locate_game_folder(&recorded, id) else {
            continue;
        };
        if let Some(refreshed) = scan_gog_info(&actual, id) {
            *info = refreshed;
        } else {
            info.install_path = actual.to_string_lossy().to_string();
        }
        changed = true;
    }
    changed
}

/// Save registered GOG game installations to disk.
pub fn save_installed_games(
    app: &AppHandle,
    games: &HashMap<String, GogInstalledInfo>,
) -> Result<(), GogError> {
    let path = installed_json_path(app);
    let json = serde_json::to_vec_pretty(games)?;
    fs::write(&path, json).map_err(|e| GogError::Io(e.to_string()))
}

/// Load cached GOG library snapshot for instant hydration on boot.
pub fn load_cached_library(app: &AppHandle) -> GogCachedLibrary {
    let path = library_snapshot_path(app);
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(mut cached) = serde_json::from_slice::<GogCachedLibrary>(&bytes) {
            for g in &mut cached.games {
                if let Some(ref c) = g.cover_url {
                    if c.contains("_product_card_v2_mobile_slider_639.jpg") {
                        if g.hero_url.is_none() {
                            g.hero_url = Some(c.clone());
                        }
                        g.cover_url = Some(c.replace(
                            "_product_card_v2_mobile_slider_639.jpg",
                            "_glx_vertical_cover.jpg",
                        ));
                    }
                }
            }
            return cached;
        }
    }
    GogCachedLibrary {
        account: None,
        account_id: None,
        games: Vec::new(),
    }
}

/// Write updated GOG library snapshot to disk in a single sequential I/O operation.
pub fn save_cached_library(
    app: &AppHandle,
    account: Option<&str>,
    account_id: Option<&str>,
    games: &[GogGameSummary],
) -> Result<(), GogError> {
    let path = library_snapshot_path(app);
    let snapshot = GogCachedLibrary {
        account: account.map(String::from),
        account_id: account_id.map(String::from),
        games: games.to_vec(),
    };
    let json = serde_json::to_vec_pretty(&snapshot)?;
    fs::write(&path, json).map_err(|e| GogError::Io(e.to_string()))
}

/// Load cached GOG achievement summaries from disk.
pub fn load_achievements_cache(
    app: &AppHandle,
) -> HashMap<String, crate::legendary::models::GameAchievementSummary> {
    let path = super::paths::achievements_cache_path(app);
    if let Ok(bytes) = fs::read(&path) {
        if let Ok(mut map) = serde_json::from_slice::<
            HashMap<String, crate::legendary::models::GameAchievementSummary>,
        >(&bytes)
        {
            // Cache rows written before the field existed still carry real
            // progress; the serde default (false) would hide their counts.
            for summary in map.values_mut() {
                summary.progress_known = true;
            }
            return map;
        }
    }
    HashMap::new()
}

/// Save GOG achievement summaries to disk in a single sequential I/O operation.
pub fn save_achievements_cache(
    app: &AppHandle,
    cache: &HashMap<String, crate::legendary::models::GameAchievementSummary>,
) -> Result<(), GogError> {
    let path = super::paths::achievements_cache_path(app);
    let json = serde_json::to_vec_pretty(cache)?;
    fs::write(&path, json).map_err(|e| GogError::Io(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    fn write_info(dir: &Path, id: &str, title: &str, build: &str) {
        let text = format!(
            r#"{{
                "gameId": "{id}",
                "name": "{title}",
                "version": "1.0.3",
                "buildId": "{build}",
                "playTasks": [
                    {{ "isPrimary": true, "path": "bin\\{title}.exe", "type": "FileTask" }}
                ]
            }}"#
        );
        let mut file = File::create(dir.join(format!("goggame-{id}.info"))).unwrap();
        file.write_all(text.as_bytes()).unwrap();
    }

    #[test]
    fn scan_reads_the_game_info() {
        let temp = std::env::temp_dir().join("efxlve_test_gog_info");
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        write_info(&temp, "123456", "Test Game", "42");

        let info = scan_gog_info(&temp, "123456").expect("info");
        assert_eq!(info.title, "Test Game");
        assert_eq!(info.version, "1.0.3");
        assert_eq!(info.build_id, "42");
        assert_eq!(info.executable.as_deref(), Some("bin\\Test Game.exe"));

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn a_legacy_parent_record_moves_to_the_game_folder() {
        let root = std::env::temp_dir().join("efxlve_gog_migrate");
        let inner = root.join("Test Game");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&inner).unwrap();
        write_info(&inner, "123456", "Test Game", "42");

        let mut map = HashMap::from([(
            "123456".to_string(),
            GogInstalledInfo {
                game_id: "123456".into(),
                title: "123456".into(),
                install_path: root.to_string_lossy().to_string(),
                version: "1.0.0".into(),
                install_size: 0,
                executable: None,
                build_id: String::new(),
            },
        )]);
        assert!(migrate_legacy_paths(&mut map));
        let info = map.get("123456").unwrap();
        assert_eq!(Path::new(&info.install_path), inner);
        assert_eq!(info.title, "Test Game");
        assert_eq!(info.build_id, "42");
        // Once healed, the record is left alone.
        assert!(!migrate_legacy_paths(&mut map));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn locate_refuses_an_ambiguous_parent() {
        let root = std::env::temp_dir().join("efxlve_gog_locate");
        let first = root.join("First");
        let second = root.join("Second");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        write_info(&first, "123456", "First", "1");
        write_info(&second, "123456", "Second", "2");

        assert_eq!(locate_game_folder(&root, "123456"), None);
        assert_eq!(locate_game_folder(&first, "123456"), Some(first.clone()));

        let _ = fs::remove_dir_all(&root);
    }
}
