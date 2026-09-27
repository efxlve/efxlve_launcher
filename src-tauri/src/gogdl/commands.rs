//! Tauri IPC commands for GOG.COM integration.

use tauri::{AppHandle, command};

use super::api_client::{
    exchange_auth_code, fetch_game_details, fetch_user_library, get_user_profile, refresh_tokens,
};
use super::cache::{
    clear_auth_tokens, load_auth_tokens, load_cached_library, load_installed_games,
    save_auth_tokens, save_cached_library,
};
use super::models::{
    GogAuthStatus, GogCachedLibrary, GogGameDetails, GogGameSummary, GogSetupStatus,
};
use super::paths::{downloaded_binary, resolve_binary};
use super::{cmd_error, GogError};

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
    // Background validation can refresh if needed
    Ok(GogAuthStatus {
        logged_in: true,
        user_id: Some(tokens.user_id),
        username: None,
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
    let resolved = resolve_binary(&app, None).ok();

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

    // Cache to disk
    let _ = save_cached_library(&app, None, Some(&tokens.user_id), &enriched);

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
