//! Installed EA, Ubisoft and Battle.net rows from the uninstall registry,
//! plus Xbox games laid out under `C:\XboxGames`.

use std::path::{Path, PathBuf};

use super::FoundGame;

#[derive(Debug, Clone, PartialEq, Eq)]
struct UninstallEntry {
    name: String,
    publisher: String,
    location: String,
}

/// `MicrosoftGame.config` title. The element form and the attribute form both occur.
pub(crate) fn xbox_display_name(xml: &str) -> Option<String> {
    xml_attr(xml, "DefaultDisplayName").or_else(|| xml_text(xml, "DefaultDisplayName"))
}

pub(crate) fn xml_attr(xml: &str, attr: &str) -> Option<String> {
    let key = format!("{attr}=\"");
    let rest = xml.split(&key).nth(1)?;
    let value = rest.split('"').next()?.trim();
    if value.is_empty() { None } else { Some(value.to_string()) }
}

pub(crate) fn xml_text(xml: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let rest = xml.split(&open).nth(1)?;
    let value = rest.split('<').next()?.trim();
    if value.is_empty() { None } else { Some(value.to_string()) }
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

pub(crate) fn slug(name: &str) -> String {
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

pub(crate) fn games_from_uninstall(entries_text: &str) -> Vec<FoundGame> {
    let mut games = Vec::new();
    for entry in parse_uninstall_export(entries_text) {
        let Some(store) = companion_store(&entry.name, &entry.publisher) else {
            continue;
        };
        let id = slug(&entry.name);
        if id.is_empty() {
            continue;
        }
        games.push(FoundGame {
            store: store.to_string(),
            id,
            name: entry.name,
            install_path: entry.location,
            installed: true,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: String::new(),
            install_uri: String::new(),
            uninstall_uri: String::new(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

pub(crate) fn uninstall_games() -> Vec<FoundGame> {
    #[cfg(windows)]
    {
        games_from_uninstall(&query_uninstall())
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

pub(crate) fn xbox_games() -> Vec<FoundGame> {
    xbox_games_in(Path::new(r"C:\XboxGames"))
}

pub(crate) fn xbox_games_in(root: &Path) -> Vec<FoundGame> {
    let Ok(entries) = std::fs::read_dir(root) else {
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
        let content = entry.path().join("Content");
        let config = content.join("MicrosoftGame.config");
        let xml = std::fs::read_to_string(&config).unwrap_or_default();
        let name = xbox_display_name(&xml).unwrap_or(folder);
        let id = slug(&name);
        if id.is_empty() {
            continue;
        }
        let store_id = xml_text(&xml, "StoreId").unwrap_or_default();
        let exe_rel = executable_name(&xml).unwrap_or_default();
        let launch_exe = exe_under(&content, &exe_rel);
        games.push(FoundGame {
            store: "xbox".into(),
            id,
            name,
            install_path: entry.path().to_string_lossy().to_string(),
            installed: true,
            store_id,
            launch_exe,
            launch_uri: String::new(),
            install_uri: String::new(),
            uninstall_uri: String::new(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// `Name` on `<Executable>`, not the package identity.
fn executable_name(xml: &str) -> Option<String> {
    let rest = xml.split("<Executable ").nth(1)?;
    let tag = rest.split(['/', '>']).next()?;
    xml_attr(tag, "Name")
}

/// The executable attribute is only used when it stays inside the game folder.
fn exe_under(content: &Path, relative: &str) -> String {
    if relative.is_empty() || relative.contains("..") {
        return String::new();
    }
    let path = content.join(relative.replace('/', "\\"));
    if path.is_file() {
        path.to_string_lossy().to_string()
    } else {
        String::new()
    }
}

pub(crate) fn client_exe(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(PathBuf::from).find(|path| path.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn xbox_config_reads_title_store_and_exe() {
        let xml = r#"<Game>
          <ExecutableList><Executable Name="Binaries\NMS.exe" Id="NoMansSky"/></ExecutableList>
          <ShellVisuals DefaultDisplayName="No Man's Sky" />
          <StoreId>BQVQTL3PCH05</StoreId>
        </Game>"#;
        assert_eq!(xbox_display_name(xml).as_deref(), Some("No Man's Sky"));
        assert_eq!(xml_text(xml, "StoreId").as_deref(), Some("BQVQTL3PCH05"));
        assert_eq!(executable_name(xml).as_deref(), Some("Binaries\\NMS.exe"));
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
        let games = games_from_uninstall(text);
        assert_eq!(games.len(), 3);
        assert!(games.iter().any(|g| g.store == "ea" && g.name.contains("FC 25") && g.installed));
        assert!(games.iter().any(|g| g.store == "ubisoft" && g.id == "assassin-s-creed-mirage"));
        assert!(games.iter().any(|g| g.store == "battlenet" && g.name == "Overwatch"));
        assert!(games.iter().all(|g| g.name != "EA App" && g.name != "Ubisoft Connect"));
    }
}
