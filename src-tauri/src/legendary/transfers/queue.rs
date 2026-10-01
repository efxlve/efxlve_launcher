//! One Epic download at a time: queue, spawn, and the stderr monitor.
//!
//! Shared state is locked only across short sections. The child process
//! belongs to the monitor task. Line parsing lives in `parse.rs`.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};

use super::guard::{is_safe_game_dir, plain_folder_name};
use super::parse::*;
use super::paths::{resolve_base, resolve_bin};
use crate::{load_settings, AppState};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct EpicDlState {
    pub active: Option<String>,
    pub pid: Option<u32>,
    pub cancelled: bool,
    pub paused: bool,
    queue: VecDeque<PendingDownload>,
    active_generation: Option<u64>,
    next_generation: u64,
    /// Base path and tags for the process that currently owns `active`.
    active_meta: Option<PendingDownload>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub(super) struct PendingDownload {
    app_name: String,
    install_tags: Vec<String>,
    install_dir: Option<String>,
}

pub(super) fn pending_download_path() -> PathBuf {
    crate::legendary::skip::default_config_dir().join("efxlve-pending-download.json")
}

pub(super) fn queued_downloads_path() -> PathBuf {
    crate::legendary::skip::default_config_dir().join("efxlve-download-queue.json")
}

pub(super) fn write_queue_snapshot(queue: &VecDeque<PendingDownload>) {
    let path = queued_downloads_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string_pretty(queue) {
        let _ = std::fs::write(path, text);
    }
}

pub(super) fn read_queue_snapshot() -> VecDeque<PendingDownload> {
    std::fs::read_to_string(queued_downloads_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub(super) fn write_pending_download(
    app_name: &str,
    install_tags: &[String],
    install_dir: Option<&str>,
) {
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

pub(super) fn clear_pending_download() {
    let _ = std::fs::remove_file(pending_download_path());
}

pub(super) fn read_pending_download() -> Option<PendingDownload> {
    std::fs::read_to_string(pending_download_path())
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
}

pub(super) fn clear_pending_if_app(app_name: &str) {
    if read_pending_download().is_some_and(|pending| pending.app_name == app_name) {
        clear_pending_download();
    }
}

pub(super) fn game_was_installed(app_name: &str) -> bool {
    let config = crate::legendary::skip::default_config_dir();
    crate::legendary::cache::read_installed(&config)
        .iter()
        .any(|game| game.app_name == app_name)
}

pub(super) fn record_from_pending(
    pending: &PendingDownload,
) -> crate::legendary::download_resume::ResumeRecord {
    crate::legendary::download_resume::ResumeRecord {
        app_name: pending.app_name.clone(),
        install_tags: pending.install_tags.clone(),
        install_dir: pending.install_dir.clone(),
    }
}

pub(super) fn pending_from_record(
    record: crate::legendary::download_resume::ResumeRecord,
) -> PendingDownload {
    PendingDownload {
        app_name: record.app_name,
        install_tags: record.install_tags,
        install_dir: record.install_dir,
    }
}

/// Base path and tags from memory, then the active pending file, then the per-app record.
pub(super) fn remembered_request(
    app_name: &str,
    meta: Option<&PendingDownload>,
) -> PendingDownload {
    if let Some(meta) = meta.filter(|item| item.app_name == app_name) {
        return meta.clone();
    }
    if let Some(pending) = read_pending_download().filter(|pending| pending.app_name == app_name) {
        return pending;
    }
    if let Some(saved) = crate::legendary::download_resume::load_one(
        &crate::legendary::download_resume::resumes_path(),
        app_name,
    ) {
        return pending_from_record(saved);
    }
    PendingDownload {
        app_name: app_name.to_string(),
        install_tags: Vec::new(),
        install_dir: None,
    }
}

pub(super) fn has_resume_record(app_name: &str) -> bool {
    read_pending_download().is_some_and(|pending| pending.app_name == app_name)
        || crate::legendary::download_resume::load_one(
            &crate::legendary::download_resume::resumes_path(),
            app_name,
        )
        .is_some()
}

pub(super) fn saved_install_dir(app_name: &str) -> Option<String> {
    remembered_request(app_name, None).install_dir
}

pub(super) fn persist_resume(pending: &PendingDownload) {
    write_pending_download(
        &pending.app_name,
        &pending.install_tags,
        pending.install_dir.as_deref(),
    );
    crate::legendary::download_resume::save_one(
        &crate::legendary::download_resume::resumes_path(),
        &record_from_pending(pending),
    );
}

/// Cleanup and resume-record updates for a finished attempt.
/// Partial folders are removed only when the plan says so (user cancel of a
/// game that was never installed). Failure and pause leave both in place.
pub(super) fn finish_stop(
    app: &AppHandle,
    app_name: &str,
    stop: crate::legendary::download_resume::DownloadStop,
) {
    let plan = crate::legendary::download_resume::plan_stop(stop);
    if plan.cleanup_partial {
        cleanup_partial_install(app, app_name);
    }
    crate::legendary::download_resume::commit_stop(
        &crate::legendary::download_resume::resumes_path(),
        app_name,
        stop,
    );
    if !plan.keep_resume_record {
        clear_pending_if_app(app_name);
    }
}

pub(super) fn user_halted(app: &AppHandle) -> bool {
    app.state::<AppState>()
        .epic_dl
        .lock()
        .map(|slot| slot.cancelled || slot.paused)
        .unwrap_or(false)
}

pub(super) fn release_owned_slot(app: &AppHandle, app_name: &str, generation: u64) {
    if let Ok(mut slot) = app.state::<AppState>().epic_dl.lock() {
        if slot.active.as_deref() == Some(app_name) && slot.active_generation == Some(generation) {
            slot.active = None;
            slot.active_generation = None;
            slot.pid = None;
            slot.active_meta = None;
        }
    }
}

pub(super) fn cleanup_partial_install(app: &AppHandle, app_name: &str) {
    if game_was_installed(app_name) {
        // Do not delete game directories for games that were already installed (e.g. game updates).
        return;
    }

    let pending_install_dir = saved_install_dir(app_name);
    let config = crate::legendary::skip::default_config_dir();
    let base = resolve_base(app, pending_install_dir);

    // Identify candidate folder names created by Legendary:
    // 1. From metadata: customAttributes.FolderName.value
    // 2. From metadata: title (with path-invalid characters stripped)
    // 3. app_name itself
    let mut candidate_names: Vec<String> = Vec::new();

    let meta_file = config.join("metadata").join(format!("{}.json", app_name));
    if meta_file.is_file() {
        if let Ok(content) = std::fs::read_to_string(&meta_file) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&content) {
                let meta = v.get("metadata").unwrap_or(&v);
                if let Some(cattr) = meta.get("customAttributes") {
                    if let Some(fn_val) = cattr
                        .get("FolderName")
                        .and_then(|x| x.get("value"))
                        .and_then(|x| x.as_str())
                    {
                        let trimmed = fn_val.trim();
                        if !trimmed.is_empty() {
                            candidate_names.push(trimmed.to_string());
                        }
                    }
                }
                if let Some(title) = meta.get("title").and_then(|x| x.as_str()) {
                    let cleaned: String = title
                        .chars()
                        .filter(|c| {
                            !matches!(*c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                        })
                        .collect();
                    let trimmed = cleaned.trim();
                    if !trimmed.is_empty() && !candidate_names.contains(&trimmed.to_string()) {
                        candidate_names.push(trimmed.to_string());
                    }
                }
            }
        }
    }
    if !candidate_names.contains(&app_name.to_string()) {
        candidate_names.push(app_name.to_string());
    }

    for name in candidate_names {
        // Metadata and the app id become a child of the install root. An
        // absolute name or `..` would make `join` leave that root.
        if !plain_folder_name(&name) {
            continue;
        }
        let partial_dir = base.join(&name);
        if !partial_dir.is_dir() || !is_safe_game_dir(&partial_dir, &base) {
            continue;
        }
        let (Ok(child), Ok(root)) = (partial_dir.canonicalize(), base.canonicalize()) else {
            continue;
        };
        if child == root || !child.starts_with(&root) {
            continue;
        }
        // Retry removal up to 5 times in case Windows process termination file locks take a brief moment to release
        for _ in 0..5 {
            if std::fs::remove_dir_all(&partial_dir).is_ok() || !partial_dir.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    }

    // Also check and clean legendary config tmp folder if any partial pieces remained
    let tmp_dir = config.join("tmp");
    if tmp_dir.is_dir() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
    }
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
            active_meta: None,
        }
    }
}

pub(super) fn queue_names(queue: &VecDeque<PendingDownload>) -> Vec<String> {
    queue.iter().map(|item| item.app_name.clone()).collect()
}

pub(super) fn start_download_request(
    app: &AppHandle,
    request: PendingDownload,
) -> Result<String, String> {
    let bin = resolve_bin(app)?;
    let saved = crate::legendary::download_resume::load_one(
        &crate::legendary::download_resume::resumes_path(),
        &request.app_name,
    );
    let resuming = saved.is_some();
    let merged = pending_from_record(crate::legendary::download_resume::merge_resume(
        saved.as_ref(),
        record_from_pending(&request),
    ));
    // Persist the resolved folder, not a later settings default. A retry that
    // omits the path would otherwise install into an empty directory.
    let base = resolve_base(app, merged.install_dir.clone());
    let request = PendingDownload {
        app_name: merged.app_name,
        install_tags: merged.install_tags,
        install_dir: Some(base.to_string_lossy().to_string()),
    };

    // Claim the slot before spawn so a second caller cannot start another
    // legendary install against the same .egstore.
    let generation = {
        let state = app.state::<AppState>();
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        if s.active.is_some() {
            return Err("@t:dl.anotherStarted".into());
        }
        s.next_generation = s.next_generation.wrapping_add(1);
        let generation = s.next_generation;
        s.active = Some(request.app_name.clone());
        s.active_generation = Some(generation);
        s.active_meta = Some(request.clone());
        s.pid = None;
        s.cancelled = false;
        s.paused = false;
        generation
    };

    let mut child = match spawn_install_with_tags(
        app,
        &bin,
        &request.app_name,
        &base,
        false,
        &request.install_tags,
    ) {
        Ok(child) => child,
        Err(e) => {
            release_owned_slot(app, &request.app_name, generation);
            return Err(format!("@t:dl.startFailed\u{1f}{e}"));
        }
    };

    let cancelled_during_start = {
        let state = app.state::<AppState>();
        let mut s = state.epic_dl.lock().map_err(|e| e.to_string())?;
        let owns = s.active.as_deref() == Some(request.app_name.as_str())
            && s.active_generation == Some(generation);
        if owns && !s.cancelled {
            s.pid = child.id();
            s.active_meta = Some(request.clone());
            false
        } else if owns {
            s.active = None;
            s.active_generation = None;
            s.pid = None;
            s.active_meta = None;
            s.cancelled = false;
            true
        } else {
            // A newer attempt owns the slot. Do not touch its resume record.
            drop(child);
            return Err("@t:dl.anotherStarted".into());
        }
    };
    if cancelled_during_start {
        // The user cancelled while the process was starting. Dropping the child
        // kills it (`kill_on_drop`) before it can rewrite .egstore.
        drop(child);
        finish_stop(
            app,
            &request.app_name,
            crate::legendary::download_resume::DownloadStop::UserCancel {
                was_installed: game_was_installed(&request.app_name),
            },
        );
        emit_cancelled(app, &request.app_name);
        return Ok("@t:dl.cancelled".into());
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    persist_resume(&request);
    // A resumed install must not flash 0%. Legendary's own progress line is the
    // first percent we publish. A brand-new install still starts at 0.
    if !resuming {
        emit_progress(app, &request.app_name, 0, false);
    }
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
pub(super) struct DlFailed {
    id: String,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DlCancelled {
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

pub(super) fn emit_progress(app: &AppHandle, id: &str, progress: u8, done: bool) {
    emit_progress_full(
        app, id, progress, done, None, None, None, None, None, None, None, None,
    );
}

pub(super) fn emit_paused(app: &AppHandle, id: &str) {
    let _ = app.emit("download-paused", DlPaused { id: id.to_string() });
}

pub(super) fn emit_failed(app: &AppHandle, id: &str, message: String) {
    let _ = app.emit(
        "download-failed",
        DlFailed {
            id: id.to_string(),
            message,
        },
    );
}

pub(super) fn emit_cancelled(app: &AppHandle, id: &str) {
    let _ = app.emit("download-cancelled", DlCancelled { id: id.to_string() });
}

/// Concurrent chunk download workers per network profile. Higher worker counts
/// saturate fast connections better (Epic's own launcher uses ChunkDownloads=32).
pub(super) fn get_worker_count_arg(app: &AppHandle) -> Option<&'static str> {
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
pub(super) fn get_max_memory_arg(app: &AppHandle) -> Option<&'static str> {
    let s = load_settings(app);
    match s.network_profile.as_deref() {
        Some("max") => Some("2048"),
        Some("low") => Some("512"),
        Some("balanced") => Some("1024"),
        _ => None,
    }
}

pub(super) fn spawn_install_with_tags(
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
    if let Some(cdn) = load_settings(app)
        .preferred_cdn
        .filter(|c| !c.trim().is_empty())
    {
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
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
}

/// Drains the stdout pipe in the background (a full pipe would deadlock the process!).
/// Note: progress is on STDERR, not STDOUT; this only prevents a stall.
pub(super) fn spawn_drain(
    stdout: Option<tokio::process::ChildStdout>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        if let Some(o) = stdout {
            let mut r = BufReader::new(o).lines();
            while let Ok(Some(_)) = r.next_line().await {}
        }
    })
}

/// Starts the download (must NOT be called while holding a lock!). Sets up the monitor task on success.
pub(super) fn start_download(
    app: &AppHandle,
    app_name: String,
    override_dir: Option<String>,
) -> Result<String, String> {
    start_download_with_tags(app, app_name, Vec::new(), override_dir)
}

pub(super) fn start_download_with_tags(
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
pub(super) async fn monitor_download(
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
    let mut net_rate: Option<(f64, std::time::Instant)> = None;
    let mut disk_rate: Option<(f64, std::time::Instant)> = None;
    let mut explicit_net = false;
    let mut explicit_disk = false;
    let mut high_mem = false;
    let mut rate_limit_retried = false;
    let mut timeout_retried = false;
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
                    &[
                        "Download speed:",
                        "Download Speed:",
                        "Download:",
                        "Download",
                        "Speed:",
                        "Net:",
                    ],
                ) {
                    if bytes_sec > 0 {
                        explicit_net = true;
                        current_speed = Some(spd_s);
                        current_speed_bytes = Some(bytes_sec);
                    }
                }
                if let Some((d_spd_s, d_bytes_sec)) = parse_speed(
                    &line,
                    &[
                        "Disk speed:",
                        "Disk Speed:",
                        "Written speed:",
                        "Disk write:",
                        "Disk:",
                        "Write:",
                        "Disk",
                        "Write",
                    ],
                ) {
                    if d_bytes_sec > 0 {
                        explicit_disk = true;
                        current_disk_speed = Some(d_spd_s);
                        current_disk_bytes = Some(d_bytes_sec);
                    }
                }
                if total_mib <= 0.0 {
                    if let Some(v) = parse_mib_after(&line, "Download size:") {
                        total_mib = v;
                    }
                }
                if let Some(d) = parse_mib_after(&line, "Downloaded:") {
                    downloaded_mib = d;
                    // Some legendary builds print only the byte counters, not a MiB/s line.
                    if !explicit_net {
                        if let Some(bps) = bytes_per_sec_from_mib(&mut net_rate, d) {
                            current_speed_bytes = Some(bps);
                            current_speed = Some(format_rate(bps));
                        }
                    }
                }
                if let Some(w) = parse_mib_after(&line, "Written:") {
                    if !explicit_disk {
                        if let Some(bps) = bytes_per_sec_from_mib(&mut disk_rate, w) {
                            current_disk_bytes = Some(bps);
                            current_disk_speed = Some(format_rate(bps));
                        }
                    }
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
                // Speed lines arrive before the first `Progress:` line. Publishing 0
                // here resets a resumed download in the UI.
                if (pct_changed || time_elapsed) && (new_pct.is_some() || last_pct >= 0) {
                    last_emit = std::time::Instant::now();
                    if let Some(p) = new_pct {
                        last_pct = p;
                    }
                    let p = last_pct as u8;
                    let dl_bytes = if downloaded_mib > 0.0 {
                        Some((downloaded_mib * 1024.0 * 1024.0) as u64)
                    } else {
                        None
                    };
                    let tot_bytes = if total_mib > 0.0 {
                        Some((total_mib * 1024.0 * 1024.0) as u64)
                    } else {
                        None
                    };
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
            if user_halted(&app) {
                break Err("@t:dl.cancelled".into());
            }
            high_mem = true;
            if user_halted(&app) {
                break Err("@t:dl.cancelled".into());
            }
            match spawn_install_with_tags(&app, &bin, &app_name, &base, true, &install_tags) {
                Ok(c) => {
                    child = c;
                    stdout = child.stdout.take();
                    stderr = child.stderr.take();
                    // Update the pid (so the cancel command finds the current process)
                    if let Ok(mut s) = app.state::<AppState>().epic_dl.lock() {
                        let still_ours =
                            s.active_generation == Some(generation) && !s.cancelled && !s.paused;
                        if !still_ours {
                            drop(s);
                            drop(child);
                            break Err("@t:dl.cancelled".into());
                        }
                        s.pid = child.id();
                    }
                    continue;
                }
                Err(e) => {
                    break Err(format!("@t:dl.restartFailed\u{1f}{e}"));
                }
            }
        }
        // If Epic rate-limited with HTTP 429, wait 8 seconds for the rate-limit window to clear and retry once.
        if !rate_limit_retried
            && (err_text.contains("429") || err_text.contains("Too Many Requests"))
        {
            if user_halted(&app) {
                break Err("@t:dl.cancelled".into());
            }
            rate_limit_retried = true;
            tokio::time::sleep(std::time::Duration::from_secs(8)).await;
            if user_halted(&app) {
                break Err("@t:dl.cancelled".into());
            }
            match spawn_install_with_tags(&app, &bin, &app_name, &base, high_mem, &install_tags) {
                Ok(c) => {
                    child = c;
                    stdout = child.stdout.take();
                    stderr = child.stderr.take();
                    if let Ok(mut s) = app.state::<AppState>().epic_dl.lock() {
                        let still_ours =
                            s.active_generation == Some(generation) && !s.cancelled && !s.paused;
                        if !still_ours {
                            drop(s);
                            drop(child);
                            break Err("@t:dl.cancelled".into());
                        }
                        s.pid = child.id();
                    }
                    continue;
                }
                Err(e) => {
                    break Err(format!("@t:dl.restartFailed\u{1f}{e}"));
                }
            }
        }
        // If Epic service timed out (TimeoutError / ReadTimeoutError), wait 3 seconds and retry once.
        if !timeout_retried
            && (err_text.contains("timed out")
                || err_text.contains("Timeout")
                || err_text.contains("ReadTimeoutError"))
        {
            if user_halted(&app) {
                break Err("@t:dl.cancelled".into());
            }
            timeout_retried = true;
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            if user_halted(&app) {
                break Err("@t:dl.cancelled".into());
            }
            match spawn_install_with_tags(&app, &bin, &app_name, &base, high_mem, &install_tags) {
                Ok(c) => {
                    child = c;
                    stdout = child.stdout.take();
                    stderr = child.stderr.take();
                    if let Ok(mut s) = app.state::<AppState>().epic_dl.lock() {
                        let still_ours =
                            s.active_generation == Some(generation) && !s.cancelled && !s.paused;
                        if !still_ours {
                            drop(s);
                            drop(child);
                            break Err("@t:dl.cancelled".into());
                        }
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

    // Release the slot only after this monitor has seen the child exit.
    // An older monitor must not delete a newer transfer's files or resume record.
    let (was_cancelled, was_paused, next) = {
        let state = app.state::<AppState>();
        let mut s = match state.epic_dl.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        let owns_active = s.active.as_deref() == Some(app_name.as_str())
            && s.active_generation == Some(generation);
        if !owns_active {
            return;
        }
        let was_cancelled = s.cancelled;
        let was_paused = s.paused;
        let next = if was_cancelled || !was_paused {
            s.cancelled = false;
            let next = s.queue.pop_front();
            write_queue_snapshot(&s.queue);
            next
        } else {
            None
        };
        s.active = None;
        s.active_generation = None;
        s.pid = None;
        s.active_meta = None;
        (was_cancelled, was_paused, next)
    };

    let stop = if was_cancelled {
        crate::legendary::download_resume::DownloadStop::UserCancel {
            was_installed: game_was_installed(&app_name),
        }
    } else if was_paused {
        crate::legendary::download_resume::DownloadStop::Pause
    } else if result.is_ok() {
        crate::legendary::download_resume::DownloadStop::Success
    } else {
        crate::legendary::download_resume::DownloadStop::Failure
    };
    // Failure and pause keep the partial folder and the resume record.
    // Only a user cancel of a never-installed game removes them.
    finish_stop(&app, &app_name, stop);

    match stop {
        crate::legendary::download_resume::DownloadStop::Pause => {
            emit_paused(&app, &app_name);
            return;
        }
        crate::legendary::download_resume::DownloadStop::UserCancel { .. } => {
            emit_cancelled(&app, &app_name);
        }
        crate::legendary::download_resume::DownloadStop::Success => {
            let tot_bytes = if total_mib > 0.0 {
                Some((total_mib * 1024.0 * 1024.0) as u64)
            } else {
                None
            };
            // Keep the Epic Games Launcher's own `.item` version in step with the
            // files legendary just wrote; otherwise EGL re-offers the update.
            crate::legendary::cache::sync_egl_manifest_version(
                &crate::legendary::skip::default_config_dir(),
                &app_name,
            );
            emit_progress_full(
                &app, &app_name, 100, true, None, None, None, None, None, None, tot_bytes,
                tot_bytes,
            );
            let settings = crate::load_settings(&app);
            if settings.auto_desktop_shortcut {
                let app_clone = app.clone();
                let app_name_clone = app_name.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(800)).await;
                    let _ = crate::legendary::commands::epic_create_desktop_shortcut(
                        app_clone,
                        app_name_clone,
                    )
                    .await;
                });
            }
        }
        crate::legendary::download_resume::DownloadStop::Failure => {
            if let Err(msg) = &result {
                emit_failed(&app, &app_name, msg.clone());
            }
        }
    }
    if let Some(n) = next {
        let next_id = n.app_name.clone();
        if let Err(msg) = start_download_request(&app, n) {
            emit_failed(&app, &next_id, msg);
            pump_queue(&app);
        }
    }
}

/// Starts the next download in the queue (when idle).
pub(super) fn pump_queue(app: &AppHandle) {
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
        } else if has_resume_record(&app_name) {
            // Real user cancel before the in-memory id was rebound (launcher
            // restart). A crash never reaches this command, so the resume record
            // and partial files stay until the user actually cancels.
            drop(s);
            finish_stop(
                &app,
                &app_name,
                crate::legendary::download_resume::DownloadStop::UserCancel {
                    was_installed: game_was_installed(&app_name),
                },
            );
            emit_cancelled(&app, &app_name);
            return Ok("@t:dl.cancelled".into());
        } else {
            return Err("@t:dl.noActive".into());
        }
    };
    // The monitor applies the cancel plan after the child exits. Cleaning up
    // here would delete `.egstore` before that exit is classified, and a
    // mismatched id would wipe a different game's resume record.
    if let Some(pid) = pid {
        #[cfg(windows)]
        {
            let mut cmd = tokio::process::Command::new("taskkill");
            cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output().await;
        }
        #[cfg(not(windows))]
        {
            let _ = tokio::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .output()
                .await;
        }
    }
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
            let mut cmd = tokio::process::Command::new("taskkill");
            cmd.args(["/PID", &p.to_string(), "/T", "/F"]);
            cmd.creation_flags(CREATE_NO_WINDOW);
            let _ = cmd.output().await;
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
    let request = remembered_request(&app_name, None);
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
                    let active_request = remembered_request(&curr_active, s.active_meta.as_ref());
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
                let mut cmd = tokio::process::Command::new("taskkill");
                cmd.args(["/PID", &p.to_string(), "/T", "/F"]);
                cmd.creation_flags(CREATE_NO_WINDOW);
                let _ = cmd.output().await;
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
