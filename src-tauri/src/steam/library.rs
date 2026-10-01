//! Installed-game list from `appmanifest_*.acf` and `libraryfolders.vdf`.
//!
//! Owns `SteamGame` and which folders count as libraries. Download progress
//! on a manifest is only trusted while the Steam client process is alive.

use std::path::{Path, PathBuf};

use serde::Serialize;

use super::catalog::cached_preload_ids;
use super::runtime::{path_key, steam_client_running};
use super::vdf::{parse_vdf, Vdf};

/// Integer field from an app manifest. Missing or junk reads as zero.
fn acf_u64(state: &Vdf, key: &str) -> u64 {
    state
        .get(key)
        .and_then(Vdf::as_str)
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// Every `steamapps` folder: the main install plus the extra library folders.
pub fn library_folders(steam: &Path) -> Vec<PathBuf> {
    let main = steam.join("steamapps");
    let mut folders = vec![main.clone()];
    let mut seen = std::collections::HashSet::from([path_key(&main)]);
    let Ok(text) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf"))
    else {
        return folders;
    };
    let root = parse_vdf(&text);
    let Some(list) = root.get("libraryfolders") else {
        return folders;
    };
    for (_, entry) in list.entries() {
        let Some(path) = entry.get("path").and_then(Vdf::as_str) else {
            continue;
        };
        let candidate = PathBuf::from(path).join("steamapps");
        // The main install is usually listed again with different casing; only a
        // real, unseen folder joins the list.
        if candidate.is_dir() && seen.insert(path_key(&candidate)) {
            folders.push(candidate);
        }
    }
    folders
}

/// One installed Steam game read from its app manifest.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamGame {
    pub app_id: String,
    pub name: String,
    pub install_dir: String,
    pub size_bytes: u64,
    /// Steam's `StateFlags`; 4 means fully installed.
    pub state_flags: u32,
    /// Library folder that holds the game.
    pub library: String,
    /// True while the Steam client is downloading this app (`steamapps/downloading/<id>`).
    pub downloading: bool,
    /// Bytes the client has already pulled (`BytesDownloaded`, else the downloading folder).
    pub bytes_downloaded: u64,
    /// Total bytes this job still reports (`BytesToDownload`). Zero when Steam has not written it.
    pub bytes_to_download: u64,
    /// True when the install is a preload (release build is not out yet).
    /// Steam still sets `UpdateRequired` for those, but there is nothing to download.
    #[serde(default)]
    pub preloaded: bool,
}

/// Parses one `appmanifest_<id>.acf` file.
pub fn parse_app_manifest(text: &str, library: &Path) -> Option<SteamGame> {
    let root = parse_vdf(text);
    let state = root.get("AppState")?;
    let app_id = state.get("appid").and_then(Vdf::as_str)?.to_string();
    if app_id.is_empty() {
        return None;
    }
    let name = state
        .get("name")
        .and_then(Vdf::as_str)
        .unwrap_or(&app_id)
        .to_string();
    let install_dir = state
        .get("installdir")
        .and_then(Vdf::as_str)
        .unwrap_or("")
        .to_string();
    let size_bytes = state
        .get("SizeOnDisk")
        .and_then(Vdf::as_str)
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let state_flags = state
        .get("StateFlags")
        .and_then(Vdf::as_str)
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);
    let mut bytes_to_download = acf_u64(state, "BytesToDownload");
    let mut bytes_downloaded = acf_u64(state, "BytesDownloaded");
    let bytes_to_stage = acf_u64(state, "BytesToStage");
    let build_id = acf_u64(state, "buildid");
    let target_build_id = acf_u64(state, "TargetBuildID");
    let dl_dir = library.join("downloading").join(&app_id);
    // Only a live `downloading/<id>` folder means Steam is transferring files.
    // If paused (bit 512 = 0x200), it is not actively downloading.
    // Byte counters come from the manifest. Walking the download folder to sum
    // file sizes blocks the UI for the whole transfer (tens of GB, constantly
    // rewritten while the poller is running).
    let paused = (state_flags & 512) != 0;
    let downloading = dl_dir.is_dir() && !paused;
    if downloading && bytes_to_download == 0 {
        let stage_to = acf_u64(state, "BytesToStage");
        if stage_to > 0 {
            bytes_to_download = stage_to;
            if bytes_downloaded == 0 {
                bytes_downloaded = acf_u64(state, "BytesStaged");
            }
        }
    }
    Some(SteamGame {
        app_id,
        name,
        install_dir,
        size_bytes,
        state_flags,
        library: library.to_string_lossy().to_string(),
        downloading,
        bytes_downloaded,
        bytes_to_download,
        // A preload has encrypted depots (buildid > 0) with no public target
        // build yet (TargetBuildID == 0) and keeps UpdateRequired set until release day.
        preloaded: (state_flags & 2) != 0
            && bytes_to_download == 0
            && bytes_to_stage == 0
            && build_id > 0
            && target_build_id == 0,
    })
}

