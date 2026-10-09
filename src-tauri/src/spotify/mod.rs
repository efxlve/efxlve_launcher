//! Spotify Web API integration: PKCE login, session storage, player control.
//!
//! Spotify caps development-mode apps at a handful of users, so the launcher
//! asks every user for their own Spotify app Client ID (create one in the
//! Developer Dashboard, register the loopback redirect, paste the ID here).
//! Playback is controlled through the Web API on whatever Spotify Connect
//! device the user already has (desktop, phone, speaker) — no audio stack and
//! no librespot dependency in the launcher.

pub mod api;
pub mod auth;
pub mod session;

use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

/// Fixed loopback port. The user registers `http://127.0.0.1:8899/callback`
/// as the app's redirect URI once, and the login flow reuses it forever.
pub const CALLBACK_PORT: u16 = 8899;

/// Spotify removed free playback control; the UI hints this when product is
/// not premium.
struct State {
    /// Bumped by `spotify_cancel_login` to abort a pending login.
    login_generation: u64,
    /// Short-lived cache so the launcher and the overlay can both poll.
    now_playing: Option<(Instant, Option<api::NowPlaying>)>,
}

static STATE: Mutex<State> = Mutex::new(State {
    login_generation: 0,
    now_playing: None,
});

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn http_client() -> &'static reqwest::Client {
    use std::sync::OnceLock;
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(20))
            .build()
            .unwrap_or_default()
    })
}

