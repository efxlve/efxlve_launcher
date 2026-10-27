//! Task manager: what the launcher itself is using.
//!
//! One snapshot, three kinds of rows: the launcher's process tree (the app, the
//! WebView2 processes it spawned, the command-line tools it runs and any other
//! helper), the running game as a separate section, and the background jobs the
//! launcher runs. Process rows carry CPU, memory, disk totals and a live disk
//! rate from `sysinfo`; the snapshot also carries the system's memory size and
//! the last samples of the launcher totals, which is what the panel's
//! sparklines draw.
//!
//! Jobs run as threads inside the launcher process, so they have no CPU or
//! memory of their own; those numbers live on the process rows.

use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Emitter};

/// Kept between calls: CPU usage is a delta since the previous refresh, so a
/// fresh `System` on every poll would always read zero.
static SYSTEM: Mutex<Option<System>> = Mutex::new(None);

/// One sample per snapshot; the panel polls every two seconds while the
/// section is open, so 30 samples are roughly the last minute.
const HISTORY_LEN: usize = 30;
/// A longer pause means the graph is not "the last minute" any more, so the old
/// samples are dropped instead of being joined to the new ones.
const HISTORY_GAP: Duration = Duration::from_secs(10);
static HISTORY: Mutex<History> = Mutex::new(History {
    samples: VecDeque::new(),
    last_at: None,
});

/// Disk totals are cumulative, so a live rate is the delta between two polls.
static DISK_MARKS: Mutex<Option<HashMap<u32, DiskMark>>> = Mutex::new(None);

/// The processes the last snapshot marked endable, keyed by PID with their
/// start time. An end request must match this list, so a stale or forged PID
/// cannot reach a process the panel never offered.
static ENDABLE: Mutex<Option<HashMap<u32, u64>>> = Mutex::new(None);

struct History {
    samples: VecDeque<Sample>,
    last_at: Option<Instant>,
}

#[derive(Clone, Copy)]
struct Sample {
    cpu: f64,
    memory_mb: f64,
    jobs: f64,
}

#[derive(Clone, Copy)]
struct DiskMark {
    started_at: u64,
    read: u64,
    written: u64,
    at: Instant,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Group {
    App,
    Webview,
    Cli,
    Game,
    Other,
}

impl Group {
    fn as_str(self) -> &'static str {
        match self {
            Group::App => "app",
            Group::Webview => "webview",
            Group::Cli => "cli",
            Group::Game => "game",
            Group::Other => "other",
        }
    }
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
    /// The WebView2 role (`browser`, `renderer`, `gpu`, …) or `app`, `cli`,
    /// `game`, `helper`.
    pub role: String,
    /// `app` | `webview` | `cli` | `game` | `other` for processes; `job`.
    pub group: String,
    /// Display owner for a grouped row (the game title), otherwise empty.
    pub owner: String,
    /// Parent PID; 0 when the process has no parent or the row is a job.
    pub parent_pid: u32,
    pub pid: u32,
    /// Machine-wide CPU percent (0-100), like Task Manager.
    pub cpu: f64,
    pub memory_mb: f64,
    /// Bytes read and written since the process started, in MB.
    pub read_mb: f64,
    pub written_mb: f64,
    /// Live disk rates, in MB/s, from the delta between two snapshots.
    pub read_rate: f64,
    pub write_rate: f64,
    /// Executable path, start time (unix seconds) and the full command line:
    /// the row's detail card shows them.
    pub exe: String,
    pub started_at: u64,
    pub cmd: String,
    pub running: bool,
    pub stoppable: bool,
    /// True when the task manager may end this process (CLI tools and the
    /// launcher's own helpers, never the app or the WebView2 infrastructure).
    pub endable: bool,
}

