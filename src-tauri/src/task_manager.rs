//! Task manager: what the launcher itself is using.
//!
//! One snapshot, two kinds of rows: the launcher's process tree (the app, its
//! own helper processes and the WebView2 processes it spawned) with CPU,
//! memory and disk counters from `sysinfo`, and the background jobs the
//! launcher runs, each with a live status and — when stopping it is safe — a
//! stop action. The snapshot also carries the system's memory size and the
//! last minute of totals, which is what the panel's sparklines draw.
//!
//! Jobs run as threads inside the launcher process, so they have no CPU or
//! memory of their own; those numbers live on the process rows.

use serde::Serialize;
use std::collections::VecDeque;
use std::sync::Mutex;
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::AppHandle;

/// Kept between calls: CPU usage is a delta since the previous refresh, so a
/// fresh `System` on every poll would always read zero.
static SYSTEM: Mutex<Option<System>> = Mutex::new(None);

/// One sample per snapshot; the panel polls every two seconds while the
/// section is open, so 30 samples are the last minute.
const HISTORY_LEN: usize = 30;
static HISTORY: Mutex<VecDeque<Sample>> = Mutex::new(VecDeque::new());

#[derive(Clone, Copy)]
struct Sample {
    cpu: f64,
    memory_mb: f64,
    jobs: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskRow {
    /// `process:<pid>` or the job id (`metrics`, `store_page`, …).
    pub id: String,
    /// "process" | "job"
    pub kind: String,
    /// Process name; empty for jobs (the UI labels those by id).
    pub name: String,
    /// `app` for the launcher itself, `helper` for its own child processes,
    /// then the WebView2 role: `browser`, `renderer`, `gpu`, `network`,
    /// `storage`, `audio`, `crashpad`, `utility`, ….
    pub role: String,
    pub pid: u32,
    /// Machine-wide CPU percent (0-100), like Task Manager.
    pub cpu: f64,
    pub memory_mb: f64,
    /// Bytes read and written since the process started, in MB.
    pub read_mb: f64,
    pub written_mb: f64,
    /// Executable path, start time (unix seconds) and the full command line:
    /// the row's detail card shows them.
    pub exe: String,
    pub started_at: u64,
    pub cmd: String,
    pub running: bool,
    pub stoppable: bool,
}

/// Everything one call returns: the rows, the system's memory size and the
/// recent history the sparklines use.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub rows: Vec<TaskRow>,
    pub total_memory_mb: f64,
    pub cpu_history: Vec<f64>,
    pub memory_history: Vec<f64>,
    pub jobs_history: Vec<f64>,
}

/// WebView2's own processes are all named after the Edge binary.
fn is_webview(name: &str) -> bool {
    name.to_ascii_lowercase().contains("msedgewebview2")
}

/// The WebView2 role a child process plays, from its `--type=` switch. Utility
/// processes are narrowed by `--utility-sub-type=`, so the panel can tell the
/// network, storage and audio services apart.
fn webview_role(cmd: &[std::ffi::OsString]) -> String {
    let mut kind = String::new();
    let mut sub = String::new();
    for arg in cmd {
        let text = arg.to_string_lossy();
        if let Some(rest) = text.strip_prefix("--type=") {
            kind = rest.to_string();
        } else if let Some(rest) = text.strip_prefix("--utility-sub-type=") {
            sub = rest.to_string();
        }
    }
    match kind.as_str() {
        // No `--type=`: the WebView2 browser process itself.
        "" => "browser".to_string(),
        "gpu-process" => "gpu".to_string(),
        "crashpad-handler" => "crashpad".to_string(),
        "utility" => {
            if sub.starts_with("network.") {
                "network".to_string()
            } else if sub.starts_with("storage.") {
                "storage".to_string()
            } else if sub.starts_with("audio.") {
                "audio".to_string()
            } else {
                "utility".to_string()
            }
        }
        other => other.to_string(),
    }
}

