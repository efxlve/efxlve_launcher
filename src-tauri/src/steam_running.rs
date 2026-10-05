//! Watches Steam's own per-app `Running` flag.
//!
//! Steam writes `HKCU\Software\Valve\Steam\Apps\<appid>\Running` while a game is
//! open, no matter who started it. Polling that flag lets the launcher show the
//! Running badge (and Recently played) for games started from the Steam client
//! or a desktop shortcut, not just the ones Efxlve handed over.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

use tauri::{AppHandle, Emitter};

/// One `reg query` per tick; three seconds keeps the badge responsive without
/// spawning the helper too often.
const POLL: Duration = Duration::from_secs(3);

const APPS_KEY: &str = r"HKCU\Software\Valve\Steam\Apps";
const KEY_PREFIX: &str = r"HKEY_CURRENT_USER\Software\Valve\Steam\Apps\";

static STARTED: AtomicBool = AtomicBool::new(false);

/// App ids whose `Running` value is `0x1`, from one recursive query.
fn running_app_ids() -> HashSet<String> {
    crate::winreg::query_all(APPS_KEY, "Running")
        .map(|text| parse_running_output(&text))
        .unwrap_or_default()
}

/// Parses the `reg query <key> /s /v Running` output: a key line is followed by
/// its `Running    REG_DWORD    0x1` value line.
fn parse_running_output(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(KEY_PREFIX) {
            current = rest.rsplit('\\').next().map(str::to_string);
        } else if trimmed.starts_with("Running") {
            let running = trimmed.split_whitespace().nth(2) == Some("0x1");
            if running {
                if let Some(id) = current.take() {
                    if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
                        out.insert(id);
                    }
                }
            } else {
                current = None;
            }
        }
    }
    out
}

fn emit_status(app: &AppHandle, app_id: &str, running: bool) {
    let _ = app.emit(
        "game-status",
        serde_json::json!({
            "id": format!("steam::{app_id}"),
            "running": running,
        }),
    );
}

fn watch_loop(app: AppHandle, mut last: HashSet<String>) {
    loop {
        thread::sleep(POLL);
        let now = running_app_ids();
        for id in now.difference(&last) {
            emit_status(&app, id, true);
        }
        for id in last.difference(&now) {
            emit_status(&app, id, false);
        }
        last = now;
    }
}

/// Starts the Steam running watcher once and returns the ids running right now,
/// so the UI can seed its state before the first change event arrives.
#[tauri::command]
pub fn steam_watch_running(app: AppHandle) -> Vec<String> {
    let current = running_app_ids();
    if !STARTED.swap(true, Ordering::SeqCst) {
        let baseline = current.clone();
        let handle = app.clone();
        let _ = thread::Builder::new()
            .name("steam-running".into())
            .spawn(move || watch_loop(handle, baseline));
    }
    let mut ids: Vec<String> = current.into_iter().collect();
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn running_values_map_to_app_ids() {
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\\Apps\\220\r\n    Running    REG_DWORD    0x0\r\n\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\\Apps\\730\r\n    Running    REG_DWORD    0x1\r\n\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\\Apps\\271590\r\n    Running    REG_DWORD    0x1\r\n";
        let ids = parse_running_output(output);
        assert_eq!(ids.len(), 2);
        assert!(ids.contains("730"));
        assert!(ids.contains("271590"));
        assert!(!ids.contains("220"));
    }

    #[test]
    fn junk_and_empty_output_yield_nothing() {
        assert!(parse_running_output("").is_empty());
        assert!(parse_running_output("no registry output here").is_empty());
        let non_numeric =
            "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\\Apps\\SomeName\r\n    Running    REG_DWORD    0x1\r\n";
        assert!(parse_running_output(non_numeric).is_empty());
    }
}