/// The game the launcher is tracking right now, with the totals of its process
/// tree. Game rows are kept out of the launcher totals.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TaskGame {
    pub key: String,
    pub title: String,
    /// `epic` | `gog` | `amazon` | `custom` | `steam` | `other`.
    pub store: String,
    pub cpu: f64,
    pub memory_mb: f64,
    pub process_count: usize,
    /// Start time (unix seconds) of the oldest game process; 0 if unknown.
    pub started_at: u64,
    pub closable: bool,
}

/// Everything one call returns: the rows, the games, the system's memory size
/// and the recent history the sparklines use.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskSnapshot {
    pub rows: Vec<TaskRow>,
    pub games: Vec<TaskGame>,
    pub total_memory_mb: f64,
    pub cpu_history: Vec<f64>,
    pub memory_history: Vec<f64>,
    pub jobs_history: Vec<f64>,
}

/// WebView2's own processes are all named after the Edge binary.
fn is_webview(name: &str) -> bool {
    name.to_ascii_lowercase().contains("msedgewebview2")
}

/// The packaged command-line tools the launcher runs. PyInstaller starts two
/// processes per tool (bootloader + interpreter), both carry the same name, so
/// matching the name is enough.
fn is_cli(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let base = lower.strip_suffix(".exe").unwrap_or(lower.as_str());
    matches!(base, "legendary" | "gogdl" | "nile" | "rclone")
}

/// The WebView2 role a child process plays, from its `--type=` switch. Utility
/// processes are narrowed by `--utility-sub-type=`, so the panel can tell the
/// network, storage and audio services apart.
fn webview_role(cmd: &[OsString]) -> String {
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

/// Which group a process belongs to. Games win over everything else: their
/// crash reporter and anti-cheat processes also sit in the game's tree.
fn classify(pid: u32, name: &str, me: u32, game_pids: &HashSet<u32>) -> Group {
    if pid == me {
        Group::App
    } else if game_pids.contains(&pid) {
        Group::Game
    } else if is_webview(name) {
        Group::Webview
    } else if is_cli(name) {
        Group::Cli
    } else {
        Group::Other
    }
}

/// The command line as one readable string; arguments with spaces get their
/// quotes back, so a path stays copyable.
fn command_line(cmd: &[OsString]) -> String {
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

/// Direct and indirect descendants of `root`, in breadth-first order. The
/// parent map is built once per snapshot, so this is O(processes) rather than
/// O(processes × tree).
fn collect_descendants(root: u32, children: &HashMap<u32, Vec<u32>>) -> Vec<u32> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let mut frontier = vec![root];
    while let Some(parent) = frontier.pop() {
        let Some(list) = children.get(&parent) else {
            continue;
        };
        for &child in list {
            if seen.insert(child) {
                out.push(child);
                frontier.push(child);
            }
        }
    }
    out
}

/// One process → its direct children, in a single pass over the process list.
fn children_map(system: &System) -> HashMap<u32, Vec<u32>> {
    let mut map: HashMap<u32, Vec<u32>> = HashMap::new();
    for (pid, process) in system.processes() {
        if let Some(parent) = process.parent() {
            map.entry(parent.as_u32()).or_default().push(pid.as_u32());
        }
    }
    map
}

/// True when `pid` is a descendant of `root`. Stops on a cycle (a reused PID
/// can point at itself on some platforms) and after a sane depth.
fn is_descendant(system: &System, mut pid: u32, root: u32) -> bool {
    for _ in 0..128 {
        let Some(process) = system.process(Pid::from_u32(pid)) else {
            return false;
        };
        let Some(parent) = process.parent() else {
            return false;
        };
        let parent = parent.as_u32();
        if parent == root {
            return true;
        }
        if parent == pid {
            return false;
        }
        pid = parent;
    }
    false
}

/// Store ids carry the store as a prefix; Epic app names are bare.
fn game_store(key: &str) -> &'static str {
    if key.starts_with("gog::") {
        "gog"
    } else if key.starts_with("amazon::") {
        "amazon"
    } else if key.starts_with("custom::") {
        "custom"
    } else if key.starts_with("steam::") {
        "steam"
    } else if key.starts_with("battlenet::") {
        "battlenet"
    } else if key.starts_with("ubisoft::") {
        "ubisoft"
    } else if key.starts_with("ea::") {
        "ea"
    } else if key.starts_with("riot::") {
        "riot"
    } else if key.starts_with("xbox::") {
        "xbox"
    } else if key.contains("::") {
        "other"
    } else {
        "epic"
    }
}

