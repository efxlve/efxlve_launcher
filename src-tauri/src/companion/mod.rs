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
mod ea_content;
mod ea_direct;
mod ea_install;
mod ea_license;
mod ea_login;
mod ea_lsx;
mod ea_machine;
mod ea_vault;
mod launch;
pub(crate) use launch::{client_installed, client_path};
pub(crate) use ubi_direct::save_path_for_product as ubi_save_path_for_product;
mod pcsign;
mod proto;
mod riot;
mod scan;
mod signin;
mod ubi_achievements;
mod ubi_direct;
mod ubi_installs;
mod ubisoft;
mod ubisoft_login;
mod ubi_vault;
mod xbox_catalog;
mod xbox_deploy;
mod xbox_installed;
mod xbox_login;
mod xbox_vault;
pub(crate) use ubisoft_login::{accept_session as accept_ubi_session, watch_script as ubi_watch_script};
use ubisoft_login::UbiSync;

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::legendary::models::{GameAchievementSummary, GameAchievementsResponse};

pub use accounts::{CompanionAccount, CompanionStoreStatus};
pub use covers::{CoverHit, CoverQuery};
use accounts::load_accounts;
use covers::{cached_art, load_cache};

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

/// A headless EA LSX capture for support and field tests.
///
/// It starts the listener, launches Mirror's Edge Catalyst through the direct
/// path and keeps the process alive so the game can connect. Run it elevated
/// when the EA background service has to be stopped first.
pub(crate) fn ea_lsx_test() {
    let path = r"C:\Program Files (x86)\Steam\steamapps\common\Mirrors Edge Catalyst";
    let content_id = "1026480";
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("EA LSX test runtime");
    let result = runtime.block_on(ea_direct::launch_path(path, content_id));
    println!("EA LSX launch: {result:?}");
    std::thread::sleep(std::time::Duration::from_secs(60));
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
    /// Studio resolved from the store page or the client's own catalog.
    pub developer: String,
    /// True while the owning client is downloading this game (Ubisoft writes a
    /// `uplay_download` folder before the files are complete).
    pub downloading: bool,
    /// Bytes already written under that `uplay_download` folder. Zero when the
    /// client has not written any content yet.
    pub download_bytes: u64,
    /// Total transfer size; zero until the client exposes it.
    pub download_total: u64,
    /// Bulk achievement progress from the account's own service (Xbox title
    /// history today). Zero when the store only answers per game.
    pub achievements_unlocked: u32,
    pub achievements_total: u32,
    pub achievements_xp: u32,
    pub achievements_total_xp: u32,
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
        "xbox" => xbox_login::merged_games(&xbox_installed::installed_games()),
        "battlenet" => battlenet::merged_games(&installed),
        "riot" => riot::games(),
        _ => Vec::new(),
    }
}

