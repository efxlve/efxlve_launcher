//! GOG game download, update, and transfer management via `gogdl` CLI.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{command, AppHandle, Emitter};
use tokio::io::{AsyncRead, AsyncReadExt};

use super::cache::{load_installed_games, save_installed_games};
use super::cmd_error;
use super::models::GogInstalledInfo;
use super::paths::{auth_json_path, ensure_binary};

/// gogdl's progress thread keeps printing the same counters when its workers
/// wedge, so a repeated line is not movement. Same window as the other stores.
const STALL_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// Before the progress bar starts gogdl only fetches build data. Complete
/// silence for this long is a dead request, not a slow disk.
const STARTUP_STALL: Duration = Duration::from_secs(10 * 60);
/// At the very end gogdl applies patches and removes old files.
const FINALIZE_STALL: Duration = Duration::from_secs(15 * 60);
/// How often the reader checks the activity clock while no line arrives.
const STALL_POLL: Duration = Duration::from_secs(15);

#[derive(Default)]
pub struct GogDlState {
    pub active_game_id: Option<String>,
    pub child_pid: Option<u32>,
    pub paused: bool,
    /// Set by the cancel command so the monitor does not also report the
    /// process exit as a failure.
    pub cancelled: bool,
}

pub static GOG_DL_STATE: Mutex<Option<GogDlState>> = Mutex::new(None);

/// True while the user has this transfer paused; a suspended process emits no
/// progress and must not be mistaken for a stalled one.
fn download_paused(composite_id: &str) -> bool {
    GOG_DL_STATE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .is_some_and(|state| {
            state.active_game_id.as_deref() == Some(composite_id) && state.paused
        })
}

/// Ends a gogdl process; the tree flag matters if it ever starts a helper.
async fn kill_gogdl(pid: u32) {
    #[cfg(windows)]
    {
        let mut kill_cmd = tokio::process::Command::new("taskkill");
        kill_cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        kill_cmd.creation_flags(CREATE_NO_WINDOW);
        let _ = kill_cmd.output().await;
    }
    #[cfg(unix)]
    {
        // gogdl runs in its own process group, so this reaches its workers.
        let _ = tokio::process::Command::new("kill")
            .args(["-9", &format!("-{pid}")])
            .output()
            .await;
    }
}

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

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct VerifyProgressPayload {
    id: String,
    current: u64,
    total: u64,
    percent: f64,
    speed: String,
    detail: String,
}

