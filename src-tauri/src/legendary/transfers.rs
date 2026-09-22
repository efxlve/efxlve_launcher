//! Game download/install: `legendary install` wrapper + queue + cancel.
//!
//! Contract: progress flows through the existing `download-progress` event
//! (`{id, progress, done}`), hata `download-failed`, iptal
//! and cancellation is reported via `download-cancelled`. Only one active download at a time.
//!
//! Patterns borrowed from Heroic: `-y --skip-dlcs --skip-sdl`, and on MemoryError
//! `--max-shared-memory 5000` ile tekrar, stdout regex parse, indirme
//! a fresh process per attempt (partial files resume on the next run).
//!
//! Concurrency note: the child process belongs to the monitor task; shared
//! state is held only across short critical sections (never hold a lock
//! across an await). Cancellation is enforced by the OS via the PID.

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, BufReader};

use super::{cmd_error, paths};
use crate::{load_settings, AppState};

pub struct EpicDlState {
    pub active: Option<String>,
    pub pid: Option<u32>,
    pub cancelled: bool,
    pub paused: bool,
    queue: VecDeque<PendingDownload>,
    active_generation: Option<u64>,
    next_generation: u64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct PendingDownload {
    app_name: String,
    install_tags: Vec<String>,
    install_dir: Option<String>,
}

fn pending_download_path() -> PathBuf {
    super::skip::default_config_dir().join("efxlve-pending-download.json")
}

fn queued_downloads_path() -> PathBuf {
    super::skip::default_config_dir().join("efxlve-download-queue.json")
}

fn write_queue_snapshot(queue: &VecDeque<PendingDownload>) {
    let path = queued_downloads_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(queue) {
        let _ = std::fs::write(path, text);
    }
}

fn read_queue_snapshot() -> VecDeque<PendingDownload> {
    std::fs::read_to_string(queued_downloads_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

fn write_pending_download(app_name: &str, install_tags: &[String], install_dir: Option<&str>) {
    let path = pending_download_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let pending = PendingDownload {
        app_name: app_name.to_string(),
        install_tags: install_tags.to_vec(),
        install_dir: install_dir.map(str::to_string),
    };
    if let Ok(text) = serde_json::to_string_pretty(&pending) {
        let _ = std::fs::write(path, text);
    }
}

fn clear_pending_download() {
    let _ = std::fs::remove_file(pending_download_path());
}

impl Default for EpicDlState {
    fn default() -> Self {
        Self {
            active: None,
            pid: None,
            cancelled: false,
            paused: false,
            queue: VecDeque::new(),
            active_generation: None,
            next_generation: 0,
        }
    }
}

fn queue_names(queue: &VecDeque<PendingDownload>) -> Vec<String> {
    queue.iter().map(|item| item.app_name.clone()).collect()
}

fn start_download_request(app: &AppHandle, request: PendingDownload) -> Result<String, String> {
    let bin = resolve_bin(app)?;
    let base = resolve_base(app, request.install_dir.clone());
    let mut child = spawn_install_with_tags(
        app,
        &bin,
        &request.app_name,
        &base,
        false,
        &request.install_tags,
    )
    .map_err(|e| format!("@t:dl.startFailed\u{1f}{e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let pid = child.id();
    let generation = {
        let state = app.state::<AppState>();
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.is_some() {
            drop(s);
            drop(child);
            return Err("@t:dl.anotherStarted".into());
        }
        s.next_generation = s.next_generation.wrapping_add(1);
        let generation = s.next_generation;
        s.active = Some(request.app_name.clone());
        s.active_generation = Some(generation);
        s.pid = pid;
        s.cancelled = false;
        s.paused = false;
        generation
    };
    write_pending_download(
        &request.app_name,
        &request.install_tags,
        request.install_dir.as_deref(),
    );
    emit_progress(app, &request.app_name, 0, false);
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        monitor_download(
            app2,
            bin,
            request.app_name,
            base,
            request.install_tags,
            generation,
            child,
            stdout,
            stderr,
        )
        .await;
    });
    Ok("@t:dl.started".into())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DlProgress {
    pub id: String,
    pub progress: u8,
    pub done: bool,
    pub speed: Option<String>,
    pub speed_bytes: Option<u64>,
    pub disk_speed: Option<String>,
    pub disk_bytes: Option<u64>,
    pub eta: Option<String>,
    pub eta_seconds: Option<u64>,
    pub downloaded_bytes: Option<u64>,
    pub total_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DlPaused {
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DlQueueStatus {
    pub active: Option<String>,
    pub is_paused: bool,
    pub queue: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DlFailed {
    id: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DlCancelled {
    id: String,
}

#[allow(clippy::too_many_arguments)]
pub fn emit_progress_full(
    app: &AppHandle,
    id: &str,
    progress: u8,
    done: bool,
    speed: Option<String>,
    speed_bytes: Option<u64>,
    disk_speed: Option<String>,
    disk_bytes: Option<u64>,
    eta: Option<String>,
    eta_seconds: Option<u64>,
    downloaded_bytes: Option<u64>,
    total_bytes: Option<u64>,
) {
    let _ = app.emit(
        "download-progress",
        DlProgress {
            id: id.to_string(),
            progress,
            done,
            speed,
            speed_bytes,
            disk_speed,
            disk_bytes,
            eta,
            eta_seconds,
            downloaded_bytes,
            total_bytes,
        },
    );
}

fn emit_progress(app: &AppHandle, id: &str, progress: u8, done: bool) {
    emit_progress_full(
        app, id, progress, done, None, None, None, None, None, None, None, None,
    );
}

fn emit_paused(app: &AppHandle, id: &str) {
    let _ = app.emit(
        "download-paused",
        DlPaused {
            id: id.to_string(),
        },
    );
}

fn emit_failed(app: &AppHandle, id: &str, message: String) {
    let _ = app.emit(
        "download-failed",
        DlFailed {
            id: id.to_string(),
            message,
        },
    );
}

fn emit_cancelled(app: &AppHandle, id: &str) {
    let _ = app.emit(
        "download-cancelled",
        DlCancelled {
            id: id.to_string(),
        },
    );
}

/// Default install root: `<home>/Games` (same as legendary).
pub fn default_install_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE")
        .or_else(|_| std::env::var("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir());
    home.join("Games")
}

fn resolve_base(app: &AppHandle, override_dir: Option<String>) -> PathBuf {
    if let Some(p) = override_dir
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
    {
        return PathBuf::from(p);
    }
    load_settings(app)
        .install_dir
        .map(PathBuf::from)
        .unwrap_or_else(default_install_dir)
}

fn resolve_bin(app: &AppHandle) -> Result<PathBuf, String> {
    let settings = load_settings(app);
    paths::resolve_binary(app, settings.alt_legendary_bin.as_deref()).map_err(cmd_error)
}

/// Extracts seconds and the raw string from a "00:01:22" or "01:22" line.
pub fn parse_eta(line: &str) -> Option<(String, u64)> {
    let idx = line.find("ETA:")? + "ETA:".len();
    let rest = line[idx..].trim_start();
    let raw_eta: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == ':')
        .collect();
    if raw_eta.is_empty() || !raw_eta.contains(':') {
        return None;
    }
    let parts: Vec<&str> = raw_eta.split(':').collect();
    let secs = match parts.len() {
        2 => {
            let m: u64 = parts[0].parse().ok()?;
            let s: u64 = parts[1].parse().ok()?;
            m * 60 + s
        }
        3 => {
            let h: u64 = parts[0].parse().ok()?;
            let m: u64 = parts[1].parse().ok()?;
            let s: u64 = parts[2].parse().ok()?;
            h * 3600 + m * 60 + s
        }
        _ => return None,
    };
    Some((raw_eta, secs))
}

/// Extracts the speed from a "Download: 15.40 MiB/s" or "Speed: 12.5 MB/s" line.
pub fn parse_speed(line: &str, keys: &[&str]) -> Option<(String, u64)> {
    for key in keys {
        if let Some(idx) = line.find(key) {
            let rest = line[idx + key.len()..].trim_start();
            let num_end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ','))?;
            if num_end == 0 {
                continue;
            }
            let num: f64 = rest[..num_end].replace(',', ".").parse().ok()?;
            let after = rest[num_end..].trim_start();
            let unit: String = after
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '/')
                .collect();
            let unit_lower = unit.to_lowercase();
            let bytes_per_sec = if unit_lower.starts_with("gib") || unit_lower.starts_with("gb") {
                (num * 1024.0 * 1024.0 * 1024.0) as u64
            } else if unit_lower.starts_with("mib") || unit_lower.starts_with("mb") {
                (num * 1024.0 * 1024.0) as u64
            } else if unit_lower.starts_with("kib") || unit_lower.starts_with("kb") {
                (num * 1024.0) as u64
            } else {
                num as u64
            };
            let speed_str = format!("{num:.1} {unit}");
            return Some((speed_str, bytes_per_sec));
        }
    }
    None
}

/// MiB value from `Downloaded: 123.45 MiB` / `Download size: 123.45 MiB` lines.
fn parse_mib_after(line: &str, key: &str) -> Option<f64> {
    let rest = line.find(key).map(|i| &line[i + key.len()..])?.trim_start();
    let num_end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.' || c == ','))?;
    if num_end == 0 {
        return None;
    }
    let num: f64 = rest[..num_end].replace(',', ".").parse().ok()?;
    let after = rest[num_end..].trim_start();
    Some(if after.starts_with("GiB") {
        num * 1024.0
    } else {
        num
    })
}

/// Concurrent chunk download workers per network profile. Higher worker counts
/// saturate fast connections better (Epic's own launcher uses ChunkDownloads=32).
fn get_worker_count_arg(app: &AppHandle) -> Option<&'static str> {
    let s = load_settings(app);
    match s.network_profile.as_deref() {
        Some("max") => Some("32"),
        Some("low") => Some("2"),
        Some("balanced") => Some("8"),
        _ => None,
    }
}

/// Shared chunk-buffer memory (MiB) per network profile. Kept modest so low-RAM
/// machines (8 GB baseline) are never starved.
fn get_max_memory_arg(app: &AppHandle) -> Option<&'static str> {
    let s = load_settings(app);
    match s.network_profile.as_deref() {
        Some("max") => Some("2048"),
        Some("low") => Some("512"),
        Some("balanced") => Some("1024"),
        _ => None,
    }
}

fn spawn_install_with_tags(
    app: &AppHandle,
    bin: &PathBuf,
    app_name: &str,
    base: &PathBuf,
    high_mem: bool,
    install_tags: &[String],
) -> std::io::Result<tokio::process::Child> {
    let mut cmd = tokio::process::Command::new(bin);
    // Note: global flags (-y) come BEFORE the subcommand.
    cmd.arg("-y")
        .arg("install")
        .arg(app_name)
        .arg("--base-path")
        .arg(base)
        .arg("--skip-dlcs");

    if let Some(w) = get_worker_count_arg(app) {
        cmd.arg("--max-workers").arg(w);
    }

    // Preferred CDN (from the auto speed test) can noticeably improve throughput.
    if let Some(cdn) = load_settings(app).preferred_cdn.filter(|c| !c.trim().is_empty()) {
        cmd.arg("--preferred-cdn").arg(cdn);
    }

    if install_tags.is_empty() {
        cmd.arg("--skip-sdl");
    } else {
        for tag in install_tags {
            cmd.arg("--install-tag").arg(tag);
        }
    }

    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if high_mem {
        cmd.arg("--max-shared-memory").arg("5000");
    } else if let Some(m) = get_max_memory_arg(app) {
        cmd.arg("--max-shared-memory").arg(m);
    }
    cmd.spawn()
}

/// Drains the stdout pipe in the background (a full pipe would deadlock the process!).
/// Note: progress is on STDERR, not STDOUT; this only prevents a stall.
fn spawn_drain(stdout: Option<tokio::process::ChildStdout>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Some(o) = stdout {
            let mut r = BufReader::new(o).lines();
            while let Ok(Some(_)) = r.next_line().await {}
        }
    })
}

/// Legendary overwrites download progress on a single line with `\r` (carriage return).
/// The standard `BufReader::lines()` only waits for `\n`, so speed/ETA data
/// does not reach the UI in time. This reader treats both `\n` and `\r`
/// boundaries as line ends, keeping the live speed stream uninterrupted.
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
                let line: Vec<u8> = self.pending.drain(..=pos).collect();
                let s = String::from_utf8_lossy(&line[..line.len().saturating_sub(1)])
                    .trim()
                    .to_string();
                if s.is_empty() {
                    continue;
                }
                return Some(s);
            }
            match self.reader.read(&mut self.buf).await {
                Ok(0) => {
                    let s = String::from_utf8_lossy(&self.pending).trim().to_string();
                    self.pending.clear();
                    return if s.is_empty() { None } else { Some(s) };
                }
                Ok(n) => self.pending.extend_from_slice(&self.buf[..n]),
                Err(_) => return None,
            }
        }
    }
}