fn library_games() -> Vec<FoundGame> {
    let linked: HashSet<String> = load_accounts(&accounts::accounts_file()).into_iter().map(|a| a.store).collect();
    let played = load_local_playtimes();
    let mut games = Vec::new();
    let mut seen = HashSet::new();
    for store in STORES {
        let riot = *store == "riot";
        for game in visible_games(store, discover(store), &played) {
            // Riot's free catalog is already down to the installed or played
            // titles; the other stores need a link or an install.
            if !riot && !linked.contains(*store) && !game.installed {
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

/// Games a store should report as present. Riot's catalog is free to play, so
/// `discover` always returns its four titles; only the ones the player
/// installed or has already played count as their games.
fn visible_games(
    store: &str,
    discovered: Vec<FoundGame>,
    played: &std::collections::HashMap<String, u64>,
) -> Vec<FoundGame> {
    if store != "riot" {
        return discovered;
    }
    discovered
        .into_iter()
        .filter(|game| {
            game.installed || played.contains_key(&format!("{}::{}", game.store, game.id))
        })
        .collect()
}

fn to_public(game: &FoundGame, cover: &str, hero: &str, developer: &str) -> CompanionGame {
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
        developer: developer.to_string(),
        downloading: game.store == "ubisoft" && ubisoft::connect_downloading(&game.name),
        download_bytes: if game.store == "ubisoft" {
            ubisoft::connect_download_state(&game.name).unwrap_or(0)
        } else {
            0
        },
        download_total: 0,
        achievements_unlocked: 0,
        achievements_total: 0,
        achievements_xp: 0,
        achievements_total_xp: 0,
    }
}

/// Bulk progress row from the Xbox title history behind one library game.
fn xbox_progress<'a>(game: &FoundGame, owned: &'a [xbox_login::OwnedGame]) -> Option<&'a xbox_login::OwnedGame> {
    if game.store != "xbox" {
        return None;
    }
    if let Some(row) = owned
        .iter()
        .find(|row| !row.pfn.is_empty() && row.pfn.eq_ignore_ascii_case(&game.id))
    {
        return Some(row);
    }
    let wanted = ea::normalize_title(&game.name);
    if wanted.is_empty() {
        return None;
    }
    owned.iter().find(|row| ea::normalize_title(&row.name) == wanted)
}

fn with_cached_art(games: &[FoundGame]) -> Vec<CompanionGame> {
    let cache = load_cache();
    // The account's own title history already carries per-game achievement
    // progress and gamerscore; attach it here so the profile needs no network
    // round trip per game.
    let xbox_owned = xbox_login::cached_owned();
    games
        .iter()
        .map(|game| {
            // The account catalog art wins over the Steam-search fallback.
            let art = cached_art(&cache, &game.store, &game.id);
            let cover = if game.cover_url.is_empty() { art.cover } else { game.cover_url.clone() };
            let hero = if game.hero_url.is_empty() { art.hero } else { game.hero_url.clone() };
            let mut public = to_public(game, &cover, &hero, &art.developer);
            if let Some(row) = xbox_progress(game, &xbox_owned) {
                public.achievements_unlocked = row.achievement_current;
                public.achievements_total = row.achievement_total;
                public.achievements_xp = row.gamerscore;
                public.achievements_total_xp = row.total_gamerscore;
            }
            public
        })
        .collect()
}

/// Games a store should report as present. Riot's catalog is free to play, so
/// `discover` always returns its four titles; they are only the player's games
/// once installed or actually played.
fn status_rows() -> Vec<CompanionStoreStatus> {
    let accounts = load_accounts(&accounts::accounts_file());
    STORES
        .iter()
        .map(|store| {
            let saved = accounts.iter().find(|a| a.store == *store);
            let detected = accounts::detected_name(store);
            let name = saved.map(|a| a.name.clone()).filter(|n| !n.is_empty()).unwrap_or(detected);
            let linked = saved.is_some();
            let client_installed = launch::client_installed(store);
            CompanionStoreStatus {
                store: (*store).to_string(),
                client_installed,
                account_name: name,
                linked,
                needs_login: saved.map(|a| a.needs_login).unwrap_or(false),
                game_count: visible_games(store, discover(store), &load_local_playtimes()).len() as u32,
            }
        })
        .collect()
}

/// Installed games, plus the owned catalog of every linked account.
#[tauri::command]
pub async fn companion_installed_games() -> Vec<CompanionGame> {
    // Walks every store's catalogs and install folders; a sync command would
    // run this on the main thread and freeze the window.
    tokio::task::spawn_blocking(companion_games_sync)
        .await
        .unwrap_or_default()
}

/// Same list as `companion_installed_games`. Kept so the accounts page can ask
/// for the library by the name it uses.
#[tauri::command]
pub async fn companion_library() -> Vec<CompanionGame> {
    let timer = crate::perf::Timer::start("rust:companion_library");
    let games = tokio::task::spawn_blocking(companion_games_sync)
        .await
        .unwrap_or_default();
    timer.done_global();
    games
}

fn companion_games_sync() -> Vec<CompanionGame> {
    let t_library = std::time::Instant::now();
    let games = library_games();
    crate::perf::write_line_global(&format!(
        "{:>6} ms  rust:companion/library_games",
        t_library.elapsed().as_millis()
    ));
    let t_art = std::time::Instant::now();
    let result = with_cached_art(&games);
    crate::perf::write_line_global(&format!(
        "{:>6} ms  rust:companion/art",
        t_art.elapsed().as_millis()
    ));
    result
}

#[tauri::command]
pub async fn companion_store_status() -> Vec<CompanionStoreStatus> {
    tokio::task::spawn_blocking(status_rows)
        .await
        .unwrap_or_default()
}

#[tauri::command]
pub fn companion_link(store: String) -> Result<CompanionAccount, String> {
    clear_achievement_cache();
    accounts::link_store(&store)
}

#[tauri::command]
pub fn companion_unlink(store: String) -> Result<(), String> {
    clear_achievement_cache();
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
pub async fn companion_launch(app: tauri::AppHandle, store: String, id: String) -> Result<(), String> {
    if !accounts::is_store(&store) || id.is_empty() {
        return Err("Unknown game".into());
    }
    let Some(game) = discover(&store).into_iter().find(|g| g.id == id) else {
        return launch::open_client(&store);
    };
    let direct = game.store == "ea" && crate::load_settings(&app).ea_direct_launch.unwrap_or(false);
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
        watch_companion_exit(app.clone(), Some(app_name), game.store.clone(), install_path);
    } else if close_after_play_enabled("ubisoft") {
        watch_companion_exit(app.clone(), None, game.store.clone(), install_path);
    }
    // Riot hands every action to RiotClientServices.exe with a product flag.
    if store == "riot" {
        return match riot::action_command(&id, "launch") {
            Some((exe, args)) => launch::run_command(&exe, &args),
            None => launch::open_client(&store),
        };
    }
    // The opt-in EA path reads the game's own installer manifest and starts it
    // with the account token. The watcher above already covers the session; a
    // missing fact falls back to the client handoff below.
    if direct {
        match ea_direct::launch(&game).await {
            Ok(_) => return Ok(()),
            Err(err) => ea_direct::remember_error(&err),
        }
    }
    // A game the launcher installed from Ubisoft's CDN has its own executable
    // and no client protocol. Start it directly; the client stays out of the
    // path.
    if store == "ubisoft" && !game.install_path.is_empty() {
        if let Some(installed) = ubi_installs::load()
            .into_iter()
            .find(|row| row.install_dir.eq_ignore_ascii_case(&game.install_path))
        {
            let shim = crate::load_settings(&app).ubi_direct_shim.unwrap_or(true);
            let launched = ubi_direct::launch_game(installed.product_id, shim).await;
            if launched.is_ok() {
                schedule_update_check(&app, installed.product_id);
            }
            return launched;
        }
    }
    if store == "ubisoft" && game.launch_uri.is_empty() && game.launch_exe.is_empty() {
        // A client-installed row carries the product id but no launch protocol.
        // Use it first; the Demux lookup below is only for rows without one.
        if let Ok(id) = game.store_id.parse::<u32>() {
            if id > 0 {
                return launch::open_game(&format!("uplay://launch/{id}/0"), "");
            }
        }
        if let Some(uri) = ubisoft_uri_for("launch", &game.name).await {
            return launch::open_game(&uri, "");
        }
    }
    if !game.launch_uri.is_empty() || !game.launch_exe.is_empty() {
        return launch::open_game(&game.launch_uri, &game.launch_exe);
    }
    launch::open_client(&store)
}

/// Native Ubisoft probe: owned base games and their manifest ids straight from
/// Demux, with no Ubisoft Connect process involved. This is the first step of
/// the direct install path; it changes nothing on disk.
#[tauri::command]
pub async fn ubi_direct_probe() -> Result<ubi_direct::UbiDirectProbe, String> {
    ubi_direct::probe().await
}

/// Read an owned product's manifest and return the install size and slice
/// layout. This is the confirmation step before a direct install.
#[tauri::command]
pub async fn ubi_direct_plan(
    product_id: u32,
    path: Option<String>,
) -> Result<ubi_direct::install::InstallPlan, String> {
    let dir = path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| ubi_direct::install::default_install_dir(product_id));
    ubi_direct::plan_game(product_id, dir).await
}

