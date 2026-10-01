//! Watches Steam library folders so the launcher sees updates and downloads
//! as soon as the Steam client writes them — no idle polling.

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};

static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

fn event_matters(event: &notify::Event) -> bool {
    event.paths.iter().any(|path| {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        name.starts_with("appmanifest_")
            || path.components().any(|c| c.as_os_str() == "downloading")
    })
}

/// Starts a one-shot directory watch on every Steam library folder.
///
/// Harmless when Steam is missing or the watch is already running.
#[tauri::command]
pub fn steam_watch_library(app: AppHandle) -> Result<(), String> {
    let mut slot = WATCHER.lock().map_err(|e| e.to_string())?;
    if slot.is_some() {
        return Ok(());
    }
    let Some(steam) = crate::steam::steam_install_path() else {
        return Ok(());
    };

    let (tx, rx) = mpsc::channel();
    let mut watcher =
        RecommendedWatcher::new(tx, notify::Config::default()).map_err(|e| e.to_string())?;
    for folder in crate::steam::library_folders(&steam) {
        let _ = watcher.watch(&folder, RecursiveMode::NonRecursive);
        let downloading = folder.join("downloading");
        if downloading.is_dir() {
            let _ = watcher.watch(&downloading, RecursiveMode::NonRecursive);
        }
    }
    *slot = Some(watcher);
    drop(slot);

    std::thread::Builder::new()
        .name("steam-watch".into())
        .spawn(move || {
            let mut pending = false;
            let mut last = Instant::now() - Duration::from_secs(2);
            loop {
                match rx.recv_timeout(Duration::from_millis(500)) {
                    Ok(Ok(event)) => {
                        if event_matters(&event) {
                            pending = true;
                        }
                    }
                    Ok(Err(_)) => {}
                    Err(RecvTimeoutError::Timeout) => {
                        if pending && last.elapsed() >= Duration::from_millis(900) {
                            pending = false;
                            last = Instant::now();
                            let _ = app.emit("steam-library-changed", ());
                        }
                    }
                    Err(RecvTimeoutError::Disconnected) => break,
                }
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}
