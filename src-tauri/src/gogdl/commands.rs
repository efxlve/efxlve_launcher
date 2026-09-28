//! Tauri IPC commands for GOG.COM integration.

use tauri::{AppHandle, command};

use super::api_client::{
    exchange_auth_code, fetch_game_details, fetch_gog_achievements, fetch_user_library,
    get_user_profile, refresh_tokens,
};
use super::cache::{
    clear_auth_tokens, load_achievements_cache, load_auth_tokens, load_cached_library,
    load_installed_games, save_achievements_cache, save_auth_tokens, save_cached_library,
};
use super::models::{
    GogAuthStatus, GogCachedLibrary, GogFriend, GogGameDetails, GogGameSummary, GogSetupStatus,
};
use super::paths::{downloaded_binary, resolve_binary};
use super::{cmd_error, GogError};
use crate::legendary::models::{
    GameAchievementSummary, GameAchievementsResponse, GameRequirementsResponse,
};

/// Checks whether the user is currently authenticated with GOG.COM.
#[command]
pub async fn gog_auth_status(app: AppHandle) -> Result<GogAuthStatus, String> {
    let tokens = match load_auth_tokens(&app) {
        Some(t) => t,
        None => {
            return Ok(GogAuthStatus {
                logged_in: false,
                user_id: None,
                username: None,
            });
        }
    };

    // Fast check: if we have tokens on disk, return logged in
    let cached = load_cached_library(&app);
    let mut username = cached.account.clone();
    if username.as_deref() == Some("GOG User") || username.is_none() {
        if let Ok(profile) = get_user_profile(&tokens.access_token).await {
            if !profile.username.is_empty() && profile.username != "GOG User" {
                username = Some(profile.username.clone());
                let _ = save_cached_library(&app, Some(&profile.username), Some(&tokens.user_id), &cached.games);
                let gog_dir = super::paths::gog_config_dir(&app);
                super::accounts::ensure_current_gog_account_saved(&gog_dir, Some(&profile.username));
            }
        }
    }

    Ok(GogAuthStatus {
        logged_in: true,
        user_id: Some(tokens.user_id),
        username,
    })
}

/// Exchanges an authorization code obtained from the GOG OAuth2 login page.
#[command]
pub async fn gog_auth_code(app: AppHandle, code: String) -> Result<GogAuthStatus, String> {
    let code = code.trim();
    if code.is_empty() {
        return Err("Authorization code cannot be empty".to_string());
    }

    let tokens = exchange_auth_code(code).await.map_err(cmd_error)?;

    // Fetch user profile to verify and retrieve display name
    let profile = get_user_profile(&tokens.access_token)
        .await
        .unwrap_or(super::models::GogUserProfile {
            user_id: tokens.user_id.clone(),
            username: "GOG User".to_string(),
            avatar_url: None,
        });

    save_auth_tokens(&app, &tokens).map_err(cmd_error)?;

    let gog_dir = super::paths::gog_config_dir(&app);
    super::accounts::ensure_current_gog_account_saved(&gog_dir, Some(&profile.username));

    Ok(GogAuthStatus {
        logged_in: true,
        user_id: Some(profile.user_id),
        username: Some(profile.username),
    })
}

/// Logs out the user from GOG and clears stored credentials.
#[command]
pub async fn gog_logout(app: AppHandle) -> Result<(), String> {
    clear_auth_tokens(&app);
    let _ = save_cached_library(&app, None, None, &[]);
    Ok(())
}

/// Checks the status of the local `gogdl.exe` binary.
#[command]
pub async fn gog_setup_status(app: AppHandle) -> Result<GogSetupStatus, String> {
    let dl_bin = downloaded_binary(&app);
    let resolved = resolve_binary(&app).ok();

    Ok(GogSetupStatus {
        binary_path: resolved.as_ref().map(|p| p.to_string_lossy().to_string()),
        version: None,
        needs_download: !dl_bin.is_file(),
    })
}

/// Reads the cached GOG library snapshot for instantaneous local hydration on startup.
#[command]
pub async fn gog_cached_library(app: AppHandle) -> Result<GogCachedLibrary, String> {
    let mut cached = load_cached_library(&app);
    let installed_map = load_installed_games(&app);
    for g in &mut cached.games {
        if let Some(inst) = installed_map.get(&g.game_id) {
            g.is_installed = true;
            g.install_path = Some(inst.install_path.clone());
        }
    }
    Ok(cached)
}

