//! EA App, Ubisoft Connect, Xbox and Battle.net.
//!
//! The games stay inside those clients, the same way GOG Galaxy's community
//! plugins read a local catalog and hand launch back. Linking an account
//! imports that catalog (installed and, where the client cached it, owned).
//! Passwords and third-party client secrets are not stored here.

mod accounts;
pub(crate) use signin::{accept_library as accept_bnet_library, watch_script as bnet_watch_script};
mod battlenet;
mod covers;
mod ea;
mod ea_login;
mod ea_vault;
mod launch;
pub(crate) use launch::{client_installed, client_path};
mod pcsign;
mod proto;
mod riot;
mod scan;
mod signin;
mod ubi_achievements;
mod ubisoft;
mod ubisoft_login;
mod ubi_vault;
mod xbox_login;
mod xbox_vault;
pub(crate) use ubisoft_login::{accept_session as accept_ubi_session, watch_script as ubi_watch_script};
use ubisoft_login::UbiSync;

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::legendary::models::{GameAchievementSummary, GameAchievementsResponse};

pub use accounts::{CompanionAccount, CompanionStoreStatus};
pub use covers::{CoverHit, CoverQuery};
use accounts::load_accounts;
use covers::{cached_cover, load_cache};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FoundGame {
    pub store: String,
    pub id: String,
    pub name: String,
    pub install_path: String,
    pub installed: bool,
    pub store_id: String,
    pub launch_exe: String,
    pub launch_uri: String,
    /// Client protocol that opens the install prompt (empty when unknown).
    pub install_uri: String,
    /// Client protocol that removes the game (empty when unknown).
    pub uninstall_uri: String,
    /// Box art from the owned catalog (empty when the client art is used).
    pub cover_url: String,
    /// Wide art from the owned catalog (empty when the client art is used).
    pub hero_url: String,
    /// Store description from the owned catalog (empty when the client has none).
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionGame {
    pub store: String,
    pub id: String,
    pub name: String,
    pub install_path: String,
    pub installed: bool,
    pub cover_url: String,
    pub hero_url: String,
    pub store_id: String,
    pub description: String,
}

const STORES: &[&str] = &["ea", "ubisoft", "xbox", "battlenet", "riot"];

fn discover(store: &str) -> Vec<FoundGame> {
    let installed = scan::uninstall_games();
    match store {
        "ea" => {
            let mut games = ea::merged_games(&installed);
            ea_login::merge_owned(&mut games);
            games
        }
        "ubisoft" => ubisoft::merged_games(&installed),
        "xbox" => xbox_login::merged_games(&scan::xbox_games()),
        "battlenet" => battlenet::merged_games(&installed),
        "riot" => riot::games(),
        _ => Vec::new(),
    }
}

fn library_games() -> Vec<FoundGame> {
    let linked: HashSet<String> = load_accounts(&accounts::accounts_file()).into_iter().map(|a| a.store).collect();
    let mut games = Vec::new();
    let mut seen = HashSet::new();
    for store in STORES {
        // Riot's PC titles are free to play: with the client installed the
        // whole catalog belongs in the library, linked or not.
        let free_with_client = *store == "riot" && launch::client_installed("riot");
        for game in discover(store) {
            if !linked.contains(*store) && !game.installed && !free_with_client {
                continue;
            }
            let key = format!("{}::{}", game.store, game.id);
            if !seen.insert(key) {
                continue;
            }
            games.push(game);
        }
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

fn to_public(game: &FoundGame, cover: &str, hero: &str) -> CompanionGame {
    CompanionGame {
        store: game.store.clone(),
        id: game.id.clone(),
        name: game.name.clone(),
        install_path: game.install_path.clone(),
        installed: game.installed,
        cover_url: cover.to_string(),
        hero_url: hero.to_string(),
        store_id: game.store_id.clone(),
        description: game.description.clone(),
    }
}

fn with_cached_art(games: &[FoundGame]) -> Vec<CompanionGame> {
    let cache = load_cache();
    games
        .iter()
        .map(|game| {
            // The account catalog art wins over the Steam-search fallback.
            let (cached, cached_hero) = cached_cover(&cache, &game.store, &game.id);
            let cover = if game.cover_url.is_empty() { cached } else { game.cover_url.clone() };
            let hero = if game.hero_url.is_empty() { cached_hero } else { game.hero_url.clone() };
            to_public(game, &cover, &hero)
        })
        .collect()
}

fn status_rows() -> Vec<CompanionStoreStatus> {
    let accounts = load_accounts(&accounts::accounts_file());
    STORES
        .iter()
        .map(|store| {
            let saved = accounts.iter().find(|a| a.store == *store);
            let detected = accounts::detected_name(store);
            let name = saved.map(|a| a.name.clone()).filter(|n| !n.is_empty()).unwrap_or(detected);
            CompanionStoreStatus {
                store: (*store).to_string(),
                client_installed: launch::client_installed(store),
                account_name: name,
                linked: saved.is_some(),
                needs_login: saved.map(|a| a.needs_login).unwrap_or(false),
                game_count: discover(store).len() as u32,
            }
        })
        .collect()
}

/// Installed games, plus the owned catalog of every linked account.
#[tauri::command]
pub fn companion_installed_games() -> Vec<CompanionGame> {
    with_cached_art(&library_games())
}

/// Same list as `companion_installed_games`. Kept so the accounts page can ask
/// for the library by the name it uses.
#[tauri::command]
pub fn companion_library() -> Vec<CompanionGame> {
    companion_installed_games()
}

#[tauri::command]
pub fn companion_store_status() -> Vec<CompanionStoreStatus> {
    status_rows()
}

#[tauri::command]
pub fn companion_link(store: String) -> Result<CompanionAccount, String> {
    accounts::link_store(&store)
}

#[tauri::command]
pub fn companion_unlink(store: String) -> Result<(), String> {
    if store == "ubisoft" {
        ubi_vault::clear();
    }
    if store == "ea" {
        ea_vault::clear();
        ea_login::clear_session();
        ea_login::clear_owned();
    }
    if store == "xbox" {
        xbox_vault::clear();
        xbox_login::clear_session();
        xbox_login::clear_owned();
    }
    accounts::unlink_store(&store)
}

/// One background refresh result for a companion account.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionSyncReport {
    pub updated: bool,
    pub count: u32,
    pub needs_login: bool,
}

/// Refreshes a linked account from its own service. Ubisoft and EA keep a
/// refreshable session; the other stores are local-only and report what the
/// disk scan found.
#[tauri::command]
pub async fn companion_sync(store: String) -> Result<CompanionSyncReport, String> {
    if !accounts::is_store(&store) {
        return Err("Unknown store".into());
    }
    if store == "ea" {
        if !accounts::is_linked("ea") {
            return Ok(CompanionSyncReport {
                updated: false,
                count: discover("ea").len() as u32,
                needs_login: false,
            });
        }
        return Ok(match ea_login::sync_owned().await {
            Ok(count) => CompanionSyncReport { updated: true, count: count as u32, needs_login: false },
            Err(message) if message == "@t:accounts.eaSessionExpired" => CompanionSyncReport {
                updated: false,
                count: 0,
                needs_login: true,
            },
            Err(message) => return Err(message),
        });
    }
    if store == "xbox" {
        if !accounts::is_linked("xbox") {
            return Ok(CompanionSyncReport {
                updated: false,
                count: discover("xbox").len() as u32,
                needs_login: false,
            });
        }
        return Ok(match xbox_login::sync_owned().await {
            Ok(count) => CompanionSyncReport { updated: true, count: count as u32, needs_login: false },
            Err(message) if message == "@t:accounts.xboxSessionExpired" => CompanionSyncReport {
                updated: false,
                count: 0,
                needs_login: true,
            },
            Err(message) => return Err(message),
        });
    }
    if store != "ubisoft" {
        return Ok(CompanionSyncReport {
            updated: false,
            count: discover(&store).len() as u32,
            needs_login: false,
        });
    }
    Ok(match ubisoft_login::sync_owned().await {
        UbiSync::Updated(count) => CompanionSyncReport { updated: true, count: count as u32, needs_login: false },
        UbiSync::Unchanged(count) => CompanionSyncReport { updated: false, count: count as u32, needs_login: false },
        UbiSync::NoSession => {
            // A linked account with no sealed session (linked before this
            // existed): ask for one sign-in so auto-sync can take over.
            let linked = accounts::is_linked("ubisoft");
            if linked {
                let _ = accounts::mark_needs_login("ubisoft", true);
            }
            CompanionSyncReport { updated: false, count: 0, needs_login: linked }
        }
        UbiSync::AuthLost => {
            let _ = accounts::mark_needs_login("ubisoft", true);
            CompanionSyncReport { updated: false, count: 0, needs_login: true }
        }
        UbiSync::Failed(err) => return Err(err),
    })
}

/// Refreshes linked companion stores while the launcher runs. A game bought on
/// another machine then shows up without touching the Accounts page.
pub fn start_ubi_sync(app: tauri::AppHandle) {
    use tauri::Emitter;
    tauri::async_runtime::spawn(async move {
        // The frontend syncs once at boot; this timer keeps a long session
        // fresh without jumping the user anywhere.
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15 * 60)).await;
            if !accounts::is_linked("ubisoft") {
                continue;
            }
            match ubisoft_login::sync_owned().await {
                UbiSync::Updated(_) => {
                    let _ = app.emit("companion-store-changed", "ubisoft");
                }
                UbiSync::AuthLost => {
                    let _ = accounts::mark_needs_login("ubisoft", true);
                    let _ = app.emit("companion-signin-failed", "@t:accounts.ubiSessionExpired");
                    let _ = app.emit("companion-store-changed", "ubisoft");
                }
                _ => {}
            }
        }
    });
}

