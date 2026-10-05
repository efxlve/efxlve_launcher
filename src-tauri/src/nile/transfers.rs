//! Amazon install, update, launch and uninstall through the Nile CLI.
//!
//! Nile logs its download progress to stderr once per second; `run_streaming`
//! parses those lines and forwards them as `nile-progress` events. Launching
//! blocks inside Nile until the game exits, which is exactly what the playtime
//! session needs.

use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::json;
use tauri::{AppHandle, Emitter};

use super::cli;

/// One parsed progress line:
/// `= Progress: 42.13 12345678/29301082, Running for: 00:01:23, ETA: 00:01:55`
#[derive(Debug, Clone, PartialEq)]
pub struct ProgressUpdate {
    pub percent: f64,
    pub downloaded: u64,
    pub total: u64,
    /// Nile's own estimate as `HH:MM:SS` (None when the line omits it).
    pub eta: Option<String>,
}

pub fn parse_progress_line(line: &str) -> Option<ProgressUpdate> {
    let marker = "= Progress:";
    let start = line.find(marker)? + marker.len();
    let mut parts = line[start..].split_whitespace();
    let percent: f64 = parts.next()?.parse().ok()?;
    let sizes = parts.next()?;
    let (downloaded, total) = sizes.split_once('/')?;
    let eta = line
        .find("ETA:")
        .and_then(|i| line[i + 4..].split_whitespace().next())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    Some(ProgressUpdate {
        percent,
        downloaded: downloaded.trim().parse().ok()?,
        total: total.trim().trim_end_matches(',').parse().ok()?,
        eta,
    })
}

/// One rate line: `+ Download\t- 1.23 MiB/s` or `+ Disk\t- 1.30 MiB/s`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RateUpdate {
    /// True for the `+ Disk` line, false for `+ Download`.
    pub disk: bool,
    /// MiB/s.
    pub mib_per_sec: f64,
}

pub fn parse_speed_line(line: &str) -> Option<RateUpdate> {
    let disk = if line.contains("+ Download") {
        false
    } else if line.contains("+ Disk") {
        true
    } else {
        return None;
    };
    let tail = line.rsplit('-').next()?.trim();
    let mib_per_sec = tail.split_whitespace().next()?.parse::<f64>().ok()?;
    Some(RateUpdate { disk, mib_per_sec })
}

/// Running game processes started by us, keyed by composite id.
static LAUNCH_PIDS: Mutex<Option<HashMap<String, u32>>> = Mutex::new(None);

fn with_pids<R>(f: impl FnOnce(&mut HashMap<String, u32>) -> R) -> R {
    let mut slot = LAUNCH_PIDS.lock().unwrap();
    let map = slot.get_or_insert_with(HashMap::new);
    f(map)
}

/// One stderr line handler that forwards download progress as events.
fn progress_emitter(app: AppHandle, event_id: String) -> impl FnMut(&str) + Send + 'static {
    let mut last_download = 0.0f64;
    let mut last_disk = 0.0f64;
    let mut last_eta: Option<String> = None;
    move |line: &str| {
        if let Some(rate) = parse_speed_line(line) {
            if rate.disk {
                last_disk = rate.mib_per_sec;
            } else {
                last_download = rate.mib_per_sec;
            }
            return;
        }
        if let Some(progress) = parse_progress_line(line) {
            if let Some(eta) = progress.eta.as_deref() {
                last_eta = Some(eta.to_string());
            }
            let _ = app.emit(
                "nile-progress",
                json!({
                    "id": event_id,
                    "percent": progress.percent,
                    "downloaded": progress.downloaded,
                    "total": progress.total,
                    "speed": last_download,
                    "diskSpeed": last_disk,
                    "eta": last_eta,
                }),
            );
        }
    }
}