/// Reads every app manifest across all library folders, newest first.
pub fn installed_games(steam: &Path) -> Vec<SteamGame> {
    let mut games: Vec<SteamGame> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let steam_running = steam_client_running(steam);
    let preloads = cached_preload_ids(steam);
    for folder in library_folders(steam) {
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if !file_name.starts_with("appmanifest_") || !file_name.ends_with(".acf") {
                continue;
            }
            let Ok(text) = std::fs::read_to_string(&path) else {
                continue;
            };
            if let Some(mut game) = parse_app_manifest(&text, &folder) {
                if is_steam_library_noise(&game.app_id, &game.name) {
                    continue;
                }
                if !steam_running {
                    game.downloading = false;
                }
                if !game.preloaded {
                    if let Ok(id) = game.app_id.parse::<u32>() {
                        if preloads.contains(&id) {
                            game.preloaded = true;
                        }
                    }
                }
                // A game left behind in an old library folder must not appear twice.
                if seen.insert(game.app_id.clone()) {
                    games.push(game);
                }
            }
        }
        // First-time installs create `downloading/<id>` before a full manifest.
        if !steam_running {
            continue;
        }
        if let Ok(dl_entries) = std::fs::read_dir(folder.join("downloading")) {
            for entry in dl_entries.flatten() {
                let id = entry.file_name().to_string_lossy().to_string();
                if !entry.path().is_dir() || !id.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                if is_steam_library_noise(&id, "") {
                    continue;
                }
                if seen.insert(id.clone()) {
                    games.push(SteamGame {
                        app_id: id.clone(),
                        name: id,
                        install_dir: String::new(),
                        size_bytes: 0,
                        state_flags: 0,
                        library: folder.to_string_lossy().to_string(),
                        downloading: true,
                        bytes_downloaded: 0,
                        bytes_to_download: 0,
                        preloaded: false,
                    });
                }
            }
        }
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/// Tools and SDKs Steam installs next to games (not playable titles).
pub(super) fn is_steam_library_noise(app_id: &str, name: &str) -> bool {
    if app_id == "228980" {
        return true;
    }
    let n = name.to_ascii_lowercase();
    n.contains("steamworks common redistributables")
        || n.contains("steamworks redistributable")
        || n.starts_with("steam linux runtime")
        || n.starts_with("proton ")
        || n == "proton experimental"
        || n.contains("steamworks sdk")
        || n == "source sdk"
        || n.starts_with("source sdk ")
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::path::Path;

    use super::super::vdf::parse_vdf;

    const APP_MANIFEST: &str = r#"
    "AppState"
    {
    	"appid"		"620"
    	"Universe"		"1"
    	"name"		"Portal 2"
    	"installdir"		"Portal 2"
    	"SizeOnDisk"		"12345678901"
    	"StateFlags"		"4"
    }
    "#;

    const APP_MANIFEST_DOWNLOADING: &str = r#"
    "AppState"
    {
    	"appid"		"730"
    	"name"		"Counter-Strike 2"
    	"installdir"		"Counter-Strike Global Offensive"
    	"SizeOnDisk"		"100"
    	"StateFlags"		"1026"
    	"BytesToDownload"		"4000"
    	"BytesDownloaded"		"1000"
    }
    "#;

    #[test]
    fn app_manifest_reads_game_fields() {
        let game =
            parse_app_manifest(APP_MANIFEST, Path::new(r"D:\SteamLibrary\steamapps")).expect("game");
        assert_eq!(game.app_id, "620");
        assert_eq!(game.name, "Portal 2");
        assert_eq!(game.install_dir, "Portal 2");
        assert_eq!(game.size_bytes, 12_345_678_901);
        assert_eq!(game.state_flags, 4);
        assert_eq!(game.bytes_downloaded, 0);
        assert_eq!(game.bytes_to_download, 0);
        assert!(game.library.ends_with("steamapps"));
        assert!(!game.preloaded);
    }
    #[test]
    fn preload_manifest_is_not_an_update() {
        let preload = r#"
    "AppState"
    {
    	"appid"		"3962600"
    	"name"		"AION 2"
    	"installdir"		"AION2"
    	"StateFlags"		"6"
    	"buildid"		"17000001"
    	"TargetBuildID"		"0"
    	"BytesToDownload"		"0"
    	"BytesToStage"		"0"
    }
    "#;
        let game = parse_app_manifest(preload, Path::new("x")).expect("game");
        assert!(game.preloaded);
        assert_eq!(game.state_flags, 6);
    }
    #[test]
    fn real_update_with_a_newer_build_is_not_a_preload() {
        let update = r#"
    "AppState"
    {
    	"appid"		"730"
    	"name"		"Counter-Strike 2"
    	"StateFlags"		"6"
    	"buildid"		"100"
    	"TargetBuildID"		"200"
    	"BytesToDownload"		"0"
    	"BytesToStage"		"0"
    }
    "#;
        let game = parse_app_manifest(update, Path::new("x")).expect("game");
        assert!(!game.preloaded);
    }
    #[test]
    fn queued_bytes_keep_an_update_even_without_a_target_build() {
        let update = r#"
    "AppState"
    {
    	"appid"		"730"
    	"name"		"Counter-Strike 2"
    	"StateFlags"		"6"
    	"buildid"		"100"
    	"TargetBuildID"		"0"
    	"BytesToDownload"		"4096"
    }
    "#;
        let game = parse_app_manifest(update, Path::new("x")).expect("game");
        assert!(!game.preloaded);
    }
    #[test]
    fn broken_or_empty_documents_never_panic() {
        assert!(parse_app_manifest("", Path::new("x")).is_none());
        assert!(parse_app_manifest("\"AppState\" { \"name\"", Path::new("x")).is_none());
        assert_eq!(parse_vdf("not vdf at all").entries().len(), 0);
        assert_eq!(
            parse_app_manifest(APP_MANIFEST, Path::new("x"))
                .unwrap()
                .app_id,
            "620"
        );
    }
    #[test]
    fn app_manifest_reads_download_bytes_without_treating_them_as_live() {
        let game = parse_app_manifest(APP_MANIFEST_DOWNLOADING, Path::new("x")).expect("game");
        assert_eq!(game.app_id, "730");
        assert_eq!(game.bytes_downloaded, 1000);
        assert_eq!(game.bytes_to_download, 4000);
        assert_eq!(game.state_flags, 1026);
        assert!(!game.downloading);
    }
    #[test]
    fn downloading_folder_marks_a_live_download() {
        let tmp = std::env::temp_dir().join(format!("efxlve-steam-dl-{}", std::process::id()));
        let dl = tmp.join("downloading").join("730");
        std::fs::create_dir_all(&dl).expect("temp downloading dir");
        let game = parse_app_manifest(APP_MANIFEST_DOWNLOADING, &tmp).expect("game");
        assert!(game.downloading);
        let _ = std::fs::remove_dir_all(&tmp);
    }
    #[test]
    fn paused_download_is_not_marked_downloading() {
        let tmp = std::env::temp_dir().join(format!("efxlve-steam-dl-paused-{}", std::process::id()));
        let dl = tmp.join("downloading").join("730");
        std::fs::create_dir_all(&dl).expect("temp downloading dir");
        let paused_vdf = r#"
    "AppState"
    {
    	"appid"		"730"
    	"name"		"Counter-Strike 2"
    	"StateFlags"		"1538"
    	"BytesToDownload"		"4000"
    	"BytesDownloaded"		"1000"
    }
    "#;
        let game = parse_app_manifest(paused_vdf, &tmp).expect("game");
        assert!(!game.downloading);
        let _ = std::fs::remove_dir_all(&tmp);
    }
    #[test]
    fn staging_bytes_used_when_download_bytes_zero() {
        let tmp = std::env::temp_dir().join(format!("efxlve-steam-dl-staging-{}", std::process::id()));
        let dl = tmp.join("downloading").join("730");
        std::fs::create_dir_all(&dl).expect("temp downloading dir");
        let staging_vdf = r#"
    "AppState"
    {
    	"appid"		"730"
    	"name"		"Counter-Strike 2"
    	"StateFlags"		"1026"
    	"BytesToDownload"		"0"
    	"BytesDownloaded"		"0"
    	"BytesToStage"		"8000"
    	"BytesStaged"		"4000"
    }
    "#;
        let game = parse_app_manifest(staging_vdf, &tmp).expect("game");
        assert!(game.downloading);
        assert_eq!(game.bytes_to_download, 8000);
        assert_eq!(game.bytes_downloaded, 4000);
        let _ = std::fs::remove_dir_all(&tmp);
    }
    #[test]
    fn steamworks_redistributables_are_not_games() {
        assert!(is_steam_library_noise("228980", "Anything"));
        assert!(is_steam_library_noise(
            "1",
            "Steamworks Common Redistributables"
        ));
        assert!(is_steam_library_noise("0", "Proton 9.0"));
        assert!(!is_steam_library_noise("730", "Counter-Strike 2"));
        assert!(!is_steam_library_noise(
            "2322010",
            "Grand Theft Auto V Enhanced"
        ));
    }
}
