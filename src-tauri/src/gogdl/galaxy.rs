//! GOG Galaxy integration.
//!
//! The official client registers every game it installs under
//! `…\GOG.com\Games\<gameId>` with `path`, `gameName`, `version`, `buildId` and
//! `exe` values. Games installed through this launcher never touch that key, so
//! Galaxy keeps offering the same update after we already applied it, and games
//! removed here stay visible (and broken) inside Galaxy.
//!
//! This module reads the key for detection/import and keeps it in step after
//! installs, updates and removals. Everything is best effort: machine-wide keys
//! need admin rights, and a missing key simply means Galaxy never installed that
//! game.

use std::collections::HashSet;
use std::path::Path;

use serde::Serialize;
use tauri::AppHandle;

use super::cache::{load_installed_games, save_installed_games};
use super::models::GogInstalledInfo;

/// Registry roots Galaxy writes to: machine-wide (32/64-bit views) and per-user.
const REG_ROOTS: [&str; 3] = [
    r"HKLM\SOFTWARE\WOW6432Node\GOG.com\Games",
    r"HKLM\SOFTWARE\GOG.com\Games",
    r"HKCU\SOFTWARE\GOG.com\Games",
];

/// One game entry read from Galaxy's registry.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GalaxyDetectedGame {
    pub game_id: String,
    pub title: String,
    pub install_path: String,
    pub version: String,
    pub build_id: String,
    pub executable: String,
}