/// Drops the installed record and the stored manifest for one product.
///
/// Nile compares stored manifests instead of the files on disk, and its saved
/// path lookup keys on the entitlement id while the record uses the product
/// id, so a moved or deleted folder still reads as "up to date" forever.
fn reset_install_record(app: &AppHandle, id: &str) {
    let dir = cli::config_dir(app);
    let path = dir.join("installed.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(list) = serde_json::from_str::<Vec<serde_json::Value>>(&text) {
            let kept: Vec<serde_json::Value> = list
                .into_iter()
                .filter(|game| game.get("id").and_then(|v| v.as_str()) != Some(id))
                .collect();
            if let Ok(serialized) = serde_json::to_string(&kept) {
                let _ = std::fs::write(&path, serialized);
            }
        }
    }
    let _ = std::fs::remove_file(dir.join("manifests").join(format!("{id}.raw")));
}

/// Installs (or updates) one Amazon game. Progress arrives as `nile-progress`
/// events with the composite id the library uses.
#[tauri::command]
pub async fn nile_install(
    app: AppHandle,
    id: String,
    base_path: Option<String>,
    max_workers: Option<u32>,
) -> Result<(), String> {
    let mut args: Vec<String> = vec!["install".into(), id.clone()];
    if let Some(base) = base_path.filter(|p| !p.trim().is_empty()) {
        // `--base-path` appends the sanitized game title, so the setting reads
        // as "the folder Amazon games go into". Create it first: Nile's space
        // check runs before the first download and a missing base is a hard
        // failure on some systems.
        let _ = std::fs::create_dir_all(&base);
        args.push("--base-path".into());
        args.push(base);
    }
    if let Some(workers) = max_workers.filter(|w| *w > 0) {
        args.push("--max-workers".into());
        args.push(workers.to_string());
    }

    let event_id = format!("amazon::{id}");
    let out = cli::run_streaming(
        &app,
        &args,
        6 * 3600,
        progress_emitter(app.clone(), event_id.clone()),
    )
    .await?;

    // Keep the full output for diagnostics: Nile reports some failures only on
    // stderr and still exits zero.
    let log_path = cli::config_dir(&app).join(format!("install-{id}.log"));
    let _ = std::fs::write(
        &log_path,
        format!(
            "stdout:\n{}\n\nstderr:\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
    );

    if !out.status.success() {
        return Err(cli::failure_message(&out));
    }
    // Nile exits zero even when it refuses to install ("Not enough space") and
    // when it only *thinks* the install is current. The installed record plus
    // its folder is the postcondition.
    if super::library::installed_game(&app, &id).is_none() {
        reset_install_record(&app, &id);
        let retry = cli::run_streaming(
            &app,
            &args,
            6 * 3600,
            progress_emitter(app.clone(), event_id),
        )
        .await;
        let healed = retry
            .as_ref()
            .map(|v| v.status.success())
            .unwrap_or(false)
            && super::library::installed_game(&app, &id).is_some();
        if !healed {
            let detail = match retry {
                Ok(v) => cli::failure_message(&v),
                Err(e) => e,
            };
            return Err(format!("@t:amazon.installFailed\u{1f}{detail}"));
        }
    }
    Ok(())
}

/// Download size for the install dialog, without downloading anything.
#[tauri::command]
pub async fn nile_install_info(app: AppHandle, id: String) -> Result<u64, String> {
    let out = cli::run(&app, &["install", &id, "--info", "--json"], 120).await?;
    let text = cli::stdout_text(&out);
    let value: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| cli::failure_message(&out))?;
    Ok(value
        .get("download_size")
        .and_then(|v| v.as_u64())
        .unwrap_or(0))
}

/// Removes one installed game and its files.
#[tauri::command]
pub async fn nile_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    let out = cli::run(&app, &["uninstall", &id], 300).await?;
    if !out.status.success() {
        return Err(cli::failure_message(&out));
    }
    Ok(())
}