#[tauri::command]
pub async fn task_manager_snapshot(app: AppHandle) -> Result<TaskSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || build_snapshot(&app))
        .await
        .map_err(|error| error.to_string())
}

/// The synchronous half of the snapshot, kept off the IPC thread.
fn build_snapshot(app: &AppHandle) -> TaskSnapshot {
    let mut guard = SYSTEM.lock().unwrap_or_else(|e| e.into_inner());
    let system = guard.get_or_insert_with(System::new);
    system.refresh_cpu_all();
    system.refresh_memory();

    // First pass: process list, names and parents only. This is what the tree
    // needs; memory, CPU, exe and command line are read for the few rows the
    // panel actually shows.
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );

    let me = std::process::id();
    let children = children_map(system);
    let mut wanted: Vec<u32> = std::iter::once(me)
        .chain(collect_descendants(me, &children))
        .collect();

    // The tracked game may not be a descendant of the launcher (a detached
    // process whose parent exited), so its tree is added explicitly.
    let active_game = crate::legendary::screenshots::get_active_running_game();
    let mut game_tree: HashSet<u32> = HashSet::new();
    if active_game.is_some() {
        for pid in crate::legendary::screenshots::active_game_pids() {
            game_tree.insert(pid);
            for child in collect_descendants(pid, &children) {
                game_tree.insert(child);
            }
        }
    }
    wanted.extend(game_tree.iter().copied());
    wanted.sort_unstable();
    wanted.dedup();

    // Second pass: the full counters, only for the rows the panel shows.
    let wanted_pids: Vec<Pid> = wanted.iter().map(|pid| Pid::from_u32(*pid)).collect();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&wanted_pids),
        false,
        ProcessRefreshKind::nothing()
            .with_memory()
            .with_cpu()
            .with_disk_usage()
            .with_exe(UpdateKind::OnlyIfNotSet)
            .with_cmd(UpdateKind::OnlyIfNotSet),
    );

    let rates = disk_rates(system, &wanted);
    let logical = system.cpus().len().max(1) as f32;
    let mut rows = Vec::with_capacity(wanted.len() + 12);

    let process_row = |pid: u32| -> Option<TaskRow> {
        let process = system.process(Pid::from_u32(pid))?;
        let name = process.name().to_string_lossy().to_string();
        let group = classify(pid, &name, me, &game_tree);
        let disk = process.disk_usage();
        let (read_rate, write_rate) = rates.get(&pid).copied().unwrap_or((0.0, 0.0));
        let owner = if group == Group::Game {
            active_game
                .as_ref()
                .map(|(_, title)| title.clone())
                .unwrap_or_default()
        } else {
            String::new()
        };
        Some(TaskRow {
            id: format!("process:{pid}"),
            kind: "process".to_string(),
            name,
            role: match group {
                Group::App => "app".to_string(),
                Group::Webview => webview_role(process.cmd()),
                Group::Cli => "cli".to_string(),
                Group::Game => "game".to_string(),
                Group::Other => "helper".to_string(),
            },
            group: group.as_str().to_string(),
            owner,
            parent_pid: process.parent().map(Pid::as_u32).unwrap_or(0),
            pid,
            cpu: (process.cpu_usage() / logical) as f64,
            memory_mb: process.memory() as f64 / (1024.0 * 1024.0),
            read_mb: disk.total_read_bytes as f64 / (1024.0 * 1024.0),
            written_mb: disk.total_written_bytes as f64 / (1024.0 * 1024.0),
            read_rate,
            write_rate,
            exe: process
                .exe()
                .map(|path| path.to_string_lossy().to_string())
                .unwrap_or_default(),
            started_at: process.start_time(),
            cmd: command_line(process.cmd()),
            running: true,
            stoppable: false,
            endable: matches!(group, Group::Cli | Group::Other),
        })
    };

    for pid in &wanted {
        if let Some(row) = process_row(*pid) {
            rows.push(row);
        }
    }

    let games = games_from_rows(active_game, &rows);

    // The background jobs, in a fixed order: what the panel runs first, then
    // the always-on helpers, then the pages that can be handed back.
    let job = |id: &str, running: bool, stoppable: bool| TaskRow {
        id: id.to_string(),
        kind: "job".to_string(),
        name: String::new(),
        role: String::new(),
        group: "job".to_string(),
        owner: String::new(),
        parent_pid: 0,
        pid: 0,
        cpu: 0.0,
        memory_mb: 0.0,
        read_mb: 0.0,
        written_mb: 0.0,
        read_rate: 0.0,
        write_rate: 0.0,
        exe: String::new(),
        started_at: 0,
        cmd: String::new(),
        running,
        stoppable,
        endable: false,
    };
    rows.push(job("metrics", crate::overlay::metrics::running(), true));
    rows.push(job("spotify", crate::spotify::playback::status(app).running, true));
    rows.push(job("controller_bridge", crate::controller_bridge::status().running, true));
    rows.push(job("discord_voice", crate::discord_rpc::voice_watch_running(), true));
    rows.push(job("discord_sdk", crate::discord_sdk::sdk_connected(), false));
    rows.push(job("presence", crate::presence::running(), true));
    rows.push(job("game_watch", true, false));
    rows.push(job("screenshots", true, false));
    rows.push(job("store_page", crate::store_host::store_view_alive(app), true));
    rows.push(job("discord_page", crate::discord_host::page_alive(app), true));
    rows.push(job("spotify_player", crate::spotify_host::player_alive(app), true));
    rows.push(job(
        "overlay_browser",
        crate::overlay::browser::overlay_browser_is_open(app.clone()),
        true,
    ));

    // Games are their own section: keep them out of the launcher totals.
    let total_cpu: f64 = rows
        .iter()
        .filter(|row| row.kind == "process" && row.group != "game")
        .map(|row| row.cpu)
        .sum();
    let total_memory: f64 = rows
        .iter()
        .filter(|row| row.kind == "process" && row.group != "game")
        .map(|row| row.memory_mb)
        .sum();
    let running_jobs = rows.iter().filter(|row| row.kind == "job" && row.running).count();

    let mut history = HISTORY.lock().unwrap_or_else(|e| e.into_inner());
    let stale = history
        .last_at
        .map(|at| at.elapsed() > HISTORY_GAP)
        .unwrap_or(true);
    if stale {
        history.samples.clear();
    }
    history.last_at = Some(Instant::now());
    history.samples.push_back(Sample {
        cpu: total_cpu,
        memory_mb: total_memory,
        jobs: running_jobs as f64,
    });
    while history.samples.len() > HISTORY_LEN {
        history.samples.pop_front();
    }

    let endable: HashMap<u32, u64> = rows
        .iter()
        .filter(|row| row.endable)
        .map(|row| (row.pid, row.started_at))
        .collect();
    *ENDABLE.lock().unwrap_or_else(|e| e.into_inner()) = Some(endable);

    TaskSnapshot {
        rows,
        games,
        total_memory_mb: system.total_memory() as f64 / (1024.0 * 1024.0),
        cpu_history: history.samples.iter().map(|sample| sample.cpu).collect(),
        memory_history: history.samples.iter().map(|sample| sample.memory_mb).collect(),
        jobs_history: history.samples.iter().map(|sample| sample.jobs).collect(),
    }
}