/// Percentage from the `= Progress: 50.46% (1156/2291)` line.
/// Legendary's own figure is the most accurate; the MiB-based one is a fallback.
fn parse_progress_percent(line: &str) -> Option<i32> {
    let idx = line.find("Progress:")? + "Progress:".len();
    let rest = line[idx..].trim_start();
    let num_end = rest.find(|c: char| !(c.is_ascii_digit() || c == '.'))?;
    if num_end == 0 {
        return None;
    }
    let v: f64 = rest[..num_end].parse().ok()?;
    Some((v.round() as i32).clamp(0, 100))
}

fn short_error(err_text: &str) -> String {
    let lines: Vec<&str> = err_text.lines().collect();
    let mut picked: Vec<&str> = lines
        .iter()
        .filter(|l| {
            let low = l.to_lowercase();
            low.contains("error") || low.contains("exception") || low.contains("failed")
        })
        .take(3)
        .copied()
        .collect();
    if picked.is_empty() {
        picked = lines.iter().rev().take(3).copied().collect();
        picked.reverse();
    }
    let out: String = picked.join("\n").chars().take(600).collect();
    if out.trim().is_empty() {
        "bilinmeyen hata".to_string()
    } else {
        out
    }
}

/// Starts the download (must NOT be called while holding a lock!). Sets up the monitor task on success.
fn start_download(app: &AppHandle, app_name: String, override_dir: Option<String>) -> Result<String, String> {
    start_download_with_tags(app, app_name, Vec::new(), override_dir)
}

