//! In-launcher Spotify playback: the launcher itself becomes a Spotify
//! Connect receiver through librespot — the same model spotifast, spotifyd and
//! spotify-player use.
//!
//! Pairing is one browser approval against Spotify's own desktop client
//! (`streaming` scope only, no developer app needed). After that the launcher
//! shows up as "Efxlve Launcher" in every Spotify client and the Web API
//! controls it like any other device. Spotify Premium is required by Spotify
//! for this kind of playback.
//!
//! The playback token is separate from the Web API session: a user can control
//! their phone/desktop without pairing, and can play here without connecting
//! the Web API.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::AppHandle;

pub const DEVICE_NAME: &str = "Efxlve Launcher";

/// Loopback redirect registered for Spotify's own desktop client; librespot's
/// OAuth helper binds it and shows the approval page in the browser.
#[cfg(windows)]
const REDIRECT_URI: &str = "http://127.0.0.1:8898/login";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackStatus {
    /// The one-time browser approval is stored.
    pub paired: bool,
    /// The Connect receiver is running right now.
    pub running: bool,
    pub device_name: String,
}

/// Tokens from the playback approval (separate from the Web API session).
#[derive(Serialize, Deserialize, Clone)]
pub struct PlaybackToken {
    pub access_token: String,
    pub refresh_token: String,
    /// Unix seconds.
    pub expires_at: i64,
}

static RUNNING: AtomicBool = AtomicBool::new(false);
/// Sending `()` stops the engine thread.
static STOP: Mutex<Option<std::sync::mpsc::Sender<()>>> = Mutex::new(None);

fn token_path(app: &AppHandle) -> PathBuf {
    crate::spotify::session::data_dir(app).join("playback.json")
}

pub fn load_token(app: &AppHandle) -> Option<PlaybackToken> {
    let text = std::fs::read_to_string(token_path(app)).ok()?;
    serde_json::from_str(&text).ok()
}

pub fn save_token(app: &AppHandle, token: &PlaybackToken) {
    if let Ok(text) = serde_json::to_string(token) {
        let _ = std::fs::write(token_path(app), text);
    }
}

pub fn clear_token(app: &AppHandle) {
    let _ = std::fs::remove_file(token_path(app));
}

pub fn status(app: &AppHandle) -> PlaybackStatus {
    PlaybackStatus {
        paired: load_token(app).is_some(),
        running: RUNNING.load(Ordering::Relaxed),
        device_name: DEVICE_NAME.to_string(),
    }
}

fn now_unix() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn spotify_playback_status(app: AppHandle) -> PlaybackStatus {
    status(&app)
}

/// Starts the Connect receiver. When no playback approval is stored yet this
/// opens the browser and waits for the user; the UI shows a waiting state.
#[tauri::command]
pub async fn spotify_playback_start(app: AppHandle) -> Result<PlaybackStatus, String> {
    #[cfg(windows)]
    {
        let handle = tauri::async_runtime::spawn_blocking(move || imp::start(app));
        handle.await.map_err(|error| error.to_string())?
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Err("unsupported".to_string())
    }
}

/// Stops the receiver; the pairing stays stored for the next start.
#[tauri::command]
pub fn spotify_playback_stop() {
    if let Ok(mut slot) = STOP.lock() {
        if let Some(stop) = slot.take() {
            let _ = stop.send(());
        }
    }
}

/// Stops the receiver and forgets the playback approval.
#[tauri::command]
pub fn spotify_playback_forget(app: AppHandle) {
    spotify_playback_stop();
    clear_token(&app);
}

#[cfg(windows)]
mod imp {
    use super::*;
    use librespot::connect::{ConnectConfig, Spirc};
    use librespot::core::{
        authentication::Credentials, cache::Cache, config::DeviceType, config::SessionConfig,
        session::Session,
    };
    use librespot::oauth::{OAuthClientBuilder, OAuthToken};
    use librespot::playback::{
        audio_backend,
        config::{AudioFormat, PlayerConfig},
        mixer::{self, MixerConfig},
        player::Player,
    };
    use std::sync::mpsc::{Receiver, Sender};

