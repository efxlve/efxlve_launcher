//! Amazon install, update, launch and uninstall through the Nile CLI.
//!
//! Nile logs its download progress to stderr once per second; `run_streaming`
//! parses those lines and forwards them as `nile-progress` events. Launching
//! blocks inside Nile until the game exits, which is exactly what the playtime
//! session needs. Uninstall deletes the recorded folder itself: Nile only
//! removes the files its stored manifest still names.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
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

/// True while an Amazon install/update child is running. The window-close and
/// tray-quit guards must keep the app alive for it just like an Epic or GOG
/// transfer.
static DL_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn download_active() -> bool {
    DL_ACTIVE.load(Ordering::SeqCst)
}

struct ActiveGuard;

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        DL_ACTIVE.store(false, Ordering::SeqCst);
    }
}

fn with_pids<R>(f: impl FnOnce(&mut HashMap<String, u32>) -> R) -> R {
    let mut slot = LAUNCH_PIDS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let map = slot.get_or_insert_with(HashMap::new);
    f(map)
}

/// One Amazon install in flight. Cancelling has to reach the Nile process tree,
/// and the install must know the kill was asked for so it reports a cancel
/// instead of a failure.
struct NileDlState {
    id: String,
    generation: u64,
    child_pid: Option<u32>,
    cancelled: bool,
}

static NILE_DL_STATE: Mutex<Option<NileDlState>> = Mutex::new(None);
/// Distinguishes two installs of the same product (cancel then retry) so an
/// older monitor cannot clear or cancel the newer slot.
static NILE_DL_GENERATION: AtomicU64 = AtomicU64::new(0);

fn begin_nile_download(id: &str) -> Result<u64, String> {
    let generation = NILE_DL_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let mut slot = NILE_DL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot.is_some() {
        return Err("@t:dl.anotherActive".to_string());
    }
    *slot = Some(NileDlState {
        id: id.to_string(),
        generation,
        child_pid: None,
        cancelled: false,
    });
    Ok(generation)
}

fn with_nile_download<R>(
    id: &str,
    generation: u64,
    f: impl FnOnce(&mut NileDlState) -> R,
) -> Option<R> {
    let mut slot = NILE_DL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let state = slot.as_mut()?;
    if state.id != id || state.generation != generation {
        return None;
    }
    Some(f(state))
}

fn record_nile_child(id: &str, generation: u64, pid: u32) {
    with_nile_download(id, generation, |state| state.child_pid = Some(pid));
}

fn clear_nile_child(id: &str, generation: u64) {
    with_nile_download(id, generation, |state| state.child_pid = None);
}

fn nile_download_cancelled(id: &str, generation: u64) -> bool {
    with_nile_download(id, generation, |state| state.cancelled).unwrap_or(false)
}

/// True while any Amazon install is writing Nile's shared config.
pub(super) fn install_in_flight() -> bool {
    NILE_DL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .is_some()
}

fn finish_nile_download(id: &str, generation: u64) {
    let mut slot = NILE_DL_STATE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if slot
        .as_ref()
        .is_some_and(|state| state.id == id && state.generation == generation)
    {
        *slot = None;
    }
}

/// Clears the slot on every exit path of `nile_install`, including `?`.
struct DownloadSlot {
    id: String,
    generation: u64,
}

impl Drop for DownloadSlot {
    fn drop(&mut self) {
        finish_nile_download(&self.id, self.generation);
    }
}