/// Runs `reg` without flashing a console window; returns stdout on success.
fn reg(args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let mut cmd = std::process::Command::new("reg");
    cmd.args(args).creation_flags(CREATE_NO_WINDOW);
    let out = cmd.output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Parses `reg query … /s` output into game records.
///
/// Blocks start with a `HKEY…` header line and contain `name    REG_SZ    value`
/// rows. The root key itself has no values, so it produces no record.
fn parse_reg_output(text: &str) -> Vec<GalaxyDetectedGame> {
    let mut out: Vec<GalaxyDetectedGame> = Vec::new();
    let mut current: Option<GalaxyDetectedGame> = None;

    let commit = |rec: Option<GalaxyDetectedGame>, out: &mut Vec<GalaxyDetectedGame>| {
        if let Some(g) = rec {
            if !g.game_id.is_empty() && !g.install_path.is_empty() {
                out.push(g);
            }
        }
    };

    for raw in text.lines() {
        if raw.trim().is_empty() {
            continue;
        }
        if raw.starts_with("HKEY") {
            commit(current.take(), &mut out);
            let id = raw.trim().rsplit('\\').next().unwrap_or("").to_string();
            current = Some(GalaxyDetectedGame {
                game_id: id,
                title: String::new(),
                install_path: String::new(),
                version: String::new(),
                build_id: String::new(),
                executable: String::new(),
            });
            continue;
        }
        let Some(rec) = current.as_mut() else { continue };
        let line = raw.trim_start();
        let Some(type_pos) = line.find("REG_") else { continue };
        let name = line[..type_pos].trim().to_lowercase();
        let after = &line[type_pos..];
        let value = after
            .find(|c: char| c.is_whitespace())
            .map(|p| after[p..].trim())
            .unwrap_or("");
        match name.as_str() {
            "path" => rec.install_path = value.to_string(),
            "gamename" => rec.title = value.to_string(),
            "version" => rec.version = value.to_string(),
            "buildid" => rec.build_id = value.to_string(),
            "exe" => rec.executable = value.to_string(),
            _ => {}
        }
    }
    commit(current.take(), &mut out);
    out
}

/// Every game GOG Galaxy currently reports as installed and present on disk.
pub fn detect_galaxy_games() -> Vec<GalaxyDetectedGame> {
    let mut found: Vec<GalaxyDetectedGame> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for root in REG_ROOTS {
        let Some(text) = reg(&["query", root, "/s"]) else {
            continue;
        };
        for g in parse_reg_output(&text) {
            // Skip the root key itself and entries whose folder is gone.
            if g.game_id.eq_ignore_ascii_case("Games") || !Path::new(&g.install_path).is_dir() {
                continue;
            }
            if !seen.insert(g.game_id.clone()) {
                continue;
            }
            found.push(g);
        }
    }
    found.sort_by_key(|g| g.title.to_lowercase());
    found
}

/// Registers detected Galaxy installs in this launcher's GOG installed map.
/// Existing entries are left untouched; returns how many were added.
pub fn sync_galaxy_installed(app: &AppHandle) -> Result<u32, String> {
    let detected = detect_galaxy_games();
    if detected.is_empty() {
        return Ok(0);
    }
    let mut map = load_installed_games(app);
    let mut imported = 0u32;
    for g in detected {
        if map.contains_key(&g.game_id) {
            continue;
        }
        let dir = Path::new(&g.install_path);
        // Prefer the real `goggame-<id>.info` (play tasks, build id); fall back
        // to the registry values so Galaxy installs are usable immediately.
        let info = super::transfers::scan_gog_info(dir, &g.game_id).unwrap_or(GogInstalledInfo {
            game_id: g.game_id.clone(),
            title: if g.title.is_empty() { g.game_id.clone() } else { g.title.clone() },
            install_path: g.install_path.clone(),
            version: if g.version.is_empty() { "1.0.0".to_string() } else { g.version.clone() },
            install_size: 0,
            executable: if g.executable.is_empty() { None } else { Some(g.executable.clone()) },
            build_id: g.build_id.clone(),
        });
        map.insert(g.game_id.clone(), info);
        imported += 1;
    }
    if imported > 0 {
        save_installed_games(app, &map).map_err(|e| e.to_string())?;
    }
    Ok(imported)
}

/// Deletes Galaxy's registry entries for a game. Called on uninstall so the
/// official client does not keep a broken entry (parity with Epic `.item`s).
pub fn remove_galaxy_registry(game_id: &str) {
    for root in REG_ROOTS {
        let key = format!("{root}\\{game_id}");
        let _ = reg(&["delete", &key, "/f"]);
    }
}

/// Copies the freshly installed version/build into Galaxy's registry entry so
/// the official client does not offer the same update again. Best effort.
pub fn sync_galaxy_version(game_id: &str, version: &str, build_id: &str) {
    for root in REG_ROOTS {
        let key = format!("{root}\\{game_id}");
        if reg(&["query", &key]).is_none() {
            continue;
        }
        if !version.is_empty() {
            let _ = reg(&["add", &key, "/v", "version", "/t", "REG_SZ", "/d", version, "/f"]);
        }
        if !build_id.is_empty() {
            let _ = reg(&["add", &key, "/v", "buildId", "/t", "REG_SZ", "/d", build_id, "/f"]);
        }
        return;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"
HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\GOG.com\Games
HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\GOG.com\Games\1207658924
    buildId    REG_SZ    54933
    exe    REG_SZ    bin\x64\witcher3.exe
    gameId    REG_SZ    1207658924
    gameName    REG_SZ    The Witcher 3: Wild Hunt
    path    REG_SZ    C:\Games\The Witcher 3
    version    REG_SZ    1.32
HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\GOG.com\Games\1423049311
    buildId    REG_SZ    12345
    gameName    REG_SZ    Cyberpunk 2077
    path    REG_SZ    D:\Games\Cyberpunk 2077
    version    REG_SZ    2.13
"#;

    #[test]
    fn parses_galaxy_registry_blocks() {
        let games = parse_reg_output(SAMPLE);
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].game_id, "1207658924");
        assert_eq!(games[0].title, "The Witcher 3: Wild Hunt");
        assert_eq!(games[0].install_path, r"C:\Games\The Witcher 3");
        assert_eq!(games[0].version, "1.32");
        assert_eq!(games[0].build_id, "54933");
        assert_eq!(games[0].executable, r"bin\x64\witcher3.exe");
        assert_eq!(games[1].game_id, "1423049311");
        assert_eq!(games[1].title, "Cyberpunk 2077");
        // The root key has no values and must not become a record.
        assert!(games.iter().all(|g| g.game_id != "Games"));
    }

    #[test]
    fn empty_or_garbage_output_yields_no_records() {
        assert!(parse_reg_output("").is_empty());
        assert!(parse_reg_output("ERROR: The system was unable to find the specified registry key").is_empty());
    }
}
