//! Running the Nile CLI with launcher-owned state.
//!
//! Nile keeps its library, installed list and encrypted tokens in a config
//! directory. We point it at `<app_data>/nile` via `NILE_CONFIG_PATH`, so the
//! launcher owns the whole state, can read `installed.json` directly, and an
//! uninstall can clean everything up.

use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

/// No progress for this long while the percentage can still move means the
/// transfer is wedged. Same window the Epic watchdog uses.
const STALL_LIMIT: Duration = Duration::from_secs(5 * 60);
/// Before the first progress line Nile only prepares the install. Complete
/// silence for this long is a wedged process, not a slow disk.
const STARTUP_STALL_LIMIT: Duration = Duration::from_secs(10 * 60);
/// Once the download is essentially complete Nile removes replaced files; the
/// percentage keeps repeating while that cleanup runs, so allow more time.
const FINALIZE_STALL: Duration = Duration::from_secs(15 * 60);
/// How often the wait loop checks the activity clock.
const STALL_POLL: Duration = Duration::from_secs(10);

/// `<app_data>`: the parent Nile appends its own `nile` folder to.
pub fn config_root(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
}

/// `<app_data>/nile` — passed to every Nile invocation as the config parent and
/// read directly for `library.json` / `installed.json`.
pub fn config_dir(app: &AppHandle) -> PathBuf {
    let dir = config_root(app).join("nile");
    migrate_nested_config(&dir);
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Earlier builds pointed `NILE_CONFIG_PATH` at `<app_data>/nile`, but Nile
/// appends its own `nile` folder, so the real config landed one level deeper.
/// Lift it up once so the login, library and installed list survive.
fn migrate_nested_config(dir: &Path) {
    let nested = dir.join("nile");
    if !nested.join("library.json").is_file() || dir.join("library.json").is_file() {
        return;
    }
    if let Ok(entries) = std::fs::read_dir(&nested) {
        for entry in entries.flatten() {
            let _ = std::fs::rename(entry.path(), dir.join(entry.file_name()));
        }
    }
    let _ = std::fs::remove_dir(&nested);
}

/// Builds one Nile invocation with the launcher-owned config and no console
/// window. Callers add args and stdio.
pub fn command(app: &AppHandle, bin: PathBuf) -> tokio::process::Command {
    // Lift a legacy nested config before Nile reads its own folder.
    let _ = config_dir(app);
    let mut cmd = tokio::process::Command::new(bin);
    // Nile appends "nile" itself, so the env var names the parent directory.
    cmd.env("NILE_CONFIG_PATH", config_root(app));
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// Runs one Nile command and returns its captured output.
pub async fn run(app: &AppHandle, args: &[&str], timeout_secs: u64) -> Result<Output, String> {
    let bin = super::ensure_binary(app).await?;
    let mut cmd = command(app, bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| "Nile timed out".to_string())?
        .map_err(|e| format!("Nile could not run: {e}"))
}

/// Runs one Nile command while streaming its stderr line by line. Nile logs the
/// download progress there, so the caller can forward it to the UI.
///
/// `on_spawn` learns the child pid as soon as it exists; returning `true` kills
/// it immediately, which closes the window between a cancel command and the
/// spawn. A transfer with no moving progress is killed instead of holding the
/// slot until the multi-hour cap.
pub async fn run_streaming(
    app: &AppHandle,
    args: &[String],
    timeout_secs: u64,
    stall_watchdog: bool,
    on_stderr_line: impl FnMut(&str) + Send + 'static,
    on_spawn: impl FnOnce(u32) -> bool + Send + 'static,
) -> Result<Output, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    let bin = super::ensure_binary(app).await?;
    let mut cmd = command(app, bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // The install child leads its own process group so a cancel reaches the
    // download workers too. Launches keep the caller's group.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.as_std_mut().process_group(0);
    }
    // Install, update and verify all download through Nile's requests workers.
    crate::download_limit::configure_child(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| format!("Nile could not run: {e}"))?;

    if let Some(pid) = child.id() {
        if on_spawn(pid) {
            kill_install_tree(pid).await;
        }
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let activity = Arc::new(Mutex::new(StreamActivity::new(Instant::now())));
    let activity_for_lines = Arc::clone(&activity);
    let mut on_line = on_stderr_line;
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                activity_for_lines
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .note_line(&line, Instant::now());
                on_line(&line);
                text.push_str(&line);
                text.push('\n');
            }
        }
        text
    });
    let stdout_task = tokio::spawn(async move {
        let mut bytes = Vec::new();
        if let Some(mut stdout) = stdout {
            let _ = stdout.read_to_end(&mut bytes).await;
        }
        bytes
    });

    let deadline = tokio::time::sleep(Duration::from_secs(timeout_secs));
    tokio::pin!(deadline);
    let mut poll = tokio::time::interval(STALL_POLL);
    poll.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let status = loop {
        tokio::select! {
            result = child.wait() => {
                break result.map_err(|e| format!("Nile could not finish: {e}"))?
            }
            _ = &mut deadline => {
                if let Some(pid) = child.id() {
                    kill_install_tree(pid).await;
                }
                return Err("@t:dl.stalled".to_string());
            }
            _ = poll.tick(), if stall_watchdog => {
                let stalled = activity
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .stalled(Instant::now());
                if stalled {
                    if let Some(pid) = child.id() {
                        kill_install_tree(pid).await;
                    }
                    return Err("@t:dl.stalled".to_string());
                }
            }
        }
    };
    let stderr_text = stderr_task.await.unwrap_or_default();
    let stdout_bytes = stdout_task.await.unwrap_or_default();

    Ok(Output {
        status,
        stdout: stdout_bytes,
        stderr: stderr_text.into_bytes(),
    })
}

