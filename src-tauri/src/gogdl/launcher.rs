//! GOG game launching, process supervision, and crash-safe playtime recording.

use std::path::{Path, PathBuf};
use std::time::Instant;
use tauri::{command, AppHandle, Emitter};

use super::cache::load_installed_games;
use super::transfers::scan_gog_info;
use crate::legendary::transfers::{
    discover_game_executables, game_process_pids, is_game_process_running,
};

/// Helper to find any candidate executable in the game folder when metadata is missing.
fn find_fallback_exe(dir: &Path) -> Result<PathBuf, String> {
    let exes = discover_game_executables(dir, None);
    if let Some(first) = exes.first() {
        let p = dir.join(first);
        if p.is_file() {
            return Ok(p);
        }
    }
    Err("@t:dl.executableNotFound".to_string())
}

/// Launches an installed DRM-free GOG game and tracks its session playtime.
#[command]
pub async fn gog_launch_game(app: AppHandle, game_id: String) -> Result<String, String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let composite_id = format!("gog::{clean_id}");

    let installed_map = load_installed_games(&app);
    let entry = installed_map
        .get(&clean_id)
        .ok_or_else(|| "@t:dl.notInstalled".to_string())?;

    let install_dir = PathBuf::from(&entry.install_path);
    if !install_dir.is_dir() {
        return Err("@t:dl.notInstalled".to_string());
    }

    // Resolve the target game binary
    let mut resolved_exe: Option<PathBuf> = None;

    if let Some(ref rel) = entry.executable {
        let p = install_dir.join(rel);
        if p.is_file() {
            resolved_exe = Some(p);
        }
    }

    if resolved_exe.is_none() {
        if let Some(info) = scan_gog_info(&install_dir, &clean_id) {
            if let Some(ref rel) = info.executable {
                let p = install_dir.join(rel);
                if p.is_file() {
                    resolved_exe = Some(p);
                }
            }
        }
    }

    let target_exe = match resolved_exe {
        Some(p) => p,
        None => find_fallback_exe(&install_dir)?,
    };

    let title = if entry.title.is_empty() {
        clean_id.clone()
    } else {
        entry.title.clone()
    };

    // Spawn the game detached from launcher window
    let mut cmd = tokio::process::Command::new(&target_exe);
    cmd.current_dir(&install_dir);

    #[cfg(windows)]
    {
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        const DETACHED_PROCESS: u32 = 0x00000008;
        cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS);
    }

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn game process: {e}"))?;
    let initial_pid = child.id();

    // Signal UI that game has entered the Running state
    let _ = app.emit(
        "game-status",
        serde_json::json!({ "id": composite_id, "running": true }),
    );

    // Initialize crash-safe playtime marker
    crate::legendary::playtime_session::begin(&composite_id);

    // Candidate executables for process tree supervision
    let candidate_exes = discover_game_executables(&install_dir, entry.executable.as_deref());

    let app_clone = app.clone();
    let comp_id_clone = composite_id.clone();
    let install_dir_clone = install_dir.clone();

    tokio::spawn(async move {
        let started = Instant::now();
        let mut last_heartbeat = Instant::now();

        // Brief delay for the game process tree to stabilize
        tokio::time::sleep(tokio::time::Duration::from_millis(1500)).await;

        loop {
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

            // Heartbeat updates crash-recovery marker every 15s
            if last_heartbeat.elapsed().as_secs() >= 15 {
                crate::legendary::playtime_session::heartbeat();
                last_heartbeat = Instant::now();
            }

            // Check if any process belonging to the game folder is still running
            let running = is_game_process_running(Some(&install_dir_clone), &candidate_exes);
            if !running {
                // If candidate detection is empty, also verify the initial spawned PID
                if let Some(pid) = initial_pid {
                    #[cfg(windows)]
                    {
                        let mut check_cmd = tokio::process::Command::new("tasklist");
                        check_cmd.args(["/FI", &format!("PID eq {pid}"), "/NH"]);
                        const CREATE_NO_WINDOW: u32 = 0x08000000;
                        check_cmd.creation_flags(CREATE_NO_WINDOW);
                        if let Ok(out) = check_cmd.output().await {
                            let text = String::from_utf8_lossy(&out.stdout);
                            if text.contains(&pid.to_string()) {
                                continue;
                            }
                        }
                    }
                }
                break;
            }
        }

        let elapsed = started.elapsed().as_secs();
        let _ = crate::legendary::playtime::record_session(&comp_id_clone, elapsed);
        crate::legendary::playtime_session::finish();

        let _ = app_clone.emit(
            "game-status",
            serde_json::json!({ "id": comp_id_clone, "running": false }),
        );
    });

    Ok(format!("@t:dl.launched\u{1f}{title}"))
}

/// Stops a running GOG game by terminating its active processes.
#[command]
pub async fn gog_stop_game(app: AppHandle, game_id: String) -> Result<String, String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let composite_id = format!("gog::{clean_id}");

    let installed_map = load_installed_games(&app);
    if let Some(entry) = installed_map.get(&clean_id) {
        let install_path = PathBuf::from(&entry.install_path);
        let candidate_exes = discover_game_executables(&install_path, entry.executable.as_deref());
        let pids = game_process_pids(Some(&install_path), &candidate_exes);
        for pid in pids {
            #[cfg(windows)]
            {
                let mut cmd = tokio::process::Command::new("taskkill");
                cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
                const CREATE_NO_WINDOW: u32 = 0x08000000;
                cmd.creation_flags(CREATE_NO_WINDOW);
                let _ = cmd.output().await;
            }
        }
    }

    crate::legendary::playtime_session::finish();
    crate::legendary::transfers::wake_main_window(&app);

    let _ = app.emit(
        "game-status",
        serde_json::json!({ "id": composite_id, "running": false }),
    );

    Ok("@t:dl.stopped".to_string())
}