#[tauri::command]
pub async fn companion_resolve_covers(queries: Vec<CoverQuery>) -> Vec<CoverHit> {
    covers::resolve_covers(queries).await
}

#[tauri::command]
pub async fn companion_show_login(app: tauri::AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    signin::show_login(app, x, y, width, height).await
}

#[tauri::command]
pub fn companion_hide_login(app: tauri::AppHandle) {
    signin::hide_login(&app);
}

/// Opens the EA sign-in window (PKCE + PC signature) over the main window.
#[tauri::command]
pub async fn ea_login_open(app: tauri::AppHandle) -> Result<(), String> {
    ea_login::open_login(app).await
}

#[tauri::command]
pub fn ea_login_hide(app: tauri::AppHandle) {
    ea_login::hide_login(&app);
}

/// Opens the Microsoft sign-in window for the Xbox account.
#[tauri::command]
pub async fn xbox_login_open(app: tauri::AppHandle) -> Result<(), String> {
    xbox_login::open_login(app).await
}

#[tauri::command]
pub fn xbox_login_hide(app: tauri::AppHandle) {
    xbox_login::hide_login(&app);
}

#[tauri::command]
pub fn companion_open_client(store: String) -> Result<(), String> {
    launch::open_client(&store)
}

#[tauri::command]
pub fn companion_launch(app: tauri::AppHandle, store: String, id: String) -> Result<(), String> {
    if !accounts::is_store(&store) || id.is_empty() {
        return Err("Unknown game".into());
    }
    let Some(game) = discover(&store).into_iter().find(|g| g.id == id) else {
        return launch::open_client(&store);
    };
    // The screenshot hotkey needs to know which game is on screen. The install
    // folder is enough to match the process; client protocols do not expose the
    // executable name. Ubisoft Connect has its own F12 screenshot tool, so only
    // its close-after-play watcher is worth spawning.
    let install_path = std::path::Path::new(&game.install_path)
        .is_dir()
        .then(|| std::path::PathBuf::from(&game.install_path));
    if game.store != "ubisoft" {
        let app_name = format!("{}::{}", game.store, game.id);
        crate::legendary::screenshots::set_active_running_game(
            &app_name,
            &game.name,
            install_path.clone(),
            Vec::new(),
        );
        watch_companion_exit(app, Some(app_name), game.store.clone(), install_path);
    } else if close_after_play_enabled("ubisoft") {
        watch_companion_exit(app, None, game.store.clone(), install_path);
    }
    // Riot hands every action to RiotClientServices.exe with a product flag.
    if store == "riot" {
        return match riot::action_command(&id, "launch") {
            Some((exe, args)) => launch::run_command(&exe, &args),
            None => launch::open_client(&store),
        };
    }
    if !game.launch_uri.is_empty() || !game.launch_exe.is_empty() {
        return launch::open_game(&game.launch_uri, &game.launch_exe);
    }
    launch::open_client(&store)
}

