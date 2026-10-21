//! Custom games management: manual game addition, metadata search, launch, and tracking.

use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomGame {
    pub id: String,
    pub title: String,
    pub exe_path: String,
    pub launch_args: Option<String>,
    pub cover_url: Option<String>,
    pub header_url: Option<String>,
    pub hero_url: Option<String>,
    pub description: Option<String>,
    pub developer: Option<String>,
    pub release_year: Option<u32>,
    pub genres: Vec<String>,
    pub steam_app_id: Option<String>,
    pub added_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamStoreSearchHit {
    pub id: u64,
    pub name: String,
    pub cover_url: String,
    pub header_url: String,
    pub hero_url: String,
}

#[derive(Deserialize)]
struct RawSteamSearchResponse {
    items: Option<Vec<RawSteamSearchItem>>,
}

#[derive(Deserialize)]
struct RawSteamSearchItem {
    id: u64,
    name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SteamGameStoreDetails {
    pub name: String,
    pub short_description: String,
    pub header_image: String,
    pub developers: Vec<String>,
    pub genres: Vec<String>,
    pub release_year: Option<u32>,
}

fn custom_games_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("custom_games.json")
}

pub fn load_custom_games(app: &AppHandle) -> Vec<CustomGame> {
    let path = custom_games_path(app);
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save_custom_games(app: &AppHandle, list: &[CustomGame]) -> Result<(), String> {
    let path = custom_games_path(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

pub fn slugify(title: &str) -> String {
    let mut s = String::new();
    let mut last_dash = false;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            s.push(c.to_ascii_lowercase());
            last_dash = false;
        } else if !last_dash && (c == ' ' || c == '-' || c == '_') {
            s.push('-');
            last_dash = true;
        }
    }
    let trimmed = s.trim_matches('-');
    if trimmed.is_empty() {
        "game".to_string()
    } else {
        trimmed.to_string()
    }
}

/* ---------- Tauri Commands ---------- */

#[tauri::command]
pub fn custom_games_list(app: AppHandle) -> Vec<CustomGame> {
    load_custom_games(&app)
}

#[tauri::command]
pub fn custom_games_add(app: AppHandle, mut game: CustomGame) -> Result<CustomGame, String> {
    if game.title.trim().is_empty() {
        return Err("Game title cannot be empty".into());
    }
    if game.exe_path.trim().is_empty() {
        return Err("Executable path cannot be empty".into());
    }

    let mut list = load_custom_games(&app);
    if game.id.trim().is_empty() || !game.id.starts_with("custom::") {
        let slug = slugify(&game.title);
        let mut id = format!("custom::{slug}");
        let mut counter = 2;
        while list.iter().any(|g| g.id == id) {
            id = format!("custom::{slug}-{counter}");
            counter += 1;
        }
        game.id = id;
    }

    if game.added_at == 0 {
        game.added_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
    }

    list.retain(|g| g.id != game.id);
    list.push(game.clone());
    save_custom_games(&app, &list)?;

    Ok(game)
}

#[tauri::command]
pub fn custom_games_edit(app: AppHandle, game: CustomGame) -> Result<CustomGame, String> {
    if game.id.is_empty() {
        return Err("Invalid game ID".into());
    }
    let mut list = load_custom_games(&app);
    let index = list.iter().position(|g| g.id == game.id).ok_or("Game not found")?;
    list[index] = game.clone();
    save_custom_games(&app, &list)?;
    Ok(game)
}

#[tauri::command]
pub fn custom_games_remove(app: AppHandle, id: String) -> Result<(), String> {
    let mut list = load_custom_games(&app);
    list.retain(|g| g.id != id);
    save_custom_games(&app, &list)?;
    Ok(())
}

#[tauri::command]
pub async fn custom_games_launch(app: AppHandle, id: String) -> Result<(), String> {
    let games = load_custom_games(&app);
    let game = games.into_iter().find(|g| g.id == id).ok_or("Game not found")?;

    let exe_path = PathBuf::from(&game.exe_path);
    if !exe_path.exists() {
        return Err(format!("Executable not found: {}", game.exe_path));
    }

    let working_dir = exe_path.parent().unwrap_or(&exe_path);
    let mut cmd = std::process::Command::new(&exe_path);
    cmd.current_dir(working_dir);

    if let Some(ref args_str) = game.launch_args {
        for arg in args_str.split_whitespace() {
            cmd.arg(arg);
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008); // DETACHED_PROCESS
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch game: {e}"))?;

    let app_clone = app.clone();
    let game_id = game.id.clone();
    let game_title = game.title.clone();
    let steam_app_id = game.steam_app_id.clone();
    let app_key = format!("custom::{game_id}");

    crate::legendary::screenshots::set_active_running_game(&app_key, &game_title, Some(working_dir.to_path_buf()), vec![]);

    if let Some(ref aid) = steam_app_id {
        crate::steam::steam_start_achievement_watcher(app_clone.clone(), aid.clone());
    }

    std::thread::spawn(move || {
        let _ = child.wait();
        if let Some(ref aid) = steam_app_id {
            crate::steam::steam_stop_achievement_watcher(aid.clone());
        }
        crate::legendary::screenshots::clear_active_running_game(&app_key);
        let _ = app_clone.emit("custom-games-changed", ());
    });

    let _ = app.emit("custom-games-changed", ());
    Ok(())
}

#[tauri::command]
pub async fn custom_games_pick_file(
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let picker_title = title.unwrap_or_else(|| "Select Executable".to_string()).replace('\'', "''");
        tokio::task::spawn_blocking(move || {
            let clean_default_path = default_path.unwrap_or_default().replace('\'', "''");
            let script = format!(
                r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Windows.Forms;
$f = New-Object System.Windows.Forms.OpenFileDialog;
$f.Title = '{picker_title}';
$f.Filter = 'Executables (*.exe;*.bat;*.cmd;*.lnk)|*.exe;*.bat;*.cmd;*.lnk|All files (*.*)|*.*';
if ('{clean_default_path}' -ne '') {{ $f.InitialDirectory = '{clean_default_path}' }};
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
    Write-Output $f.FileName
}}
"#
            );

            let mut cmd = std::process::Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            }
            let output = cmd.output().map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if stdout.is_empty() {
                Ok(None)
            } else {
                Ok(Some(stdout))
            }
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = (default_path, title);
        Ok(None)
    }
}

#[tauri::command]
pub async fn custom_games_search_steam(query: String) -> Result<Vec<SteamStoreSearchHit>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let encoded: String = url::form_urlencoded::byte_serialize(trimmed.as_bytes()).collect();
    let url = format!(
        "https://store.steampowered.com/api/storesearch/?term={}&l=english&cc=US",
        encoded
    );

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|e| e.to_string())?;

    let res = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<RawSteamSearchResponse>()
        .await
        .map_err(|e| e.to_string())?;

    let items = res.items.unwrap_or_default();
    let hits = items
        .into_iter()
        .take(12)
        .map(|item| {
            let id = item.id;
            SteamStoreSearchHit {
                id,
                name: item.name,
                cover_url: format!("https://cdn.akamai.steamstatic.com/steam/apps/{id}/library_600x900.jpg"),
                header_url: format!("https://cdn.akamai.steamstatic.com/steam/apps/{id}/header.jpg"),
                hero_url: format!("https://cdn.akamai.steamstatic.com/steam/apps/{id}/library_hero.jpg"),
            }
        })
        .collect();

    Ok(hits)
}