/// A direct install has no client auto-updater: check after the game is already
/// starting, so a slow CDN response never delays the launch.
pub(crate) fn schedule_update_check(app: &tauri::AppHandle, product_id: u32) {
    // Launches can repeat quickly while a user tests a title; a half-hour
    // throttle keeps the ownership service out of the startup path.
    static LAST_CHECK: std::sync::Mutex<Option<std::collections::HashMap<u32, std::time::Instant>>> =
        std::sync::Mutex::new(None);
    if let Ok(mut lock) = LAST_CHECK.lock() {
        let checks = lock.get_or_insert_with(std::collections::HashMap::new);
        if checks
            .get(&product_id)
            .map(|last| last.elapsed() < std::time::Duration::from_secs(30 * 60))
            .unwrap_or(false)
        {
            return;
        }
        checks.insert(product_id, std::time::Instant::now());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        if let Ok(check) = ubi_direct::check_update(product_id).await {
            if check.update {
                let name = ubi_installs::find(product_id)
                    .map(|game| game.name)
                    .unwrap_or_default();
                let _ = handle.emit(
                    "ubi-direct-update",
                    serde_json::json!({ "productId": product_id, "name": name }),
                );
            }
        }
    });
}

/// Start a game the launcher installed, without Ubisoft Connect.
#[tauri::command]
pub async fn ubi_direct_launch(app: tauri::AppHandle, product_id: u32) -> Result<(), String> {
    let shim = crate::load_settings(&app).ubi_direct_shim.unwrap_or(true);
    let launched = ubi_direct::launch_game(product_id, shim).await;
    if launched.is_ok() {
        schedule_update_check(&app, product_id);
    }
    launched
}

/// Forget a direct-install record without touching the game files.
#[tauri::command]
pub fn ubi_direct_forget(product_id: u32) {
    ubi_installs::remove(product_id);
}

/// Remove a direct install and optionally its folder.
#[tauri::command]
pub fn ubi_direct_uninstall(product_id: u32, delete_files: bool) -> Result<(), String> {
    ubi_direct::uninstall_game(product_id, delete_files)
}

/// Ask a running direct install to stop; the partial file is kept for resume.
#[tauri::command]
pub fn ubi_direct_cancel(product_id: u32) {
    ubi_direct::cancel_game(product_id);
}

/// Check a direct install against its manifest; with `repair`, re-download the
/// files that fail the slice hashes.
#[tauri::command]
pub async fn ubi_direct_verify(
    app: tauri::AppHandle,
    install_path: String,
    repair: bool,
) -> Result<ubi_direct::verify::VerifyReport, String> {
    let record = ubi_installs::load()
        .into_iter()
        .find(|record| record.install_dir.eq_ignore_ascii_case(&install_path))
        .ok_or_else(|| "this folder is not a direct install".to_string())?;
    ubi_direct::verify_game(app, record.product_id, repair).await
}

/// Whether this direct install hands its launch to Ubisoft Connect; `None`
/// when the folder is managed by the client instead of a direct install.
#[tauri::command]
pub fn ubi_direct_launch_mode(install_path: String) -> Option<bool> {
    ubi_installs::load()
        .into_iter()
        .find(|record| record.install_dir.eq_ignore_ascii_case(&install_path))
        .map(|record| record.client_launch)
}

/// Where this Ubisoft title keeps its saves, or `None` when no shim, client or
/// documents folder exists yet.
#[tauri::command]
pub fn ubi_save_path(
    product_id: u32,
    install_path: Option<String>,
    title: Option<String>,
) -> Option<String> {
    let install = install_path.map(std::path::PathBuf::from);
    ubi_direct::save_path(product_id, install.as_deref(), title.as_deref())
        .map(|path| path.to_string_lossy().to_string())
}

/// Opens the resolved save folder in the system file manager.
#[tauri::command]
pub fn ubi_open_saves(
    product_id: u32,
    install_path: Option<String>,
    title: Option<String>,
) -> Result<(), String> {
    let install = install_path.map(std::path::PathBuf::from);
    let path = ubi_direct::save_path(product_id, install.as_deref(), title.as_deref())
        .ok_or_else(|| "@t:manage.ubiNoSaveFolder".to_string())?;
    crate::open_in_file_manager(&path)
}

/// Compare the installed build with the current Ubisoft CDN manifest.
#[tauri::command]
pub async fn ubi_direct_update_check(
    install_path: String,
) -> Result<ubi_direct::UpdateCheck, String> {
    let record = ubi_installs::load()
        .into_iter()
        .find(|record| record.install_dir.eq_ignore_ascii_case(&install_path))
        .ok_or_else(|| "this folder is not a direct install".to_string())?;
    ubi_direct::check_update(record.product_id).await
}

/// Adopt an install Ubisoft Connect created, without re-downloading it.
#[tauri::command]
pub async fn ubi_direct_adopt(
    product_id: u32,
    install_path: String,
    title: Option<String>,
) -> Result<ubi_direct::AdoptedInstall, String> {
    ubi_direct::adopt_game(
        product_id,
        std::path::Path::new(&install_path),
        title.as_deref(),
    )
    .await
}

/// Hand an adopted install back to Ubisoft Connect and restore its loaders.
#[tauri::command]
pub fn ubi_direct_release(product_id: u32) -> Result<usize, String> {
    ubi_direct::release_game(product_id)
}

/// Copy the classic Connect save slots into a direct install on demand, for a
/// user who wants the progress before the first launch.
#[tauri::command]
pub fn ubi_direct_import_saves(install_path: String) -> Result<usize, String> {
    let record = ubi_installs::load()
        .into_iter()
        .find(|record| record.install_dir.eq_ignore_ascii_case(&install_path))
        .ok_or_else(|| "this folder is not a launcher-managed Ubisoft install".to_string())?;
    let install = std::path::PathBuf::from(&record.install_dir);
    let exe_dir = if record.exe.trim().is_empty() {
        None
    } else {
        let exe = install.join(record.exe.replace('\\', std::path::MAIN_SEPARATOR_STR));
        exe.parent().map(std::path::Path::to_path_buf)
    };
    ubi_direct::import_connect_saves(
        record.product_id,
        record.uplay_id,
        &install,
        exe_dir.as_deref(),
    )
}

/// Move a direct install into another folder and update its record/registry.
#[tauri::command]
pub fn ubi_direct_move(
    install_path: String,
    destination: String,
) -> Result<ubi_direct::MovedInstall, String> {
    let record = ubi_installs::load()
        .into_iter()
        .find(|record| record.install_dir.eq_ignore_ascii_case(&install_path))
        .ok_or_else(|| "this folder is not a direct install".to_string())?;
    ubi_direct::move_game(record.product_id, std::path::Path::new(&destination))
}