fn start_download_with_tags(
    app: &AppHandle,
    app_name: String,
    install_tags: Vec<String>,
    override_dir: Option<String>,
) -> Result<String, String> {
    start_download_request(
        app,
        PendingDownload {
            app_name,
            install_tags,
            install_dir: override_dir,
        },
    )
}

#[allow(clippy::too_many_arguments)]
async fn monitor_download(
    app: AppHandle,
    bin: PathBuf,
    app_name: String,
    base: PathBuf,
    install_tags: Vec<String>,
    generation: u64,
    mut child: tokio::process::Child,
    mut stdout: Option<tokio::process::ChildStdout>,
    mut stderr: Option<tokio::process::ChildStderr>,
) {
    let mut total_mib = 0.0f64;
    let mut downloaded_mib = 0.0f64;
    let mut current_speed: Option<String> = None;
    let mut current_speed_bytes: Option<u64> = None;
    let mut current_disk_speed: Option<String> = None;
    let mut current_disk_bytes: Option<u64> = None;
    let mut current_eta: Option<String> = None;
    let mut current_eta_seconds: Option<u64> = None;
    let mut last_pct: i32 = -1;
    let mut last_emit = std::time::Instant::now();
    let mut high_mem = false;
    let mut tail: VecDeque<String> = VecDeque::with_capacity(60);

    let result: Result<(), String> = loop {
        // stdout carries no progress but is drained so the pipe does not fill.
        let out_task = spawn_drain(stdout.take());
        if let Some(e) = stderr.take() {
            let mut r = CrlfLines::new(e);
            while let Some(line) = r.next_line().await {
                if tail.len() >= 60 {
                    tail.pop_front();
                }

                if let Some((eta_s, secs)) = parse_eta(&line) {
                    current_eta = Some(eta_s);
                    current_eta_seconds = Some(secs);
                }
                if let Some((spd_s, bytes_sec)) = parse_speed(
                    &line,
                    &["Download speed:", "Download Speed:", "Download:", "Speed:", "Net:"],
                ) {
                    current_speed = Some(spd_s);
                    current_speed_bytes = Some(bytes_sec);
                }
                if let Some((d_spd_s, d_bytes_sec)) = parse_speed(
                    &line,
                    &["Disk speed:", "Disk Speed:", "Written speed:", "Disk:", "Written:", "Write:"],
                ) {
                    current_disk_speed = Some(d_spd_s);
                    current_disk_bytes = Some(d_bytes_sec);
                }
                if total_mib <= 0.0 {
                    if let Some(v) = parse_mib_after(&line, "Download size:") {
                        total_mib = v;
                    }
                }
                if let Some(d) = parse_mib_after(&line, "Downloaded:") {
                    downloaded_mib = d;
                }

                let mut new_pct: Option<i32> = None;
                if let Some(pct) = parse_progress_percent(&line) {
                    new_pct = Some(pct);
                } else if total_mib > 0.0 && downloaded_mib > 0.0 {
                    let pct = ((downloaded_mib / total_mib * 100.0).round() as i32).clamp(0, 100);
                    new_pct = Some(pct);
                }

                let pct_changed = new_pct.is_some() && new_pct != Some(last_pct);
                let time_elapsed = last_emit.elapsed().as_millis() >= 250;
                if pct_changed || time_elapsed {
                    last_emit = std::time::Instant::now();
                    if let Some(p) = new_pct {
                        last_pct = p;
                    }
                    let p = if last_pct >= 0 { last_pct as u8 } else { 0 };
                    let dl_bytes = if downloaded_mib > 0.0 { Some((downloaded_mib * 1024.0 * 1024.0) as u64) } else { None };
                    let tot_bytes = if total_mib > 0.0 { Some((total_mib * 1024.0 * 1024.0) as u64) } else { None };
                    emit_progress_full(
                        &app,
                        &app_name,
                        p,
                        false,
                        current_speed.clone(),
                        current_speed_bytes,
                        current_disk_speed.clone(),
                        current_disk_bytes,
                        current_eta.clone(),
                        current_eta_seconds,
                        dl_bytes,
                        tot_bytes,
                    );
                }
                tail.push_back(line);
            }
        }
        let status = child.wait().await.ok();
        let _ = out_task.await;
        let err_text: String = tail.iter().cloned().collect::<Vec<_>>().join("\n");
        if status.is_some_and(|s| s.success()) {
            break Ok(());
        }
        // Heroic pattern: on a memory error, raise the limit and retry once.
        if !high_mem && err_text.contains("MemoryError") {
            // Do not restart if it was cancelled.
            let cancelled = app
                .state::<AppState>()
                .epic_dl
                .lock()
                .map(|s| s.cancelled)
                .unwrap_or(false);
            if cancelled {
                break Err("@t:dl.cancelled".into());
            }
            high_mem = true;
            total_mib = 0.0;
            downloaded_mib = 0.0;
            last_pct = -1;
            match spawn_install_with_tags(&app, &bin, &app_name, &base, true, &install_tags) {
                Ok(c) => {
                    child = c;
                    stdout = child.stdout.take();
                    stderr = child.stderr.take();
                    // Update the pid (so the cancel command finds the current process)
                    if let Ok(mut s) = app.state::<AppState>().epic_dl.lock() {
                        s.pid = child.id();
                    }
                    continue;
                }
                Err(e) => {
                    break Err(format!("@t:dl.restartFailed\u{1f}{e}"));
                }
            }
        }
        break Err(short_error(&err_text));
    };

    // Son durum: iptal/duraklatma/tamamlama
    let next = {
        let state = app.state::<AppState>();
        let mut s = match state.epic_dl.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let was_cancelled = s.cancelled;
        let was_paused = s.paused;
        let owns_active = s.active.as_deref() == Some(app_name.as_str())
            && s.active_generation == Some(generation);

        // An older monitor must never clean up a newer transfer.
        if !owns_active {
            return;
        }

        if was_paused {
            // Release the active slot only after the monitor has observed the
            // child exit, so resume cannot race the old process cleanup.
            if s.active.as_ref().is_some_and(|a| a == &app_name) {
                s.active = None;
            }
            s.active_generation = None;
            s.pid = None;
            emit_paused(&app, &app_name);
            return;
        }

        clear_pending_download();

        if s.active.as_ref().is_some_and(|a| a == &app_name) {
            s.active = None;
            s.active_generation = None;
            s.pid = None;
        }
        if was_cancelled {
            s.cancelled = false;
            emit_cancelled(&app, &app_name);
        } else {
            let tot_bytes = if total_mib > 0.0 { Some((total_mib * 1024.0 * 1024.0) as u64) } else { None };
            match &result {
                Ok(()) => emit_progress_full(&app, &app_name, 100, true, None, None, None, None, None, None, tot_bytes, tot_bytes),
                Err(msg) => emit_failed(&app, &app_name, msg.clone()),
            }
        }
        let next = s.queue.pop_front();
        write_queue_snapshot(&s.queue);
        next
    };
    if let Some(n) = next {
        let next_id = n.app_name.clone();
        if let Err(msg) = start_download_request(&app, n) {
            emit_failed(&app, &next_id, msg);
            pump_queue(&app);
        }
    }
}