/* ---------- Locally tracked companion playtime ---------- */

fn playtime_cache_path() -> std::path::PathBuf {
    accounts::data_dir().join("companion_playtime.json")
}

fn load_local_playtimes() -> std::collections::HashMap<String, u64> {
    let Ok(text) = std::fs::read_to_string(playtime_cache_path()) else {
        return std::collections::HashMap::new();
    };
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    value
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(key, row)| Some((key.clone(), row.as_u64()?)))
                .collect()
        })
        .unwrap_or_default()
}

/// Adds one finished session to the local companion playtime cache.
fn add_local_playtime(app_name: &str, seconds: u64) {
    if seconds == 0 {
        return;
    }
    let mut map = load_local_playtimes();
    let entry = map.entry(app_name.to_string()).or_insert(0);
    *entry = entry.saturating_add(seconds);
    let path = playtime_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let value = serde_json::Value::Object(
        map.into_iter()
            .map(|(key, seconds)| (key, serde_json::Value::from(seconds)))
            .collect(),
    );
    if let Ok(text) = serde_json::to_string(&value) {
        let _ = std::fs::write(path, text);
    }
}

/* ---------- Per-client behavior (close after playing) ---------- */

/// Client behavior toggles from the Integrations page, stored beside the
/// playtime cache. A store that is absent means "off".
#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompanionClientSettings {
    #[serde(default)]
    pub close_after_play: std::collections::HashMap<String, bool>,
}

