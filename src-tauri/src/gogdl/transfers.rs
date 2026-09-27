//! GOG game download, update, and transfer management via `gogdl` CLI.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::Instant;
use tauri::{AppHandle, Emitter, command};
use tokio::io::{AsyncRead, AsyncReadExt};

use super::cache::{load_installed_games, save_installed_games};
use super::models::GogInstalledInfo;
use super::paths::{auth_json_path, ensure_binary};
use super::cmd_error;

#[derive(Default)]
pub struct GogDlState {
    pub active_game_id: Option<String>,
    pub child_pid: Option<u32>,
}

pub static GOG_DL_STATE: Mutex<Option<GogDlState>> = Mutex::new(None);

#[derive(serde::Serialize, Clone)]
struct DlProgressPayload {
    id: String,
    progress: i32,
    done: bool,
    speed: String,
    #[serde(rename = "speedBytes")]
    speed_bytes: u64,
    #[serde(rename = "diskSpeed")]
    disk_speed: String,
    #[serde(rename = "diskBytes")]
    disk_bytes: u64,
    eta: String,
    #[serde(rename = "downloadedBytes")]
    downloaded_bytes: Option<u64>,
    #[serde(rename = "totalBytes")]
    total_bytes: Option<u64>,
}

#[derive(serde::Serialize, Clone)]
struct DlCancelledPayload {
    id: String,
}

#[derive(serde::Serialize, Clone)]
struct DlFailedPayload {
    id: String,
    message: String,
}

/// Helper for reading CRLF and CR-terminated lines from child stderr streams.
struct CrlfLines<R> {
    reader: R,
    buf: Vec<u8>,
    pending: Vec<u8>,
}

impl<R: AsyncRead + Unpin> CrlfLines<R> {
    fn new(reader: R) -> Self {
        Self {
            reader,
            buf: vec![0u8; 4096],
            pending: Vec::new(),
        }
    }

    async fn next_line(&mut self) -> Option<String> {
        loop {
            if let Some(pos) = self
                .pending
                .iter()
                .position(|&b| b == b'\n' || b == b'\r')
            {
                let line_bytes: Vec<u8> = self.pending.drain(..pos).collect();
                if !self.pending.is_empty() {
                    let next = self.pending[0];
                    if next == b'\n' || next == b'\r' {
                        self.pending.remove(0);
                    }
                }
                let s = String::from_utf8_lossy(&line_bytes).trim().to_string();
                if !s.is_empty() {
                    return Some(s);
                }
                continue;
            }

            match self.reader.read(&mut self.buf).await {
                Ok(0) => {
                    if !self.pending.is_empty() {
                        let s = String::from_utf8_lossy(&self.pending).trim().to_string();
                        self.pending.clear();
                        if !s.is_empty() {
                            return Some(s);
                        }
                    }
                    return None;
                }
                Ok(n) => {
                    self.pending.extend_from_slice(&self.buf[..n]);
                }
                Err(_) => return None,
            }
        }
    }
}

/// Parses progress percentage from `= Progress: 45.20%` lines.
fn parse_progress(line: &str) -> Option<i32> {
    let idx = line.find("Progress:")? + "Progress:".len();
    let rest = line[idx..].trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    if end == 0 {
        return None;
    }
    let val: f64 = rest[..end].parse().ok()?;
    Some((val.round() as i32).clamp(0, 100))
}

/// Parses ETA string from `ETA: 00:02:30` lines.
fn parse_eta(line: &str) -> Option<String> {
    let idx = line.find("ETA:")? + "ETA:".len();
    let rest = line[idx..].trim();
    let end = rest.find(|c: char| c == ' ' || c == ',' || c == '\t').unwrap_or(rest.len());
    let eta = rest[..end].trim();
    if !eta.is_empty() {
        Some(eta.to_string())
    } else {
        None
    }
}

