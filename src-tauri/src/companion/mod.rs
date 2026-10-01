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
pub(crate) use ubisoft_login::{accept_session as accept_ubi_session, watch_script as ubi_watch_script};

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
    }
}

fn with_cached_art(games: &[FoundGame]) -> Vec<CompanionGame> {
    let cache = load_cache();
    games
        .iter()
        .map(|game| {
            let (cover, hero) = cached_cover(&cache, &game.store, &game.id);
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
    accounts::unlink_store(&store)
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