fn client_settings_path() -> std::path::PathBuf {
    accounts::data_dir().join("companion_settings.json")
}

fn load_client_settings() -> CompanionClientSettings {
    std::fs::read_to_string(client_settings_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn close_after_play_enabled(store: &str) -> bool {
    load_client_settings()
        .close_after_play
        .get(store)
        .copied()
        .unwrap_or(false)
}

/// Quits a store client by image name. The clients expose no quit command, so
/// this is a forced tree kill; it only runs when the user opted in.
fn close_client(store: &str) {
    let images: &[&str] = match store {
        "ea" => &["EADesktop.exe"],
        "ubisoft" => &["UbisoftConnect.exe"],
        "battlenet" => &["Battle.net.exe"],
        "riot" => &["RiotClientServices.exe", "RiotClient.exe"],
        _ => return,
    };
    for image in images {
        let mut cmd = std::process::Command::new("taskkill");
        cmd.args(["/IM", image, "/T", "/F"]);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        let _ = cmd.spawn();
    }
}

fn close_client_if_enabled(store: &str) {
    if close_after_play_enabled(store) {
        close_client(store);
    }
}

/// Client behavior toggles for the Integrations page.
#[tauri::command]
pub fn companion_get_client_settings() -> CompanionClientSettings {
    load_client_settings()
}

#[tauri::command]
pub fn companion_set_close_after_play(store: String, enabled: bool) -> Result<(), String> {
    if !accounts::is_store(&store) {
        return Err("Unknown store".into());
    }
    let mut settings = load_client_settings();
    if enabled {
        settings.close_after_play.insert(store, true);
    } else {
        settings.close_after_play.remove(&store);
    }
    let path = client_settings_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(&settings) {
        let _ = std::fs::write(path, text);
    }
    Ok(())
}

/// Clears the screenshot hotkey's active game once the process exits, adds the
/// session to the locally tracked playtime, and quits the client when the user
/// asked for it. The client protocol returns before the game window exists, so
/// the watcher waits for a process first, then for it to disappear. Riot and
/// Battle.net can spend minutes updating before the game window appears, hence
/// the long grace. `app_name` is `None` for stores whose screenshot tool stays
/// the client's own (Ubisoft).
fn watch_companion_exit(
    app: tauri::AppHandle,
    app_name: Option<String>,
    store: String,
    install_path: Option<std::path::PathBuf>,
) {
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let started = std::time::Instant::now();
        let mut detected_at: Option<std::time::Instant> = None;
        let mut missing = 0u32;
        loop {
            if crate::legendary::transfers::is_game_process_running(install_path.as_deref(), &[]) {
                detected_at.get_or_insert_with(std::time::Instant::now);
                missing = 0;
            } else if detected_at.is_some() {
                missing += 1;
                if missing >= 3 {
                    break;
                }
            } else if started.elapsed() > std::time::Duration::from_secs(300) {
                // The client only opened an install prompt; nothing to watch.
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        if let Some(app_name) = &app_name {
            crate::legendary::screenshots::clear_active_running_game(app_name);
        }
        if let Some(detected) = detected_at {
            // Opt-in: quit the store client now that its game has closed.
            close_client_if_enabled(&store);
            if let Some(app_name) = &app_name {
                let seconds = detected.elapsed().as_secs();
                if seconds >= 5 {
                    add_local_playtime(app_name, seconds);
                    // The cards and the open page re-read the cache.
                    let _ = app.emit("companion-store-changed", store);
                }
            }
        }
    });
}

/// Playtime rows keyed by library id. Ubisoft and EA report it through their
/// services; the other clients have no playtime API, so the sessions this
/// launcher started are summed from the local cache.
#[tauri::command]
pub async fn companion_playtimes(store: String) -> Vec<ubisoft_login::PlaytimeRow> {
    if store == "ubisoft" {
        return ubisoft_login::playtimes().await;
    }
    if store == "ea" {
        return ea_playtimes().await;
    }
    if store == "xbox" {
        return xbox_playtimes().await;
    }
    let prefix = format!("{store}::");
    load_local_playtimes()
        .into_iter()
        .filter_map(|(key, seconds)| {
            key.strip_prefix(&prefix)
                .map(|id| ubisoft_login::PlaytimeRow {
                    id: id.to_string(),
                    total_seconds: seconds,
                })
        })
        .collect()
}

/// EA's own totals, with the locally tracked sessions as the fallback. The
/// service works in game slugs; the id the UI uses depends on whether the
/// game is installed, so the merged library is consulted for the row id.
async fn ea_playtimes() -> Vec<ubisoft_login::PlaytimeRow> {
    let mut totals: std::collections::HashMap<String, u64> = load_local_playtimes()
        .into_iter()
        .filter_map(|(key, seconds)| key.strip_prefix("ea::").map(|id| (id.to_string(), seconds)))
        .collect();
    if accounts::is_linked("ea") {
        if let Ok(access) = ea_login::ensure_access().await {
            if let Ok(api_rows) = ea_login::fetch_playtimes(&access).await {
                let games = discover("ea");
                for (slug, seconds) in api_rows {
                    let Some(owned) = ea_login::owned_for_slug(&slug) else {
                        continue;
                    };
                    let title = ea::normalize_title(&owned.name);
                    let id = games
                        .iter()
                        .find(|game| {
                            game.id == owned.id
                                || (!owned.content_id.is_empty()
                                    && game.store_id.split(',').any(|part| part.trim() == owned.content_id))
                                || (!title.is_empty() && ea::normalize_title(&game.name) == title)
                        })
                        .map(|game| game.id.clone())
                        .unwrap_or_else(|| owned.id.clone());
                    let entry = totals.entry(id).or_insert(0);
                    *entry = (*entry).max(seconds);
                }
            }
        }
    }
    let mut rows: Vec<ubisoft_login::PlaytimeRow> = totals
        .into_iter()
        .map(|(id, total_seconds)| ubisoft_login::PlaytimeRow { id, total_seconds })
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

/// Xbox's own totals, with the locally tracked sessions as the fallback. The
/// service works in title ids; the library id depends on whether the game came
/// from the local scan, so the merged library is consulted for the row id.
async fn xbox_playtimes() -> Vec<ubisoft_login::PlaytimeRow> {
    let mut totals: std::collections::HashMap<String, u64> = load_local_playtimes()
        .into_iter()
        .filter_map(|(key, seconds)| key.strip_prefix("xbox::").map(|id| (id.to_string(), seconds)))
        .collect();
    if accounts::is_linked("xbox") {
        if let Ok(api_rows) = xbox_login::fetch_playtimes().await {
            let games = discover("xbox");
            for (title_id, seconds) in api_rows {
                let Some(owned) = xbox_login::owned_for_title(&title_id) else {
                    continue;
                };
                let title = ea::normalize_title(&owned.name);
                let id = games
                    .iter()
                    .find(|game| {
                        (!owned.pfn.is_empty() && game.id.eq_ignore_ascii_case(&owned.pfn))
                            || game.id == owned.title_id
                            || (!title.is_empty() && ea::normalize_title(&game.name) == title)
                    })
                    .map(|game| game.id.clone())
                    .unwrap_or_else(|| owned.pfn.clone());
                if id.is_empty() {
                    continue;
                }
                let entry = totals.entry(id).or_insert(0);
                *entry = (*entry).max(seconds);
            }
        }
    }
    let mut rows: Vec<ubisoft_login::PlaytimeRow> = totals
        .into_iter()
        .map(|(id, total_seconds)| ubisoft_login::PlaytimeRow { id, total_seconds })
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));
    rows
}

/// Achievements the store's own service reports. Ubisoft's client cache needs
/// no session; EA reads the achievement set of the owned offer with the sealed
/// account session. The id is the library card id, `title` the fallback
/// matcher for installed rows that kept their own id.
#[tauri::command]
pub async fn companion_achievements(
    store: String,
    id: String,
    title: Option<String>,
    language: Option<String>,
) -> GameAchievementsResponse {
    if store == "ea" {
        return ea_login::achievements(&id, title.as_deref().unwrap_or("")).await;
    }
    if store == "xbox" {
        let Some(title_id) = xbox_login::title_id_for(&id, title.as_deref().unwrap_or("")) else {
            return GameAchievementsResponse::default();
        };
        return xbox_login::achievements(&title_id).await;
    }
    if store != "ubisoft" {
        return GameAchievementsResponse::default();
    }
    ubi_achievements::achievements_for(
        &id,
        title.as_deref().unwrap_or(""),
        language.as_deref().unwrap_or("en"),
    )
}

/// Bulk achievement summaries for a store that keeps them on disk. Ubisoft
/// writes every game's set into the client's own cache, so one pass over the
/// library is cheap and offline. Xbox and EA answer per game over the network,
/// so those stay on their game pages.
#[tauri::command]
pub async fn companion_achievements_summary(
    store: String,
    language: Option<String>,
) -> std::collections::HashMap<String, GameAchievementSummary> {
    if store != "ubisoft" {
        return std::collections::HashMap::new();
    }
    let language = language.unwrap_or_else(|| "en".to_string());
    tokio::task::spawn_blocking(move || {
        let mut rows = std::collections::HashMap::new();
        for game in library_games() {
            if game.store != "ubisoft" {
                continue;
            }
            let response = ubi_achievements::achievements_for(&game.id, &game.name, &language);
            if response.total_achievements == 0 {
                continue;
            }
            let key = format!("ubisoft::{}", game.id);
            rows.insert(
                key.clone(),
                GameAchievementSummary {
                    app_name: key,
                    user_unlocked: response.user_unlocked,
                    total_achievements: response.total_achievements,
                    user_xp: response.user_xp,
                    total_xp: response.total_xp,
                    is_platinum: response.is_platinum,
                    supported: true,
                    ..Default::default()
                },
            );
        }
        rows
    })
    .await
    .unwrap_or_default()
}

/// Install, uninstall or launch a companion game. Install and uninstall use the
/// client's own protocol handlers or tools: the client does the work, the
/// launcher only starts it. A game without a known id falls back to opening the
/// client.
#[tauri::command]
pub fn companion_game_action(store: String, id: String, action: String) -> Result<(), String> {
    if !accounts::is_store(&store) || id.is_empty() {
        return Err("Unknown game".into());
    }
    let Some(game) = discover(&store).into_iter().find(|g| g.id == id) else {
        return Err("Unknown game".into());
    };
    // Riot: launch, install and uninstall are product flags on the client exe.
    if store == "riot" {
        return match riot::action_command(&game.id, &action) {
            Some((exe, args)) => launch::run_command(&exe, &args),
            None => launch::open_client(&store),
        };
    }
    match action.as_str() {
        // EA has no headless uninstaller: the EA app's library owns the flow.
        "uninstall" if store == "ea" => launch::open_client(&store),
        // Battle.net ships an official headless uninstaller in the agent folder.
        "uninstall" if store == "battlenet" => {
            match battlenet::uninstall_command(&game.id, &game.name) {
                Some((exe, args)) => launch::run_command(&exe, &args),
                None => launch::open_client(&store),
            }
        }
        "install" if !game.install_uri.is_empty() => launch::open_game(&game.install_uri, ""),
        "uninstall" if !game.uninstall_uri.is_empty() => launch::open_game(&game.uninstall_uri, ""),
        "launch" if !game.launch_uri.is_empty() || !game.launch_exe.is_empty() => {
            launch::open_game(&game.launch_uri, &game.launch_exe)
        }
        // No install protocol: open the client on the product's own page, where
        // it offers install or uninstall.
        "install" | "uninstall" if !game.launch_uri.is_empty() => launch::open_game(&game.launch_uri, ""),
        _ => launch::open_client(&store),
    }
}
