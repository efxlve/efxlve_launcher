//! Store client detection for Settings > Launchers.
//!
//! The launcher hands play back to these clients (Steam, Ubisoft Connect, ...),
//! so this page reports which ones are installed and where they live. The
//! managed stores (Epic, GOG, Amazon Games) are listed too: their clients are
//! optional, and the row says so. Missing clients link to their official
//! download page; nothing installs from here.

use std::path::{Path, PathBuf};

use serde::Serialize;

/// One row of the Settings > Launchers list.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherStatus {
    pub id: String,
    pub name: String,
    pub installed: bool,
    /// Executable or data folder when known (empty otherwise).
    pub path: String,
    pub download_url: String,
}

/// Official Amazon help page that carries the Amazon Games App installer.
const AMAZON_GAMES_DOWNLOAD: &str =
    "https://www.amazon.com/gp/help/customer/display.html?nodeId=TQ1wROUN7BTxoTBbAk";

/// Store clients in the same order as the storefront header.
const LAUNCHERS: [(&str, &str, &str); 10] = [
    ("epic", "Epic Games Launcher", "https://store.epicgames.com/download"),
    ("gog", "GOG Galaxy", "https://www.gog.com/galaxy"),
    ("amazon", "Amazon Games", AMAZON_GAMES_DOWNLOAD),
    ("steam", "Steam", "https://store.steampowered.com/about/"),
    ("xbox", "Xbox", "https://www.xbox.com/apps/xbox-app-for-pc"),
    ("battlenet", "Battle.net", "https://www.blizzard.com/download"),
    ("ubisoft", "Ubisoft Connect", "https://ubisoftconnect.com/"),
    ("ea", "EA App", "https://www.ea.com/ea-app"),
    (
        "rockstar",
        "Rockstar Games Launcher",
        "https://socialclub.rockstargames.com/rockstar-games-launcher",
    ),
    ("riot", "Riot Client", "https://www.leagueoflegends.com/download/"),
];

fn first_file(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(PathBuf::from).find(|path| path.is_file())
}

fn gog_galaxy() -> Option<PathBuf> {
    first_file(&[
        r"C:\Program Files (x86)\GOG Galaxy\GalaxyClient.exe",
        r"C:\Program Files\GOG Galaxy\GalaxyClient.exe",
    ])
}

/// `<ProgramData>/GOG.com/Galaxy` exists once Galaxy has run.
fn gog_storage() -> Option<PathBuf> {
    let base = std::env::var_os("ProgramData")?;
    let dir = PathBuf::from(base).join("GOG.com").join("Galaxy");
    dir.is_dir().then_some(dir)
}

/// Path inside a `DisplayIcon` value (`"C:\...\App.exe,0"`).
fn icon_path(value: &str) -> PathBuf {
    let raw = value.trim();
    let raw = match raw.strip_prefix('"') {
        Some(rest) => rest.split('"').next().unwrap_or(raw),
        None => raw,
    };
    // The icon index follows the path after a comma; a bare path has none.
    let path = match raw.rsplit_once(',') {
        Some((head, tail))
            if !tail.trim().is_empty() && tail.trim().chars().all(|c| c.is_ascii_digit()) =>
        {
            head
        }
        _ => raw,
    };
    PathBuf::from(path.trim())
}

/// The Amazon Games App executable inside one `Amazon Games\App` folder.
fn amazon_app_exe(dir: &Path) -> Option<PathBuf> {
    for name in ["Amazon Games.exe", "AmazonGames.exe"] {
        let path = dir.join(name);
        if path.is_file() {
            return Some(path);
        }
    }
    // Setup has shipped the App under different names; any Amazon executable
    // in that folder still proves the client is installed.
    let mut found: Vec<PathBuf> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
                && path
                    .file_stem()
                    .is_some_and(|stem| stem.to_string_lossy().to_lowercase().contains("amazon"))
        })
        .collect();
    found.sort();
    found.into_iter().next()
}

/// Amazon Games App executable, or `None` when the App is not installed.
///
/// Setup installs under the user's local folder but accepts another one, so
/// the uninstall entry's `DisplayIcon` is checked first; the standard folders
/// cover installs whose key is gone.
fn amazon_games() -> Option<PathBuf> {
    for key in [
        r"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\Amazon Games",
        r"HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\Amazon Games",
        r"HKLM\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\Amazon Games",
    ] {
        if let Some(output) = crate::winreg::query(key, Some("DisplayIcon")) {
            let path = icon_path(&crate::winreg::parse_reg_sz(&output));
            if path.is_file() {
                return Some(path);
            }
        }
    }
    ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter_map(|base| amazon_app_exe(&PathBuf::from(base).join("Amazon Games").join("App")))
        .next()
}

/// Installation state and path of one client.
fn state(id: &str) -> (bool, String) {
    // The Xbox app ships as a Store package and has no single path.
    if id == "xbox" {
        return (crate::companion::client_installed("xbox"), String::new());
    }
    let path = match id {
        // Only the executable counts. `%ProgramData%\Epic\UnrealEngineLauncher`
        // outlives an uninstall and must not make a missing launcher look installed.
        "epic" => crate::legendary::import_installed::epic_launcher_executable(),
        "gog" => gog_galaxy().or_else(gog_storage),
        "amazon" => amazon_games(),
        "steam" => crate::steam::steam_install_path(),
        _ => crate::companion::client_path(id),
    };
    match path {
        Some(path) => (true, path.to_string_lossy().to_string()),
        None => (false, String::new()),
    }
}

/// Reports which store clients are installed (Settings > Launchers).
#[tauri::command]
pub fn launchers_status() -> Vec<LauncherStatus> {
    LAUNCHERS
        .iter()
        .map(|(id, name, download)| {
            let (installed, path) = state(id);
            LauncherStatus {
                id: (*id).to_string(),
                name: (*name).to_string(),
                installed,
                path,
                download_url: (*download).to_string(),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn icon_path_drops_the_icon_index() {
        assert_eq!(
            icon_path(r#""C:\Program Files\Amazon Games\App\Amazon Games.exe",0"#),
            PathBuf::from(r"C:\Program Files\Amazon Games\App\Amazon Games.exe")
        );
        assert_eq!(
            icon_path(r"C:\Games\Amazon Games.exe"),
            PathBuf::from(r"C:\Games\Amazon Games.exe")
        );
        // A comma inside the path is not an icon index.
        assert_eq!(
            icon_path(r#""C:\Games,Old\Amazon.exe""#),
            PathBuf::from(r"C:\Games,Old\Amazon.exe")
        );
    }

    #[test]
    fn amazon_app_folder_finds_the_executable() {
        let dir = std::env::temp_dir().join(format!("efxlve-amazon-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(amazon_app_exe(&dir), None);
        std::fs::write(dir.join("Amazon Games.exe"), b"").unwrap();
        assert_eq!(amazon_app_exe(&dir), Some(dir.join("Amazon Games.exe")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