/// Every Ubisoft client download currently writing files, with its byte count.
#[tauri::command]
pub fn ubi_client_downloads() -> Vec<ubisoft::ClientDownload> {
    ubisoft::active_client_downloads()
}

/// Switch one direct install between the local shim and the official client.
#[tauri::command]
pub fn ubi_direct_set_client_launch(install_path: String, enabled: bool) -> Result<(), String> {
    let record = ubi_installs::load()
        .into_iter()
        .find(|record| record.install_dir.eq_ignore_ascii_case(&install_path))
        .ok_or_else(|| "this folder is not a direct install".to_string())?;
    if ubi_installs::set_client_launch(record.product_id, enabled) {
        Ok(())
    } else {
        Err("the direct-install record could not be updated".to_string())
    }
}

/// Start a direct install in the background. Progress arrives on
/// `ubi-direct-progress`, completion on `ubi-direct-done`, and a failure on
/// `ubi-direct-failed`.
#[tauri::command]
pub async fn ubi_direct_install(
    app: tauri::AppHandle,
    product_id: u32,
    path: Option<String>,
) -> Result<(), String> {
    let dir = path
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| ubi_direct::install::default_install_dir(product_id));
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        match ubi_direct::install_game(app.clone(), product_id, dir).await {
            Ok(summary) => {
                let _ = app.emit("ubi-direct-done", summary);
            }
            Err(error) => {
                let _ = app.emit(
                    "ubi-direct-failed",
                    serde_json::json!({ "productId": product_id, "error": error }),
                );
            }
        }
    });
    Ok(())
}

/// The diagnostics behind the opt-in direct EA path.
#[tauri::command]
pub fn ea_direct_probe(store: String, id: String) -> Result<ea_direct::EaDirectProbe, String> {
    if store != "ea" || id.is_empty() {
        return Err("Unknown game".into());
    }
    let Some(game) = discover("ea").into_iter().find(|g| g.id == id) else {
        return Err("Unknown game".into());
    };
    Ok(ea_direct::probe(&game))
}

/// Whether the opt-in direct EA path is on, plus the last failure.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EaDirectStatus {
    pub enabled: bool,
    pub last_error: String,
}

#[tauri::command]
pub fn ea_direct_status(app: tauri::AppHandle) -> EaDirectStatus {
    EaDirectStatus {
        enabled: crate::load_settings(&app).ea_direct_launch.unwrap_or(false),
        last_error: ea_direct::last_error().unwrap_or_default(),
    }
}

#[tauri::command]
pub fn ea_direct_set_enabled(app: tauri::AppHandle, enabled: bool) {
    let mut settings = crate::load_settings(&app);
    settings.ea_direct_launch = Some(enabled);
    crate::save_settings(&app, &settings);
}

/* ---------- EA content service: install, update, repair ---------- */

/// The live package for one owned EA game, plus what the local folder says.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EaContentPlan {
    /// Library key, the value the UI already has.
    pub id: String,
    /// Origin offer id, the content service's identity.
    pub offer_id: String,
    pub name: String,
    /// Live build id (the package's own identity on the content service).
    pub build_id: String,
    pub version: String,
    pub installed_version: String,
    pub installed: bool,
    pub update_available: bool,
    /// EA anti-cheat titles stay on the EA App for install, update and repair.
    pub eaac: bool,
    pub root: String,
    /// Compressed package bytes to fetch on a fresh install.
    pub download_bytes: u64,
    /// Uncompressed bytes on disk.
    pub install_bytes: u64,
    pub files: usize,
}

/// One progress tick for `ea-content-progress`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EaContentProgress {
    id: String,
    offer_id: String,
    name: String,
    phase: String,
    files: usize,
    bytes: u64,
    skipped: usize,
    skipped_bytes: u64,
    done_bytes: u64,
    total_files: usize,
    total_bytes: u64,
}

/// The owned catalog row behind an installed or catalog EA game.
fn ea_owned_row(game: &FoundGame) -> Option<ea_login::OwnedGame> {
    let owned = ea_login::cached_owned();
    if let Some(row) = owned.iter().find(|row| row.id == game.id) {
        return Some(row.clone());
    }
    if let Some(row) = owned.iter().find(|row| {
        !row.content_id.is_empty()
            && game
                .store_id
                .split(',')
                .any(|id| id.trim() == row.content_id)
    }) {
        return Some(row.clone());
    }
    let wanted = ea::normalize_title(&game.name);
    if let Some(row) = owned
        .iter()
        .find(|row| ea::normalize_title(&row.name) == wanted)
    {
        return Some(row.clone());
    }
    let slug = scan::slug(&game.name);
    owned.iter().find(|row| row.slug == slug).cloned()
}

/// The recorded build only describes this folder, not another copy.
fn same_install_root(recorded: &str, root: &std::path::Path) -> bool {
    if recorded.trim().is_empty() {
        return false;
    }
    let left = recorded.trim_end_matches(['\\', '/']);
    let right = root.to_string_lossy();
    let right = right.trim_end_matches(['\\', '/']);
    if cfg!(windows) {
        left.eq_ignore_ascii_case(right)
    } else {
        left == right
    }
}

/// Resolves the library row and its folder. An explicit path wins over the
/// discovered install path, then the default EA library folder.
fn ea_content_target(    id: &str,
    path: Option<String>,
) -> Result<(FoundGame, ea_login::OwnedGame, std::path::PathBuf), String> {
    if id.is_empty() {
        return Err("Unknown game".into());
    }
    let game = discover("ea")
        .into_iter()
        .find(|game| game.id == id)
        .ok_or_else(|| "Unknown game".to_string())?;
    let owned = ea_owned_row(&game)
        .ok_or_else(|| "This EA game is not in the linked account".to_string())?;
    let root = path
        .filter(|path| !path.trim().is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            (!game.install_path.is_empty()).then(|| std::path::PathBuf::from(&game.install_path))
        })
        .unwrap_or_else(|| ea_install::default_root(&game.name));
    Ok((game, owned, root))
}