    /// Small bilingual landing page shown in the browser after approval.
    const CALLBACK_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Efxlve Launcher</title><style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center;max-width:420px}h1{font-size:18px}p{color:#9aa0ab;font-size:14px}</style></head><body><div><h1>Çalma etkinleştirildi / Playback enabled</h1><p>Bu sekmeyi kapatıp Efxlve Launcher'a dönebilirsin.<br>You can close this tab and return to Efxlve Launcher.</p></div></body></html>";

    pub fn start(app: AppHandle) -> Result<PlaybackStatus, String> {
        if RUNNING.load(Ordering::Relaxed) {
            return Ok(status(&app));
        }
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
        {
            let mut slot = STOP.lock().map_err(|_| "state_poisoned".to_string())?;
            if slot.is_some() {
                return Ok(status(&app));
            }
            *slot = Some(stop_tx);
        }

        let thread_app = app.clone();
        std::thread::spawn(move || {
            let outcome = run(thread_app, stop_rx, ready_tx);
            if let Err(error) = outcome {
                // Errors before "ready" are delivered through the channel;
                // this path only logs late failures.
                eprintln!("spotify playback engine ended: {error}");
            }
            RUNNING.store(false, Ordering::Relaxed);
            if let Ok(mut slot) = STOP.lock() {
                *slot = None;
            }
        });

        // Pairing can wait for the browser, so allow a generous window.
        match ready_rx.recv_timeout(Duration::from_secs(600)) {
            Ok(Ok(())) => Ok(status(&app)),
            Ok(Err(error)) => Err(error),
            Err(_) => Err("timeout".to_string()),
        }
    }

    fn run(
        app: AppHandle,
        stop_rx: Receiver<()>,
        ready: Sender<Result<(), String>>,
    ) -> Result<(), String> {
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        runtime.block_on(async move {
            match setup(&app).await {
                Ok(spirc) => {
                    RUNNING.store(true, Ordering::Relaxed);
                    let _ = ready.send(Ok(()));
                    // Park until the UI asks to stop; Spirc's task keeps
                    // serving Connect commands in the background.
                    loop {
                        if stop_rx.try_recv().is_ok() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(250)).await;
                    }
                    let _ = spirc.shutdown();
                    Ok(())
                }
                Err(error) => {
                    let _ = ready.send(Err(error.clone()));
                    Err(error)
                }
            }
        })
    }

    async fn setup(app: &AppHandle) -> Result<Spirc, String> {
        let session_config = SessionConfig::default();
        let token = ensure_token(app, &session_config).await?;
        let credentials = Credentials::with_access_token(token.access_token);

        let cache_dir = crate::spotify::session::data_dir(app).join("librespot");
        let files_dir = cache_dir.join("files");
        std::fs::create_dir_all(&files_dir).map_err(|error| error.to_string())?;
        let cache = Cache::new(
            Some(cache_dir.as_path()),
            Some(cache_dir.as_path()),
            Some(files_dir.as_path()),
            None,
        )
        .map_err(|error| error.to_string())?;

        let session = Session::new(session_config, Some(cache));
        let sink_builder = audio_backend::find(None).ok_or_else(|| "no_audio_backend".to_string())?;
        let mixer_builder = mixer::find(None).ok_or_else(|| "no_mixer".to_string())?;
        let mixer = mixer_builder(MixerConfig::default()).map_err(|error| error.to_string())?;
        let player = Player::new(
            PlayerConfig::default(),
            session.clone(),
            mixer.get_soft_volume(),
            move || sink_builder(None, AudioFormat::default()),
        );

        let connect_config = ConnectConfig {
            name: DEVICE_NAME.to_string(),
            device_type: DeviceType::Computer,
            initial_volume: 100,
            ..Default::default()
        };
        let (spirc, task) = Spirc::new(connect_config, session.clone(), credentials, player, mixer)
            .await
            .map_err(|error| error.to_string())?;
        tokio::spawn(task);
        spirc.activate().map_err(|error| error.to_string())?;
        Ok(spirc)
    }

    /// Stored token, refreshed when it is about to expire; otherwise the
    /// one-time browser approval runs and its tokens are stored.
    async fn ensure_token(
        app: &AppHandle,
        session_config: &SessionConfig,
    ) -> Result<PlaybackToken, String> {
        if let Some(saved) = load_token(app) {
            if saved.expires_at - 60 > now_unix() {
                return Ok(saved);
            }
            let client = OAuthClientBuilder::new(
                &session_config.client_id,
                REDIRECT_URI,
                vec!["streaming"],
            )
            .build()
            .map_err(|error| error.to_string())?;
            match client.refresh_token_async(&saved.refresh_token).await {
                Ok(token) => return Ok(store_token(app, token)),
                Err(_) => clear_token(app),
            }
        }

        let client = OAuthClientBuilder::new(
            &session_config.client_id,
            REDIRECT_URI,
            vec!["streaming"],
        )
        .open_in_browser()
        .with_custom_message(CALLBACK_HTML)
        .build()
        .map_err(|error| error.to_string())?;
        let token = client
            .get_access_token_async()
            .await
            .map_err(|error| error.to_string())?;
        Ok(store_token(app, token))
    }

    fn store_token(app: &AppHandle, token: OAuthToken) -> PlaybackToken {
        let remaining = token
            .expires_at
            .saturating_duration_since(Instant::now())
            .as_secs() as i64;
        let stored = PlaybackToken {
            access_token: token.access_token,
            refresh_token: token.refresh_token,
            expires_at: now_unix() + remaining.max(60),
        };
        save_token(app, &stored);
        stored
    }
}
