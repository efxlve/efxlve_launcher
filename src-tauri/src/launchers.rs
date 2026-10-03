//! Store client detection for Settings > Launchers.
//!
//! The launcher hands play back to these clients (Steam, Ubisoft Connect, ...),
//! so this page reports which ones are installed and where they live. Missing
//! clients link to their official download page; nothing installs from here.

use std::path::PathBuf;

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

/// Store clients in the same order as the storefront header.
const LAUNCHERS: [(&str, &str, &str); 8] = [
    ("epic", "Epic Games Launcher", "https://store.epicgames.com/download"),
    ("gog", "GOG Galaxy", "https://www.gog.com/galaxy"),
    ("steam", "Steam", "https://store.steampowered.com/about/"),
    ("xbox", "Xbox", "https://www.xbox.com/apps/xbox-app-for-pc"),
    ("battlenet", "Battle.net", "https://www.blizzard.com/download"),
    ("ubisoft", "Ubisoft Connect", "https://ubisoftconnect.com/"),
    ("ea", "EA App", "https://www.ea.com/ea-app"),
    ("riot", "Riot Client", "https://www.leagueoflegends.com/download/"),
];

fn first_file(candidates: &[&str]) -> Option<PathBuf> {
    candidates.iter().map(PathBuf::from).find(|path| path.is_file())
}

fn epic_launcher() -> Option<PathBuf> {
    first_file(&[
        r"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe",
        r"C:\Program Files\Epic Games\Launcher\Portal\Binaries\Win32\EpicGamesLauncher.exe",
        r"C:\Program Files (x86)\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe",
        r"C:\Program Files\Epic Games\Launcher\Portal\Binaries\Win64\EpicGamesLauncher.exe",
    ])
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

/// `<ProgramData>/Epic/UnrealEngineLauncher` exists once the Epic Games
/// Launcher has run.
fn egl_data() -> Option<PathBuf> {
    let base = std::env::var_os("ProgramData")?;
    let dir = PathBuf::from(base).join("Epic").join("UnrealEngineLauncher");
    dir.is_dir().then_some(dir)
}

/// Installation state and path of one client.
fn state(id: &str) -> (bool, String) {
    // The Xbox app ships as a Store package and has no single path.
    if id == "xbox" {
        return (crate::companion::client_installed("xbox"), String::new());
    }
    let path = match id {
        "epic" => epic_launcher().or_else(egl_data),
        "gog" => gog_galaxy().or_else(gog_storage),
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
