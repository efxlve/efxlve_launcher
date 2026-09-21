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

enum Msg {
    Update { details: String, state: String },
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
pub fn update(details: &str, state: &str) {
    let guard = HANDLE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handle) = guard.as_ref() {
        let _ = handle.tx.send(Msg::Update {
            details: details.to_string(),
            state: state.to_string(),
        });
    }
}

/// Clears the presence activity but keeps the worker alive.
pub fn clear() {
    let guard = HANDLE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handle) = guard.as_ref() {
        let _ = handle.tx.send(Msg::Clear);
    }
}

/// Stops the worker (used when the setting is turned off).
pub fn shutdown() {
    let mut guard = HANDLE.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(handle) = guard.take() {
        let _ = handle.tx.send(Msg::Stop);
    }
}

fn worker(rx: Receiver<Msg>, client_id: String) {
    let mut client: Option<DiscordIpcClient> = None;
    let mut last: Option<(String, String)> = None;
    let mut next_connect = Instant::now();

    while let Ok(msg) = rx.recv() {
        match msg {
            Msg::Stop => break,
            Msg::Clear => {
                if let Some(c) = client.as_mut() {
                    let _ = c.clear_activity();
                }
                last = None;
            }
            Msg::Update { details, state } => {
                if last.as_ref() == Some(&(details.clone(), state.clone())) {
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
                let payload = activity::Activity::new().details(&details).state(&state);
                let ok = client
                    .as_mut()
                    .map(|c| c.set_activity(payload).is_ok())
                    .unwrap_or(false);
                if ok {
                    last = Some((details, state));
                } else {
                    // Connection dropped (e.g. Discord closed): retry later.
                    client = None;
                    next_connect = Instant::now() + RECONNECT_COOLDOWN;
                }
            }
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
#[tauri::command]
pub fn epic_presence_update(details: String, state: String) {
    update(&details, &state);
}

/// Clears the current activity.
#[tauri::command]
pub fn epic_presence_clear() {
    clear();
}