/// Reads the live build and the local folder for one EA game. No download.
#[tauri::command]
pub async fn ea_content_plan(
    id: String,
    path: Option<String>,
) -> Result<EaContentPlan, String> {
    let (game, owned, root) = ea_content_target(&id, path)?;
    let access = ea_login::ensure_access().await?;
    let plan = ea_content::plan_install(&access, &owned.id, &root).await?;
    let installed_version = ea_install::installed_version(&root).unwrap_or_default();
    let installed = ea_install::has_install(&root);
    let local_build = ea_content::recorded_install(&owned.id)
        .filter(|record| same_install_root(&record.root, &root))
        .map(|record| record.build_id)
        .unwrap_or_default();
    let changed = if !installed_version.is_empty() && !plan.version.is_empty() {
        installed_version != plan.version
    } else if !local_build.is_empty() {
        local_build != plan.build_id
    } else {
        false
    };
    Ok(EaContentPlan {
        id: game.id,
        offer_id: owned.id,
        name: game.name,
        build_id: plan.build_id.clone(),
        version: plan.version.clone(),
        update_available: installed && changed,
        installed_version,
        installed,
        eaac: plan.eaac,
        root: root.to_string_lossy().to_string(),
        download_bytes: plan.total_compressed(),
        install_bytes: plan.total_uncompressed(),
        files: plan.manifest.entries.len(),
    })
}

/// Checks every local file against the live package. No download; missing and
/// damaged files are counted so the UI can offer a repair.
#[tauri::command]
pub async fn ea_content_verify(
    id: String,
    path: Option<String>,
) -> Result<ea_content::VerifyReport, String> {
    let (_, owned, root) = ea_content_target(&id, path)?;
    let access = ea_login::ensure_access().await?;
    let plan = ea_content::plan_install(&access, &owned.id, &root).await?;
    ea_content::verify_install(&plan, usize::MAX, u64::MAX, u64::MAX).await
}

/// Starts a background install, update or repair. Progress arrives on
/// `ea-content-progress`; the end is `ea-content-done` or `ea-content-failed`.
#[tauri::command]
pub async fn ea_content_install(
    app: tauri::AppHandle,
    id: String,
    path: Option<String>,
    locale: Option<String>,
) -> Result<(), String> {
    let (game, owned, root) = ea_content_target(&id, path)?;
    if !ea_install::folder_writable(&root) {
        return Err(format!(
            "@t:ea.folderNotWritable\u{1f}{}",
            root.display()
        ));
    }
    let locale = locale.unwrap_or_else(|| "en_US".into());
    let game_id = game.id.clone();
    let name = game.name.clone();
    let offer_id = owned.id.clone();
    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let flag = ea_content::begin_job(&offer_id);
        let progress = |tick: ea_install::InstallTick<'_>| {
            let metrics = tick.progress.unwrap_or_default();
            let _ = app.emit(
                "ea-content-progress",
                EaContentProgress {
                    id: game_id.clone(),
                    offer_id: offer_id.clone(),
                    name: name.clone(),
                    phase: tick.phase.to_string(),
                    files: metrics.files,
                    bytes: metrics.bytes,
                    skipped: metrics.skipped,
                    skipped_bytes: metrics.skipped_bytes,
                    done_bytes: metrics.done_bytes,
                    total_files: metrics.total_files,
                    total_bytes: metrics.total_bytes,
                },
            );
        };
        let result = async {
            let access = ea_login::ensure_access().await?;
            ea_install::install_with_progress(&access, &offer_id, &root, &locale, &flag, progress)
                .await
        }
        .await;
        ea_content::end_job(&offer_id);
        match result {
            Ok(report) => {
                ea_content::record_install(
                    &offer_id,
                    ea_content::InstallRecord {
                        build_id: report.build_id.clone(),
                        version: report.version.clone(),
                        root: root.to_string_lossy().to_string(),
                        files: report.download.files,
                        bytes: report.download.bytes,
                    },
                );
                let _ = app.emit(
                    "ea-content-done",
                    serde_json::json!({
                        "id": game_id,
                        "name": name,
                        "version": report.version,
                        "buildId": report.build_id,
                        "mode": report.mode.as_str(),
                        "files": report.download.files,
                        "bytes": report.download.bytes,
                        "skipped": report.download.skipped,
                        "touchupError": report.touchup_error,
                    }),
                );
            }
            Err(error) => {
                let _ = app.emit(
                    "ea-content-failed",
                    serde_json::json!({ "id": game_id, "name": name, "error": error }),
                );
            }
        }
    });
    Ok(())
}

