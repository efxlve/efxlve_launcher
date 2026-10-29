//! Custom games management: manual game addition, metadata search, launch, and tracking.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

/// Child PIDs of custom games the launcher started, keyed by library id.
static RUNNING_PIDS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn remember_pid(id: &str, pid: u32) {
    if let Ok(mut lock) = RUNNING_PIDS.lock() {
        lock.get_or_insert_with(HashMap::new).insert(id.to_string(), pid);
    }
}

fn forget_pid(id: &str, pid: u32) {
    if let Ok(mut lock) = RUNNING_PIDS.lock() {
        if let Some(map) = lock.as_mut() {
            if map.get(id).copied() == Some(pid) {
                map.remove(id);
            }
        }
    }
}

/// True while this launcher owns the game process; the generic process watcher
/// then leaves the start/stop event (and the playtime record) to the launch
/// thread instead of counting the session twice.
pub fn is_launcher_running(id: &str) -> bool {
    RUNNING_PIDS
        .lock()
        .ok()
        .and_then(|lock| lock.as_ref().and_then(|map| map.get(id).copied()))
        .is_some()
}

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

fn ensure_detected_steam_app_id(game: &mut CustomGame) -> bool {
    let has_app_id = game
        .steam_app_id
        .as_deref()
        .is_some_and(|id| !id.trim().is_empty());
    if has_app_id || game.exe_path.trim().is_empty() {
        return false;
    }
    if let Some(detected) = crate::steam::detect_steam_app_id_for_exe(Path::new(game.exe_path.trim())) {
        game.steam_app_id = Some(detected);
        return true;
    }
    false
}

pub fn load_custom_games(app: &AppHandle) -> Vec<CustomGame> {
    let path = custom_games_path(app);
    let mut list: Vec<CustomGame> = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    let mut dirty = false;
    for game in &mut list {
        if ensure_detected_steam_app_id(game) {
            dirty = true;
        }
    }
    if dirty {
        let _ = save_custom_games(app, &list);
    }
    list
}

pub fn save_custom_games(app: &AppHandle, list: &[CustomGame]) -> Result<(), String> {
    let path = custom_games_path(app);
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let text = serde_json::to_string_pretty(list).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())
}

/// Splits a launcher argument line, keeping quoted values together.
fn split_launch_args(input: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut current = String::new();
    let mut quote: Option<char> = None;
    for ch in input.chars() {
        match quote {
            Some(q) if ch == q => quote = None,
            Some(_) => current.push(ch),
            None if ch == '"' || ch == '\'' => quote = Some(ch),
            None if ch.is_whitespace() => {
                if !current.is_empty() {
                    out.push(std::mem::take(&mut current));
                }
            }
            None => current.push(ch),
        }
    }
    if !current.is_empty() {
        out.push(current);
    }
    out
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
    let _ = ensure_detected_steam_app_id(&mut game);

    list.retain(|g| g.id != game.id);
    list.push(game.clone());
    save_custom_games(&app, &list)?;

    Ok(game)
}

#[tauri::command]
pub fn custom_games_edit(app: AppHandle, mut game: CustomGame) -> Result<CustomGame, String> {
    if game.id.is_empty() {
        return Err("Invalid game ID".into());
    }
    let _ = ensure_detected_steam_app_id(&mut game);
    let mut list = load_custom_games(&app);
    let index = list
        .iter()
        .position(|g| g.id == game.id || g.id.strip_prefix("custom::") == Some(&game.id))
        .ok_or("Game not found")?;
    list[index] = game.clone();
    save_custom_games(&app, &list)?;
    Ok(game)
}

#[tauri::command]
pub fn custom_games_remove(app: AppHandle, id: String) -> Result<(), String> {
    let mut list = load_custom_games(&app);
    list.retain(|g| g.id != id && g.id.strip_prefix("custom::") != Some(&id));
    save_custom_games(&app, &list)?;
    Ok(())
}

