//! EA App, Ubisoft Connect and Xbox game detection with hand-off launching.
//!
//! All three stores licence their games through their own client, so the
//! launcher never installs, moves or removes anything: it reads the store's own
//! metadata from the registry / disk and hands every action back through the
//! store's protocol or the Xbox shell. No network access.

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

use crate::winreg;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// One game installed by an external store.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalGame {
    /// `ea`, `ubisoft` or `xbox`.
    pub store: String,
    /// Store-specific identifier (product id, EA game id, Xbox package family name).
    pub id: String,
    pub title: String,
    pub install_path: String,
}

/// Subkey names directly under one registry key.
///
/// `reg query` prints the full hive name (`HKEY_LOCAL_MACHINE`) even when the
/// key was asked for as `HKLM`, so the key's own last segment is the anchor.
pub fn parse_subkeys(output: &str, key: &str) -> Vec<String> {
    let anchor = key.rsplit('\\').next().unwrap_or(key);
    let needle = format!("\\{anchor}\\");
    output
        .lines()
        .map(str::trim)
        .filter_map(|line| {
            let at = line.find(&needle)? + needle.len();
            let name = &line[at..];
            if name.is_empty() || name.contains('\\') {
                None
            } else {
                Some(name.to_string())
            }
        })
        .collect()
}

/// Subkey names directly under one registry key.
pub fn reg_subkeys(key: &str) -> Vec<String> {
    winreg::query(key, None)
        .map(|output| parse_subkeys(&output, key))
        .unwrap_or_default()
}

fn reg_value(key: &str, value: &str) -> Option<String> {
    let raw = winreg::query(key, Some(value))?;
    let parsed = winreg::parse_reg_sz(&raw);
    if parsed.is_empty() {
        None
    } else {
        Some(parsed)
    }
}

/* ---------- EA App ---------- */

const EA_GAME_KEYS: [&str; 2] = [
    r"HKLM\SOFTWARE\WOW6432Node\Electronic Arts\EA Games",
    r"HKLM\SOFTWARE\Electronic Arts\EA Games",
];

/// Content id from an Origin/EA `installerdata.xml`, when the game ships one.
fn ea_content_id(install_dir: &str) -> Option<String> {
    let path = PathBuf::from(install_dir.replace('/', "\\")).join("__Installer").join("installerdata.xml");
    let text = std::fs::read_to_string(path).ok()?;
    let at = text.find("content id=\"")? + "content id=\"".len();
    let rest = &text[at..];
    let end = rest.find('"')?;
    let id = &rest[..end];
    if id.is_empty() {
        None
    } else {
        Some(id.to_string())
    }
}

/// Games installed by the EA App / Origin.
pub fn detect_ea() -> Vec<ExternalGame> {
    let mut games = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for key in EA_GAME_KEYS {
        for name in reg_subkeys(key) {
            let sub = format!("{key}\\{name}");
            let Some(install_dir) = reg_value(&sub, "Install Dir") else { continue };
            if !Path::new(&install_dir).is_dir() || !seen.insert(name.clone()) {
                continue;
            }
            // Prefer the content id: `link2ea://` expects it, the key name is only
            // the display-ish folder name.
            let id = ea_content_id(&install_dir).unwrap_or_else(|| name.clone());
            games.push(ExternalGame {
                store: "ea".into(),
                id,
                title: name.replace('_', " "),
                install_path: install_dir.replace('/', "\\"),
            });
        }
    }
    games.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    games
}

/// `EADesktop.exe` path when the EA App is installed (used as the fallback).
pub fn ea_client_path() -> Option<String> {
    for key in [
        r"HKLM\SOFTWARE\WOW6432Node\Electronic Arts\EA Desktop",
        r"HKLM\SOFTWARE\Electronic Arts\EA Desktop",
    ] {
        if let Some(path) = reg_value(key, "DesktopAppPath") {
            return Some(path);
        }
    }
    None
}

/* ---------- Ubisoft Connect ---------- */

const UBISOFT_INSTALL_KEYS: [&str; 2] = [
    r"HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs",
    r"HKCU\Software\Ubisoft\Launcher\Installs",
];