/// The active game's totals from its classified rows. The title is shown even
/// while the process tree is still being discovered.
fn games_from_rows(
    active: Option<(String, String)>,
    rows: &[TaskRow],
) -> Vec<TaskGame> {
    let Some((key, title)) = active else {
        return Vec::new();
    };
    let game_rows: Vec<&TaskRow> = rows.iter().filter(|row| row.group == "game").collect();
    let cpu = game_rows.iter().map(|row| row.cpu).sum();
    let memory_mb = game_rows.iter().map(|row| row.memory_mb).sum();
    let started_at = game_rows
        .iter()
        .map(|row| row.started_at)
        .filter(|time| *time > 0)
        .min()
        .unwrap_or(0);
    vec![TaskGame {
        store: game_store(&key).to_string(),
        key,
        title,
        cpu,
        memory_mb,
        process_count: game_rows.len(),
        started_at,
        closable: true,
    }]
}

/// Live read/write rates for the shown processes, in MB/s. The first snapshot
/// has no previous mark, so its rates are zero.
fn disk_rates(system: &System, pids: &[u32]) -> HashMap<u32, (f64, f64)> {
    let now = Instant::now();
    let mut guard = DISK_MARKS.lock().unwrap_or_else(|e| e.into_inner());
    let previous = guard.take().unwrap_or_default();
    let mut next = HashMap::with_capacity(pids.len());
    let mut rates = HashMap::with_capacity(pids.len());

    for &pid in pids {
        let Some(process) = system.process(Pid::from_u32(pid)) else {
            continue;
        };
        let disk = process.disk_usage();
        let started_at = process.start_time();
        let rate = previous
            .get(&pid)
            .filter(|mark| {
                mark.started_at == started_at && now.duration_since(mark.at) <= HISTORY_GAP
            })
            .map(
            |mark| {
                let seconds = now.duration_since(mark.at).as_secs_f64().max(0.001);
                let read = disk.total_read_bytes.saturating_sub(mark.read) as f64
                    / (1024.0 * 1024.0)
                    / seconds;
                let written = disk.total_written_bytes.saturating_sub(mark.written) as f64
                    / (1024.0 * 1024.0)
                    / seconds;
                (read, written)
            },
        );
        if let Some(rate) = rate {
            rates.insert(pid, rate);
        }
        next.insert(
            pid,
            DiskMark {
                started_at,
                read: disk.total_read_bytes,
                written: disk.total_written_bytes,
                at: now,
            },
        );
    }
    *guard = Some(next);
    rates
}