#[derive(serde::Serialize, Clone)]
struct VerifyCompletePayload {
    id: String,
    success: bool,
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
            if let Some(pos) = self.pending.iter().position(|&b| b == b'\n' || b == b'\r') {
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

/// Raw percentage from a `= Progress: 45.20` line. The watchdog needs the
/// fraction; the UI rounds it.
fn parse_progress_value(line: &str) -> Option<f64> {
    let idx = line.find("Progress:")? + "Progress:".len();
    let rest = line[idx..].trim_start();
    let end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    if end == 0 {
        return None;
    }
    rest[..end].parse().ok()
}

/// Parses progress percentage from `= Progress: 45.20%` lines.
fn parse_progress(line: &str) -> Option<i32> {
    Some((parse_progress_value(line)?.round() as i32).clamp(0, 100))
}

/// Bytes already written, from the `written/total` pair after the percentage.
fn parse_written_bytes(line: &str) -> Option<u64> {
    let idx = line.find("Progress:")? + "Progress:".len();
    let sizes = line[idx..].split_whitespace().nth(1)?;
    let (done, _total) = sizes.split_once('/')?;
    done.trim().trim_end_matches(',').parse().ok()
}

/// Parses ETA string from `ETA: 00:02:30` lines.
fn parse_eta(line: &str) -> Option<String> {
    let idx = line.find("ETA:")? + "ETA:".len();
    let rest = line[idx..].trim();
    let end = rest
        .find(|c: char| c == ' ' || c == ',' || c == '\t')
        .unwrap_or(rest.len());
    let eta = rest[..end].trim();
    if !eta.is_empty() {
        Some(eta.to_string())
    } else {
        None
    }
}

/// Turns the last informative gogdl lines into a message the user can act on.
/// "exited with code 1" alone says nothing about a full disk or a dead session.
fn failure_text(tail: &VecDeque<String>, code: Option<i32>) -> String {
    let joined = tail
        .iter()
        .map(String::as_str)
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    if joined.contains("no space left")
        || joined.contains("disk full")
        || joined.contains("notenoughspace")
        || (joined.contains("not enough") && joined.contains("space"))
    {
        return "@t:dl.diskFull".to_string();
    }
    if joined.contains("permission denied")
        || joined.contains("permissionerror")
        || joined.contains("access is denied")
        || joined.contains("read-only file system")
    {
        return "@t:dl.permissionDenied".to_string();
    }
    if let Some(line) = tail.iter().rev().find_map(|line| {
        let low = line.to_lowercase();
        let cause = low.contains("error") || low.contains("failed") || low.contains("exception");
        (cause && !line.trim().is_empty()).then(|| line.trim().to_string())
    }) {
        return line;
    }
    match code {
        Some(code) => format!("gogdl exited with code {code}"),
        None => "gogdl stopped".to_string(),
    }
}

/// Parses speed value from `+ Download - 25.40 MiB/s` or `+ Disk - 15.20 MiB/s` lines.
fn parse_speed(line: &str, keyword: &str) -> Option<(String, u64)> {
    let idx = line.find(keyword)? + keyword.len();
    let rest = line[idx..].trim_start();
    let clean = rest.trim_start_matches('-').trim_start();
    // The slash belongs to the unit (`MiB/s`); only a parenthesis or comma
    // starts the next field.
    let end = clean
        .find(|c: char| c == '(' || c == ',')
        .unwrap_or(clean.len());
    let part = clean[..end].trim();
    if part.is_empty() {
        return None;
    }

    let tokens: Vec<&str> = part.split_whitespace().collect();
    if tokens.len() < 2 {
        return None;
    }
    let num = tokens[0].parse::<f64>().ok()?;
    let unit = tokens[1].to_lowercase();
    // gogdl may log cumulative sizes (`Downloaded: 1.2 GiB`); only a rate is
    // a speed, otherwise the card would show that size as the live rate.
    if !unit.contains("/s") {
        return None;
    }
    let bytes = if unit.starts_with("gib") || unit.starts_with("gb") {
        (num * 1024.0 * 1024.0 * 1024.0) as u64
    } else if unit.starts_with("mib") || unit.starts_with("mb") {
        (num * 1024.0 * 1024.0) as u64
    } else if unit.starts_with("kib") || unit.starts_with("kb") {
        (num * 1024.0) as u64
    } else {
        num as u64
    };

    Some((part.to_string(), bytes))
}

/// Parses `goggame-<id>.info` in target directory if it exists to extract executable path.
pub fn scan_gog_info(target_dir: &Path, game_id: &str) -> Option<GogInstalledInfo> {
    let info_path = target_dir.join(format!("goggame-{game_id}.info"));
    if !info_path.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(&info_path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&text).ok()?;

    let title = val
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let version = val
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("1.0.0")
        .to_string();
    let build_id = val
        .get("buildId")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let mut exe: Option<String> = None;

    if let Some(tasks) = val.get("playTasks").and_then(|v| v.as_array()) {
        for t in tasks {
            let is_primary = t
                .get("isPrimary")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
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
        build_id,
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

    // One gogdl at a time. A second start would replace the state, and the
    // first monitor would then drop its completion without recording the
    // install, so the next launch would download the same game again.
    {
        let state = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .as_ref()
            .is_some_and(|st| st.active_game_id.is_some() && !st.cancelled)
        {
            return Err("@t:dl.anotherActive".into());
        }
    }

    // Claim the single GOG slot before the binary check; a second caller must
    // not slip past the guard while the first is still preparing.
    {
        let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
        *state_guard = Some(GogDlState {
            active_game_id: Some(composite_id.clone()),
            child_pid: None,
            paused: false,
            cancelled: false,
        });
    }
    let bin_path = match ensure_binary(&app).await {
        Ok(path) => path,
        Err(e) => {
            let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
            if state_guard
                .as_ref()
                .is_some_and(|st| st.active_game_id.as_deref() == Some(composite_id.as_str()))
            {
                *state_guard = None;
            }
            return Err(cmd_error(e));
        }
    };
    let auth_path = auth_json_path(&app);

    // Target installation directory: the caller's pick first, then the folder
    // chosen in Settings → Downloads, then `<home>/Games/GOG`.
    let target_dir = install_path
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            let base = crate::load_settings(&app)
                .gog_install_dir
                .filter(|path| !path.trim().is_empty())
                .map(PathBuf::from)
                .unwrap_or_else(|| {
                    std::env::var_os("USERPROFILE")
                        .or_else(|| std::env::var_os("HOME"))
                        .map(PathBuf::from)
                        .unwrap_or_else(|| PathBuf::from("."))
                        .join("Games")
                        .join("GOG")
                });
            base.join(&clean_id)
        });
    let _ = tokio::fs::create_dir_all(&target_dir).await;

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
    // Same network profile as Epic: gogdl takes the worker count directly.
    let workers = crate::profile_workers(crate::load_settings(&app).network_profile.as_deref());

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
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // gogdl uses requests, so the shared cap proxy covers its downloads.
        crate::download_limit::configure_child(&mut cmd);
        if let Some(workers) = workers {
            cmd.arg("--max-workers").arg(workers);
        }

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.as_std_mut().process_group(0);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                // A stale active_game_id would make every later gogdl action
                // report "another download is running".
                let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
                if state_guard
                    .as_ref()
                    .is_some_and(|st| st.active_game_id.as_deref() == Some(&comp_id_clone))
                {
                    *state_guard = None;
                }
                drop(state_guard);
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
            // The user can cancel between the state claim and this spawn; the
            // pid has to be seen by that cancel, or the process keeps writing.
            let cancelled_before_pid = {
                let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
                match state_guard.as_mut() {
                    Some(st) if st.active_game_id.as_deref() == Some(&composite_id) => {
                        if st.cancelled {
                            true
                        } else {
                            st.child_pid = Some(pid);
                            false
                        }
                    }
                    _ => false,
                }
            };
            if cancelled_before_pid {
                kill_gogdl(pid).await;
                let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
                if state_guard.as_ref().is_some_and(|st| {
                    st.active_game_id.as_deref() == Some(comp_id_clone.as_str()) && st.cancelled
                }) {
                    *state_guard = None;
                }
                return;
            }
        }

        let stderr = child.stderr.take();
        // Drain stdout too: gogdl prints the disk-space refusal there, and an
        // unread pipe can block the child once its buffer fills.
        let mut stdout_pipe = child.stdout.take();
        let stdout_task = tokio::spawn(async move {
            let mut text = String::new();
            if let Some(stdout) = stdout_pipe.as_mut() {
                let mut lines = CrlfLines::new(stdout);
                while let Some(line) = lines.next_line().await {
                    if text.len() < 8192 {
                        text.push_str(&line);
                        text.push('\n');
                    }
                }
            }
            text
        });
        let mut last_emit = Instant::now();
        let mut last_progress = 0i32;
        let mut current_speed = "0 B/s".to_string();
        let mut current_speed_bytes = 0u64;
        let mut current_disk_speed = "0 B/s".to_string();
        let mut current_disk_bytes = 0u64;
        let mut current_eta = "--".to_string();
        // Progress lines churn once a second; keep the last few informative
        // lines so a failure can name its cause instead of an exit code.
        let mut tail: VecDeque<String> = VecDeque::with_capacity(40);
        let mut stalled = false;

        if let Some(err_stream) = stderr {
            let mut lines = CrlfLines::new(err_stream);
            let mut last_line = Instant::now();
            let mut last_moved = Instant::now();
            let mut last_pct: Option<f64> = None;
            let mut last_bytes: Option<u64> = None;
            loop {
                let line = match tokio::time::timeout(STALL_POLL, lines.next_line()).await {
                    Ok(Some(line)) => line,
                    Ok(None) => break,
                    Err(_) => {
                        let now = Instant::now();
                        // A paused transfer is not stalled; restart both
                        // clocks so resuming gets a fresh window.
                        if download_paused(&comp_id_clone) {
                            last_line = now;
                            last_moved = now;
                            continue;
                        }
                        let (since, limit) = if last_pct.is_none() {
                            (now.saturating_duration_since(last_line), STARTUP_STALL)
                        } else if last_pct.is_some_and(|pct| pct >= 99.0) {
                            (now.saturating_duration_since(last_moved), FINALIZE_STALL)
                        } else {
                            (now.saturating_duration_since(last_moved), STALL_TIMEOUT)
                        };
                        if since >= limit {
                            if let Some(pid) = child.id() {
                                kill_gogdl(pid).await;
                            }
                            stalled = true;
                            break;
                        }
                        continue;
                    }
                };
                last_line = Instant::now();
                // The progress thread repeats the same counters while workers
                // are stuck, so movement means either the fraction or the
                // written byte count changed.
                if let Some(pct) = parse_progress_value(&line) {
                    let bytes = parse_written_bytes(&line);
                    let moved = last_pct.is_none()
                        || last_pct != Some(pct)
                        || last_bytes.is_some_and(|prev| bytes.is_some_and(|b| b != prev));
                    if moved {
                        last_moved = Instant::now();
                    }
                    last_pct = Some(pct);
                    if let Some(b) = bytes {
                        last_bytes = Some(b);
                    }
                }
                let mut dirty = false;
                let mut informative = true;

                if let Some(p) = parse_progress(&line) {
                    informative = false;
                    if p != last_progress {
                        last_progress = p;
                        dirty = true;
                    }
                }
                if let Some(eta) = parse_eta(&line) {
                    informative = false;
                    current_eta = eta;
                    dirty = true;
                }
                if let Some((sp_str, bytes)) = parse_speed(&line, "Download") {
                    informative = false;
                    current_speed = sp_str;
                    current_speed_bytes = bytes;
                    dirty = true;
                }
                if let Some((disk_str, bytes)) = parse_speed(&line, "Disk") {
                    informative = false;
                    current_disk_speed = disk_str;
                    current_disk_bytes = bytes;
                    dirty = true;
                }
                // The second counter line repeats every second with the first.
                if line.trim_start().starts_with("= Downloaded:") {
                    informative = false;
                }
                if informative && !line.trim().is_empty() {
                    if tail.len() >= 40 {
                        tail.pop_front();
                    }
                    tail.push_back(line.clone());
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

        // The stderr pipe closes before the process exits; a killed transfer
        // must not leave the monitor waiting on a process that ignored the
        // first kill.
        let status: Result<std::process::ExitStatus, String> =
            match tokio::time::timeout(Duration::from_secs(30), child.wait()).await {
                Ok(Ok(status)) => Ok(status),
                Ok(Err(error)) => Err(error.to_string()),
                Err(_) => Err("gogdl did not exit".to_string()),
            };
        let (owns_state, was_cancelled) = {
            let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
            let owns = state_guard
                .as_ref()
                .is_some_and(|st| st.active_game_id.as_deref() == Some(comp_id_clone.as_str()));
            let cancelled = owns && state_guard.as_ref().is_some_and(|st| st.cancelled);
            if owns {
                *state_guard = None;
            }
            (owns, cancelled)
        };
        // A newer attempt may already own the state; an old monitor must not
        // clear it or report a stale failure over the new row.
        if !owns_state {
            return;
        }
        let stdout_text = tokio::time::timeout(Duration::from_secs(5), stdout_task)
            .await
            .ok()
            .and_then(|task| task.ok())
            .unwrap_or_default();
        for line in stdout_text.lines() {
            if tail.len() >= 40 {
                tail.pop_front();
            }
            tail.push_back(line.trim().to_string());
        }

        match status {
            Ok(s) if s.success() => {
                // Record local install entry
                let mut installed_map = load_installed_games(&app_clone);
                let info =
                    scan_gog_info(&target_dir_clone, &clean_id_clone).unwrap_or(GogInstalledInfo {
                        game_id: clean_id_clone.clone(),
                        title: clean_id_clone.clone(),
                        install_path: target_dir_clone.to_string_lossy().to_string(),
                        version: "1.0.0".to_string(),
                        install_size: 0,
                        executable: None,
                        build_id: String::new(),
                    });
                // Keep GOG Galaxy's registry entry in step so the official client
                // does not offer the update we just installed. Best effort.
                super::galaxy::sync_galaxy_version(&clean_id_clone, &info.version, &info.build_id);
                // Freshly installed build is up to date: refresh the update cache.
                super::updates::store_installed_build(
                    &app_clone,
                    &clean_id_clone,
                    &info.build_id,
                    &info.version,
                );
                installed_map.insert(clean_id_clone.clone(), info);
                let _ = save_installed_games(&app_clone, &installed_map);
                // A cancel already removed the row and told the user it stopped;
                // a late completion must not resurrect it.
                if was_cancelled {
                    return;
                }

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
                if was_cancelled {
                    return;
                }
                let message = if stalled {
                    "@t:dl.stalled".to_string()
                } else {
                    failure_text(&tail, s.code())
                };
                let _ = app_clone.emit(
                    "download-failed",
                    DlFailedPayload {
                        id: comp_id_clone,
                        message,
                    },
                );
            }
            Err(e) => {
                if was_cancelled {
                    return;
                }
                let message = if stalled {
                    "@t:dl.stalled".to_string()
                } else if tail.is_empty() {
                    e
                } else {
                    failure_text(&tail, None)
                };
                let _ = app_clone.emit(
                    "download-failed",
                    DlFailedPayload {
                        id: comp_id_clone,
                        message,
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

    // Set the flag before the kill: the monitor can see the process exit the
    // moment taskkill lands, and it must already know this was a cancel.
    // The state stays until the monitor reaps the exit.
    let pid_to_kill = {
        let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(st) = state_guard.as_mut() {
            if st.active_game_id.as_deref() == Some(composite_id.as_str()) {
                st.cancelled = true;
                st.child_pid.take()
            } else {
                None
            }
        } else {
            None
        }
    };

    if let Some(pid) = pid_to_kill {
        kill_gogdl(pid).await;
    }

    let _ = app.emit(
        "download-cancelled",
        DlCancelledPayload { id: composite_id },
    );

    Ok(())
}

fn gog_pid_for(composite_id: &str) -> Option<(u32, bool)> {
    let state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
    let st = state_guard.as_ref()?;
    if st.active_game_id.as_deref() != Some(composite_id) {
        return None;
    }
    Some((st.child_pid?, st.paused))
}

/// Pauses an in-progress GOG download by suspending the gogdl process tree.
#[command]
pub async fn gog_pause_download(app: AppHandle, game_id: String) -> Result<String, String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let composite_id = format!("gog::{clean_id}");
    let (pid, already) =
        gog_pid_for(&composite_id).ok_or_else(|| "@t:gog.notDownloading".to_string())?;
    if already {
        return Ok("@t:dl.paused".to_string());
    }
    #[cfg(windows)]
    super::win_job::suspend_tree(pid)?;
    #[cfg(unix)]
    {
        let status = tokio::process::Command::new("kill")
            .args(["-STOP", &format!("-{pid}")])
            .status()
            .await
            .map_err(|e| format!("@t:err.io\u{1f}{e}"))?;
        if !status.success() {
            return Err(format!(
                "@t:err.commandFailed\u{1f}{}\u{1f}kill -STOP",
                status.code().unwrap_or(-1)
            ));
        }
    }
    {
        let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut st) = *state_guard {
            if st.active_game_id.as_deref() == Some(composite_id.as_str()) {
                st.paused = true;
            }
        }
    }
    let _ = app.emit("download-paused", DlCancelledPayload { id: composite_id });
    Ok("@t:dl.paused".to_string())
}

/// Resumes a paused GOG download.
#[command]
pub async fn gog_resume_download(app: AppHandle, game_id: String) -> Result<String, String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let composite_id = format!("gog::{clean_id}");
    let (pid, paused) =
        gog_pid_for(&composite_id).ok_or_else(|| "@t:gog.notDownloading".to_string())?;
    if !paused {
        return Ok("@t:dl.resumed".to_string());
    }
    #[cfg(windows)]
    super::win_job::resume_tree(pid)?;
    #[cfg(unix)]
    {
        let status = tokio::process::Command::new("kill")
            .args(["-CONT", &format!("-{pid}")])
            .status()
            .await
            .map_err(|e| format!("@t:err.io\u{1f}{e}"))?;
        if !status.success() {
            return Err(format!(
                "@t:err.commandFailed\u{1f}{}\u{1f}kill -CONT",
                status.code().unwrap_or(-1)
            ));
        }
    }
    {
        let mut state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(ref mut st) = *state_guard {
            if st.active_game_id.as_deref() == Some(composite_id.as_str()) {
                st.paused = false;
            }
        }
    }
    let _ = app.emit("download-resumed", DlCancelledPayload { id: composite_id });
    Ok("@t:dl.resumed".to_string())
}

/// Helper to calculate directory size iteratively.
pub fn calculate_dir_size(root: &Path) -> u64 {
    let mut total = 0u64;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for entry in entries.flatten() {
                if let Ok(meta) = entry.metadata() {
                    if meta.is_file() {
                        total = total.saturating_add(meta.len());
                    } else if meta.is_dir() {
                        stack.push(entry.path());
                    }
                }
            }
        }
    }
    total
}

/// Helper to scan for the best main executable in a game directory if not in goggame-*.info.
pub fn find_fallback_exe(dir: &Path) -> Option<String> {
    if let Ok(entries) = std::fs::read_dir(dir) {
        let mut candidates: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let p = entry.path();
            if p.is_file() {
                if let Some(ext) = p.extension() {
                    if ext.eq_ignore_ascii_case("exe") {
                        if let Some(name) = p.file_name().and_then(|n| n.to_str()) {
                            let lower = name.to_ascii_lowercase();
                            if !lower.starts_with("unins")
                                && !lower.starts_with("crash")
                                && !lower.starts_with("unitycrash")
                                && !lower.contains("redist")
                            {
                                candidates.push(name.to_string());
                            }
                        }
                    }
                }
            }
        }
        if let Some(first) = candidates.into_iter().next() {
            return Some(first);
        }
    }
    None
}

/// Uninstalls an installed GOG game. Stops any running instance, removes the
/// folder, and removes the game entry from `installed.json`.
#[command]
pub async fn gog_uninstall_game(app: AppHandle, game_id: String) -> Result<String, String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let composite_id = format!("gog::{clean_id}");

    // Terminate running instance if any
    let _ = super::launcher::gog_stop_game(app.clone(), composite_id).await;

    let mut installed_map = load_installed_games(&app);
    let info = installed_map
        .remove(&clean_id)
        .ok_or_else(|| "@t:dl.notInstalled".to_string())?;

    let path_str = info.install_path.trim();
    if !path_str.is_empty() {
        let p = Path::new(path_str);
        if p.exists() && p.is_dir() {
            if let Err(e) = tokio::fs::remove_dir_all(p).await {
                eprintln!("Could not delete GOG install dir '{}': {}", path_str, e);
            }
        }
    }

    // Drop GOG Galaxy's registry entry as well, otherwise the official client
    // keeps showing a broken install (same reason we delete Epic `.item`s).
    super::galaxy::remove_galaxy_registry(&clean_id);

    save_installed_games(&app, &installed_map).map_err(|e| format!("@t:err.io\u{1f}{e}"))?;

    Ok(format!("@t:dl.uninstalled\u{1f}{}", info.title))
}

/// Imports an existing local GOG game installation into `installed.json`.
#[command]
pub async fn gog_import_game(
    app: AppHandle,
    game_id: String,
    install_path: String,
) -> Result<GogInstalledInfo, String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let target = PathBuf::from(install_path.trim());
    if !target.is_dir() {
        return Err("@t:settings.importInstalledMissing".to_string());
    }