#[tauri::command]
pub async fn custom_games_launch(app: AppHandle, id: String) -> Result<(), String> {
    let games = load_custom_games(&app);
    let game = games
        .into_iter()
        .find(|g| g.id == id || g.id.strip_prefix("custom::") == Some(&id))
        .ok_or("Game not found")?;

    if game.exe_path.trim().is_empty() {
        return Err("No executable configured for this game".into());
    }

    let exe_path = PathBuf::from(&game.exe_path);
    if !exe_path.exists() {
        return Err(format!("Executable not found: {}", game.exe_path));
    }

    let working_dir = exe_path.parent().unwrap_or(&exe_path);
    let mut cmd = std::process::Command::new(&exe_path);
    cmd.current_dir(working_dir);

    if let Some(ref args_str) = game.launch_args {
        for arg in split_launch_args(args_str) {
            cmd.arg(arg);
        }
    }

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x00000008); // DETACHED_PROCESS
    }

    let mut child = cmd.spawn().map_err(|e| format!("Failed to launch game: {e}"))?;
    let child_pid = child.id();
    remember_pid(&game.id, child_pid);

    let app_clone = app.clone();
    let game_id = game.id.clone();
    let game_title = game.title.clone();
    let steam_app_id = game.steam_app_id.clone();
    // `id` already carries the `custom::` namespace; adding it twice made the
    // screenshot/session keys disagree with the library key.
    let app_key = game_id.clone();

    crate::legendary::screenshots::set_active_running_game(&app_key, &game_title, Some(working_dir.to_path_buf()), vec![]);

    if let Some(ref aid) = steam_app_id {
        // Emulator achievement files often sit next to the exe
        // (`steam_settings/achievements.ini`), so teach the detector that root.
        crate::steam::remember_achievement_dir(aid, working_dir);
    }

    let started = std::time::Instant::now();
    let watch_dir = working_dir.to_path_buf();
    let _ = app.emit(
        "game-status",
        serde_json::json!({ "id": app_key, "running": true }),
    );

    std::thread::spawn(move || {
        let _ = child.wait();
        let elapsed = started.elapsed().as_secs();
        // A custom entry can be a launcher/updater stub that starts the real
        // game and exits after a second. Do not report a stop while that game
        // is still running; let the folder watcher own the rest of the session.
        if elapsed < 5 {
            std::thread::sleep(std::time::Duration::from_millis(1000));
            let exes = crate::legendary::transfers::discover_game_executables(&watch_dir, None);
            if !exes.is_empty()
                && crate::legendary::transfers::is_game_process_running(Some(&watch_dir), &exes)
            {
                forget_pid(&app_key, child_pid);
                let _ = app_clone.emit("custom-games-changed", ());
                return;
            }
        }
        // The frontend starts/stops the watcher from the game-status event, so
        // both launcher and external launches use the same path.
        crate::legendary::screenshots::clear_active_running_game(&app_key);

        // Custom games have no store backend to report hours, so the launcher
        // records the session the same way it does for Epic titles.
        let record = if elapsed >= 5 {
            crate::legendary::playtime::record_session(&app_key, elapsed).ok()
        } else {
            None
        };
        let mut payload = serde_json::json!({
            "id": app_key,
            "running": false,
            "sessionSeconds": elapsed,
        });
        if let Some(record) = record {
            payload["totalSeconds"] = serde_json::json!(record.total_seconds);
            payload["sessionCount"] = serde_json::json!(record.session_count);
            payload["lastPlayed"] = serde_json::json!(record.last_played);
            payload["lastPlayedTimestamp"] = serde_json::json!(record.last_played_timestamp);
        }
        let _ = app_clone.emit("game-status", payload);
        // Release the launcher-owned marker only after the stop event so the
        // generic process watcher cannot count the same session again.
        forget_pid(&app_key, child_pid);
        let _ = app_clone.emit("custom-games-changed", ());
    });

    let _ = app.emit("custom-games-changed", ());
    Ok(())
}

/// A folder import only needs a plausible main binary per game folder: the
/// largest non-installer `.exe` two levels down. The user can fine-tune it with
/// the edit dialog afterwards.
fn best_game_exe(dir: &Path) -> Option<PathBuf> {
    const SKIP: &[&str] = &[
        "unins", "setup", "install", "vcredist", "vc_redist", "dxsetup", "dotnet",
        "crashreport", "unitycrashhandler", "unrealcefsubprocess", "eac_launcher",
        "easyanticheat", "launcher_installer", "redist", "dxwebsetup",
    ];
    let mut best: Option<(u64, PathBuf)> = None;
    let mut walk = vec![(dir.to_path_buf(), 0usize)];
    while let Some((folder, depth)) = walk.pop() {
        if depth > 2 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if depth < 2 {
                    walk.push((path, depth + 1));
                }
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !name.ends_with(".exe") || SKIP.iter().any(|marker| name.contains(marker)) {
                continue;
            }
            let size = entry.metadata().map(|meta| meta.len()).unwrap_or(0);
            if size >= 16 * 1024
                && best
                    .as_ref()
                    .map_or(true, |(best_size, _)| size > *best_size)
            {
                best = Some((size, path));
            }
        }
    }
    best.map(|(_, path)| path)
}