/// Starts the next download in the queue (when idle).
fn pump_queue(app: &AppHandle) {
    let next = {
        let state = app.state::<AppState>();
        let mut s = match state.epic_dl.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if s.active.is_some() {
            return;
        }
        let next = s.queue.pop_front();
        write_queue_snapshot(&s.queue);
        next
    };
    if let Some(q) = next {
        let q_id = q.app_name.clone();
        if let Err(msg) = start_download_request(app, q) {
            emit_failed(app, &q_id, msg);
            pump_queue(app);
        }
    }
}

#[tauri::command]
pub async fn epic_install_game(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    app_name: String,
    install_dir: Option<String>,
) -> Result<String, String> {
    let app_name = app_name.trim().to_string();
    if app_name.is_empty() {
        return Err("@t:dl.nameEmpty".into());
    }
    {
        let s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.as_ref().is_some_and(|a| a == &app_name)
            || s.queue.iter().any(|q| q.app_name == app_name)
        {
            return Err("@t:dl.alreadyQueued".into());
        }
        if s.active.is_some() {
            drop(s);
            let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
            s.queue.push_back(PendingDownload {
                app_name: app_name.clone(),
                install_tags: Vec::new(),
                install_dir: install_dir.clone(),
            });
            write_queue_snapshot(&s.queue);
            drop(s);
            emit_progress(&app, &app_name, 0, false);
            return Ok("@t:dl.queuedActive".into());
        }
    }
    start_download(&app, app_name, install_dir)
}

#[tauri::command]
pub async fn epic_install_with_options(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    app_name: String,
    install_tags: Vec<String>,
    dlc_app_ids: Vec<String>,
    install_dir: Option<String>,
) -> Result<String, String> {
    let app_name = app_name.trim().to_string();
    if app_name.is_empty() {
        return Err("@t:dl.nameEmpty".into());
    }

    // Enqueue all selected DLCs first
    {
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.as_ref().is_some_and(|a| a == &app_name)
            || s.queue.iter().any(|q| q.app_name == app_name)
        {
            return Err("@t:dl.alreadyQueued".into());
        }
        for dlc_id in dlc_app_ids {
            let dlc_trimmed = dlc_id.trim().to_string();
            if !dlc_trimmed.is_empty()
                && !s.queue.iter().any(|q| q.app_name == dlc_trimmed)
                && s.active.as_deref() != Some(&dlc_trimmed)
            {
                s.queue.push_back(PendingDownload {
                    app_name: dlc_trimmed,
                    install_tags: Vec::new(),
                    install_dir: install_dir.clone(),
                });
            }
        }
        write_queue_snapshot(&s.queue);

        if s.active.is_some() {
            s.queue.push_back(PendingDownload {
                app_name: app_name.clone(),
                install_tags,
                install_dir: install_dir.clone(),
            });
            write_queue_snapshot(&s.queue);
            emit_progress(&app, &app_name, 0, false);
            return Ok("@t:dl.queuedWithDlc".into());
        }
    }

    start_download_with_tags(&app, app_name, install_tags, install_dir)
}

/// Restores the last active download after the launcher process was restarted.
#[tauri::command]
pub async fn epic_resume_pending_download(app: AppHandle) -> Result<String, String> {
    let path = pending_download_path();
    let pending = std::fs::read_to_string(&path)
        .ok()
        .and_then(|text| serde_json::from_str::<PendingDownload>(&text).ok());
    {
        let state = app.state::<AppState>();
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.queue.is_empty() {
            s.queue = read_queue_snapshot();
        }
        if s.active.is_some() {
            return Ok("@t:dl.alreadyQueued".into());
        }
        if pending.is_none() {
            let next = s.queue.pop_front();
            write_queue_snapshot(&s.queue);
            drop(s);
            return match next {
                Some(request) => start_download_request(&app, request),
                None => Ok("@t:dl.noPending".into()),
            };
        }
    }
    start_download_request(&app, pending.unwrap())
}

#[tauri::command]
pub async fn epic_cancel_download(app: AppHandle, app_name: String) -> Result<String, String> {
    let pid = {
        let state = app.state::<AppState>();
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.as_ref().is_some_and(|a| a == &app_name) {
            s.cancelled = true;
            s.paused = false;
            s.pid.take()
        } else if s.queue.iter().any(|q| q.app_name == app_name) {
            s.queue.retain(|q| q.app_name != app_name);
            write_queue_snapshot(&s.queue);
            drop(s);
            emit_cancelled(&app, &app_name);
            return Ok("@t:dl.removedFromQueue".into());
        } else if pending_download_path().is_file() {
            // The launcher may have been restarted before the restore command
            // recreated the in-memory process state.
            clear_pending_download();
            drop(s);
            emit_cancelled(&app, &app_name);
            return Ok("@t:dl.cancelled".into());
        } else {
            return Err("@t:dl.noActive".into());
        }
    };
    // Terminate via the pid (the monitor task treats the exit as a cancellation).
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .output()
                .await;
        }
        #[cfg(not(windows))]
        {
            let _ = tokio::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output()
                .await;
        }
    }
    clear_pending_download();
    Ok("@t:dl.cancelled".into())
}

