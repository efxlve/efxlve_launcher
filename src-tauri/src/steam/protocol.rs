//! Hand a play / install / uninstall action back to the Steam client.
//!
//! Owns `steam://` URLs. This module never touches game files.

use std::process::Command;

use serde::Serialize;

use super::library::{installed_games, SteamGame};
use super::runtime::steam_install_path;
use super::users::active_steam_user;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Status shown in Settings > Integrations and on the Accounts page.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamStatus {
    pub installed: bool,
    pub path: String,
    pub games: usize,
    /// Persona name of the account signed in to the Steam client (empty when unknown).
    pub user_name: String,
}

#[tauri::command]
pub fn steam_status() -> SteamStatus {
    match steam_install_path() {
        Some(path) => {
            let games = installed_games(&path).len();
            let user_name = active_steam_user(&path)
                .map(|(_, name)| name)
                .unwrap_or_default();
            SteamStatus {
                installed: true,
                path: path.to_string_lossy().to_string(),
                games,
                user_name,
            }
        }
        None => SteamStatus {
            installed: false,
            path: String::new(),
            games: 0,
            user_name: String::new(),
        },
    }
}

/// Opens the Steam client itself (`steam://open/main`).
#[tauri::command]
pub fn steam_open_client() -> Result<(), String> {
    spawn_uri("steam://open/main")
}

/// Opens Steam's own download manager (`steam://open/downloads`).
#[tauri::command]
pub fn steam_open_downloads() -> Result<(), String> {
    spawn_uri("steam://open/downloads")
}

#[tauri::command]
pub fn steam_list_installed() -> Vec<SteamGame> {
    steam_install_path()
        .map(|p| installed_games(&p))
        .unwrap_or_default()
}

/// Opens a `steam://` URL through Steam's registered protocol handler.
///
/// `cmd start` eats `/` as switches. Passing the URI as a bare `steam.exe`
/// argument also fails: the client only treats it as a protocol when it is
/// preceded by `--` (the association is `steam.exe -- "%1"`).
pub(super) fn spawn_uri(target: &str) -> Result<(), String> {
    // The cmd fallback interpolates this string. Reject anything that is not
    // a steam:// URL, including quotes and shell metacharacters.
    if !target.starts_with("steam://")
        || target
            .bytes()
            .any(|b| b == b'"' || b == b'\n' || b == b'\r' || b == b'&' || b == b'|')
    {
        return Err("Unsupported Steam URL".into());
    }
    if tauri_plugin_opener::open_url(target, None::<&str>).is_ok() {
        return Ok(());
    }
    if let Some(exe) = steam_install_path().map(|p| p.join("steam.exe")) {
        if exe.is_file() {
            let mut command = Command::new(&exe);
            command.arg("-silent").arg("--").arg(target);
            return command
                .spawn()
                .map(|_| ())
                .map_err(|e| format!("Steam could not be opened: {e}"));
        }
    }
    let mut command = Command::new("cmd");
    command.args(["/C", &format!("start \"\" \"{target}\"")]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Steam could not be opened: {e}"))
}

pub(super) fn steam_action_url(app_id: &str, action: &str) -> Option<String> {
    match action {
        "launch" | "update" => Some(format!("steam://rungameid/{app_id}")),
        "install" => Some(format!("steam://install/{app_id}")),
        "uninstall" => Some(format!("steam://uninstall/{app_id}")),
        "validate" => Some(format!("steam://validate/{app_id}")),
        _ => None,
    }
}

#[tauri::command]
pub fn steam_game_action(app_id: String, action: String) -> Result<(), String> {
    if app_id.is_empty() || !app_id.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid Steam app id".into());
    }
    let Some(url) = steam_action_url(&app_id, &action) else {
        return Err("Unsupported Steam action".into());
    };
    spawn_uri(&url)
}

#[cfg(test)]
mod tests {
    use super::*;


    #[test]
    fn actions_reject_bad_input() {
        assert!(steam_game_action("620; rm -rf".into(), "launch".into()).is_err());
        assert!(steam_game_action(String::new(), "launch".into()).is_err());
        assert!(steam_game_action("620".into(), "delete-everything".into()).is_err());
    }
    #[test]
    fn steam_action_urls_keep_the_verb_and_app_id() {
        assert_eq!(
            steam_action_url("730", "install").as_deref(),
            Some("steam://install/730")
        );
        assert_eq!(
            steam_action_url("730", "update").as_deref(),
            Some("steam://rungameid/730")
        );
        assert_eq!(
            steam_action_url("730", "launch").as_deref(),
            Some("steam://rungameid/730")
        );
        assert!(steam_action_url("730", "delete-everything").is_none());
    }
    #[test]
    fn steam_uri_rejects_shell_metacharacters() {
        assert!(spawn_uri("https://example.com").is_err());
        assert!(spawn_uri("steam://run/1&calc").is_err());
        assert!(spawn_uri("steam://open/main\ncmd").is_err());
    }
}