fn import_title(folder: &Path, exe: &Path) -> String {
    let raw = folder
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .or_else(|| exe.file_stem().and_then(|name| name.to_str()))
        .unwrap_or("Game");
    let cleaned = raw
        .replace('_', " ")
        .replace('-', " ")
        .replace('.', " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    if cleaned.is_empty() {
        "Game".to_string()
    } else {
        cleaned
    }
}

#[tauri::command]
pub fn custom_games_import_folder(
    app: AppHandle,
    path: String,
) -> Result<Vec<CustomGame>, String> {
    let root = PathBuf::from(path.trim());
    if !root.is_dir() {
        return Err("The selected folder does not exist".into());
    }
    let mut list = load_custom_games(&app);
    let mut known_paths: std::collections::HashSet<String> = list
        .iter()
        .map(|game| game.exe_path.to_lowercase())
        .collect();
    let mut known_ids: std::collections::HashSet<String> =
        list.iter().map(|game| game.id.clone()).collect();

    // A folder with an exe of its own is one game; otherwise a folder of game
    // folders is imported as one game per subfolder.
    let has_direct_exe = std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .flatten()
        .any(|entry| {
            entry.path().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
        });
    let mut subdirs: Vec<PathBuf> = std::fs::read_dir(&root)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| path.is_dir())
        .collect();
    subdirs.sort();
    // A game folder often keeps its exe in `Binaries/Win64`; a parent folder
    // holding several games has titled subfolders instead. Only the latter is
    // imported one game per child.
    const ENGINE_DIRS: &[&str] = &[
        "bin", "bin32", "bin64", "binaries", "win32", "win64", "x64", "x86",
        "engine", "system", "launcher", "retail", "game", "games",
    ];
    let has_engine_dir = subdirs.iter().any(|dir| {
        dir.file_name()
            .and_then(|name| name.to_str())
            .map(|name| ENGINE_DIRS.contains(&name.to_lowercase().as_str()))
            .unwrap_or(false)
    });
    let candidates: Vec<PathBuf> = if has_direct_exe || subdirs.is_empty() || has_engine_dir {
        vec![root.clone()]
    } else {
        subdirs
    };

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let mut imported = Vec::new();
    for folder in candidates.into_iter().take(200) {
        let Some(exe) = best_game_exe(&folder) else {
            continue;
        };
        let exe_key = exe.to_string_lossy().to_lowercase();
        if known_paths.contains(&exe_key) {
            continue;
        }
        let title = import_title(&folder, &exe);
        let slug = slugify(&title);
        let mut id = format!("custom::{slug}");
        let mut counter = 2;
        while known_ids.contains(&id) {
            id = format!("custom::{slug}-{counter}");
            counter += 1;
        }
        known_paths.insert(exe_key);
        known_ids.insert(id.clone());
        let game = CustomGame {
            id,
            title,
            exe_path: exe.to_string_lossy().to_string(),
            launch_args: None,
            cover_url: None,
            header_url: None,
            hero_url: None,
            description: None,
            developer: None,
            release_year: None,
            genres: Vec::new(),
            steam_app_id: crate::steam::detect_steam_app_id_for_exe(&exe),
            added_at: now,
        };
        list.push(game.clone());
        imported.push(game);
    }

    if !imported.is_empty() {
        save_custom_games(&app, &list)?;
    }
    Ok(imported)
}

#[tauri::command]
pub async fn custom_games_pick_folder(
    default_path: Option<String>,
    title: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(windows)]
    {
        let picker_title = title
            .unwrap_or_else(|| "Select Game Folder".to_string())
            .replace('\'', "''");
        tokio::task::spawn_blocking(move || {
            let clean_default_path = default_path.unwrap_or_default().replace('\'', "''");
            let script = format!(
                r#"[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;
Add-Type -AssemblyName System.Windows.Forms;
$f = New-Object System.Windows.Forms.FolderBrowserDialog;
$f.Description = '{picker_title}';
if ('{clean_default_path}' -ne '') {{ $f.SelectedPath = '{clean_default_path}' }};
if ($f.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {{
    Write-Output $f.SelectedPath
}}
"#
            );
            let mut cmd = std::process::Command::new("powershell");
            cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
            let output = cmd.output().map_err(|e| e.to_string())?;
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok::<Option<String>, String>(if stdout.is_empty() {
                None
            } else {
                Some(stdout)
            })
        })
        .await
        .map_err(|e| e.to_string())?
    }
    #[cfg(not(windows))]
    {
        crate::legendary::move_game::select_folder_dialog(default_path, title).await
    }
}