#[tauri::command]
pub async fn custom_games_steam_details(app_id: String) -> Result<SteamGameStoreDetails, String> {
    let id_str = app_id.trim();
    if id_str.is_empty() || !id_str.chars().all(|c| c.is_ascii_digit()) {
        return Err("Invalid AppID".into());
    }

    let url = format!("https://store.steampowered.com/api/appdetails?appids={id_str}&l=english");
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|e| e.to_string())?;

    let val = client
        .get(&url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let data = val
        .get(id_str)
        .and_then(|app| app.get("data"))
        .ok_or_else(|| "No details found for AppID".to_string())?;

    let name = data.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let short_description = data
        .get("short_description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let header_image = data
        .get("header_image")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let developers = data
        .get("developers")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let genres = data
        .get("genres")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|g| g.get("description").and_then(|d| d.as_str()).map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let release_year = data
        .get("release_date")
        .and_then(|rd| rd.get("date"))
        .and_then(|d| d.as_str())
        .and_then(|s| {
            s.split(|c: char| !c.is_ascii_digit())
                .find(|part| part.len() == 4)
                .and_then(|y| y.parse::<u32>().ok())
        });

    Ok(SteamGameStoreDetails {
        name,
        short_description,
        header_image,
        developers,
        genres,
        release_year,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugifies_game_titles() {
        assert_eq!(slugify("Need for Speed: Most Wanted (2005)"), "need-for-speed-most-wanted-2005");
        assert_eq!(slugify("Minecraft: Story Mode"), "minecraft-story-mode");
        assert_eq!(slugify("  Spaces & D环ashes - - "), "spaces-dashes");
        assert_eq!(slugify("!!!"), "game");
    }
}
