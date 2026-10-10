//! Optional Discord Rich Presence integration.
//!
//! A single background worker thread owns the Discord IPC client. The UI sends
//! already-localized activity text through a channel; the worker de-duplicates
//! it and backs off on failures. When disabled, or when Discord is not running,
//! the worker exits or waits quietly so the launcher keeps zero idle cost.

use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};

/// How long to wait before trying to (re)connect after a failure.
const RECONNECT_COOLDOWN: Duration = Duration::from_secs(30);

struct ActivityUpdate {
    details: String,
    state: String,
    large_image: String,
    large_text: String,
    small_image: String,
    /// Unix milliseconds. Zero means no elapsed timer.
    start_ms: i64,
    /// Unix milliseconds. With `start_ms` this draws the time bar (Listening).
    end_ms: i64,
    /// "Listening to X" instead of "Playing X" (the receiver's track).
    listening: bool,
}

enum Msg {
    Update(ActivityUpdate),
    Clear,
    Stop,
}

struct Handle {
    tx: Sender<Msg>,
}

static HANDLE: Mutex<Option<Handle>> = Mutex::new(None);

/// (Re)configures the presence worker. Disabling, or passing an empty
/// `client_id`, stops the worker and clears any active presence.
pub fn configure(enabled: bool, client_id: &str) {
    let id = client_id.trim().to_string();
    let mut guard = HANDLE.lock().unwrap_or_else(|e| e.into_inner());

    // Stop the previous worker if the client id changed or presence is disabled.
    if let Some(handle) = guard.take() {
        let _ = handle.tx.send(Msg::Stop);
    }
    if !enabled || id.is_empty() {
        return;
    }

    let (tx, rx) = channel::<Msg>();
    let worker_id = id.clone();
    let spawned = std::thread::Builder::new()
        .name("discord-presence".to_string())
        .spawn(move || worker(rx, worker_id))
        .is_ok();
    if spawned {
        *guard = Some(Handle { tx });
    }
}

/// Sends a localized activity update (de-duplicated inside the worker).
/// Image fields are HTTPS URLs or empty. `start_ms`/`end_ms` are unix
/// milliseconds, or 0; `listening` switches the verb to "Listening to".
pub fn update(
    details: &str,
    state: &str,
    large_image: &str,
    large_text: &str,
    small_image: &str,
    start_ms: i64,
    end_ms: i64,
    listening: bool,
) {
    let guard = HANDLE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handle) = guard.as_ref() {
        let _ = handle.tx.send(Msg::Update(ActivityUpdate {
            details: details.to_string(),
            state: state.to_string(),
            large_image: large_image.to_string(),
            large_text: large_text.to_string(),
            small_image: small_image.to_string(),
            start_ms,
            end_ms,
            listening,
        }));
    }
}

/// Clears the presence activity but keeps the worker alive.
pub fn clear() {
    let guard = HANDLE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handle) = guard.as_ref() {
        let _ = handle.tx.send(Msg::Clear);
    }
}

fn worker(rx: Receiver<Msg>, client_id: String) {
    let mut client: Option<DiscordIpcClient> = None;
    // What Discord is currently showing, and what it should show next. The
    // newest update is kept while the connection is down so a late-starting
    // Discord still receives the right activity.
    let mut applied: Option<(String, String, String, String, i64, i64, bool)> = None;
    let mut pending: Option<ActivityUpdate> = None;
    let mut next_connect = Instant::now();
    // How often a pending update retries a failed connection while idle.
    let retry_tick = Duration::from_secs(5);

    loop {
        // Block while idle; tick while an update waits for a connection.
        let msg = if pending.is_some() {
            match rx.recv_timeout(retry_tick) {
                Ok(msg) => Some(msg),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => None,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
            }
        } else {
            match rx.recv() {
                Ok(msg) => Some(msg),
                Err(_) => break,
            }
        };
        if let Some(msg) = msg {
            match msg {
                Msg::Stop => break,
                Msg::Clear => {
                    pending = None;
                    if let Some(c) = client.as_mut() {
                        let _ = c.clear_activity();
                    }
                    applied = None;
                    continue;
                }
                Msg::Update(upd) => pending = Some(upd),
            }
        }

        let Some(upd) = pending.as_ref() else { continue };
        let signature = (
            upd.details.clone(),
            upd.state.clone(),
            upd.large_image.clone(),
            upd.small_image.clone(),
            upd.start_ms,
            upd.end_ms,
            upd.listening,
        );
        // Already showing this exact activity.
        if client.is_some() && applied.as_ref() == Some(&signature) {
            continue;
        }
        if client.is_none() {
            if Instant::now() < next_connect {
                continue;
            }
            let mut c = DiscordIpcClient::new(&client_id);
            if c.connect().is_err() {
                next_connect = Instant::now() + RECONNECT_COOLDOWN;
                continue;
            }
            client = Some(c);
        }
        let mut payload = activity::Activity::new()
            .details(&upd.details)
            .state(&upd.state);
        if upd.listening {
            payload = payload.activity_type(activity::ActivityType::Listening);
        }
        let mut assets = activity::Assets::new();
        let mut has_assets = false;
        if !upd.large_image.is_empty() {
            let hover = if upd.large_text.is_empty() {
                &upd.details
            } else {
                &upd.large_text
            };
            assets = assets.large_image(&upd.large_image).large_text(hover);
            has_assets = true;
        }
        if !upd.small_image.is_empty() {
            assets = assets
                .small_image(&upd.small_image)
                .small_text("Efxlve Launcher");
            has_assets = true;
        }
        if has_assets {
            payload = payload.assets(assets);
        }
        if upd.start_ms > 0 {
            let mut stamps = activity::Timestamps::new().start(upd.start_ms);
            if upd.end_ms > upd.start_ms {
                stamps = stamps.end(upd.end_ms);
            }
            payload = payload.timestamps(stamps);
        }
        let ok = client
            .as_mut()
            .map(|c| c.set_activity(payload).is_ok())
            .unwrap_or(false);
        if ok {
            applied = Some(signature);
        } else {
            // Connection dropped (e.g. Discord closed): retry later.
            client = None;
            next_connect = Instant::now() + RECONNECT_COOLDOWN;
        }
    }

    if let Some(mut c) = client {
        let _ = c.clear_activity();
        let _ = c.close();
    }
}

/// Enables/disables presence and persists the setting + Discord application id.
#[tauri::command]
pub fn epic_presence_configure(app: tauri::AppHandle, enabled: bool, client_id: String) {
    let mut s = crate::load_settings(&app);
    s.presence_enabled = Some(enabled);
    s.presence_client_id = Some(client_id.clone());
    crate::save_settings(&app, &s);
    configure(enabled, &client_id);
}

/// Pushes a localized activity update (`details` first line, `state` second).
/// `listening` switches the verb to "Listening to" and shows the time bar when
/// both timestamps are present (the receiver's track).
#[tauri::command]
pub fn epic_presence_update(
    details: String,
    state: String,
    large_image: Option<String>,
    large_text: Option<String>,
    small_image: Option<String>,
    start_ms: Option<i64>,
    end_ms: Option<i64>,
    listening: Option<bool>,
) {
    update(
        &details,
        &state,
        large_image.as_deref().unwrap_or(""),
        large_text.as_deref().unwrap_or(""),
        small_image.as_deref().unwrap_or(""),
        start_ms.unwrap_or(0),
        end_ms.unwrap_or(0),
        listening.unwrap_or(false),
    );
}

/// Clears the current activity.
#[tauri::command]
pub fn epic_presence_clear() {
    clear();
}
