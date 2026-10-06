//! Watches installed games by process, so every store reports "Running".
//!
//! Steam reports itself through its own registry flag (`steam_running`); this
//! module covers the rest of the stores: the UI keeps a list of installed games
//! with their folders, and a background thread checks whether one of a game's
//! own executables is open — no matter which client started it.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::legendary::transfers::{discover_game_executables, is_game_process_running};

/// The process list is cached for a second, so one tick here is cheap; four
/// seconds keeps the badge responsive without a tight loop.
const POLL: Duration = Duration::from_secs(4);

/// One installed game to watch: the library key and its install folder.
#[derive(Debug, Clone, Deserialize)]
pub struct WatchGame {
    pub id: String,
    pub path: String,
}

static WATCHED: Mutex<Vec<(String, PathBuf)>> = Mutex::new(Vec::new());
static STARTED: AtomicBool = AtomicBool::new(false);

/// Stores with no playtime API: the local companion cache is their only source,
/// so the watcher sums sessions however the game was started (their own client,
/// a desktop shortcut, anything).
fn tracked_locally(id: &str) -> bool {
    id.starts_with("riot::") || id.starts_with("battlenet::")
}

fn emit_status(app: &AppHandle, id: &str, running: bool) {
    let _ = app.emit(
        "game-status",
        serde_json::json!({ "id": id, "running": running }),
    );
}

/// Executable names for one game folder, discovered once and cached.
fn exes_for<'a>(cache: &'a mut HashMap<PathBuf, Vec<String>>, path: &Path) -> &'a [String] {
    cache
        .entry(path.to_path_buf())
        .or_insert_with(|| discover_game_executables(path, None))
        .as_slice()
}

fn watch_loop(app: AppHandle) {
    let mut last: HashSet<String> = HashSet::new();
    let mut exes: HashMap<PathBuf, Vec<String>> = HashMap::new();
    // Start instant per running game, for the stores tracked locally.
    let mut started: HashMap<String, Instant> = HashMap::new();
    loop {
        thread::sleep(POLL);
        let games = WATCHED.lock().map(|g| g.clone()).unwrap_or_default();
        let mut now = HashSet::new();
        for (id, path) in &games {
            let list = exes_for(&mut exes, path);
            if !list.is_empty() && is_game_process_running(Some(path), list) {
                now.insert(id.clone());
            }
        }
        // Games that left the library must not keep their cached scan around.
        if exes.len() > games.len() * 2 {
            let keep: HashSet<&PathBuf> = games.iter().map(|(_, path)| path).collect();
            exes.retain(|path, _| keep.contains(path));
        }
        for id in now.difference(&last) {
            emit_status(&app, id, true);
            if tracked_locally(id) {
                started.insert(id.clone(), Instant::now());
            }
        }
        for id in last.difference(&now) {
            emit_status(&app, id, false);
            if let Some(at) = started.remove(id) {
                let seconds = at.elapsed().as_secs();
                if seconds >= 5 {
                    crate::companion::add_local_playtime(id, seconds);
                    // The cards and the open page re-read the cache.
                    let store = id.split("::").next().unwrap_or_default();
                    let _ = app.emit("companion-store-changed", store);
                }
            }
        }
        last = now;
    }
}

/// Replaces the watched game list. Harmless when called again; the watcher
/// thread starts once.
#[tauri::command]
pub fn game_watch_installed(app: AppHandle, games: Vec<WatchGame>) {
    let list: Vec<(String, PathBuf)> = games
        .into_iter()
        .filter(|g| !g.id.is_empty() && !g.path.is_empty())
        .map(|g| (g.id, PathBuf::from(g.path)))
        .collect();
    if let Ok(mut slot) = WATCHED.lock() {
        *slot = list;
    }
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let _ = thread::Builder::new()
        .name("game-running".into())
        .spawn(move || watch_loop(app));
}
