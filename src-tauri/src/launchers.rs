//! Store client detection for Settings > Launchers.
//!
//! The launcher hands play back to these clients (Steam, Ubisoft Connect, ...),
//! so this page reports which ones are installed and where they live. The
//! managed stores (Epic, GOG, Amazon Games) are listed too: their clients are
//! optional, and the row says so. Missing clients link to their official
//! download page; nothing installs from here.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::AppHandle;

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

fn gog_galaxy() -> Option<PathBuf> {
    // The URI handler also finds a Galaxy installed outside Program Files.
    for key in [
        r"HKCU\Software\Classes\goggalaxy\shell\open\command",
        r"HKLM\SOFTWARE\Classes\goggalaxy\shell\open\command",
        r"HKLM\SOFTWARE\WOW6432Node\Classes\goggalaxy\shell\open\command",
    ] {
        if let Some(output) = crate::winreg::query(key, None) {
            let command = crate::winreg::parse_reg_sz(&output);
            if let Some(path) = crate::legendary::import_installed::exe_from_open_command(&command) {
                return Some(path);
            }
        }
    }
    let mut candidates = vec![
        PathBuf::from(r"C:\Program Files (x86)\GOG Galaxy\GalaxyClient.exe"),
        PathBuf::from(r"C:\Program Files\GOG Galaxy\GalaxyClient.exe"),
    ];
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        candidates.push(local.join("GOG Galaxy").join("GalaxyClient.exe"));
        candidates.push(
            local
                .join("Programs")
                .join("GOG Galaxy")
                .join("GalaxyClient.exe"),
        );
        candidates.push(
            local
                .join("Programs")
                .join("GOG.com")
                .join("Galaxy")
                .join("GalaxyClient.exe"),
        );
    }
    candidates.into_iter().find(|path| path.is_file())
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

/// A game the official store client installed and still has on disk.
struct ClientGame {
    install_path: PathBuf,
    title: String,
    executable: String,
}

/// Finds the store's own install record for this game. Only a copy the client
/// installed is delegated; a launcher-owned install keeps the direct path.
fn client_game(store: &str, game_id: &str) -> Option<ClientGame> {
    match store {
        "epic" => crate::legendary::cache::read_egl_installed_games()
            .into_iter()
            .find(|game| game.app_name.eq_ignore_ascii_case(game_id))
            .map(|game| ClientGame {
                install_path: PathBuf::from(game.install_path),
                title: game.title,
                executable: game.executable,
            }),
        "gog" => crate::gogdl::galaxy::detect_galaxy_games()
            .into_iter()
            .find(|game| game.game_id == game_id)
            .map(|game| ClientGame {
                install_path: PathBuf::from(game.install_path),
                title: if game.title.is_empty() {
                    game_id.to_string()
                } else {
                    game.title
                },
                executable: game.executable,
            }),
        _ => None,
    }
}

/// Starts a client executable without a console window.
fn spawn_client(exe: &Path, args: &[&str]) -> Result<(), String> {
    let mut cmd = std::process::Command::new(exe);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn epic_uri(game_id: &str, launch: bool) -> String {
    if launch {
        format!("com.epicgames.launcher://apps/{game_id}?action=launch&silent=true")
    } else {
        format!("com.epicgames.launcher://apps/{game_id}")
    }
}

fn gog_args<'a>(game_id: &'a str, command: &'static str) -> [&'a str; 4] {
    ["/gameid", game_id, "/command", command]
}

/// Watches a game the client started and closes the session when it exits.
/// The client protocol returns before the game window exists, so the loop waits
/// for a process under the install folder first.
fn watch_delegated_session(app: AppHandle, store: String, key: String, game: ClientGame) {
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let candidates = crate::legendary::transfers::discover_game_executables(
            &game.install_path,
            (!game.executable.trim().is_empty()).then_some(game.executable.as_str()),
        );
        let started = std::time::Instant::now();
        let mut detected_at: Option<std::time::Instant> = None;
        let mut missing = 0u32;
        let mut last_heartbeat = std::time::Instant::now();
        loop {
            if crate::legendary::transfers::is_game_process_running(
                Some(&game.install_path),
                &candidates,
            ) {
                if detected_at.is_none() {
                    detected_at = Some(std::time::Instant::now());
                    crate::legendary::screenshots::set_active_running_game(
                        &key,
                        &game.title,
                        Some(game.install_path.clone()),
                        candidates.clone(),
                    );
                    crate::legendary::playtime_session::begin(&key);
                    let _ = app.emit(
                        "game-status",
                        serde_json::json!({ "id": key, "running": true }),
                    );
                }
                if last_heartbeat.elapsed() >= std::time::Duration::from_secs(15) {
                    crate::legendary::playtime_session::heartbeat();
                    last_heartbeat = std::time::Instant::now();
                }
                missing = 0;
            } else if detected_at.is_some() {
                missing += 1;
                if missing >= 3 {
                    break;
                }
            } else if started.elapsed() > std::time::Duration::from_secs(300) {
                // The client only opened a page or an install prompt.
                return;
            }
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
        }
        let elapsed = detected_at
            .map(|at| at.elapsed().as_secs())
            .unwrap_or(0);
        crate::legendary::screenshots::clear_active_running_game(&key);
        // Opt-in: the session went through the official client, so it can be
        // quit along with the game.
        if detected_at.is_some() {
            crate::companion::close_client_if_enabled(&store);
        }
        let record = if elapsed >= 5 {
            crate::legendary::playtime::record_session(&key, elapsed).ok()
        } else {
            None
        };
        crate::legendary::playtime_session::finish();
        let payload = match record {
            Some(record) => serde_json::json!({
                "id": key,
                "running": false,
                "sessionSeconds": elapsed,
                "totalSeconds": record.total_seconds,
                "sessionCount": record.session_count,
                "lastPlayed": record.last_played,
                "lastPlayedTimestamp": record.last_played_timestamp,
            }),
            None => serde_json::json!({ "id": key, "running": false }),
        };
        let _ = app.emit("game-status", payload);
        crate::legendary::transfers::wake_main_window(&app);
    });
}