/// Ends an install child and the workers in its process group. Launches do not
/// use a separate group, so they must not call this.
pub async fn kill_install_tree(pid: u32) {
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
        let _ = tokio::process::Command::new("kill")
            .args(["-9", &format!("-{pid}")])
            .output()
            .await;
    }
}

/// Stderr activity of one Nile transfer. A repeated percentage line does not
/// count as movement; only a changed one does.
struct StreamActivity {
    last_line: Instant,
    last_progress: Instant,
    percent: Option<f64>,
    downloaded: u64,
}

impl StreamActivity {
    fn new(now: Instant) -> Self {
        Self {
            last_line: now,
            last_progress: now,
            percent: None,
            downloaded: 0,
        }
    }

    fn note_line(&mut self, line: &str, now: Instant) {
        self.last_line = now;
        if let Some(progress) = super::transfers::parse_progress_line(line) {
            let advanced = self.percent.is_none()
                || self.percent != Some(progress.percent)
                || self.downloaded != progress.downloaded;
            if advanced {
                self.last_progress = now;
            }
            self.percent = Some(progress.percent);
            self.downloaded = progress.downloaded;
        }
    }

    /// True when the transfer should be killed. The cleanup after a finished
    /// download keeps repeating the last percentage, so it gets a longer
    /// window than a transfer that stopped moving.
    fn stalled(&self, now: Instant) -> bool {
        if self.percent.is_some() {
            let limit = if self.percent.is_some_and(|percent| percent >= 99.0) {
                FINALIZE_STALL
            } else {
                STALL_LIMIT
            };
            now.saturating_duration_since(self.last_progress) >= limit
        } else {
            now.saturating_duration_since(self.last_line) >= STARTUP_STALL_LIMIT
        }
    }
}

/// Trimmed stdout (Nile prints machine-readable payloads there).
pub fn stdout_text(out: &Output) -> String {
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}

/// Last non-empty stderr line, which carries Nile's own error message.
pub fn failure_message(out: &Output) -> String {
    String::from_utf8_lossy(&out.stderr)
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .unwrap_or_else(|| "Nile command failed".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exit_status_ok() -> std::process::ExitStatus {
        #[cfg(windows)]
        {
            use std::os::windows::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(0)
        }
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            std::process::ExitStatus::from_raw(0)
        }
    }

    #[test]
    fn a_stalled_download_is_detected_but_final_cleanup_is_not() {
        let now = Instant::now();
        let mut activity = StreamActivity::new(now);
        activity.note_line("INFO [PROGRESS]:\t = Progress: 42.13 1/2", now);
        assert!(!activity.stalled(now + Duration::from_secs(60)));
        // The same percentage and counters repeating every second is not
        // movement; upstream Nile can wedge exactly like that.
        activity.note_line(
            "INFO [PROGRESS]:\t = Progress: 42.13 1/2",
            now + Duration::from_secs(60),
        );
        assert!(activity.stalled(now + STALL_LIMIT + Duration::from_secs(1)));

        // The download completed; cleanup keeps repeating the last line, so it
        // gets the longer window instead of being killed as a network stall.
        activity.note_line("INFO [PROGRESS]:\t = Progress: 100.00 2/2", now);
        assert!(!activity.stalled(now + FINALIZE_STALL - Duration::from_secs(1)));
        activity.note_line(
            "INFO [PROGRESS]:\t = Progress: 100.00 2/2",
            now + FINALIZE_STALL - Duration::from_secs(1),
        );
        assert!(activity.stalled(now + FINALIZE_STALL + Duration::from_secs(1)));

        // Before the first progress line, only total silence counts.
        let idle = StreamActivity::new(now);
        assert!(!idle.stalled(now + Duration::from_secs(60)));
        assert!(idle.stalled(now + STARTUP_STALL_LIMIT + Duration::from_secs(1)));
    }

    #[test]
    fn stdout_is_trimmed_and_failure_reads_the_last_line() {
        let out = Output {
            status: exit_status_ok(),
            stdout: b"  {\"a\":1}\n".to_vec(),
            stderr: b"INFO [x]: one\nERROR [y]: boom\n\n".to_vec(),
        };
        assert_eq!(stdout_text(&out), "{\"a\":1}");
        assert_eq!(failure_message(&out), "ERROR [y]: boom");
    }
}