#[tauri::command]
pub async fn epic_pause_download(
    state: tauri::State<'_, AppState>,
    app_name: String,
) -> Result<String, String> {
    let pid = {
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.as_ref().is_some_and(|a| a == &app_name) {
            s.paused = true;
            s.pid.take()
        } else {
            return Err("@t:dl.notActive".into());
        }
    };
    if let Some(p) = pid {
        #[cfg(windows)]
        {
            let _ = tokio::process::Command::new("taskkill")
                .args(["/PID", &p.to_string(), "/T", "/F"])
                .output()
                .await;
        }
        #[cfg(not(windows))]
        {
            let _ = tokio::process::Command::new("kill")
                .args(["-9", &p.to_string()])
                .output()
                .await;
        }
    }
    Ok("@t:dl.paused".into())
}

#[tauri::command]
pub async fn epic_resume_download(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    app_name: String,
) -> Result<String, String> {
    let request = std::fs::read_to_string(pending_download_path())
        .ok()
        .and_then(|text| serde_json::from_str::<PendingDownload>(&text).ok())
        .filter(|pending| pending.app_name == app_name)
        .unwrap_or(PendingDownload {
            app_name: app_name.clone(),
            install_tags: Vec::new(),
            install_dir: None,
        });
    // Pause terminates the child asynchronously. Wait for its monitor to
    // release the active slot before starting the replacement process.
    for _ in 0..40 {
        let waiting = {
            let s = state.epic_dl.lock().map_err(|e| e.to_string())?;
            s.active.as_deref() == Some(app_name.as_str()) && s.paused
        };
        if !waiting {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    {
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.is_some() {
            return Err("@t:dl.anotherActive".into());
        }
        s.paused = false;
    }
    start_download_request(&app, request)
}

#[tauri::command]
pub async fn epic_reorder_queue(
    app: AppHandle,
    state: tauri::State<'_, AppState>,
    app_name: String,
    action: String,
) -> Result<DlQueueStatus, String> {
    if action == "now" {
        let (item, prev_pid) = {
            let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
            let idx_opt = s.queue.iter().position(|q| q.app_name == app_name);
            if let Some(idx) = idx_opt {
                let item = s.queue.remove(idx).unwrap();
                let prev_pid = if let Some(curr_active) = s.active.clone() {
                    let pid = s.pid.take();
                    s.paused = true;
                    let active_request = std::fs::read_to_string(pending_download_path())
                        .ok()
                        .and_then(|text| serde_json::from_str::<PendingDownload>(&text).ok())
                        .unwrap_or(PendingDownload {
                            app_name: curr_active,
                            install_tags: Vec::new(),
                            install_dir: None,
                        });
                    s.queue.push_front(active_request);
                    write_queue_snapshot(&s.queue);
                    pid
                } else {
                    None
                };
                (Some(item), prev_pid)
            } else {
                (None, None)
            }
        };
        if let Some(p) = prev_pid {
            #[cfg(windows)]
            {
                let _ = tokio::process::Command::new("taskkill")
                    .args(["/PID", &p.to_string(), "/T", "/F"])
                    .output()
                    .await;
            }
            #[cfg(not(windows))]
            {
                let _ = tokio::process::Command::new("kill")
                    .args(["-9", &p.to_string()])
                    .output()
                    .await;
            }
        }
        write_queue_snapshot(&state.epic_dl.lock().map_err(|e| e.to_string())?.queue);
        if let Some(item) = item {
            for _ in 0..40 {
                let waiting = state
                    .epic_dl
                    .lock()
                    .map(|s| s.active.is_some())
                    .unwrap_or(false);
                if !waiting {
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
            if let Err(error) = start_download_request(&app, item.clone()) {
                let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
                s.queue.push_front(item);
                return Err(error);
            }
        }
        let s2 = state.epic_dl.lock().map_err(|e| e.to_string())?;
        return Ok(DlQueueStatus {
            active: s2.active.clone(),
            is_paused: s2.paused,
            queue: queue_names(&s2.queue),
        });
    }

    let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
    let idx_opt = s.queue.iter().position(|q| q.app_name == app_name);

    match action.as_str() {
        "up" => {
            if let Some(idx) = idx_opt {
                if idx > 0 {
                    s.queue.swap(idx, idx - 1);
                }
            }
        }
        "down" => {
            if let Some(idx) = idx_opt {
                if idx + 1 < s.queue.len() {
                    s.queue.swap(idx, idx + 1);
                }
            }
        }
        "top" => {
            if let Some(idx) = idx_opt {
                let item = s.queue.remove(idx).unwrap();
                s.queue.push_front(item);
            }
        }
        "remove" => {
            if let Some(idx) = idx_opt {
                s.queue.remove(idx);
                drop(s);
                emit_cancelled(&app, &app_name);
                let s2 = state.epic_dl.lock().map_err(|e| e.to_string())?;
                return Ok(DlQueueStatus {
                    active: s2.active.clone(),
                    is_paused: s2.paused,
                    queue: queue_names(&s2.queue),
                });
            }
        }
        _ => return Err("@t:dl.invalidAction".into()),
    }

    write_queue_snapshot(&s.queue);

    Ok(DlQueueStatus {
        active: s.active.clone(),
        is_paused: s.paused,
        queue: queue_names(&s.queue),
    })
}

#[tauri::command]
pub fn epic_get_queue(state: tauri::State<'_, AppState>) -> Result<DlQueueStatus, String> {
    let s = state.epic_dl.lock().map_err(|e| e.to_string())?;
    Ok(DlQueueStatus {
        active: s.active.clone(),
        is_paused: s.paused,
        queue: queue_names(&s.queue),
    })
}

#[tauri::command]
pub async fn epic_uninstall_game(
    app: AppHandle,
    app_name: String,
    keep_files: bool,
) -> Result<String, String> {
    let bin = resolve_bin(&app)?;
    let title = app_name.clone();
    let mut cmd = tokio::process::Command::new(&bin);
    cmd.arg("-y").arg("uninstall");
    if keep_files {
        cmd.arg("--keep-files");
    }
    cmd.arg(&app_name)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd.output().await.map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(format!("@t:dl.uninstalled\u{1f}{title}"))
    } else {
        let err = String::from_utf8_lossy(&out.stderr);
        Err(short_error(&err))
    }
}

#[tauri::command]
pub fn epic_default_install_dir() -> String {
    default_install_dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn epic_set_install_dir(
    app: AppHandle,
    path: Option<String>,
) -> Result<crate::EpicSettings, String> {
    let mut s = load_settings(&app);
    s.install_dir = path.and_then(|p| {
        let t = p.trim().to_string();
        if t.is_empty() {
            None
        } else {
            Some(t)
        }
    });
    crate::save_settings(&app, &s);
    Ok(s)
}

/// Launches the game: online first (with an ownership ticket), then, if the game
/// can run offline, retries with `--offline`.
/// The game process is spawned detached (it keeps running after the handle drops).
/// Returns an error if it crashes in the first seconds, otherwise counts it as "launched".
#[tauri::command]
pub async fn epic_launch_game(app: AppHandle, app_name: String) -> Result<String, String> {
    let bin = resolve_bin(&app)?;
    let installed: Vec<super::models::InstalledGame> =
        super::client::run_json(&bin, &["list-installed", "--json"])
            .await
            .map_err(cmd_error)?;
    if let Some(entry) = installed.iter().find(|g| g.app_name == app_name) {
        let title = if entry.title.is_empty() {
            app_name.clone()
        } else {
            entry.title.clone()
        };
        let mut custom_args: Vec<String> = entry.launch_parameters
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        let settings_path = super::skip::default_config_dir()
            .join("game_settings")
            .join(format!("{app_name}.json"));
        if let Ok(st_text) = std::fs::read_to_string(&settings_path) {
            if let Ok(st_val) = serde_json::from_str::<serde_json::Value>(&st_text) {
                if let Some(lp) = st_val.get("launchParameters").and_then(|v| v.as_str()) {
                    for arg in lp.split_whitespace() {
                        if !custom_args.iter().any(|a| a == arg) {
                            custom_args.push(arg.to_string());
                        }
                    }
                }
            }
        }
        let custom_refs: Vec<&str> = custom_args.iter().map(|s| s.as_str()).collect();
        let settings = load_settings(&app);
        let is_offline = settings.offline_mode.unwrap_or(false);

        if is_offline && entry.can_run_offline {
            let mut offline_args = vec!["--offline"];
            offline_args.extend(custom_refs.iter().copied());
            return spawn_launched(&app, &bin, &app_name, &offline_args)
                .await
                .map(|_| format!("@t:dl.launchedOffline\u{1f}{title}"));
        }

        match spawn_launched(&app, &bin, &app_name, &custom_refs).await {
            Ok(()) => Ok(format!("@t:dl.launched\u{1f}{title}")),
            Err(first) => {
                if entry.can_run_offline {
                    let mut offline_args = vec!["--offline"];
                    offline_args.extend(custom_refs.iter().copied());
                    spawn_launched(&app, &bin, &app_name, &offline_args)
                        .await
                        .map(|_| format!("@t:dl.launchedOffline\u{1f}{title}"))
                        .map_err(|e| format!("{first}\n{e}"))
                } else {
                    Err(first)
                }
            }
        }
    } else {
        // Not installed: check for a third-party launcher (EA App / Origin or Ubisoft)
        let config = super::skip::default_config_dir();
        let meta_path = config.join("metadata").join(format!("{app_name}.json"));
        if let Ok(text) = std::fs::read_to_string(&meta_path) {
            if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
                let title = json
                    .get("app_title")
                    .and_then(|t| t.as_str())
                    .unwrap_or(&app_name)
                    .to_string();
                let lower = text.to_lowercase();
                if lower.contains("origin")
                    || lower.contains("the ea app")
                    || lower.contains("ea games")
                    || lower.contains("respawn")
                {
                    return spawn_launched(&app, &bin, &app_name, &["--origin"])
                        .await
                        .map(|_| format!("@t:dl.launchedEa\u{1f}{title}"));
                } else if lower.contains("ubisoftconnect") || lower.contains("ubisoft") {
                    return spawn_launched(&app, &bin, &app_name, &["--ubisoft"])
                        .await
                        .map(|_| format!("@t:dl.launchedUbisoft\u{1f}{title}"));
                }
            }
        }
        Err("@t:dl.notInstalled".to_string())
    }
}

/// Detects executable (.exe) files in the game directory.
/// Shared-library and crash-reporter binaries are filtered out.
pub fn discover_game_executables(install_path: &Path, main_executable: Option<&str>) -> Vec<String> {
    let mut exes = Vec::new();
    if let Some(main) = main_executable {
        let name = Path::new(main)
            .file_name()
            .and_then(|f| f.to_str())
            .unwrap_or(main);
        if !name.is_empty() {
            exes.push(name.to_lowercase());
        }
    }

    if install_path.is_dir() {
        let ignored_keywords = [
            "vc_redist",
            "vcredist",
            "dxsetup",
            "crashreportclient",
            "epicgameslauncher",
            "legendary",
            "unrealcefsubprocess",
            "unitycrashhandler",
        ];
        scan_dir_for_exes(install_path, 0, 4, &ignored_keywords, &mut exes);
    }

    exes.sort();
    exes.dedup();
    exes
}

fn scan_dir_for_exes(
    dir: &Path,
    depth: usize,
    max_depth: usize,
    ignored: &[&str],
    out: &mut Vec<String>,
) {
    if depth > max_depth {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                    if ext.eq_ignore_ascii_case("exe") {
                        if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                            let lower = name.to_lowercase();
                            let is_ignored = ignored.iter().any(|ign| lower.contains(ign));
                            if !is_ignored && !out.contains(&lower) {
                                out.push(lower);
                            }
                        }
                    }
                }
            } else if path.is_dir() {
                if let Some(dname) = path.file_name().and_then(|n| n.to_str()) {
                    if !dname.starts_with('.') && !dname.starts_with('$') {
                        scan_dir_for_exes(&path, depth + 1, max_depth, ignored, out);
                    }
                }
            }
        }
    }
}