/// Games installed by Ubisoft Connect (`InstallDir` per product id).
pub fn detect_ubisoft() -> Vec<ExternalGame> {
    let mut games = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for key in UBISOFT_INSTALL_KEYS {
        for id in reg_subkeys(key) {
            if !seen.insert(id.clone()) {
                continue;
            }
            let Some(install_dir) = reg_value(&format!("{key}\\{id}"), "InstallDir") else { continue };
            let normalized = install_dir.replace('/', "\\");
            if !Path::new(&normalized).is_dir() {
                continue;
            }
            // Ubisoft does not store a display name in the registry: the install
            // folder is the closest thing it has ("Watch_Dogs" → "Watch Dogs").
            let title = Path::new(&normalized)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(&id)
                .replace('_', " ");
            games.push(ExternalGame {
                store: "ubisoft".into(),
                id,
                title,
                install_path: normalized,
            });
        }
    }
    games.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    games
}

/* ---------- Xbox (Microsoft Store / PC Game Pass) ---------- */

/// `DefaultDisplayName` from an Xbox `MicrosoftGame.config` (any casing).
fn xbox_display_name(config: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config).ok()?;
    let at = text.find("DefaultDisplayName=\"")? + "DefaultDisplayName=\"".len();
    let rest = &text[at..];
    let end = rest.find('"')?;
    let name = rest[..end].trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// `Name` (package identity) from an Xbox `MicrosoftGame.config`.
fn xbox_package_name(config: &Path) -> Option<String> {
    let text = std::fs::read_to_string(config).ok()?;
    let at = text.find("<Identity")?;
    let rest = &text[at..];
    let name_at = rest.find("Name=\"")? + "Name=\"".len();
    let tail = &rest[name_at..];
    let end = tail.find('"')?;
    let name = tail[..end].trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// Package family names for the given package identities, one PowerShell call.
fn xbox_family_names(packages: &[String]) -> std::collections::HashMap<String, String> {
    let mut map = std::collections::HashMap::new();
    if packages.is_empty() {
        return map;
    }
    // One call for every game keeps the scan fast on low-end machines.
    // `$_.Name` is required: a bare property name inside a script block is
    // treated as a command by Windows PowerShell.
    let filter = packages
        .iter()
        .map(|p| format!("$_.Name -eq '{p}'"))
        .collect::<Vec<_>>()
        .join(" -or ");
    let script = format!(
        "Get-AppxPackage | Where-Object {{ {filter} }} | Select-Object Name,PackageFamilyName | ConvertTo-Json -Compress"
    );
    let mut command = Command::new("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let Ok(output) = command.output() else { return map };
    let text = String::from_utf8_lossy(&output.stdout);
    // PowerShell can prefix its output with a BOM; Rust's trim() does not drop it.
    let cleaned = text.trim().trim_start_matches('\u{feff}').trim();
    let Ok(value) = serde_json::from_str::<serde_json::Value>(cleaned) else { return map };
    let entries: Vec<&serde_json::Value> = match &value {
        serde_json::Value::Array(items) => items.iter().collect(),
        other => vec![other],
    };
    for entry in entries {
        let name = entry.get("Name").and_then(|v| v.as_str()).unwrap_or("");
        let family = entry.get("PackageFamilyName").and_then(|v| v.as_str()).unwrap_or("");
        if !name.is_empty() && !family.is_empty() {
            map.insert(name.to_string(), family.to_string());
        }
    }
    map
}

/// Games installed under `C:\XboxGames` (or the drive given by the environment).
pub fn detect_xbox() -> Vec<ExternalGame> {
    let root = std::env::var("EFXLVE_XBOX_ROOT").unwrap_or_else(|_| r"C:\XboxGames".to_string());
    let root = PathBuf::from(root);
    let Ok(entries) = std::fs::read_dir(&root) else { return Vec::new() };
    let mut found: Vec<(String, String, String)> = Vec::new(); // package, title, path
    for entry in entries.flatten() {
        let dir = entry.path();
        if !dir.is_dir() {
            continue;
        }
        let content = dir.join("Content");
        let Ok(files) = std::fs::read_dir(&content) else { continue };
        let config = files.flatten().map(|f| f.path()).find(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.eq_ignore_ascii_case("MicrosoftGame.config"))
                .unwrap_or(false)
        });
        let Some(config) = config else { continue };
        let Some(package) = xbox_package_name(&config) else { continue };
        let title = xbox_display_name(&config).unwrap_or_else(|| {
            dir.file_name().and_then(|n| n.to_str()).unwrap_or(&package).to_string()
        });
        found.push((package, title, dir.to_string_lossy().to_string()));
    }
    let packages: Vec<String> = found.iter().map(|(p, _, _)| p.clone()).collect();
    let families = xbox_family_names(&packages);
    let mut games: Vec<ExternalGame> = found
        .into_iter()
        .map(|(package, title, path)| ExternalGame {
            store: "xbox".into(),
            // The shell needs `<PackageFamilyName>!App`; without a family name the
            // card can only open the Xbox app itself.
            id: families.get(&package).map(|f| format!("{f}!App")).unwrap_or_default(),
            title,
            install_path: path,
        })
        .collect();
    games.sort_by(|a, b| a.title.to_lowercase().cmp(&b.title.to_lowercase()));
    games
}