/// Parses speed value from `+ Download - 25.40 MiB/s` or `+ Disk - 15.20 MiB/s` lines.
fn parse_speed(line: &str, keyword: &str) -> Option<(String, u64)> {
    let idx = line.find(keyword)? + keyword.len();
    let rest = line[idx..].trim_start();
    let clean = rest.trim_start_matches('-').trim_start();
    let end = clean.find(|c: char| c == '(' || c == '/' || c == ',').unwrap_or(clean.len());
    let part = clean[..end].trim();
    if part.is_empty() {
        return None;
    }

    let speed_str = part.to_string();
    let mut bytes = 0u64;
    let tokens: Vec<&str> = part.split_whitespace().collect();
    if tokens.len() >= 2 {
        if let Ok(num) = tokens[0].parse::<f64>() {
            let unit = tokens[1].to_lowercase();
            if unit.starts_with("gib") || unit.starts_with("gb") {
                bytes = (num * 1024.0 * 1024.0 * 1024.0) as u64;
            } else if unit.starts_with("mib") || unit.starts_with("mb") {
                bytes = (num * 1024.0 * 1024.0) as u64;
            } else if unit.starts_with("kib") || unit.starts_with("kb") {
                bytes = (num * 1024.0) as u64;
            } else {
                bytes = num as u64;
            }
        }
    }

    Some((speed_str, bytes))
}

/// Parses `goggame-<id>.info` in target directory if it exists to extract executable path.
pub fn scan_gog_info(target_dir: &Path, game_id: &str) -> Option<GogInstalledInfo> {
    let info_path = target_dir.join(format!("goggame-{game_id}.info"));
    if !info_path.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&info_path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&text).ok()?;

    let title = val.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let version = val.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0").to_string();
    let mut exe: Option<String> = None;

    if let Some(tasks) = val.get("playTasks").and_then(|v| v.as_array()) {
        for t in tasks {
            let is_primary = t.get("isPrimary").and_then(|v| v.as_bool()).unwrap_or(false);
            let path = t.get("path").and_then(|v| v.as_str());
            if let Some(p) = path {
                if is_primary || exe.is_none() {
                    exe = Some(p.to_string());
                    if is_primary {
                        break;
                    }
                }
            }
        }
    }

    Some(GogInstalledInfo {
        game_id: game_id.to_string(),
        title,
        install_path: target_dir.to_string_lossy().to_string(),
        version,
        install_size: 0,
        executable: exe,
    })
}