/// Stops an install after the files in flight finish. Completed files stay, so
/// the next install resumes from them.
#[tauri::command]
pub fn ea_content_cancel(id: String) {
    if let Ok((_, owned, _)) = ea_content_target(&id, None) {
        ea_content::cancel_job(&owned.id);
        return;
    }
    ea_content::cancel_job(&id);
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

/// Adds one finished session to the local companion playtime cache. The generic
/// process watcher also calls this, so games started outside the launcher count.
pub(crate) fn add_local_playtime(app_name: &str, seconds: u64) {
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

/// Short-lived answers for the two network-backed companion stores. A drawer
/// open and the running-session poll ask for the same game; the second open
/// should not spend another EA GraphQL or Xbox REST request.
const COMPANION_ACHIEVEMENTS_TTL: std::time::Duration = std::time::Duration::from_secs(60);
static COMPANION_ACHIEVEMENTS_CACHE: std::sync::Mutex<
    Option<HashMap<String, (std::time::Instant, GameAchievementsResponse)>>,
> = std::sync::Mutex::new(None);

fn cached_companion_achievements(key: &str) -> Option<GameAchievementsResponse> {
    let cache = COMPANION_ACHIEVEMENTS_CACHE.lock().ok()?;
    let (at, data) = cache.as_ref()?.get(key)?;
    (at.elapsed() < COMPANION_ACHIEVEMENTS_TTL).then(|| data.clone())
}

fn store_companion_achievements(key: String, data: GameAchievementsResponse) {
    if let Ok(mut cache) = COMPANION_ACHIEVEMENTS_CACHE.lock() {
        let map = cache.get_or_insert_with(HashMap::new);
        map.retain(|_, (at, _)| at.elapsed() < COMPANION_ACHIEVEMENTS_TTL);
        map.insert(key, (std::time::Instant::now(), data));
    }
}

fn clear_achievement_cache() {
    if let Ok(mut cache) = COMPANION_ACHIEVEMENTS_CACHE.lock() {
        if let Some(map) = cache.as_mut() {
            map.clear();
        }
    }
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
    force_refresh: Option<bool>,
) -> GameAchievementsResponse {
    let cacheable = store == "ea" || store == "xbox";
    let cache_key = format!("{store}:{id}:{}", language.as_deref().unwrap_or(""));
    if cacheable && !force_refresh.unwrap_or(false) {
        if let Some(cached) = cached_companion_achievements(&cache_key) {
            return cached;
        }
    }

    let data = if store == "ea" {
        ea_login::achievements(&id, title.as_deref().unwrap_or("")).await
    } else if store == "xbox" {
        let Some(title_id) = xbox_login::title_id_for(&id, title.as_deref().unwrap_or("")) else {
            return GameAchievementsResponse::default();
        };
        xbox_login::achievements(&title_id).await
    } else if store == "ubisoft" {
        let data = ubi_achievements::achievements_for(
            &id,
            title.as_deref().unwrap_or(""),
            language.as_deref().unwrap_or("en"),
        );
        ubi_direct::merge_achievements(data, &id, title.as_deref().unwrap_or(""))
    } else {
        return GameAchievementsResponse::default();
    };
    // Do not cache an empty answer: it can mean "the session is still being
    // linked", and the next open should retry instead of showing stale empty.
    if cacheable && data.total_achievements > 0 {
        store_companion_achievements(cache_key, data.clone());
    }
    data
}

/// Library-keyed Xbox summaries. The store answers achievements per title,
/// but the account-wide feed pages in bulk; the per-title totals are mapped
/// onto the same library rows the title history maps onto.
async fn xbox_achievements_summary() -> std::collections::HashMap<String, GameAchievementSummary> {
    let Ok(totals) = xbox_login::achievement_totals().await else {
        return std::collections::HashMap::new();
    };
    let owned = xbox_login::cached_owned();
    let games = tokio::task::spawn_blocking(library_games).await.unwrap_or_default();
    let mut rows = std::collections::HashMap::new();
    for game in games.iter().filter(|game| game.store == "xbox") {
        let Some(achievement) = xbox_progress(game, &owned).and_then(|row| totals.get(&row.title_id)) else {
            continue;
        };
        if achievement.total == 0 {
            continue;
        }
        let key = format!("xbox::{}", game.id);
        rows.insert(
            key.clone(),
            GameAchievementSummary {
                app_name: key,
                user_unlocked: achievement.unlocked,
                total_achievements: achievement.total,
                user_xp: achievement.xp,
                total_xp: achievement.total_xp,
                is_platinum: achievement.unlocked >= achievement.total,
                supported: true,
                progress_known: true,
                ..Default::default()
            },
        );
    }
    rows
}

/// Bulk achievement summaries for a store. Ubisoft writes every game's set
/// into the client's own cache, so one pass over the library is cheap and
/// offline. Xbox pages the account's own achievement service — the title
/// history zeroes its totals once a title has progress. EA answers per game
/// only and stays on its game pages.
#[tauri::command]
pub async fn companion_achievements_summary(
    store: String,
    language: Option<String>,
) -> std::collections::HashMap<String, GameAchievementSummary> {
    if store == "xbox" {
        return xbox_achievements_summary().await;
    }
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
                    progress_known: true,
                    ..Default::default()
                },
            );
        }
        rows
    })
    .await
    .unwrap_or_default()
}

/// The Game Pass PC catalog. Public store metadata: no account, no licence and
/// no package content, so it also answers before an Xbox account is linked.
#[tauri::command]
pub async fn xbox_gamepass_catalog() -> Vec<xbox_catalog::GamePassTitle> {
    xbox_catalog::catalog().await
}

/// One Game Pass page: description, art, screenshots and the package to install.
#[tauri::command]
pub async fn xbox_gamepass_detail(product_id: String) -> Option<xbox_catalog::GamePassDetail> {
    xbox_catalog::detail(&product_id).await
}

/// Opens the Store page for a product the launcher cannot install itself. The
/// id is a twelve-character Store product id, the same shape the catalog ships.
#[tauri::command]
pub fn xbox_open_store(product_id: String) -> Result<(), String> {
    if product_id.len() != 12 || !product_id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("Unknown game".into());
    }
    launch::open_game(&format!("ms-windows-store://pdp/?ProductId={product_id}"), "")
}

/// Starts the Store install for one Xbox package and reports when it lands.
/// The download and the licence work stay with the Store.
#[tauri::command]
pub fn xbox_install(app: tauri::AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() {
        return Err("Unknown game".into());
    }
    xbox_deploy::start(app, id)
}

/// Stops watching an install. The Store keeps downloading.
#[tauri::command]
pub fn xbox_install_cancel(id: String) {
    xbox_deploy::cancel(&id);
}

/// Removes one installed Xbox title through the deployment service.
#[tauri::command]
pub async fn xbox_uninstall(id: String) -> Result<(), String> {
    if id.is_empty() {
        return Err("Unknown game".into());
    }
    tokio::task::spawn_blocking(move || xbox_deploy::uninstall(&id))
        .await
        .map_err(|error| error.to_string())?
}

/// Build the Connect protocol link for one action. The client's install and
/// uninstall handlers take the numeric product id; a launch prefers the Uplay
/// id, which differs for titles such as Far Cry 3 (product 599, Uplay 46).
fn ubisoft_deep_link(action: &str, product_id: u32, uplay_id: u32) -> String {
    match action {
        "install" => format!("uplay://install/{product_id}"),
        "uninstall" => format!("uplay://uninstall/{product_id}"),
        _ => {
            let launch_id = if uplay_id != 0 { uplay_id } else { product_id };
            format!("uplay://launch/{launch_id}/0")
        }
    }
}

/// A catalog row carries a space id, not the numeric id the client's protocol
/// handler needs. Resolve it through Demux by title, then build the link. This
/// is what turns a bare "open the client" click into the game's install page.
async fn ubisoft_uri_for(action: &str, title: &str) -> Option<String> {
    let key = scan::slug(title);
    if key.is_empty() {
        return None;
    }
    let probe = ubi_direct::probe().await.ok()?;
    let game = probe
        .games
        .iter()
        .filter(|game| scan::slug(&game.name) == key)
        .max_by_key(|game| game.installable)?;
    Some(ubisoft_deep_link(action, game.product_id, game.uplay_id))
}