#[tauri::command]
pub fn custom_games_stop(app: AppHandle, id: String) -> Result<(), String> {
    let games = load_custom_games(&app);
    let game = games
        .iter()
        .find(|g| g.id == id || g.id.strip_prefix("custom::") == Some(&id))
        .ok_or("Game not found")?;
    let pid = RUNNING_PIDS
        .lock()
        .ok()
        .and_then(|lock| lock.as_ref().and_then(|map| map.get(&game.id).copied()))
        .ok_or("Game is not running")?;

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x08000000) // CREATE_NO_WINDOW
            .status()
            .map_err(|e| format!("Failed to stop game: {e}"))?;
        if !status.success() {
            return Err("The game process could not be stopped".into());
        }
    }
    #[cfg(not(windows))]
    {
        let status = std::process::Command::new("kill")
            .args(["-TERM", &pid.to_string()])
            .status()
            .map_err(|e| format!("Failed to stop game: {e}"))?;
        if !status.success() {
            return Err("The game process could not be stopped".into());
        }
    }

    // The launch thread owns the exit event and the session totals; ending the
    // process here is enough for that thread to report the stop.
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
        use std::process::Command;
        let picked_title = title.unwrap_or_else(|| "Select Executable".to_string());
        if cfg!(target_os = "macos") {
            let escaped = picked_title.replace('\\', "\\\\").replace('"', "\\\"");
            let script = format!("POSIX path of (choose file with prompt \"{escaped}\")");
            let output = Command::new("osascript")
                .args(["-e", &script])
                .output()
                .map_err(|error| error.to_string())?;
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            return Ok(if output.status.success() && !path.is_empty() {
                Some(path)
            } else {
                None
            });
        }

        let mut zenity = Command::new("zenity");
        zenity.args(["--file-selection", "--title", &picked_title]);
        if let Some(default) = default_path.as_deref().filter(|path| !path.is_empty()) {
            zenity.arg(format!("--filename={default}/"));
        }
        if let Ok(output) = zenity.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(Some(path));
                }
            }
        }

        let mut kdialog = Command::new("kdialog");
        kdialog.args(["--getopenfilename", "", "*"]);
        if let Some(default) = default_path.as_deref().filter(|path| !path.is_empty()) {
            kdialog.arg(default);
        }
        if let Ok(output) = kdialog.output() {
            if output.status.success() {
                let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
                if !path.is_empty() {
                    return Ok(Some(path));
                }
            }
        }
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
    let items: Vec<RawSteamSearchItem> = items.into_iter().take(12).collect();
    // The flat `cdn.akamai.steamstatic.com/steam/apps/<id>/...` paths 404 for
    // many newer titles: their art lives under a content-hash path that only
    // the store service publishes. Ask it once for the whole result list.
    let app_ids: Vec<u64> = items.iter().map(|item| item.id).collect();
    let assets = crate::steam_art::fetch_store_assets(&app_ids)
        .await
        .unwrap_or_default();
    let hits = items
        .into_iter()
        .map(|item| {
            let id = item.id;
            let art = assets.get(&id);
            let cover = art.and_then(crate::steam_art::cover_url_from_assets);
            let header = art.and_then(crate::steam_art::header_url_from_assets);
            let hero = art.and_then(crate::steam_art::hero_url_from_assets);
            SteamStoreSearchHit {
                id,
                name: item.name,
                cover_url: cover.unwrap_or_else(|| legacy_steam_cover(id)),
                header_url: header
                    .clone()
                    .or_else(|| hero.clone())
                    .unwrap_or_else(|| legacy_steam_header(id)),
                hero_url: hero
                    .or(header)
                    .unwrap_or_else(|| legacy_steam_hero(id)),
            }
        })
        .collect();

    Ok(hits)
}

/// Last resort for an app the store service does not publish assets for. The
/// flat path still answers for older titles.
fn legacy_steam_cover(app_id: u64) -> String {
    format!("https://cdn.akamai.steamstatic.com/steam/apps/{app_id}/library_600x900.jpg")
}

fn legacy_steam_header(app_id: u64) -> String {
    format!("https://cdn.akamai.steamstatic.com/steam/apps/{app_id}/header.jpg")
}

fn legacy_steam_hero(app_id: u64) -> String {
    format!("https://cdn.akamai.steamstatic.com/steam/apps/{app_id}/library_hero.jpg")
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

    #[test]
    fn launch_arguments_keep_quoted_values_together() {
        assert_eq!(
            split_launch_args(r#"-windowed -profile "C:\My Games\save" --name 'NFS UG2'"#),
            vec![
                "-windowed".to_string(),
                "-profile".to_string(),
                r#"C:\My Games\save"#.to_string(),
                "--name".to_string(),
                "NFS UG2".to_string(),
            ]
        );
        assert!(split_launch_args("   ").is_empty());
    }
}
