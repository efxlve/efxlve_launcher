//! Installed games that belong to a DRM launcher other than Steam.
//!
//! EA App, Ubisoft Connect, the Xbox app and Battle.net keep the games.
//! This module only reads what those clients already installed and hands
//! launch back to them. It does not invent an owned library or achievements.

use serde::Serialize;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionGame {
    pub store: String,
    pub id: String,
    pub name: String,
    pub install_path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct UninstallEntry {
    name: String,
    publisher: String,
    location: String,
}

/// `MicrosoftGame.config` title. The element form and the attribute form both occur.
pub(crate) fn xbox_display_name(xml: &str) -> Option<String> {
    if let Some(rest) = xml.split("DefaultDisplayName=\"").nth(1) {
        let name = rest.split('"').next()?.trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    let rest = xml.split("<DefaultDisplayName>").nth(1)?;
    let name = rest.split("</DefaultDisplayName>").next()?.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

fn parse_uninstall_export(text: &str) -> Vec<UninstallEntry> {
    let mut out = Vec::new();
    let mut name = String::new();
    let mut publisher = String::new();
    let mut location = String::new();
    let flush = |out: &mut Vec<UninstallEntry>, name: &mut String, publisher: &mut String, location: &mut String| {
        if !name.is_empty() {
            out.push(UninstallEntry {
                name: std::mem::take(name),
                publisher: std::mem::take(publisher),
                location: std::mem::take(location),
            });
        } else {
            publisher.clear();
            location.clear();
        }
    };
    for line in text.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("HKEY_") {
            flush(&mut out, &mut name, &mut publisher, &mut location);
            continue;
        }
        if let Some(value) = reg_sz(trimmed, "DisplayName") {
            name = value;
        } else if let Some(value) = reg_sz(trimmed, "Publisher") {
            publisher = value;
        } else if let Some(value) = reg_sz(trimmed, "InstallLocation") {
            location = value;
        }
    }
    flush(&mut out, &mut name, &mut publisher, &mut location);
    out
}

fn reg_sz(line: &str, key: &str) -> Option<String> {
    let rest = line.strip_prefix(key)?.trim();
    for marker in ["REG_EXPAND_SZ", "REG_SZ"] {
        if let Some(idx) = rest.find(marker) {
            let value = rest[idx + marker.len()..].trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

/// Launcher rows and redistributables are not games.
pub(crate) fn companion_store(name: &str, publisher: &str) -> Option<&'static str> {
    let name_l = name.to_lowercase();
    let pub_l = publisher.to_lowercase();
    if is_launcher_row(&name_l) {
        return None;
    }
    if pub_l.contains("electronic arts") || pub_l.contains("ea swiss") || name_l.contains("ea sports") {
        Some("ea")
    } else if pub_l.contains("ubisoft") {
        Some("ubisoft")
    } else if pub_l.contains("blizzard") {
        Some("battlenet")
    } else {
        None
    }
}

fn is_launcher_row(name: &str) -> bool {
    name == "ea app"
        || name == "ea desktop"
        || name == "origin"
        || name.contains("ubisoft connect")
        || name == "uplay"
        || name.contains("battle.net")
        || name.contains("xbox game bar")
        || name.contains("xbox identity provider")
}

fn slug(name: &str) -> String {
    let mut out = String::new();
    let mut dash = false;
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            dash = false;
        } else if !out.is_empty() && !dash {
            out.push('-');
            dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

fn games_from_uninstall(entries: &[UninstallEntry]) -> Vec<CompanionGame> {
    let mut games = Vec::new();
    for entry in entries {
        let Some(store) = companion_store(&entry.name, &entry.publisher) else {
            continue;
        };
        let id = slug(&entry.name);
        if id.is_empty() {
            continue;
        }
        games.push(CompanionGame {
            store: store.to_string(),
            id,
            name: entry.name.clone(),
            install_path: entry.location.clone(),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

fn xbox_games() -> Vec<CompanionGame> {
    let root = PathBuf::from(r"C:\XboxGames");
    let Ok(entries) = std::fs::read_dir(&root) else {
        return Vec::new();
    };
    let mut games = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let folder = entry.file_name().to_string_lossy().to_string();
        if folder.eq_ignore_ascii_case("GameSave") {
            continue;
        }
        let config = entry.path().join("Content").join("MicrosoftGame.config");
        let name = std::fs::read_to_string(&config)
            .ok()
            .and_then(|xml| xbox_display_name(&xml))
            .unwrap_or(folder);
        let id = slug(&name);
        if id.is_empty() {
            continue;
        }
        games.push(CompanionGame {
            store: "xbox".into(),
            id,
            name,
            install_path: entry.path().to_string_lossy().to_string(),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

fn uninstall_games() -> Vec<CompanionGame> {
    #[cfg(windows)]
    {
        games_from_uninstall(&parse_uninstall_export(&query_uninstall()))
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

#[cfg(windows)]
fn query_uninstall() -> String {
    use std::os::windows::process::CommandExt;
    let roots = [
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        r"HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
    ];
    let mut all = String::new();
    for root in roots {
        let mut cmd = std::process::Command::new("reg");
        cmd.args(["query", root, "/s"]);
        cmd.creation_flags(0x08000000);
        if let Ok(output) = cmd.output() {
            if output.status.success() {
                all.push_str(&String::from_utf8_lossy(&output.stdout));
                all.push('\n');
            }
        }
    }
    all
}

/// Installed EA, Ubisoft, Xbox and Battle.net games.
#[tauri::command]
pub fn companion_installed_games() -> Vec<CompanionGame> {
    let mut games = uninstall_games();
    games.extend(xbox_games());
    games.sort_by(|a, b| (&a.store, &a.id).cmp(&(&b.store, &b.id)));
    games.dedup_by(|a, b| a.store == b.store && a.id == b.id);
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// Opens the DRM client. The game itself will not start without it.
#[tauri::command]
pub fn companion_open_client(store: String) -> Result<(), String> {
    let path = match store.as_str() {
        "ea" => client_path(&[
            r"C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\EALauncher.exe",
            r"C:\Program Files\Electronic Arts\EA Desktop\EA Desktop\EADesktop.exe",
        ]),
        "ubisoft" => client_path(&[
            r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\UbisoftConnect.exe",
            r"C:\Program Files\Ubisoft\Ubisoft Game Launcher\UbisoftConnect.exe",
        ]),
        "battlenet" => client_path(&[
            r"C:\Program Files (x86)\Battle.net\Battle.net.exe",
            r"C:\Program Files\Battle.net\Battle.net.exe",
        ]),
        "xbox" => client_path(&[]),
        _ => None,
    };
    if store == "xbox" {
        return open_xbox();
    }
    let Some(path) = path else {
        return Err("@t:accounts.notConnected".into());
    };
    std::process::Command::new(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

fn client_path(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(PathBuf::from).find(|path| path.is_file())
}

fn open_xbox() -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg("shell:AppsFolder\\Microsoft.GamingApp_8wekyb3d8bbwe!Microsoft.Xbox.App")
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xbox_config_reads_both_title_forms() {
        let attr = r#"<ShellVisuals DefaultDisplayName="No Man's Sky" />"#;
        assert_eq!(xbox_display_name(attr).as_deref(), Some("No Man's Sky"));
        let elem = "<ShellVisuals><DefaultDisplayName>Minecraft</DefaultDisplayName></ShellVisuals>";
        assert_eq!(xbox_display_name(elem).as_deref(), Some("Minecraft"));
    }

    #[test]
    fn uninstall_rows_become_store_games_and_skip_the_clients() {
        let text = r#"
HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\EA
    DisplayName    REG_SZ    EA App
    Publisher    REG_SZ    Electronic Arts
    InstallLocation    REG_SZ    C:\EA

HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\FC
    DisplayName    REG_SZ    EA SPORTS FC 25
    Publisher    REG_SZ    Electronic Arts
    InstallLocation    REG_SZ    C:\Games\FC25

HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\AC
    DisplayName    REG_SZ    Assassin's Creed Mirage
    Publisher    REG_SZ    Ubisoft
    InstallLocation    REG_SZ    C:\Games\AC

HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\OW
    DisplayName    REG_SZ    Overwatch
    Publisher    REG_SZ    Blizzard Entertainment
    InstallLocation    REG_SZ    C:\Games\OW

HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Ubi
    DisplayName    REG_SZ    Ubisoft Connect
    Publisher    REG_SZ    Ubisoft
"#;
        let games = games_from_uninstall(&parse_uninstall_export(text));
        assert_eq!(games.len(), 3);
        assert!(games.iter().any(|g| g.store == "ea" && g.name.contains("FC 25")));
        assert!(games.iter().any(|g| g.store == "ubisoft" && g.id == "assassin-s-creed-mirage"));
        assert!(games.iter().any(|g| g.store == "battlenet" && g.name == "Overwatch"));
        assert!(games.iter().all(|g| g.name != "EA App" && g.name != "Ubisoft Connect"));
    }
}