/// Ends one launcher-owned process tree. The PID is re-checked against a fresh
/// process list, its start time must match the snapshot and it must still be a
/// descendant of the launcher in a group the panel marks `endable`.
#[tauri::command]
pub async fn task_manager_end_process(pid: u32, started_at: u64) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || end_process(pid, started_at))
        .await
        .map_err(|error| error.to_string())?
}

fn end_process(pid: u32, started_at: u64) -> Result<(), String> {
    let me = std::process::id();
    if pid == me {
        return Err("@t:task.notEndable".to_string());
    }
    let allowed = ENDABLE
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|rows| rows.get(&pid))
        .copied();
    if allowed != Some(started_at) {
        return Err("@t:task.notEndable".to_string());
    }

    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
    let Some(process) = system.process(Pid::from_u32(pid)) else {
        return Err("@t:task.notEndable".to_string());
    };
    if process.start_time() != started_at {
        return Err("@t:task.notEndable".to_string());
    }
    let name = process.name().to_string_lossy().to_string();
    let group = classify(pid, &name, me, &HashSet::new());
    if !matches!(group, Group::Cli | Group::Other) {
        return Err("@t:task.notEndable".to_string());
    }
    if !is_descendant(&system, pid, me) {
        return Err("@t:task.notEndable".to_string());
    }
    // A game launched detached still belongs to the game section; only the
    // "Close game" action may end it.
    for game_pid in crate::legendary::screenshots::active_game_pids() {
        if pid == game_pid || is_descendant(&system, pid, game_pid) {
            return Err("@t:task.notEndable".to_string());
        }
    }

    let children = children_map(&system);
    let mut tree = vec![pid];
    tree.extend(collect_descendants(pid, &children));
    // Deepest first: a parent that exits early can orphan its children.
    let mut killed = false;
    for target in tree.iter().rev() {
        if let Some(process) = system.process(Pid::from_u32(*target)) {
            killed |= process.kill();
        }
    }
    if !killed {
        return Err("@t:task.notEndable".to_string());
    }
    Ok(())
}