fn cancelled_or(id: &str, generation: u64, fallback: String) -> String {
    if nile_download_cancelled(id, generation) {
        "@t:dl.cancelled".to_string()
    } else {
        fallback
    }
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

/// Installs (or updates) one Amazon game. Progress arrives as `nile-progress`
/// events with the composite id the library uses.
#[tauri::command]
pub async fn nile_install(
    app: AppHandle,
    id: String,
    base_path: Option<String>,
    max_workers: Option<u32>,
) -> Result<(), String> {
    // Nile writes its library and manifest files; a second install would
    // overwrite the slot and let both processes write the same config.
    let generation = begin_nile_download(&id)?;
    // Declared before the active flag so the flag drops first; a new install
    // cannot start until the slot is released.
    let _slot = DownloadSlot {
        id: id.clone(),
        generation,
    };
    DL_ACTIVE.store(true, Ordering::SeqCst);
    let _download_guard = ActiveGuard;
    let _awake = crate::keep_awake::keep_awake();

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
    let out = match run_install_attempt(&app, &args, &event_id, &id, generation).await {
        Ok(out) => out,
        Err(error) => {
            let message = cancelled_or(&id, generation, error);
            crate::download_log::append(&app, &event_id, &Err(message.clone()), &[]);
            return Err(message);
        }
    };

    // Keep the full output for diagnostics: Nile reports some failures only on
    // stderr and still exits zero.
    let out_text = output_text(&out);
    let log_path = cli::config_dir(&app).join(format!("install-{id}.log"));
    let _ = std::fs::write(
        &log_path,
        format!(
            "stdout:\n{}\n\nstderr:\n{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        ),
    );

    let out_lines = tail_lines(&out_text);
    if !out.status.success() {
        let message = cancelled_or(&id, generation, nile_failure_text(&out_text, &out));
        crate::download_log::append(&app, &event_id, &Err(message.clone()), &out_lines);
        return Err(message);
    }
    // Nile exits zero even when it refuses to install ("Not enough space") and
    // when it only *thinks* the install is current. The installed record plus
    // its folder is the postcondition.
    if super::library::installed_game(&app, &id).is_none() {
        if nile_download_cancelled(&id, generation) {
            return Err("@t:dl.cancelled".to_string());
        }
        if is_out_of_space(&out_text) {
            let message = "@t:dl.diskFull".to_string();
            crate::download_log::append(&app, &event_id, &Err(message.clone()), &out_lines);
            return Err(message);
        }
        // Resetting the record only heals "Nile thinks it is current"; every
        // other zero-exit refusal would repeat until the watchdog fired.
        if !out_text.contains("Game is up to date") {
            let message = format!(
                "@t:amazon.installFailed\u{1f}{}",
                cli::failure_message(&out)
            );
            crate::download_log::append(&app, &event_id, &Err(message.clone()), &out_lines);
            return Err(message);
        }
        super::library::forget_installed(&app, &id);
        let retry = run_install_attempt(&app, &args, &event_id, &id, generation).await;
        let healed = retry.as_ref().map(|v| v.status.success()).unwrap_or(false)
            && super::library::installed_game(&app, &id).is_some();
        if nile_download_cancelled(&id, generation) {
            return Err("@t:dl.cancelled".to_string());
        }
        if !healed {
            let (detail, retry_lines) = match retry {
                Ok(v) => {
                    let text = output_text(&v);
                    let lines = tail_lines(&text);
                    (nile_failure_text(&text, &v), lines)
                }
                Err(e) => (e, Vec::new()),
            };
            let message = format!("@t:amazon.installFailed\u{1f}{detail}");
            crate::download_log::append(&app, &event_id, &Err(message.clone()), &retry_lines);
            return Err(message);
        }
    }
    crate::download_log::append(&app, &event_id, &Ok(()), &out_lines);
    Ok(())
}

fn output_text(out: &std::process::Output) -> String {
    format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    )
}

/// The attempt's last lines; the shared log caps the count again, but a
/// multi-hour progress stream must not be copied into a vector first.
fn tail_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = text.lines().rev().take(400).map(str::to_string).collect();
    lines.reverse();
    lines
}

/// Nile prints its disk-space refusal to stdout and still exits zero, so the
/// generic "install failed" wrapper would hide the one actionable cause.
fn is_out_of_space(text: &str) -> bool {
    let low = text.to_lowercase();
    low.contains("no space left")
        || low.contains("disk full")
        || low.contains("notenoughspace")
        || (low.contains("not enough") && low.contains("space"))
}

fn nile_failure_text(text: &str, out: &std::process::Output) -> String {
    if is_out_of_space(text) {
        "@t:dl.diskFull".to_string()
    } else {
        cli::failure_message(out)
    }
}

async fn run_install_attempt(
    app: &AppHandle,
    args: &[String],
    event_id: &str,
    id: &str,
    generation: u64,
) -> Result<std::process::Output, String> {
    let spawn_id = id.to_string();
    let on_spawn = move |pid| {
        record_nile_child(&spawn_id, generation, pid);
        // A cancel may arrive between the command and this spawn.
        nile_download_cancelled(&spawn_id, generation)
    };
    let result = cli::run_streaming(
        app,
        args,
        6 * 3600,
        true,
        progress_emitter(app.clone(), event_id.to_string()),
        on_spawn,
    )
    .await;
    // The next attempt (or a cancel between attempts) must not see this pid.
    clear_nile_child(id, generation);
    result
}