#[cfg(target_os = "windows")]
mod win_process {
    use std::path::Path;

    type HANDLE = *mut std::ffi::c_void;
    type BOOL = i32;
    type DWORD = u32;
    type WCHAR = u16;

    const INVALID_HANDLE_VALUE: HANDLE = -1isize as HANDLE;
    const TH32CS_SNAPPROCESS: DWORD = 0x00000002;
    const PROCESS_QUERY_LIMITED_INFORMATION: DWORD = 0x1000;

    #[repr(C)]
    struct PROCESSENTRY32W {
        dw_size: DWORD,
        cnt_usage: DWORD,
        th32_process_id: DWORD,
        th32_default_heap_id: usize,
        th32_module_id: DWORD,
        cnt_threads: DWORD,
        th32_parent_process_id: DWORD,
        pc_pri_class_base: i32,
        dw_flags: DWORD,
        sz_exe_file: [WCHAR; 260],
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateToolhelp32Snapshot(dwFlags: DWORD, th32ProcessID: DWORD) -> HANDLE;
        fn Process32FirstW(hSnapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
        fn Process32NextW(hSnapshot: HANDLE, lppe: *mut PROCESSENTRY32W) -> BOOL;
        fn CloseHandle(hObject: HANDLE) -> BOOL;
        fn OpenProcess(dwDesiredAccess: DWORD, bInheritHandle: BOOL, dwProcessId: DWORD) -> HANDLE;
        fn QueryFullProcessImageNameW(
            hProcess: HANDLE,
            dwFlags: DWORD,
            lpExeName: *mut WCHAR,
            lpdwSize: *mut DWORD,
        ) -> BOOL;
    }