/// Force-closes the tracked game through its store's normal stop path, so the
/// playtime record and the "game finished" event still run.
#[tauri::command]
pub async fn task_manager_close_game(app: AppHandle) -> Result<(), String> {
    let Some((key, _title)) = crate::legendary::screenshots::get_active_running_game() else {
        return Err("@t:task.noGame".to_string());
    };

    if let Some(id) = key.strip_prefix("gog::") {
        crate::gogdl::launcher::gog_stop_game(app, id.to_string()).await?;
    } else if let Some(id) = key.strip_prefix("amazon::") {
        crate::nile::transfers::nile_stop(app, id.to_string()).await?;
    } else if key.starts_with("custom::") {
        crate::custom_games::custom_games_stop(app, key.clone())?;
    } else if key.contains("::") {
        // Companion launches (Battle.net, Ubisoft, …) have no stop command of
        // their own: kill the tracked tree and let the store watcher finish the
        // session.
        let mut pids = crate::legendary::screenshots::active_game_pids();
        if pids.is_empty() {
            return Err("@t:task.noGame".to_string());
        }
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing(),
        );
        let children = children_map(&system);
        let mut targets: Vec<u32> = Vec::new();
        let mut seen = HashSet::new();
        for pid in pids.drain(..) {
            if seen.insert(pid) {
                targets.push(pid);
            }
            for child in collect_descendants(pid, &children) {
                if seen.insert(child) {
                    targets.push(child);
                }
            }
        }
        // Deepest first: a parent that exits early can orphan its children.
        for pid in targets.iter().rev() {
            if let Some(process) = system.process(Pid::from_u32(*pid)) {
                process.kill();
            }
        }
        crate::legendary::screenshots::clear_active_running_game(&key);
        let _ = app.emit(
            "game-status",
            serde_json::json!({ "id": key, "running": false }),
        );
    } else {
        crate::legendary::transfers::epic_stop_game(app, key).await?;
    }
    Ok(())
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
    use super::{classify, command_line, game_store, is_cli, is_webview, webview_role, Group};
    use std::collections::HashSet;
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
    fn is_cli_matches_the_packaged_tools() {
        assert!(is_cli("legendary.exe"));
        assert!(is_cli("LEGENDARY"));
        assert!(is_cli("gogdl.exe"));
        assert!(is_cli("nile"));
        assert!(is_cli("rclone.exe"));
        assert!(!is_cli("efxlve-launcher.exe"));
        assert!(!is_cli("msedgewebview2.exe"));
    }

    #[test]
    fn classify_keeps_games_and_webview_apart() {
        let me = 10;
        let mut games = HashSet::new();
        games.insert(40);
        assert_eq!(classify(me, "efxlve-launcher.exe", me, &games), Group::App);
        assert_eq!(classify(40, "game.exe", me, &games), Group::Game);
        assert_eq!(
            classify(50, "msedgewebview2.exe", me, &games),
            Group::Webview
        );
        assert_eq!(classify(60, "legendary.exe", me, &games), Group::Cli);
        assert_eq!(classify(70, "python.exe", me, &games), Group::Other);
    }

    #[test]
    fn game_store_reads_the_id_prefix() {
        assert_eq!(game_store("Gravity"), "epic");
        assert_eq!(game_store("gog::123"), "gog");
        assert_eq!(game_store("amazon::abc"), "amazon");
        assert_eq!(game_store("custom::my-game"), "custom");
        assert_eq!(game_store("steam::440"), "steam");
        assert_eq!(game_store("battlenet::wow"), "battlenet");
        assert_eq!(game_store("unknown::x"), "other");
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