/// Queries the remote GOG Galaxy API for the user's owned games and caches the result.
#[command]
pub async fn gog_list_games(app: AppHandle) -> Result<Vec<GogGameSummary>, String> {
    let mut tokens = load_auth_tokens(&app).ok_or_else(|| cmd_error(GogError::NotAuthenticated))?;

    // Attempt library fetch. If unauthorized, attempt token refresh and retry once.
    let games_res = fetch_user_library(&tokens.access_token).await;

    let games = match games_res {
        Ok(g) => g,
        Err(GogError::NotAuthenticated) => {
            // Refresh token
            let refreshed = refresh_tokens(&tokens.refresh_token)
                .await
                .map_err(cmd_error)?;
            tokens = refreshed;
            let _ = save_auth_tokens(&app, &tokens);
            fetch_user_library(&tokens.access_token)
                .await
                .map_err(cmd_error)?
        }
        Err(e) => return Err(cmd_error(e)),
    };

    let installed_map = load_installed_games(&app);
    let mut enriched = games;
    for g in &mut enriched {
        if let Some(inst) = installed_map.get(&g.game_id) {
            g.is_installed = true;
            g.install_path = Some(inst.install_path.clone());
        }
    }

    let cached = load_cached_library(&app);
    let mut username = cached.account;
    if username.as_deref() == Some("GOG User") || username.is_none() {
        if let Ok(profile) = get_user_profile(&tokens.access_token).await {
            if !profile.username.is_empty() && profile.username != "GOG User" {
                username = Some(profile.username);
            }
        }
    }

    // Cache to disk
    let _ = save_cached_library(&app, username.as_deref(), Some(&tokens.user_id), &enriched);

    Ok(enriched)
}

/// Retrieves detailed game metadata (official description, 2560px background, developers, and screenshots) on demand.
#[command]
pub async fn gog_get_game_details(
    _app: AppHandle,
    game_id: String,
) -> Result<GogGameDetails, String> {
    fetch_game_details(&game_id).await.map_err(cmd_error)
}

/// Retrieves user achievements for a GOG game from the official Gameplay API.
#[command]
pub async fn gog_get_achievements(
    app: AppHandle,
    game_id: String,
) -> Result<GameAchievementsResponse, String> {
    let mut tokens = load_auth_tokens(&app).ok_or_else(|| cmd_error(GogError::NotAuthenticated))?;
    let clean_id = game_id.trim_start_matches("gog::");

    let res = fetch_gog_achievements(&tokens.access_token, &tokens.user_id, clean_id).await;
    let data = match res {
        Ok(ach) => ach,
        Err(GogError::NotAuthenticated) => {
            let refreshed = refresh_tokens(&tokens.refresh_token)
                .await
                .map_err(cmd_error)?;
            tokens = refreshed;
            let _ = save_auth_tokens(&app, &tokens);
            fetch_gog_achievements(&tokens.access_token, &tokens.user_id, clean_id)
                .await
                .map_err(cmd_error)?
        }
        Err(e) => return Err(cmd_error(e)),
    };

    let summary = GameAchievementSummary {
        app_name: format!("gog::{clean_id}"),
        total_achievements: data.total_achievements,
        user_unlocked: data.user_unlocked,
        user_xp: data.user_xp,
        total_xp: data.total_xp,
        is_platinum: data.is_platinum,
        supported: data.supported.unwrap_or(data.total_achievements > 0),
        base_achievements: data.base_achievements,
        base_unlocked: data.base_unlocked,
    };
    let mut cache = load_achievements_cache(&app);
    cache.insert(format!("gog::{clean_id}"), summary.clone());
    cache.insert(clean_id.to_string(), summary);
    let _ = save_achievements_cache(&app, &cache);

    Ok(data)
}