/// Stops the running Amazon install. The download and its workers are killed;
/// the install reports the exit as a user cancel, not a failure.
#[tauri::command]
pub async fn nile_cancel_download(app: AppHandle, id: String) -> Result<String, String> {
    let clean_id = id.trim().trim_start_matches("amazon::").to_string();
    let pid = {
        let mut slot = NILE_DL_STATE
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        match slot.as_mut() {
            Some(state) if state.id == clean_id => {
                state.cancelled = true;
                state.child_pid.take()
            }
            _ => return Err("@t:dl.noActive".to_string()),
        }
    };
    if let Some(pid) = pid {
        cli::kill_install_tree(pid).await;
    }
    let _ = app.emit(
        "download-cancelled",
        json!({ "id": format!("amazon::{clean_id}") }),
    );
    Ok("@t:dl.cancelled".to_string())
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
///
/// Nile's own uninstaller deletes only the files its stored manifest still
/// names and drops the record even when the folder survives, so a manifest
/// that no longer matches the install orphans the files. The launcher deletes
/// the recorded folder itself and drops the record afterwards: a folder that
/// cannot be removed keeps the game installed, and the next attempt retries.
#[tauri::command]
pub async fn nile_uninstall(app: AppHandle, id: String) -> Result<(), String> {
    if install_in_flight() {
        return Err("@t:dl.anotherActive".to_string());
    }
    // The title is needed after the files are gone to drop the desktop shortcut.
    let title = super::library::game_title(&app, &id).unwrap_or_else(|| id.clone());
    let recorded = super::library::installed_path(&app, &id)
        .ok_or_else(|| "@t:dl.notInstalled".to_string())?;
    let folder = PathBuf::from(recorded.trim());
    if folder.is_dir() {
        // A path without a base (a bare drive or `C:\Games`) is not a game
        // folder; report it instead of deleting something shared.
        let base = install_base(&folder).ok_or_else(|| leftover_path(&folder))?;
        let removed = tauri::async_runtime::spawn_blocking(move || {
            crate::legendary::transfers::remove_install_folder(&folder, &base)
        })
        .await
        .ok()
        .flatten();
        if let Some(left) = removed {
            return Err(leftover_path(&left));
        }
    }
    // The folder is gone (or was already); the record and the manifest can
    // follow.
    super::library::forget_installed(&app, &id);
    super::manage::remove_shortcut_for_title(&title);
    Ok(())
}

fn leftover_path(path: &Path) -> String {
    format!("@t:dl.uninstallLeftFiles\u{1f}{}", path.display())
}

/// The base Nile appended the game title to. Requiring two folders below the
/// drive keeps a bare base such as `C:\Games` out of a recursive delete.
fn install_base(folder: &Path) -> Option<PathBuf> {
    if !folder.is_absolute() || folder.components().count() < 4 {
        return None;
    }
    folder.parent().map(Path::to_path_buf)
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
    // Launch extras saved on the manage screen: extra arguments are appended to
    // the game command and env vars travel through Nile to the game process.
    let cfgs = crate::legendary::commands::load_all_game_custom_configs();
    let cfg = cfgs.get(&composite);
    let extra_args: Vec<String> = cfg
        .and_then(|c| c.launch_parameters.as_deref())
        .map(|lp| lp.split_whitespace().map(|a| a.to_string()).collect())
        .unwrap_or_default();
    cmd.args(["launch", &id]);
    // Linux/macOS: Nile can hand the PE to the same Wine/Proton wrapper the
    // other stores use. Windows gets an empty spec, so this is a no-op there.
    crate::compat::prepare_prefix_for_launch(&app, &composite).await;
    let compat = crate::compat::launch_spec(&app, &composite);
    if let Some(wrapper) = compat.wrapper_command() {
        cmd.args(["--no-wine", "--wrapper", &wrapper]);
    }
    cmd.args(&extra_args);
    for (name, value) in &compat.env {
        cmd.env(name, value);
    }
    if let Some(env) = cfg.and_then(|c| c.env_vars.as_ref()) {
        for (name, value) in env {
            cmd.env(name, value);
        }
    }
    cmd.stdin(std::process::Stdio::null())
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
        let _ = app_clone.emit("game-status", json!({ "id": comp_id, "running": false }));
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
    let _ = app.emit("game-status", json!({ "id": composite, "running": false }));
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
    fn a_second_amazon_install_is_refused() {
        let first = begin_nile_download("first-product").expect("first install");
        assert_eq!(
            begin_nile_download("second-product").unwrap_err(),
            "@t:dl.anotherActive"
        );
        record_nile_child("first-product", first, 7);
        assert_eq!(
            with_nile_download("first-product", first, |state| state.child_pid).unwrap(),
            Some(7)
        );
        finish_nile_download("first-product", first);

        let second = begin_nile_download("second-product").expect("after the first ends");
        // An older monitor's cleanup must not drop the newer slot.
        finish_nile_download("first-product", first);
        assert!(!nile_download_cancelled("second-product", second));
        finish_nile_download("second-product", second);
    }

    #[test]
    fn a_disk_space_refusal_is_named() {
        assert!(is_out_of_space("Unable to proceed, Not enough disk space"));
        assert!(is_out_of_space("OSError: [Errno 28] No space left on device"));
        assert!(is_out_of_space("NotEnoughSpaceError: 4 GiB needed"));
        assert!(!is_out_of_space("Unable to load manifest"));
        assert!(!is_out_of_space("Download complete"));
    }

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

    #[cfg(windows)]
    #[test]
    fn an_install_folder_keeps_its_base_out_of_the_delete() {
        assert_eq!(
            install_base(Path::new(r"C:\Users\Efe\Games\nile\3 Count Bout")),
            Some(PathBuf::from(r"C:\Users\Efe\Games\nile"))
        );
        assert_eq!(
            install_base(Path::new(r"D:\Games\My Game")),
            Some(PathBuf::from(r"D:\Games"))
        );
        // A bare base or a drive is shared with other files, not a game folder.
        assert!(install_base(Path::new(r"C:\Games")).is_none());
        assert!(install_base(Path::new(r"C:\")).is_none());
        assert!(install_base(Path::new(r"relative\Game")).is_none());
    }
}