/* ---------- Commands ---------- */

/// Detects the games one external store installed on this PC.
#[tauri::command]
pub fn external_detect_games(store: String) -> Vec<ExternalGame> {
    match store.as_str() {
        "ea" => detect_ea(),
        "ubisoft" => detect_ubisoft(),
        "xbox" => detect_xbox(),
        _ => Vec::new(),
    }
}

/// Opens a protocol / shell target without a console window.
fn spawn_uri(target: &str) -> Result<(), String> {
    let mut command = Command::new("cmd");
    command.args(["/C", "start", "", target]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map(|_| ()).map_err(|e| format!("Could not open the store client: {e}"))
}

/// Hands a launch to the store's own client.
#[tauri::command]
pub fn external_launch_game(store: String, id: String) -> Result<(), String> {
    match store.as_str() {
        "ea" => {
            if !id.is_empty() && !id.contains('"') {
                return spawn_uri(&format!("link2ea://launchgame/{id}"));
            }
            // No resolvable game id: at least bring the EA App up.
            let client = ea_client_path().ok_or("The EA App is not installed")?;
            let mut command = Command::new(client);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            command.spawn().map(|_| ()).map_err(|e| e.to_string())
        }
        "ubisoft" => {
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
                return Err("Invalid Ubisoft product id".into());
            }
            spawn_uri(&format!("uplay://launch/{id}/0"))
        }
        "xbox" => {
            if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '!') {
                return Err("Xbox game is not launchable from the launcher".into());
            }
            let mut command = Command::new("explorer.exe");
            command.arg(format!("shell:appsFolder\\{id}"));
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            command.spawn().map(|_| ()).map_err(|e| e.to_string())
        }
        _ => Err("Unknown store".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn subkeys_are_parsed_from_reg_output() {
        // `reg query` prints the full hive name even for the short HKLM form.
        let output = "\r\nHKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\r\n    HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\274\r\n    HKEY_LOCAL_MACHINE\\SOFTWARE\\WOW6432Node\\Ubisoft\\Launcher\\Installs\\1093\r\n\r\n";
        let key = r"HKLM\SOFTWARE\WOW6432Node\Ubisoft\Launcher\Installs";
        assert_eq!(parse_subkeys(output, key), vec!["274", "1093"]);
        assert_eq!(parse_subkeys("", key).len(), 0);
        // A key with no children must not invent names.
        assert_eq!(parse_subkeys("HKEY_LOCAL_MACHINE\\SOFTWARE\\Vendor\\App\r\n", key).len(), 0);
    }

    #[test]
    fn ubisoft_install_dir_becomes_a_title() {
        let title = Path::new(r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\games\Watch_Dogs\")
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .replace('_', " ");
        assert_eq!(title, "Watch Dogs");
    }

    #[test]
    fn xbox_config_is_read_case_insensitively() {
        assert!(Path::new("MicrosoftGame.Config")
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("MicrosoftGame.config"))
            .unwrap_or(false));
    }

    #[test]
    fn launch_rejects_bad_ids() {
        assert!(external_launch_game("ubisoft".into(), "abc".into()).is_err());
        assert!(external_launch_game("ubisoft".into(), String::new()).is_err());
        assert!(external_launch_game("xbox".into(), "bad id!".into()).is_err());
        assert!(external_launch_game("nope".into(), "1".into()).is_err());
    }

    /// Live check against this machine's stores.
    /// Run: `cargo test live_external_stores -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_external_stores() {
        println!("EA client: {:?}", ea_client_path());
        let probe = xbox_family_names(&["Microsoft.MinecraftUWP".to_string()]);
        println!("xbox family probe: {probe:?}");
        for store in ["ea", "ubisoft", "xbox"] {
            let games = external_detect_games(store.into());
            println!("{store}: {} games", games.len());
            for game in games.iter().take(10) {
                println!("  [{}] {} | {}", game.id, game.title, game.install_path);
            }
        }
    }
}
