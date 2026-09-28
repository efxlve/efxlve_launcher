//! Keeps the signed-in GOG account visible as online in Galaxy while the
//! launcher runs, mirroring the official client's presence heartbeat.
//!
//! The presence service marks a user online on `POST /users/{id}/status` and
//! expects a refresh roughly every five minutes; the status expires on its own
//! unless heartbeats keep coming, so a crash or a kill simply drops offline.
//! This is the only standing timer the app owns: it is a single small request
//! every four minutes, it does nothing while no GOG session exists, and it is
//! what makes the launcher's user actually appear online to their friends.

use std::time::Duration;

use tauri::AppHandle;

use super::api_client::{refresh_tokens, send_presence};
use super::cache::{load_auth_tokens, save_auth_tokens};
use super::GogError;

/// Galaxy refreshes its own heartbeat every five minutes; stay just below that.
const HEARTBEAT: Duration = Duration::from_secs(4 * 60);
/// Upper bound for the final "go offline" call while the app is exiting.
const OFFLINE_TIMEOUT: Duration = Duration::from_secs(3);

/// Sends one heartbeat. Returns true when the service accepted it.
pub async fn go_online(app: &AppHandle) -> bool {
    let Some(tokens) = load_auth_tokens(app) else {
        return false;
    };
    match send_presence(&tokens.user_id, &tokens.access_token, true).await {
        Ok(()) => true,
        Err(GogError::NotAuthenticated) => {
            // Access token expired: refresh once and retry with the new one.
            let Ok(fresh) = refresh_tokens(&tokens.refresh_token).await else {
                return false;
            };
            let _ = save_auth_tokens(app, &fresh);
            send_presence(&fresh.user_id, &fresh.access_token, true).await.is_ok()
        }
        Err(_) => false,
    }
}

/// Marks the account offline (best effort; used when the app exits).
pub async fn go_offline(app: &AppHandle) {
    let Some(tokens) = load_auth_tokens(app) else {
        return;
    };
    let _ = tokio::time::timeout(
        OFFLINE_TIMEOUT,
        send_presence(&tokens.user_id, &tokens.access_token, false),
    )
    .await;
}

/// Spawns the heartbeat worker for the app's lifetime.
pub fn spawn(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        loop {
            let _ = go_online(&app).await;
            tokio::time::sleep(HEARTBEAT).await;
        }
    });
}