    pub fn is_game_process_running(install_path: Option<&Path>, candidate_exes: &[String]) -> bool {
        if candidate_exes.is_empty() && install_path.is_none() {
            return false;
        }

        let norm_install_path = install_path.map(|p| {
            p.to_string_lossy()
                .replace('/', "\\")
                .trim_end_matches('\\')
                .to_lowercase()
        });

        unsafe {
            let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snapshot == INVALID_HANDLE_VALUE {
                return false;
            }

            let mut entry = std::mem::zeroed::<PROCESSENTRY32W>();
            entry.dw_size = std::mem::size_of::<PROCESSENTRY32W>() as DWORD;

            if Process32FirstW(snapshot, &mut entry) == 0 {
                CloseHandle(snapshot);
                return false;
            }

            let mut found = false;

            loop {
                // 1. Get the process file name (sz_exe_file)
                let len = entry
                    .sz_exe_file
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.sz_exe_file.len());
                let exe_name = String::from_utf16_lossy(&entry.sz_exe_file[..len]).to_lowercase();

                // 2. Direct match against candidate exes (0ms, zero permissions, cannot be blocked by EAC)
                if !candidate_exes.is_empty() && candidate_exes.iter().any(|c| c == &exe_name) {
                    found = true;
                    break;
                }

                // 3. install_path check (QueryFullProcessImageNameW)
                if let Some(ref inst) = norm_install_path {
                    let h_proc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32_process_id);
                    if !h_proc.is_null() {
                        let mut buf = [0u16; 1024];
                        let mut size = buf.len() as DWORD;
                        if QueryFullProcessImageNameW(h_proc, 0, buf.as_mut_ptr(), &mut size) != 0 {
                            let full_path = String::from_utf16_lossy(&buf[..size as usize])
                                .replace('/', "\\")
                                .to_lowercase();
                            if full_path.starts_with(inst) {
                                let is_ignored = full_path.contains("crashreportclient")
                                    || full_path.contains("vc_redist")
                                    || full_path.contains("vcredist")
                                    || full_path.contains("dxsetup");
                                if !is_ignored {
                                    found = true;
                                    CloseHandle(h_proc);
                                    break;
                                }
                            }
                        }
                        CloseHandle(h_proc);
                    }
                }

                if Process32NextW(snapshot, &mut entry) == 0 {
                    break;
                }
            }

            CloseHandle(snapshot);
            found
        }
    }
}

#[cfg(not(target_os = "windows"))]
mod win_process {
    use std::path::Path;
    pub fn is_game_process_running(_install_path: Option<&Path>, _candidate_exes: &[String]) -> bool {
        false
    }
}

pub use win_process::is_game_process_running;