/// Launches one installed game and tracks the session until it exits.
#[tauri::command]
pub async fn nile_launch(app: AppHandle, id: String) -> Result<String, String> {
    let installed = super::library::installed_game(&app, &id)
        .ok_or_else(|| "@t:dl.notInstalled".to_string())?;
    let title = super::library::game_title(&app, &id).unwrap_or_else(|| id.clone());
    let composite = format!("amazon::{id}");

    let bin = super::ensure_binary(&app).await?;
    let mut cmd = cli::command(&app, bin);
    cmd.args(["launch", &id])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Nile could not launch the game: {e}"))?;
    if let Some(pid) = child.id() {
        with_pids(|pids| pids.insert(composite.clone(), pid));
    }

    let _ = app.emit("game-status", json!({ "id": composite, "running": true }));
    crate::legendary::playtime_session::begin(&composite);

    let app_clone = app.clone();
    let comp_id = composite.clone();
    let install_dir = std::path::PathBuf::from(installed.path);
    tokio::spawn(async move {
        let started = std::time::Instant::now();
        let _ = child.wait().await;
        let elapsed = started.elapsed().as_secs();
        let _ = crate::legendary::playtime::record_session(&comp_id, elapsed);
        crate::legendary::playtime_session::finish();
        with_pids(|pids| pids.remove(&comp_id));
        let _ = app_clone.emit(
            "game-status",
            json!({ "id": comp_id, "running": false }),
        );
    });

    // The screenshot hotkey follows the same running game as the playtime watch.
    crate::legendary::screenshots::set_active_running_game(
        &composite,
        &title,
        Some(install_dir),
        Vec::new(),
    );

    Ok(format!("@t:dl.launched\u{1f}{title}"))
}

/// Stops a running Amazon game by killing Nile's process tree.
#[tauri::command]
pub async fn nile_stop(app: AppHandle, id: String) -> Result<String, String> {
    let composite = format!("amazon::{id}");
    let pid = with_pids(|pids| pids.remove(&composite));
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            let mut cmd = tokio::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output().await;
        }
        #[cfg(unix)]
        {
            let _ = tokio::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .output()
                .await;
        }
    }

    crate::legendary::playtime_session::finish();
    crate::legendary::screenshots::clear_active_running_game(&composite);
    let _ = app.emit(
        "game-status",
        json!({ "id": composite, "running": false }),
    );
    Ok("@t:dl.stopped".to_string())
}

/// Product ids with a newer build on Amazon, as composite library ids.
#[tauri::command]
pub async fn nile_check_updates(app: AppHandle) -> Result<Vec<String>, String> {
    let out = cli::run(&app, &["list-updates", "--json"], 120).await?;
    let text = cli::stdout_text(&out);
    let ids: Vec<String> = serde_json::from_str(&text).unwrap_or_default();
    Ok(ids.into_iter().map(|id| format!("amazon::{id}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_and_speed_lines_are_parsed() {
        let line = "INFO [PROGRESS]:\t = Progress: 42.13 12345678/29301082, Running for: 00:01:23, ETA: 00:01:55";
        let parsed = parse_progress_line(line).expect("progress line");
        assert!((parsed.percent - 42.13).abs() < f64::EPSILON);
        assert_eq!(parsed.downloaded, 12_345_678);
        assert_eq!(parsed.total, 29_301_082);
        assert_eq!(parsed.eta.as_deref(), Some("00:01:55"));

        let net = parse_speed_line("INFO [PROGRESS]:\t + Download\t- 1.23 MiB/s").unwrap();
        assert!(!net.disk);
        assert!((net.mib_per_sec - 1.23).abs() < f64::EPSILON);

        let disk = parse_speed_line("INFO [PROGRESS]:\t + Disk\t- 1.30 MiB/s").unwrap();
        assert!(disk.disk);
        assert!((disk.mib_per_sec - 1.30).abs() < f64::EPSILON);

        assert!(parse_progress_line("INFO [DOWNLOAD]:\t Download complete").is_none());
        assert!(parse_speed_line("INFO [PROGRESS]:\t = Progress: 1.0 1/2").is_none());
    }
}