fn open_in_browser(url: &str) {
    #[cfg(windows)]
    unsafe {
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;
        let wide: Vec<u16> = url.encode_utf16().chain(std::iter::once(0)).collect();
        let _ = ShellExecuteW(
            None,
            w!("open"),
            PCWSTR(wide.as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
    }
    #[cfg(not(windows))]
    {
        let _ = url;
    }
}

/// Waits until a newer login generation is requested (cancel button).
async fn wait_for_cancel(generation: u64) {
    loop {
        tokio::time::sleep(Duration::from_millis(250)).await;
        let current = STATE.lock().map(|s| s.login_generation).unwrap_or(generation);
        if current != generation {
            return;
        }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpotifyStatus {
    /// A Client ID is saved (or compiled in): the login button can work.
    pub client_id_set: bool,
    /// A stored session exists; playback calls should work.
    pub connected: bool,
    pub user: String,
    /// "premium", "free" or an empty string when unknown.
    pub product: String,
    /// Why the last call failed, if it did ("refresh_failed", ...).
    pub error: String,
}

fn status_of(app: &AppHandle) -> SpotifyStatus {
    match session::load(app) {
        Some(saved) => SpotifyStatus {
            client_id_set: true,
            connected: true,
            user: saved.user,
            product: saved.product,
            error: String::new(),
        },
        None => SpotifyStatus {
            client_id_set: configured_client_id(app).is_some(),
            connected: false,
            user: String::new(),
            product: String::new(),
            error: String::new(),
        },
    }
}

/// Resolves a valid access token, refreshing it when it is about to expire.
async fn access_token(app: &AppHandle, force_refresh: bool) -> Result<String, String> {
    let mut saved = session::load(app).ok_or_else(|| "not_connected".to_string())?;
    let expired = saved.expires_at - 60 <= now_unix();
    if force_refresh || expired {
        let tokens = auth::refresh(http_client(), &saved.client_id, &saved.refresh_token)
            .await
            .map_err(|error| {
                // A refused refresh means the user revoked the app: drop it so
                // the UI returns to the connect state.
                session::clear(app);
                format!("refresh_failed: {error}")
            })?;
        saved.access_token = tokens.access_token;
        if let Some(refresh) = tokens.refresh_token {
            saved.refresh_token = refresh;
        }
        saved.expires_at = now_unix() + tokens.expires_in.unwrap_or(3600);
        session::save(app, &saved);
    }
    Ok(saved.access_token)
}

/// Saved Client ID, the compiled-in default, or None.
fn configured_client_id(app: &AppHandle) -> Option<String> {
    session::load_client_id(app).or_else(|| {
        let built_in = option_env!("EFXLVE_SPOTIFY_CLIENT_ID").unwrap_or("").trim();
        if built_in.is_empty() {
            None
        } else {
            Some(built_in.to_string())
        }
    })
}

#[tauri::command]
pub fn spotify_status(app: AppHandle) -> SpotifyStatus {
    status_of(&app)
}

/// Saves the user's own Spotify app Client ID (Developer Dashboard).
#[tauri::command]
pub fn spotify_set_client_id(app: AppHandle, client_id: String) -> Result<(), String> {
    let trimmed = client_id.trim();
    if trimmed.len() < 16 {
        return Err("client_id_invalid".to_string());
    }
    session::save_client_id(&app, trimmed);
    Ok(())
}

/// Opens the Spotify consent page in the system browser and waits for the
/// loopback redirect. Returns the connected status on success.
#[tauri::command]
pub async fn spotify_login(app: AppHandle) -> Result<SpotifyStatus, String> {
    let client_id = configured_client_id(&app).ok_or_else(|| "missing_client_id".to_string())?;

    let generation = {
        let mut state = STATE.lock().map_err(|_| "state_poisoned".to_string())?;
        state.login_generation += 1;
        state.login_generation
    };

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", CALLBACK_PORT))
        .await
        .map_err(|_| format!("port_busy:{CALLBACK_PORT}"))?;

    let verifier = auth::new_verifier();
    let challenge = auth::challenge(&verifier);
    let expected_state = auth::new_state();
    let redirect = auth::redirect_uri(CALLBACK_PORT);
    let url = auth::authorize_url(&client_id, &redirect, &challenge, &expected_state);
    open_in_browser(&url);

    let code = tokio::select! {
        result = auth::await_callback(listener, &expected_state) => result?,
        _ = tokio::time::sleep(Duration::from_secs(300)) => return Err("timeout".to_string()),
        _ = wait_for_cancel(generation) => return Err("cancelled".to_string()),
    };

    let client = http_client();
    let tokens = auth::exchange_code(client, &client_id, &code, &verifier, &redirect).await?;
    let (user, product) = api::me(client, &tokens.access_token)
        .await
        .unwrap_or_else(|_| ("Spotify".to_string(), String::new()));

    let saved = session::Session {
        client_id,
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token.unwrap_or_default(),
        expires_at: now_unix() + tokens.expires_in.unwrap_or(3600),
        user,
        product,
    };
    session::save(&app, &saved);
    Ok(status_of(&app))
}

/// Aborts a pending `spotify_login` (the user closed the browser tab).
#[tauri::command]
pub fn spotify_cancel_login() {
    if let Ok(mut state) = STATE.lock() {
        state.login_generation += 1;
    }
}

/// Forgets the Spotify session but keeps the saved Client ID.
#[tauri::command]
pub fn spotify_logout(app: AppHandle) {
    session::clear(&app);
    if let Ok(mut state) = STATE.lock() {
        state.now_playing = None;
    }
}

/// Currently playing track (or None when playback is stopped).
#[tauri::command]
pub async fn spotify_now_playing(app: AppHandle) -> Result<Option<api::NowPlaying>, String> {
    if let Ok(state) = STATE.lock() {
        if let Some((at, cached)) = &state.now_playing {
            if at.elapsed() < Duration::from_millis(900) {
                return Ok(cached.clone());
            }
        }
    }

    let token = access_token(&app, false).await?;
    let result = match api::now_playing(http_client(), &token).await {
        Ok(playing) => Ok(playing),
        Err(error) if error.status == 401 => {
            // The token was revoked: force one refresh and retry.
            let token = access_token(&app, true).await?;
            api::now_playing(http_client(), &token)
                .await
                .map_err(|e| e.message)
        }
        Err(error) if error.status == 204 || error.status == 404 => Ok(None),
        Err(error) => Err(error.message),
    }?;

    if let Ok(mut state) = STATE.lock() {
        state.now_playing = Some((Instant::now(), result.clone()));
    }
    Ok(result)
}

#[tauri::command]
pub async fn spotify_devices(app: AppHandle) -> Result<Vec<api::Device>, String> {
    let token = access_token(&app, false).await?;
    api::devices(http_client(), &token)
        .await
        .map_err(|error| error.message)
}

#[tauri::command]
pub async fn spotify_playlists(app: AppHandle) -> Result<Vec<api::Playlist>, String> {
    let token = access_token(&app, false).await?;
    api::playlists(http_client(), &token)
        .await
        .map_err(|error| error.message)
}

/// Transport and mode control. `action` is one of: play, pause, next,
/// previous, seek, volume, shuffle, repeat.
#[tauri::command]
pub async fn spotify_control(
    app: AppHandle,
    action: String,
    value: Option<i64>,
    device_id: Option<String>,
) -> Result<(), String> {
    let token = access_token(&app, false).await?;
    api::control(
        http_client(),
        &token,
        &action,
        value,
        device_id.as_deref(),
    )
    .await
    .map_err(|error| error.message)?;
    if let Ok(mut state) = STATE.lock() {
        state.now_playing = None; // The next poll should reflect the change.
    }
    Ok(())
}

/// Starts a playlist/album/track URI (transferring to the device if given).
#[tauri::command]
pub async fn spotify_play(
    app: AppHandle,
    uri: String,
    device_id: Option<String>,
) -> Result<(), String> {
    let token = access_token(&app, false).await?;
    api::play_context(http_client(), &token, &uri, device_id.as_deref())
        .await
        .map_err(|error| error.message)?;
    if let Ok(mut state) = STATE.lock() {
        state.now_playing = None;
    }
    Ok(())
}

/// Moves playback to another Spotify Connect device (device picker).
#[tauri::command]
pub async fn spotify_transfer(app: AppHandle, device_id: String) -> Result<(), String> {
    let token = access_token(&app, false).await?;
    api::transfer(http_client(), &token, &device_id)
        .await
        .map_err(|error| error.message)?;
    if let Ok(mut state) = STATE.lock() {
        state.now_playing = None;
    }
    Ok(())
}