/// Returns all cached GOG achievement summaries from disk.
#[command]
pub async fn gog_get_achievements_summary(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, GameAchievementSummary>, String> {
    Ok(load_achievements_cache(&app))
}

/// Background synchronization of GOG achievement summaries for user's owned games.
#[command]
pub async fn gog_sync_achievements(
    app: AppHandle,
) -> Result<std::collections::HashMap<String, GameAchievementSummary>, String> {
    let tokens = match load_auth_tokens(&app) {
        Some(t) => t,
        None => return Ok(std::collections::HashMap::new()),
    };
    let cached_lib = load_cached_library(&app);
    if cached_lib.games.is_empty() {
        return Ok(load_achievements_cache(&app));
    }

    let mut cache = load_achievements_cache(&app);
    let uncached: Vec<String> = cached_lib
        .games
        .iter()
        .map(|g| g.game_id.clone())
        .filter(|id| !cache.contains_key(&format!("gog::{id}")) && !cache.contains_key(id))
        .collect();

    if uncached.is_empty() {
        return Ok(cache);
    }

    let sem = std::sync::Arc::new(tokio::sync::Semaphore::new(4));
    let mut handles = Vec::new();

    for id in uncached {
        let sem = sem.clone();
        let access_token = tokens.access_token.clone();
        let user_id = tokens.user_id.clone();
        handles.push(tokio::spawn(async move {
            let _permit = sem.acquire().await;
            let res = fetch_gog_achievements(&access_token, &user_id, &id).await;
            (id, res)
        }));
    }

    let mut updated = false;
    for handle in handles {
        if let Ok((id, Ok(resp))) = handle.await {
            let summary = GameAchievementSummary {
                app_name: format!("gog::{id}"),
                total_achievements: resp.total_achievements,
                user_unlocked: resp.user_unlocked,
                user_xp: resp.user_xp,
                total_xp: resp.total_xp,
                is_platinum: resp.is_platinum,
                supported: resp.supported.unwrap_or(resp.total_achievements > 0),
                base_achievements: resp.base_achievements,
                base_unlocked: resp.base_unlocked,
            };
            cache.insert(format!("gog::{id}"), summary.clone());
            cache.insert(id, summary);
            updated = true;
        }
    }

    if updated {
        let _ = save_achievements_cache(&app, &cache);
    }

    Ok(cache)
}

/// Retrieves hardware requirements for a GOG game.
#[command]
pub async fn gog_get_system_requirements(
    game_id: String,
) -> Result<GameRequirementsResponse, String> {
    let clean_id = game_id.trim_start_matches("gog::");
    let details = fetch_game_details(clean_id).await.map_err(cmd_error)?;
    details
        .requirements
        .ok_or_else(|| "No requirements defined for this game".to_string())
}

/// Returns all saved GOG accounts.
#[command]
pub async fn gog_get_saved_accounts(
    app: AppHandle,
) -> Result<Vec<super::accounts::SavedGogAccount>, String> {
    let gog_dir = super::paths::gog_config_dir(&app);
    let cached = load_cached_library(&app);
    let mut username = cached.account;
    if username.as_deref() == Some("GOG User") || username.is_none() {
        if let Some(tokens) = load_auth_tokens(&app) {
            if let Ok(profile) = get_user_profile(&tokens.access_token).await {
                if !profile.username.is_empty() && profile.username != "GOG User" {
                    username = Some(profile.username.clone());
                    let _ = save_cached_library(&app, Some(&profile.username), Some(&tokens.user_id), &cached.games);
                }
            }
        }
    }
    Ok(super::accounts::list_saved_gog_accounts(&gog_dir, username.as_deref()))
}

/// Switches the active GOG account.
#[command]
pub async fn gog_switch_account(
    app: AppHandle,
    user_id: String,
) -> Result<super::accounts::SavedGogAccount, String> {
    let gog_dir = super::paths::gog_config_dir(&app);
    let cached = load_cached_library(&app);
    let username = cached.account.as_deref();
    super::accounts::switch_gog_account(&gog_dir, &user_id, username)
}

/// Removes a saved GOG account.
#[command]
pub async fn gog_remove_saved_account(
    app: AppHandle,
    user_id: String,
) -> Result<(), String> {
    let gog_dir = super::paths::gog_config_dir(&app);
    super::accounts::remove_saved_gog_account(&gog_dir, &user_id)
}

/// Lists games installed by the official GOG Galaxy client (registry scan).
#[command]
pub async fn gog_detect_galaxy_games() -> Result<Vec<super::galaxy::GalaxyDetectedGame>, String> {
    tauri::async_runtime::spawn_blocking(super::galaxy::detect_galaxy_games)
        .await
        .map_err(|e| e.to_string())
}

/// Registers detected Galaxy installs in this launcher's GOG installed map.
/// Returns how many games were added.
#[command]
pub async fn gog_sync_galaxy_installed(app: AppHandle) -> Result<u32, String> {
    tauri::async_runtime::spawn_blocking(move || super::galaxy::sync_galaxy_installed(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// Compares installed GOG build ids with the newest public builds.
/// Returns one entry per game that has an update; results are disk-cached.
#[command]
pub async fn gog_check_updates(
    app: AppHandle,
    force: Option<bool>,
) -> Result<Vec<super::models::GogUpdateInfo>, String> {
    super::updates::check_updates(&app, force.unwrap_or(false)).await
}

/// Lists the signed-in user's GOG friends (chat service, read-only).
#[command]
pub async fn gog_friends(app: AppHandle) -> Result<Vec<GogFriend>, String> {
    let mut tokens = load_auth_tokens(&app).ok_or_else(|| cmd_error(GogError::NotAuthenticated))?;
    let user_id = tokens.user_id.clone();
    if user_id.is_empty() {
        return Err(cmd_error(GogError::NotAuthenticated));
    }
    let friends = match super::api_client::fetch_gog_friends(&user_id, &tokens.access_token).await {
        Ok(list) => list,
        Err(GogError::NotAuthenticated) => {
            let refreshed = super::api_client::refresh_tokens(&tokens.refresh_token)
                .await
                .map_err(cmd_error)?;
            tokens = refreshed;
            let _ = save_auth_tokens(&app, &tokens);
            super::api_client::fetch_gog_friends(&user_id, &tokens.access_token)
                .await
                .map_err(cmd_error)?
        }
        Err(e) => return Err(cmd_error(e)),
    };
    Ok(friends)
}

/// Reads hours played in the official GOG Galaxy client (local database,
/// read-only). `user_id` is the signed-in GOG user id.
#[command]
pub async fn gog_sync_playtime(
    user_id: Option<String>,
) -> Result<Vec<super::galaxy_playtime::GalaxyPlaytimeEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        super::galaxy_playtime::read_galaxy_playtime(user_id.as_deref())
    })
    .await
    .map_err(|e| e.to_string())
}