async fn spawn_launched(
    app: &AppHandle,
    bin: &PathBuf,
    app_name: &str,
    extra_args: &[&str],
) -> Result<(), String> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("launch").arg(app_name);

    // Per-game wrapper + environment variables (applied to legendary so the
    // launched game inherits them).
    let cfgs = super::commands::load_all_game_custom_configs();
    if let Some(cfg) = cfgs.get(app_name) {
        if let Some(wrapper) = cfg.wrapper.as_deref().map(str::trim).filter(|w| !w.is_empty()) {
            cmd.arg("--wrapper").arg(wrapper);
        }
        if let Some(envs) = cfg.env_vars.as_ref() {
            for (key, value) in envs {
                if !key.trim().is_empty() {
                    cmd.env(key.trim(), value);
                }
            }
        }
    }

    for arg in extra_args {
        cmd.arg(arg);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| e.to_string())?;

    let config = super::skip::default_config_dir();
    let installed_games = super::cache::read_installed(&config);
    let installed_entry = installed_games.iter().find(|g| g.app_name == app_name);

    let install_path: Option<PathBuf> = installed_entry
        .map(|g| PathBuf::from(&g.install_path))
        .filter(|p| p.exists());

    let main_executable = installed_entry.map(|g| g.executable.as_str());

    let meta_path = config.join("metadata").join(format!("{app_name}.json"));
    let game_title = installed_entry
        .map(|g| g.title.clone())
        .filter(|t| !t.trim().is_empty())
        .or_else(|| {
            std::fs::read_to_string(&meta_path)
                .ok()
                .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
                .and_then(|v| v.get("app_title").and_then(|t| t.as_str()).map(|s| s.to_string()))
        })
        .unwrap_or_else(|| app_name.to_string());

    let candidate_exes = if let Some(ref ip) = install_path {
        discover_game_executables(ip, main_executable)
    } else {
        let mut v = Vec::new();
        if let Some(me) = main_executable {
            let name = Path::new(me)
                .file_name()
                .and_then(|f| f.to_str())
                .unwrap_or(me);
            if !name.is_empty() {
                v.push(name.to_lowercase());
            }
        }
        v
    };

    super::screenshots::set_active_running_game(app_name, &game_title);

    // Early-crash check in the first 2.5 seconds (only errors on a non-zero exit with no running process)
    let early_failure = match tokio::time::timeout(std::time::Duration::from_millis(2500), child.wait()).await {
        Ok(Ok(st)) if !st.success() => {
            if !is_game_process_running(install_path.as_deref(), &candidate_exes) {
                Some(format!("@t:dl.launchFailedCode\u{1f}{:?}", st.code()))
            } else {
                None
            }
        }
        Ok(Err(e)) => {
            if !is_game_process_running(install_path.as_deref(), &candidate_exes) {
                Some(e.to_string())
            } else {
                None
            }
        }
        _ => None,
    };

    if let Some(err) = early_failure {
        super::screenshots::clear_active_running_game(app_name);
        let _ = app.emit(
            "game-status",
            serde_json::json!({
                "id": app_name,
                "running": false,
            }),
        );
        return Err(err);
    }

    // Game launched! Move the UI into the "Playing..." state
    let _ = app.emit(
        "game-status",
        serde_json::json!({
            "id": app_name,
            "running": true,
        }),
    );

    let app_bg = app.clone();
    let app_name_bg = app_name.to_string();
    let bin_bg = bin.clone();
    let install_path_bg = install_path;
    let candidate_exes_bg = candidate_exes;
    let start_time = std::time::Instant::now();
    let start_system_time = std::time::SystemTime::now();

    tokio::spawn(async move {
        let mut child = child;
        let mut child_finished = false;
        let mut game_detected = false;
        let mut consecutive_not_found = 0;

        loop {
            tokio::time::sleep(std::time::Duration::from_millis(1500)).await;

            if !child_finished {
                match child.try_wait() {
                    Ok(Some(_)) => {
                        child_finished = true;
                    }
                    Ok(None) => {}
                    Err(_) => {
                        child_finished = true;
                    }
                }
            }

            let proc_running = is_game_process_running(install_path_bg.as_deref(), &candidate_exes_bg);

            if proc_running || (!child_finished) {
                game_detected = true;
                consecutive_not_found = 0;
                continue;
            }

            // Neither the child nor the game process is visible
            if !game_detected {
                // Grace period: allow 20s for the EAC/splash screen or engine loading at startup
                if start_time.elapsed() < std::time::Duration::from_secs(20) {
                    continue;
                }
                // No process was caught within 20s and the child has exited
                break;
            } else {
                // The game was active before; to avoid false alarms during transitions,
                // wait for 3 consecutive checks (~4.5s) with no process found
                consecutive_not_found += 1;
                if consecutive_not_found >= 3 {
                    break;
                }
            }
        }

        // --- OYUN SONLANDI ---
        super::screenshots::clear_active_running_game(&app_name_bg);
        let elapsed = start_time.elapsed().as_secs();
        let rec = if game_detected && elapsed >= 5 {
            super::playtime::record_session(&app_name_bg, elapsed).unwrap_or_default()
        } else {
            super::playtime::get_game_playtime(&app_name_bg)
        };

        // Automatically scan and organize new screenshots taken during play
        let clean_t = super::screenshots::clean_folder_name(&app_name_bg);
        let new_shots = super::screenshots::scan_new_captures_for_game(&clean_t, start_system_time);
        if !new_shots.is_empty() {
            let _ = app_bg.emit(
                "screenshots-updated",
                serde_json::json!({
                    "id": app_name_bg,
                    "count": new_shots.len(),
                }),
            );
        }

        let _ = app_bg.emit(
            "game-status",
            serde_json::json!({
                "id": app_name_bg,
                "running": false,
                "sessionSeconds": elapsed,
                "totalSeconds": rec.total_seconds,
                "sessionCount": rec.session_count,
                "lastPlayed": rec.last_played,
                "lastPlayedTimestamp": rec.last_played_timestamp,
            }),
        );

        // If cloud sync is enabled, run sync-saves automatically
        let settings_path = super::skip::default_config_dir()
            .join("game_settings")
            .join(format!("{app_name_bg}.json"));
        let should_sync = std::fs::read_to_string(&settings_path)
            .ok()
            .and_then(|t| serde_json::from_str::<serde_json::Value>(&t).ok())
            .and_then(|v| v.get("cloudSavesEnabled").and_then(|c| c.as_bool()))
            .unwrap_or(false);

        if should_sync {
            let mut sync_cmd = tokio::process::Command::new(&bin_bg);
            sync_cmd.arg("sync-saves").arg(&app_name_bg);
            sync_cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
            let _ = sync_cmd.status().await;
            let _ = app_bg.emit(
                "cloud-sync-complete",
                serde_json::json!({
                    "id": app_name_bg,
                    "success": true
                }),
            );
        }
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_progress_percent_line() {
        let line = "[DLManager] INFO: = Progress: 50.46% (1156/2291), Running for 00:00:31, ETA: 00:00:30";
        assert_eq!(parse_progress_percent(line), Some(50));
        let done = "[DLManager] INFO: = Progress: 100.00% (2291/2291), Running for 00:00:32, ETA: 00:00:00";
        assert_eq!(parse_progress_percent(done), Some(100));
        assert_eq!(parse_progress_percent("no progress here"), None);
    }

    #[test]
    fn parses_mib_lines() {
        assert_eq!(
            parse_mib_after(
                "[cli] INFO: Download size: 84.29 MiB (Compression savings: 53.9%)",
                "Download size:"
            ),
            Some(84.29)
        );
        assert_eq!(
            parse_mib_after(
                "[DLManager] INFO:  - Downloaded: 1.33 MiB, Written: 2.00 MiB",
                "Downloaded:"
            ),
            Some(1.33)
        );
        assert_eq!(parse_mib_after("nothing here", "Downloaded:"), None);
    }

    #[test]
    fn test_parse_eta() {
        let line = "[DLManager] INFO: = Progress: 50.46% (1156/2291), Running for 00:00:31, ETA: 00:01:22";
        let res = parse_eta(line);
        assert_eq!(res, Some(("00:01:22".to_string(), 82)));

        let short_eta = "Progress: 20%, ETA: 03:45";
        assert_eq!(parse_eta(short_eta), Some(("03:45".to_string(), 225)));
    }

    #[test]
    fn test_parse_speed() {
        let line = "[DLManager] INFO:  - Download: 15.40 MiB/s, Disk: 24.50 MiB/s";
        let net = parse_speed(line, &["Download:", "Download speed:", "Speed:"]);
        assert_eq!(net, Some(("15.4 MiB/s".to_string(), 16148070)));

        let disk = parse_speed(line, &["Disk:", "Disk speed:"]);
        assert_eq!(disk, Some(("24.5 MiB/s".to_string(), 25690112)));
    }

    #[tokio::test]
    async fn crlf_lines_splits_on_carriage_return() {
        // Legendary overwrites progress with `\r`; the reader must split on both \r and \n.
        let data = b"first line\nDownload: 5.0 MiB/s\rDownload: 6.0 MiB/s\r\nlast";
        let mut r = CrlfLines::new(&data[..]);
        assert_eq!(r.next_line().await.as_deref(), Some("first line"));
        assert_eq!(r.next_line().await.as_deref(), Some("Download: 5.0 MiB/s"));
        assert_eq!(r.next_line().await.as_deref(), Some("Download: 6.0 MiB/s"));
        assert_eq!(r.next_line().await.as_deref(), Some("last"));
        assert_eq!(r.next_line().await, None);
    }

    #[test]
    fn test_discover_game_executables() {
        let temp = std::env::temp_dir().join("efxlve_test_discover_exes");
        let _ = std::fs::remove_dir_all(&temp);
        let sub = temp.join("Binaries").join("Win64");
        std::fs::create_dir_all(&sub).unwrap();

        std::fs::write(temp.join("GameWrapper.exe"), b"fake").unwrap();
        std::fs::write(sub.join("Game-Win64-Shipping.exe"), b"fake").unwrap();
        std::fs::write(temp.join("CrashReportClient.exe"), b"fake").unwrap();
        std::fs::write(temp.join("vc_redist.x64.exe"), b"fake").unwrap();

        let exes = discover_game_executables(&temp, Some("GameWrapper.exe"));
        assert!(exes.contains(&"gamewrapper.exe".to_string()));
        assert!(exes.contains(&"game-win64-shipping.exe".to_string()));
        assert!(!exes.contains(&"crashreportclient.exe".to_string()));
        assert!(!exes.contains(&"vc_redist.x64.exe".to_string()));

        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn test_is_game_process_running() {
        assert!(!is_game_process_running(None, &["fake_nonexistent_game_xyz_999.exe".to_string()]));
        #[cfg(target_os = "windows")]
        {
            let running = is_game_process_running(None, &["explorer.exe".to_string()]);
            assert!(running, "explorer.exe should be running on Windows");
        }
    }
}
