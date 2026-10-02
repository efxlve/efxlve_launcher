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
mod launch;
mod proto;
mod scan;
mod signin;
mod ubisoft;
mod ubisoft_login;
mod ubi_vault;
pub(crate) use ubisoft_login::{accept_session as accept_ubi_session, watch_script as ubi_watch_script};
use ubisoft_login::UbiSync;

use std::collections::HashSet;

use serde::Serialize;

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

const STORES: &[&str] = &["ea", "ubisoft", "xbox", "battlenet"];

fn discover(store: &str) -> Vec<FoundGame> {
    let installed = scan::uninstall_games();
    match store {
        "ea" => installed.into_iter().filter(|g| g.store == "ea").collect(),
        "ubisoft" => ubisoft::merged_games(&installed),
        "xbox" => scan::xbox_games(),
        "battlenet" => battlenet::merged_games(&installed),
        _ => Vec::new(),
    }
}

fn library_games() -> Vec<FoundGame> {
    let linked: HashSet<String> = load_accounts(&accounts::accounts_file()).into_iter().map(|a| a.store).collect();
    let mut games = Vec::new();
    let mut seen = HashSet::new();
    for store in STORES {
        for game in discover(store) {
            if !linked.contains(*store) && !game.installed {
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

/// Refreshes a linked account from its own service. Ubisoft is the only store
/// with a refreshable session (the sealed remember-me token); the others are
/// local-only and report what the disk scan found.
#[tauri::command]
pub async fn companion_sync(store: String) -> Result<CompanionSyncReport, String> {
    if !accounts::is_store(&store) {
        return Err("Unknown store".into());
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

#[tauri::command]
pub fn companion_open_client(store: String) -> Result<(), String> {
    launch::open_client(&store)
}

#[tauri::command]
pub fn companion_launch(store: String, id: String) -> Result<(), String> {
    if !accounts::is_store(&store) || id.is_empty() {
        return Err("Unknown game".into());
    }
    if let Some(game) = discover(&store).into_iter().find(|g| g.id == id) {
        if !game.launch_uri.is_empty() || !game.launch_exe.is_empty() {
            return launch::open_game(&game.launch_uri, &game.launch_exe);
        }
    }
    launch::open_client(&store)
}

/// Playtime for the linked Ubisoft account, keyed by library id.
#[tauri::command]
pub async fn companion_playtimes(store: String) -> Vec<ubisoft_login::PlaytimeRow> {
    if store != "ubisoft" {
        return Vec::new();
    }
    ubisoft_login::playtimes().await
}

/// Install, uninstall or launch a companion game. Install and uninstall use the
/// client's own protocol handlers: the client does the work, the launcher only
/// starts it. A game without a known id falls back to opening the client.
#[tauri::command]
pub fn companion_game_action(store: String, id: String, action: String) -> Result<(), String> {
    if !accounts::is_store(&store) || id.is_empty() {
        return Err("Unknown game".into());
    }
    let Some(game) = discover(&store).into_iter().find(|g| g.id == id) else {
        return Err("Unknown game".into());
    };
    match action.as_str() {
        "install" if !game.install_uri.is_empty() => launch::open_game(&game.install_uri, ""),
        "uninstall" if !game.uninstall_uri.is_empty() => launch::open_game(&game.uninstall_uri, ""),
        "launch" if !game.launch_uri.is_empty() || !game.launch_exe.is_empty() => {
            launch::open_game(&game.launch_uri, &game.launch_exe)
        }
        _ => launch::open_client(&store),
    }
}