    let mut info = scan_gog_info(&target, &clean_id).unwrap_or_else(|| GogInstalledInfo {
        game_id: clean_id.clone(),
        title: clean_id.clone(),
        install_path: target.to_string_lossy().to_string(),
        version: "1.0.0".to_string(),
        install_size: 0,
        executable: None,
        build_id: String::new(),
    });

    if info.executable.is_none() {
        info.executable = find_fallback_exe(&target);
    }
    info.install_size = calculate_dir_size(&target);

    let mut installed_map = load_installed_games(&app);
    installed_map.insert(clean_id, info.clone());
    save_installed_games(&app, &installed_map).map_err(|e| format!("@t:err.io\u{1f}{e}"))?;

    Ok(info)
}

/// Verifies and repairs an installed GOG game through `gogdl repair`.
#[command]
pub async fn gog_verify_game(app: AppHandle, game_id: String) -> Result<(), String> {
    let clean_id = game_id.trim().trim_start_matches("gog::").to_string();
    let composite_id = format!("gog::{clean_id}");

    {
        let state_guard = GOG_DL_STATE.lock().unwrap_or_else(|e| e.into_inner());
        if state_guard
            .as_ref()
            .and_then(|s| s.active_game_id.as_deref())
            .is_some()
        {
            return Err("@t:gog.verifyBusy".to_string());
        }
    }

    let installed_map = load_installed_games(&app);
    let info = installed_map
        .get(&clean_id)
        .ok_or_else(|| "@t:dl.notInstalled".to_string())?;
    let target_dir = PathBuf::from(info.install_path.trim());
    if !target_dir.is_dir() {
        return Err("@t:settings.importInstalledMissing".to_string());
    }

    let bin_path = ensure_binary(&app).await.map_err(cmd_error)?;
    let auth_path = auth_json_path(&app);
    let app_clone = app.clone();
    let id_clone = composite_id.clone();
    let clean_clone = clean_id.clone();
    let target_clone = target_dir.clone();

    tokio::spawn(async move {
        let mut cmd = tokio::process::Command::new(&bin_path);
        cmd.arg("--auth-config-path")
            .arg(&auth_path)
            .arg("repair")
            .arg(&clean_clone)
            .arg("--path")
            .arg(&target_clone)
            .arg("--platform")
            .arg("windows")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        // A repair can download missing files, so it shares the same cap.
        crate::download_limit::configure_child(&mut cmd);

        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x08000000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.as_std_mut().process_group(0);
        }

        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) => {
                let _ = app_clone.emit(
                    "verify-complete",
                    VerifyCompletePayload {
                        id: id_clone,
                        success: false,
                        message: e.to_string(),
                    },
                );
                return;
            }
        };

        let stderr = child.stderr.take();
        let mut last_progress = 0i32;
        if let Some(err_stream) = stderr {
            let mut lines = CrlfLines::new(err_stream);
            while let Some(line) = lines.next_line().await {
                if let Some(p) = parse_progress(&line) {
                    if p == last_progress {
                        continue;
                    }
                    last_progress = p;
                    let _ = app_clone.emit(
                        "verify-progress",
                        VerifyProgressPayload {
                            id: id_clone.clone(),
                            current: p as u64,
                            total: 100,
                            percent: p as f64,
                            speed: String::new(),
                            detail: format!("{p}%"),
                        },
                    );
                }
            }
        }

        match child.wait().await {
            Ok(status) if status.success() => {
                let _ = app_clone.emit(
                    "verify-complete",
                    VerifyCompletePayload {
                        id: id_clone,
                        success: true,
                        message: "@t:verify.success".to_string(),
                    },
                );
            }
            Ok(status) => {
                let _ = app_clone.emit(
                    "verify-complete",
                    VerifyCompletePayload {
                        id: id_clone,
                        success: false,
                        message: format!(
                            "gogdl repair exited with code {}",
                            status.code().unwrap_or(-1)
                        ),
                    },
                );
            }
            Err(e) => {
                let _ = app_clone.emit(
                    "verify-complete",
                    VerifyCompletePayload {
                        id: id_clone,
                        success: false,
                        message: e.to_string(),
                    },
                );
            }
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::{self, File};
    use std::io::Write;

    #[test]
    fn speed_parser_ignores_cumulative_sizes() {
        assert_eq!(
            parse_speed("+ Download\t- 12.50 MiB/s", "Download"),
            Some(("12.50 MiB/s".to_string(), 13_107_200))
        );
        // A size, not a rate: the card must not show "1.20 GiB" as the speed.
        assert_eq!(parse_speed("Downloaded: 1.20 GiB", "Download"), None);
        assert_eq!(parse_speed("= Progress: 10.00%", "Download"), None);
    }

    #[test]
    fn progress_and_eta_lines_parse() {
        assert_eq!(
            parse_progress("[Progress] = Progress: 42.13% (123/456)"),
            Some(42)
        );
        assert_eq!(parse_eta("ETA: 00:01:22, speed 4 MiB/s"), Some("00:01:22".into()));

        // The watchdog compares the unrounded fraction and the byte counter.
        let line = "INFO [PROGRESS]:\t = Progress: 42.13 123456/456789, Running for: 00:01:23";
        assert_eq!(parse_progress_value(line), Some(42.13));
        assert_eq!(parse_written_bytes(line), Some(123_456));
        assert_eq!(
            parse_written_bytes("[Progress] = Progress: 42.13% (123/456)"),
            None
        );
    }

    #[test]
    fn a_failed_transfer_names_its_cause() {
        let mut full = VecDeque::new();
        full.push_back("Starting download".to_string());
        full.push_back("ERROR: Not enough space available".to_string());
        assert_eq!(failure_text(&full, Some(1)), "@t:dl.diskFull");
        let mut full_error = VecDeque::new();
        full_error.push_back("NotEnoughSpaceError: 4 GiB needed".to_string());
        assert_eq!(failure_text(&full_error, Some(1)), "@t:dl.diskFull");

        let mut denied = VecDeque::new();
        denied.push_back("Permission denied while writing chunk".to_string());
        assert_eq!(failure_text(&denied, Some(1)), "@t:dl.permissionDenied");

        let mut auth = VecDeque::new();
        auth.push_back("ERROR: Not logged in".to_string());
        assert_eq!(failure_text(&auth, Some(1)), "ERROR: Not logged in");

        assert_eq!(
            failure_text(&VecDeque::new(), Some(2)),
            "gogdl exited with code 2"
        );
        assert_eq!(failure_text(&VecDeque::new(), None), "gogdl stopped");
    }

    #[test]
    fn test_calculate_dir_size() {
        let temp = std::env::temp_dir().join("efxlve_test_dir_size");
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();
        let sub = temp.join("sub");
        fs::create_dir_all(&sub).unwrap();

        fs::write(temp.join("file1.bin"), b"12345").unwrap(); // 5 bytes
        fs::write(sub.join("file2.bin"), b"1234567").unwrap(); // 7 bytes

        let total = calculate_dir_size(&temp);
        assert_eq!(total, 12);

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_find_fallback_exe() {
        let temp = std::env::temp_dir().join("efxlve_test_fallback_exe");
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        // Create unins000.exe and Game.exe
        File::create(temp.join("unins000.exe")).unwrap();
        File::create(temp.join("Game.exe")).unwrap();

        let found = find_fallback_exe(&temp);
        assert_eq!(found.as_deref(), Some("Game.exe"));

        let _ = fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_scan_gog_info() {
        let temp = std::env::temp_dir().join("efxlve_test_gog_info");
        let _ = fs::remove_dir_all(&temp);
        fs::create_dir_all(&temp).unwrap();

        let info_content = r#"{
            "gameId": "123456",
            "name": "Test Game",
            "version": "1.0.3",
            "playTasks": [
                {
                    "isPrimary": true,
                    "path": "bin\\TestGame.exe",
                    "type": "FileTask"
                }
            ]
        }"#;

        let mut f = File::create(temp.join("goggame-123456.info")).unwrap();
        f.write_all(info_content.as_bytes()).unwrap();

        let info = scan_gog_info(&temp, "123456");
        assert!(info.is_some());
        let val = info.unwrap();
        assert_eq!(val.title, "Test Game");
        assert_eq!(val.version, "1.0.3");
        assert_eq!(val.executable.as_deref(), Some("bin\\TestGame.exe"));

        let _ = fs::remove_dir_all(&temp);
    }
}