/// Client arguments for one handoff action. `install` opens the game page for a
/// game the client does not have installed yet; `open` shows the page of a copy
/// the client owns; `launch` starts that copy.
fn client_args(store: &str, game_id: &str, action: &str) -> Option<Vec<String>> {
    match (store, action) {
        ("epic", "launch") => Some(vec![epic_uri(game_id, true)]),
        ("epic", "open" | "install") => Some(vec![epic_uri(game_id, false)]),
        ("gog", "launch") => Some(
            gog_args(game_id, "runGame")
                .iter()
                .map(|arg| (*arg).to_string())
                .collect(),
        ),
        ("gog", "open" | "install") => Some(
            gog_args(game_id, "launch")
                .iter()
                .map(|arg| (*arg).to_string())
                .collect(),
        ),
        _ => None,
    }
}

/// Optional hand-off to the official Epic/GOG client.
///
/// `action` is `launch` (start a game the client installed), `install` (open a
/// new game in the client), `open` (show an installed game's page for update or
/// uninstall) or `check` (only report whether the client owns this copy).
/// Returns `false` when the client is missing or a launcher-owned copy was
/// asked to launch/open, so the caller keeps using the direct path.
#[tauri::command]
pub async fn launcher_delegate(
    app: AppHandle,
    store: String,
    game_id: String,
    action: String,
) -> Result<bool, String> {
    // A client removed after the switch was enabled must fall back to the
    // direct path, not fail because its old install records are still around.
    let exe = match store.as_str() {
        "epic" => crate::legendary::import_installed::epic_launcher_executable(),
        "gog" => gog_galaxy(),
        _ => None,
    };
    let Some(exe) = exe else {
        return Ok(false);
    };
    if action == "check" {
        return Ok(client_game(&store, &game_id).is_some());
    }
    let Some(args) = client_args(&store, &game_id, &action) else {
        return Ok(false);
    };
    // A new install has no client record yet; launch/open need that record.
    let game = if action == "install" {
        None
    } else {
        match client_game(&store, &game_id) {
            Some(game) => Some(game),
            None => return Ok(false),
        }
    };
    let arg_refs: Vec<&str> = args.iter().map(String::as_str).collect();
    spawn_client(&exe, &arg_refs)?;
    if action == "launch" {
        if let Some(game) = game {
            let key = if store == "gog" {
                format!("gog::{game_id}")
            } else {
                game_id
            };
            watch_delegated_session(app, store.clone(), key, game);
        }
    }
    Ok(true)
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

    #[test]
    fn delegate_commands_carry_the_game_id() {
        assert_eq!(
            epic_uri("Ginger", true),
            "com.epicgames.launcher://apps/Ginger?action=launch&silent=true"
        );
        assert_eq!(
            epic_uri("Ginger", false),
            "com.epicgames.launcher://apps/Ginger"
        );
        assert_eq!(
            gog_args("1207658924", "runGame"),
            ["/gameid", "1207658924", "/command", "runGame"]
        );
    }

    #[test]
    fn a_new_install_opens_the_client_page() {
        assert_eq!(
            client_args("epic", "Witcher4", "install"),
            Some(vec!["com.epicgames.launcher://apps/Witcher4".to_string()])
        );
        assert_eq!(
            client_args("gog", "1207658924", "install"),
            Some(vec![
                "/gameid".to_string(),
                "1207658924".to_string(),
                "/command".to_string(),
                "launch".to_string(),
            ])
        );
        assert_eq!(client_args("epic", "Witcher4", "check"), None);
        assert_eq!(client_args("steam", "123", "install"), None);
    }
}