/// Install, uninstall or launch a companion game. Install and uninstall use the
/// client's own protocol handlers or tools: the client does the work, the
/// launcher only starts it. A game without a known id falls back to opening the
/// client.
#[tauri::command]
pub async fn companion_game_action(app: tauri::AppHandle, store: String, id: String, action: String) -> Result<(), String> {
    if !accounts::is_store(&store) || id.is_empty() {
        return Err("Unknown game".into());
    }
    let Some(game) = discover(&store).into_iter().find(|g| g.id == id) else {
        return Err("Unknown game".into());
    };
    if store == "ubisoft" && action == "launch" && !game.install_path.is_empty() {
        if let Some(installed) = ubi_installs::load()
            .into_iter()
            .find(|row| row.install_dir.eq_ignore_ascii_case(&game.install_path))
        {
            let shim = crate::load_settings(&app).ubi_direct_shim.unwrap_or(true);
            let launched = ubi_direct::launch_game(installed.product_id, shim).await;
            if launched.is_ok() {
                schedule_update_check(&app, installed.product_id);
            }
            return launched;
        }
    }
    if store == "ubisoft" && action == "uninstall" && !game.install_path.is_empty() {
        if let Some(installed) = ubi_installs::load()
            .into_iter()
            .find(|row| row.install_dir.eq_ignore_ascii_case(&game.install_path))
        {
            return ubi_direct::uninstall_game(installed.product_id, true);
        }
    }
    // A catalog-only row has no numeric launch/install id, so the generic match
    // below would open the client at its default page. Resolve the id from
    // Demux first and open the game's own page instead.
    if store == "ubisoft" {
        let missing = match action.as_str() {
            "install" => game.install_uri.is_empty(),
            "uninstall" => game.uninstall_uri.is_empty(),
            "launch" => game.launch_uri.is_empty(),
            _ => false,
        };
        if missing {
            if action == "launch" {
                if let Ok(id) = game.store_id.parse::<u32>() {
                    if id > 0 {
                        return launch::open_game(&format!("uplay://launch/{id}/0"), "");
                    }
                }
            }
            if let Some(uri) = ubisoft_uri_for(&action, &game.name).await {
                return launch::open_game(&uri, "");
            }
        }
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ubisoft_deep_links_use_the_install_id_for_installs_and_the_uplay_id_for_launches() {
        assert_eq!(ubisoft_deep_link("install", 3539, 3539), "uplay://install/3539");
        assert_eq!(ubisoft_deep_link("uninstall", 3539, 3539), "uplay://uninstall/3539");
        assert_eq!(ubisoft_deep_link("launch", 599, 46), "uplay://launch/46/0");
        assert_eq!(ubisoft_deep_link("launch", 80, 0), "uplay://launch/80/0");
        assert_eq!(ubisoft_deep_link("install", 599, 46), "uplay://install/599");
    }

    #[tokio::test]
    #[ignore = "needs a linked Ubisoft session; set EFXLVE_UBI_TEST_TITLE"]
    async fn live_resolves_a_catalog_install_uri() {
        let title = std::env::var("EFXLVE_UBI_TEST_TITLE")
            .unwrap_or_else(|_| "Assassin's Creed® Origins".to_string());
        let probe = ubi_direct::probe().await.expect("probe");
        let wanted = scan::slug(&title);
        for game in &probe.games {
            if scan::slug(&game.name).contains("assassin") {
                println!("{} -> {} (product {})", game.name, scan::slug(&game.name), game.product_id);
            }
        }
        println!("wanted -> {wanted}");
        let uri = ubisoft_uri_for("install", &title).await.expect("a URI");
        println!("{title} -> {uri}");
        assert_eq!(uri, "uplay://install/3539");
    }

    #[tokio::test]
    #[ignore = "refreshes the Ubisoft catalogue; needs a linked session"]
    async fn live_sync_assigns_product_ids_to_catalog_rows() {
        let _ = ubisoft_login::sync_owned().await;
        let owned = ubisoft::load_owned();
        let origins = owned
            .iter()
            .find(|game| game.name.contains("Origins"))
            .expect("Assassin's Creed Origins in the cache");
        println!("{} -> product {}", origins.name, origins.product_id);
        assert_eq!(origins.product_id, 3539);
        let games = discover("ubisoft");
        let row = games
            .iter()
            .find(|game| game.name.contains("Origins"))
            .expect("the library row");
        println!("{} -> {}", row.name, row.install_uri);
        assert_eq!(row.install_uri, "uplay://install/3539");
    }

    #[test]
    #[ignore = "reads the client install tree; needs Rainbow Six Siege installed"]
    fn live_r6_is_installed_and_not_downloading() {
        let game = discover("ubisoft")
            .into_iter()
            .find(|game| {
                let name = game.name.to_lowercase();
                name.contains("rainbow six") && name.contains("siege")
            })
            .expect("Rainbow Six is in the client library");
        let public = to_public(&game, "", "", "");
        println!(
            "path={} installed={} downloading={} bytes={}",
            game.install_path, game.installed, public.downloading, public.download_bytes
        );
        assert!(game.installed, "Rainbow Six is not marked installed");
        assert!(!public.downloading, "the empty playgo folder is still a download");
        assert_eq!(public.download_bytes, 0);
        assert!(
            ubisoft::active_client_downloads().is_empty(),
            "an empty download folder was reported as active"
        );
    }

    #[tokio::test]
    #[ignore = "needs a linked Ubisoft session"]
    async fn live_resolves_r6_launch_uri() {
        let uri = ubisoft_uri_for("launch", "Tom Clancy's Rainbow Six Siege")
            .await
            .expect("a launch URI");
        println!("{uri}");
        assert_eq!(uri, "uplay://launch/635/0");
    }

    #[test]
    #[ignore = "prints Ubisoft rows that have no install or launch URI"]
    fn live_print_ubisoft_rows_without_uris() {
        for game in discover("ubisoft") {
            if game.install_uri.is_empty() || game.launch_uri.is_empty() {
                println!(
                    "id={} name={} installed={} store_id='{}' install_uri='{}' launch_uri='{}' path='{}'",
                    game.id,
                    game.name,
                    game.installed,
                    game.store_id,
                    game.install_uri,
                    game.launch_uri,
                    game.install_path
                );
            }
        }
    }

    fn game(id: &str, installed: bool) -> FoundGame {
        FoundGame {
            store: "riot".into(),
            id: id.into(),
            name: id.into(),
            install_path: if installed { format!("C:\\Riot Games\\{id}") } else { String::new() },
            installed,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: String::new(),
            install_uri: String::new(),
            uninstall_uri: String::new(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        }
    }

    #[test]
    fn riot_catalog_shrinks_to_installed_and_played_titles() {
        let games = vec![
            game("league_of_legends", true),
            game("valorant", false),
            game("bacon", false),
        ];
        let mut played = std::collections::HashMap::new();
        played.insert("riot::valorant".to_string(), 120u64);
        let visible = visible_games("riot", games, &played);
        assert_eq!(visible.len(), 2);
        assert!(visible.iter().any(|g| g.id == "league_of_legends"));
        assert!(visible.iter().any(|g| g.id == "valorant"));
        assert!(!visible.iter().any(|g| g.id == "bacon"));
    }

    #[test]
    fn other_stores_keep_every_discovered_game() {
        let games = vec![game("x", false)];
        let visible = visible_games("ea", games, &std::collections::HashMap::new());
        assert_eq!(visible.len(), 1);
    }

    #[test]
    fn a_companion_achievement_answer_is_cached_for_the_next_open() {
        let key = format!("companion-cache-test-{}", std::process::id());
        let data = GameAchievementsResponse {
            total_achievements: 5,
            ..Default::default()
        };
        store_companion_achievements(key.clone(), data);
        let cached = cached_companion_achievements(&key).expect("cached answer");
        assert_eq!(cached.total_achievements, 5);
    }

    #[test]
    #[ignore = "reads the real Watch Dogs Connect saves"]
    fn live_import_saves_command_copies_watch_dogs_slots() {
        let _guard = ubi_installs::test_lock().lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "efxlve-ubi-import-command-{}",
            std::process::id()
        ));
        let install = root.join("Watch_Dogs");
        std::fs::create_dir_all(&install).unwrap();
        std::fs::write(install.join("Watch_Dogs.exe"), b"exe").unwrap();
        let record_file = root.join("installs.json");
        let previous = std::env::var_os("EFXLVE_UBI_INSTALLS_FILE");
        std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", &record_file);
        ubi_installs::save(&ubi_installs::InstalledGame {
            product_id: 274,
            name: "Watch Dogs".into(),
            install_dir: install.display().to_string(),
            exe: "Watch_Dogs.exe".into(),
            installed_at: 1,
            install_reg: String::new(),
            uplay_id: 274,
            ticket: String::new(),
            client_launch: false,
            manifest: String::new(),
        });

        let copied = ubi_direct_import_saves(install.display().to_string()).expect("import");
        println!("imported {copied} slot(s) into {}", install.display());
        assert!(copied >= 3);
        assert!(install.join("Saves").join("274").join("1.save").is_file());
        match previous {
            Some(value) => std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", value),
            None => std::env::remove_var("EFXLVE_UBI_INSTALLS_FILE"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_content_record_only_matches_its_own_folder() {
        let root = std::path::Path::new("C:\\Games\\A Way Out\\");
        assert!(same_install_root("C:\\Games\\A Way Out", root));
        #[cfg(windows)]
        assert!(same_install_root("c:\\games\\a way out\\", root));
        #[cfg(not(windows))]
        assert!(!same_install_root("c:\\games\\a way out\\", root));
        assert!(!same_install_root("C:\\Games\\Other", root));
        assert!(!same_install_root("", root));
    }

    #[test]
    #[ignore = "reads the real user library and direct-install record"]
    fn live_direct_install_is_in_the_ubisoft_library() {        let games = discover("ubisoft");
        let game = games
            .iter()
            .find(|game| game.name.eq_ignore_ascii_case("Rayman Origins"))
            .expect("Rayman Origins must be in the Ubisoft library");
        println!(
            "id={} installed={} path={} launch_uri={}",
            game.id, game.installed, game.install_path, game.launch_uri
        );
        assert!(game.installed);
        let record = ubi_installs::load()
            .into_iter()
            .find(|record| record.install_dir.eq_ignore_ascii_case(&game.install_path))
            .expect("the library row must resolve to the direct-install record");
        assert_eq!(record.product_id, 80);
        assert_eq!(record.exe, "Rayman Origins.exe");
    }

    #[tokio::test]
    #[ignore = "talks to EA's content service with the signed-in account"]
    async fn live_ea_content_plan_resolves_an_owned_title_and_its_folder() {
        let plan = ea_content_plan("Origin.OFR.50.0002412".into(), None)
            .await
            .expect("A Way Out plan");
        println!(
            "id={} offer={} version={} installed={} update={} root={} download={} install={} files={}",
            plan.id,
            plan.offer_id,
            plan.version,
            plan.installed,
            plan.update_available,
            plan.root,
            plan.download_bytes,
            plan.install_bytes,
            plan.files
        );
        assert_eq!(plan.offer_id, "Origin.OFR.50.0002412");
        assert!(!plan.version.is_empty());
        assert!(!plan.eaac);
        assert!(plan.download_bytes > 0);
        assert!(plan.install_bytes >= plan.download_bytes);
    }

    #[tokio::test]
    #[ignore = "reads the real EA library and talks to the content service"]
    async fn live_ea_content_plan_matches_the_installed_version() {
        let games = discover("ea");
        let game = games
            .iter()
            .find(|game| game.name.contains("2042"))
            .expect("Battlefield 2042 must be in the EA library");
        println!(
            "library id={} name={} installed={} path={} store_id={}",
            game.id, game.name, game.installed, game.install_path, game.store_id
        );
        let plan = ea_content_plan(game.id.clone(), None)
            .await
            .expect("Battlefield 2042 plan");
        println!(
            "offer={} version={} installed_version={} update={} files={}",
            plan.offer_id,
            plan.version,
            plan.installed_version,
            plan.update_available,
            plan.files
        );
        assert!(plan.installed);
        assert!(plan.eaac);
        assert_eq!(plan.version, plan.installed_version);
        assert!(!plan.update_available);
    }
}