/// Initiates downloading and installing a GOG game.
#[command]
pub async fn gog_install_game(
    app: AppHandle,
    game_id: String,
    install_path: Option<String>,
) -> Result<(), String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let composite_id = format!("gog::{clean_id}");

    // Ensure gogdl binary is present, downloading from releases if missing
    let bin_path = ensure_binary(&app).await.map_err(cmd_error)?;
    let auth_path = auth_json_path(&app);

    // Target installation directory
    let target_dir_str = install_path.unwrap_or_else(|| {
        let base = std::env::var("USERPROFILE").unwrap_or_else(|_| "C:".to_string());
        format!("{base}\\Games\\GOG\\{clean_id}")
    });
    let target_dir = PathBuf::from(&target_dir_str);
    let _ = tokio::fs::create_dir_all(&target_dir).await;

    // Reset state and notify UI that download is queued/starting
    {
        let mut state_guard = GOG_DL_STATE.lock().unwrap();
        *state_guard = Some(GogDlState {
            active_game_id: Some(composite_id.clone()),
            child_pid: None,
        });
    }

    let _ = app.emit(
        "download-progress",
        DlProgressPayload {
            id: composite_id.clone(),
            progress: 0,
            done: false,
            speed: "0 B/s".to_string(),
            speed_bytes: 0,
            disk_speed: "0 B/s".to_string(),
            disk_bytes: 0,
            eta: "--".to_string(),
            downloaded_bytes: Some(0),
            total_bytes: None,
        },
    );

    let app_clone = app.clone();
    let comp_id_clone = composite_id.clone();
    let clean_id_clone = clean_id.clone();
    let target_dir_clone = target_dir.clone();

    tokio::spawn(async move {
        let mut cmd = tokio::process::Command::new(&bin_path);
        cmd.arg("--auth-config-path")
            .arg(&auth_path)
            .arg("download")
            .arg(&clean_id_clone)
            .arg("--path")
            .arg(&target_dir_clone)
            .arg("--platform")
            .arg("windows")
            .arg("--skip-dlcs")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_clone.emit(
                    "download-failed",
                    DlFailedPayload {
                        id: comp_id_clone,
                        message: e.to_string(),
                    },
                );
                return;
            }
        };

        if let Some(pid) = child.id() {
            let mut state_guard = GOG_DL_STATE.lock().unwrap();
            if let Some(ref mut st) = *state_guard {
                st.child_pid = Some(pid);
            }
        }

        let stderr = child.stderr.take();
        let mut last_emit = Instant::now();
        let mut last_progress = 0i32;
        let mut current_speed = "0 B/s".to_string();
        let mut current_speed_bytes = 0u64;
        let mut current_disk_speed = "0 B/s".to_string();
        let mut current_disk_bytes = 0u64;
        let mut current_eta = "--".to_string();

        if let Some(err_stream) = stderr {
            let mut lines = CrlfLines::new(err_stream);
            while let Some(line) = lines.next_line().await {
                let mut dirty = false;

                if let Some(p) = parse_progress(&line) {
                    if p != last_progress {
                        last_progress = p;
                        dirty = true;
                    }
                }
                if let Some(eta) = parse_eta(&line) {
                    current_eta = eta;
                    dirty = true;
                }
                if let Some((sp_str, bytes)) = parse_speed(&line, "Download") {
                    current_speed = sp_str;
                    current_speed_bytes = bytes;
                    dirty = true;
                }
                if let Some((disk_str, bytes)) = parse_speed(&line, "Disk") {
                    current_disk_speed = disk_str;
                    current_disk_bytes = bytes;
                    dirty = true;
                }

                // Throttle UI emits to 250ms to prevent DOM thrashing
                if dirty && last_emit.elapsed().as_millis() >= 250 {
                    last_emit = Instant::now();
                    let _ = app_clone.emit(
                        "download-progress",
                        DlProgressPayload {
                            id: comp_id_clone.clone(),
                            progress: last_progress,
                            done: false,
                            speed: current_speed.clone(),
                            speed_bytes: current_speed_bytes,
                            disk_speed: current_disk_speed.clone(),
                            disk_bytes: current_disk_bytes,
                            eta: current_eta.clone(),
                            downloaded_bytes: None,
                            total_bytes: None,
                        },
                    );
                }
            }
        }

        let status = child.wait().await;
        let mut state_guard = GOG_DL_STATE.lock().unwrap();
        *state_guard = None;

        match status {
            Ok(s) if s.success() => {
                // Record local install entry
                let mut installed_map = load_installed_games(&app_clone);
                let info = scan_gog_info(&target_dir_clone, &clean_id_clone).unwrap_or(
                    GogInstalledInfo {
                        game_id: clean_id_clone.clone(),
                        title: clean_id_clone.clone(),
                        install_path: target_dir_clone.to_string_lossy().to_string(),
                        version: "1.0.0".to_string(),
                        install_size: 0,
                        executable: None,
                    },
                );
                installed_map.insert(clean_id_clone.clone(), info);
                let _ = save_installed_games(&app_clone, &installed_map);

                let _ = app_clone.emit(
                    "download-progress",
                    DlProgressPayload {
                        id: comp_id_clone,
                        progress: 100,
                        done: true,
                        speed: "0 B/s".to_string(),
                        speed_bytes: 0,
                        disk_speed: "0 B/s".to_string(),
                        disk_bytes: 0,
                        eta: "0s".to_string(),
                        downloaded_bytes: None,
                        total_bytes: None,
                    },
                );
            }
            Ok(s) => {
                let _ = app_clone.emit(
                    "download-failed",
                    DlFailedPayload {
                        id: comp_id_clone,
                        message: format!("gogdl exited with code {}", s.code().unwrap_or(-1)),
                    },
                );
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "download-failed",
                    DlFailedPayload {
                        id: comp_id_clone,
                        message: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

/// Cancels an in-progress GOG download.
#[command]
pub async fn gog_cancel_download(app: AppHandle, game_id: String) -> Result<(), String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let composite_id = format!("gog::{clean_id}");

    let pid_to_kill = {
        let state_guard = GOG_DL_STATE.lock().unwrap();
        if let Some(ref st) = *state_guard {
            if st.active_game_id.as_deref() == Some(&composite_id) {
                st.child_pid
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some(pid) = pid_to_kill {
        #[cfg(windows)]
        {
            let mut kill_cmd = tokio::process::Command::new("taskkill");
            kill_cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            kill_cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = kill_cmd.output().await;
        }
    }

    {
        let mut state_guard = GOG_DL_STATE.lock().unwrap();
        *state_guard = None;
    }

    let _ = app.emit(
        "download-cancelled",
        DlCancelledPayload {
            id: composite_id,
        },
    );

    Ok(())
}