/// The command line as one readable string; arguments with spaces get their
/// quotes back, so a path stays copyable.
fn command_line(cmd: &[std::ffi::OsString]) -> String {
    cmd.iter()
        .map(|arg| {
            let text = arg.to_string_lossy().to_string();
            if text.contains(' ') && !text.starts_with('"') {
                format!("\"{text}\"")
            } else {
                text
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Direct and indirect children of `root`, so WebView2's renderer processes
/// (children of its own browser process) are included too.
fn collect_children(system: &System, root: u32, out: &mut Vec<u32>) {
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        for (pid, process) in system.processes() {
            let Some(process_parent) = process.parent() else {
                continue;
            };
            if process_parent.as_u32() != parent {
                continue;
            }
            let child = pid.as_u32();
            if out.contains(&child) {
                continue;
            }
            out.push(child);
            frontier.push(child);
        }
    }
}

#[tauri::command]
pub fn task_manager_snapshot(app: AppHandle) -> TaskSnapshot {
    let mut guard = SYSTEM.lock().unwrap_or_else(|e| e.into_inner());
    let system = guard.get_or_insert_with(System::new);
    system.refresh_cpu_all();
    system.refresh_memory();
    // The default refresh kind skips the command line, the exe path and the
    // disk counters, and the panel shows all three. The command line never
    // changes, so it is only read once per process.
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cpu()
            .with_disk_usage()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );

    let mut rows = Vec::new();
    let me = std::process::id();
    let logical = system.cpus().len().max(1) as f32;

    let process_row = |pid: u32| -> Option<TaskRow> {
        let process = system.process(Pid::from_u32(pid))?;
        let name = process.name().to_string_lossy().to_string();
        let disk = process.disk_usage();
        Some(TaskRow {
            id: format!("process:{pid}"),
            kind: "process".to_string(),
            role: if pid == me {
                "app".to_string()
            } else if is_webview(&name) {
                webview_role(process.cmd())
            } else {
                "helper".to_string()
            },
            name,
            pid,
            cpu: (process.cpu_usage() / logical) as f64,
            memory_mb: process.memory() as f64 / (1024.0 * 1024.0),
            read_mb: disk.total_read_bytes as f64 / (1024.0 * 1024.0),
            written_mb: disk.total_written_bytes as f64 / (1024.0 * 1024.0),
            exe: process
                .exe()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
            started_at: process.start_time(),
            cmd: command_line(process.cmd()),
            running: true,
            stoppable: false,
        })
    };

    // The app itself, then its WebView2 tree, biggest memory first.
    if let Some(row) = process_row(me) {
        rows.push(row);
    }
    let mut children = Vec::new();
    collect_children(system, me, &mut children);
    let mut child_rows: Vec<TaskRow> = children.into_iter().filter_map(process_row).collect();
    child_rows.sort_by(|a, b| b.memory_mb.total_cmp(&a.memory_mb));
    rows.extend(child_rows);

    // The background jobs, in a fixed order: what the panel runs first, then
    // the always-on helpers, then the pages that can be handed back.
    let job = |id: &str, running: bool, stoppable: bool| TaskRow {
        id: id.to_string(),
        kind: "job".to_string(),
        name: String::new(),
        role: String::new(),
        pid: 0,
        cpu: 0.0,
        memory_mb: 0.0,
        read_mb: 0.0,
        written_mb: 0.0,
        exe: String::new(),
        started_at: 0,
        cmd: String::new(),
        running,
        stoppable,
    };
    rows.push(job("metrics", crate::overlay::metrics::running(), true));
    rows.push(job("spotify", crate::spotify::playback::status(&app).running, true));
    rows.push(job("controller_bridge", crate::controller_bridge::status().running, true));
    rows.push(job("discord_voice", crate::discord_rpc::voice_watch_running(), true));
    rows.push(job("discord_sdk", crate::discord_sdk::sdk_connected(), false));
    rows.push(job("presence", crate::presence::running(), true));
    rows.push(job("game_watch", true, false));
    rows.push(job("screenshots", true, false));
    rows.push(job("store_page", crate::store_host::store_view_alive(&app), true));
    rows.push(job("discord_page", crate::discord_host::page_alive(&app), true));
    rows.push(job("spotify_player", crate::spotify_host::player_alive(&app), true));
    rows.push(job(
        "overlay_browser",
        crate::overlay::browser::overlay_browser_is_open(app.clone()),
        true,
    ));

    let total_cpu: f64 = rows
        .iter()
        .filter(|row| row.kind == "process")
        .map(|row| row.cpu)
        .sum();
    let total_memory: f64 = rows
        .iter()
        .filter(|row| row.kind == "process")
        .map(|row| row.memory_mb)
        .sum();
    let running_jobs = rows.iter().filter(|row| row.kind == "job" && row.running).count();

    let mut history = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
    history.push_back(Sample {
        cpu: total_cpu,
        memory_mb: total_memory,
        jobs: running_jobs as f64,
    });
    while history.len() > HISTORY_LEN {
        history.pop_front();
    }

    TaskSnapshot {
        rows,
        total_memory_mb: system.total_memory() as f64 / (1024.0 * 1024.0),
        cpu_history: history.iter().map(|sample| sample.cpu).collect(),
        memory_history: history.iter().map(|sample| sample.memory_mb).collect(),
        jobs_history: history.iter().map(|sample| sample.jobs).collect(),
    }
}

/// Stops one job. Only the ids the snapshot marked `stoppable` are accepted;
/// the features start themselves again when they are next used.
#[tauri::command]
pub async fn task_manager_stop(app: AppHandle, id: String) -> Result<(), String> {
    match id.as_str() {
        "metrics" => crate::overlay::metrics::stop(),
        "spotify" => crate::spotify::playback::stop(),
        "controller_bridge" => {
            crate::controller_bridge::stop();
        }
        "discord_voice" => crate::discord_rpc::discord_voice_watch_stop(),
        "presence" => crate::presence::configure(false, ""),
        "store_page" => {
            crate::store_host::destroy_store_view(app)?;
        }
        "discord_page" => crate::discord_host::discord_view_destroy(app, None, Some(true)).await,
        "spotify_player" => crate::spotify_host::spotify_player_destroy(app),
        "overlay_browser" => crate::overlay::browser::overlay_browser_close(app),
        _ => return Err("@t:task.notStoppable".to_string()),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{command_line, is_webview, webview_role};
    use std::ffi::OsString;

    #[test]
    fn webview_role_reads_the_type_switch() {
        // No `--type=`: the WebView2 browser process itself.
        assert_eq!(webview_role(&[]), "browser");
        assert_eq!(
            webview_role(&[
                OsString::from("msedgewebview2.exe"),
                OsString::from("--type=renderer"),
                OsString::from("--foo=bar"),
            ]),
            "renderer"
        );
        assert_eq!(webview_role(&[OsString::from("--type=gpu-process")]), "gpu");
        assert_eq!(
            webview_role(&[OsString::from("--type=crashpad-handler")]),
            "crashpad"
        );
    }

    #[test]
    fn webview_role_narrows_utility_processes() {
        let utility = |sub: &str| {
            webview_role(&[
                OsString::from("--type=utility"),
                OsString::from(format!("--utility-sub-type={sub}")),
            ])
        };
        assert_eq!(utility("network.mojom.NetworkService"), "network");
        assert_eq!(utility("storage.mojom.StorageService"), "storage");
        assert_eq!(utility("audio.mojom.AudioService"), "audio");
        assert_eq!(utility("something.else"), "utility");
        assert_eq!(webview_role(&[OsString::from("--type=utility")]), "utility");
    }

    #[test]
    fn is_webview_matches_the_edge_binary() {
        assert!(is_webview("msedgewebview2.exe"));
        assert!(is_webview("MSEDGEWEBVIEW2.EXE"));
        assert!(!is_webview("efxlve-launcher.exe"));
        assert!(!is_webview("legendary.exe"));
    }

    #[test]
    fn command_line_requotes_arguments_with_spaces() {
        let cmd = vec![
            OsString::from(r"C:\Program Files\Edge\msedgewebview2.exe"),
            OsString::from("--type=renderer"),
            OsString::from("plain"),
        ];
        assert_eq!(
            command_line(&cmd),
            r#""C:\Program Files\Edge\msedgewebview2.exe" --type=renderer plain"#
        );
        assert_eq!(command_line(&[]), "");
    }
}
