//! Last-alive marker for a process that dies without a trace.
//!
//! A panic reaches `crash.log` and a native fault reaches Windows Error
//! Reporting, but a process killed from outside (Task Manager, an installer's
//! RestartManager, an anti-cheat) leaves neither: `perf.log` just stops at
//! whatever it last wrote. This module rewrites one small file while the app
//! runs, so the next launch can say when the previous one was last seen.
//!
//! The file is removed on a clean exit, exactly like `run.marker`.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Half a minute bounds the error on the death time without waking the disk
/// more than twice a minute.
const BEAT: Duration = Duration::from_secs(30);

static PATH: OnceLock<PathBuf> = OnceLock::new();

struct Timer {
    running: Mutex<bool>,
    wake: Condvar,
}

static TIMER: OnceLock<Arc<Timer>> = OnceLock::new();

/// Called once from `setup`, before [`previous_line`] reads the old file.
pub fn init(dir: PathBuf) {
    let _ = PATH.set(dir.join("alive.txt"));
    let _ = TIMER.set(Arc::new(Timer {
        running: Mutex::new(false),
        wake: Condvar::new(),
    }));
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

/// Process id first so the file also says *which* instance wrote it.
fn beat_text(now: u64) -> String {
    format!("{} {}", std::process::id(), now)
}

fn parse(text: &str) -> Option<u64> {
    text.split_whitespace().nth(1)?.parse().ok()
}

fn write_beat(path: &Path) {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(path, beat_text(now_secs()));
}

/// The line the next boot logs when the previous run left a beat behind.
///
/// `started` is that run's start time from `run.marker`; with it the line
/// separates a long session killed mid-play from one that died during boot.
pub fn previous_line(started: Option<u64>) -> Option<String> {
    let last = parse(&std::fs::read_to_string(PATH.get()?).ok()?)?;
    let stamp = crate::clock::stamp(UNIX_EPOCH + Duration::from_secs(last));
    Some(match started {
        Some(started) => format!(
            "boot: previous run last alive {stamp} ({} after its start)",
            human(last.saturating_sub(started))
        ),
        None => format!("boot: previous run last alive {stamp}"),
    })
}

/// Starts the beat thread. The first beat is written immediately, so a crash
/// during boot still leaves a timestamp.
pub fn start() {
    let (Some(path), Some(timer)) = (PATH.get().cloned(), TIMER.get().cloned()) else {
        return;
    };
    let mut running = timer
        .running
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if *running {
        return;
    }
    *running = true;
    // The guard borrows `timer`; it must be gone before the closure takes it.
    drop(running);
    write_beat(&path);
    let _ = std::thread::Builder::new()
        .name("alive-beat".into())
        .spawn(move || {
            let mut running = timer
                .running
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            while *running {
                let (guard, _) = timer
                    .wake
                    .wait_timeout(running, BEAT)
                    .unwrap_or_else(|error| error.into_inner());
                running = guard;
                if *running {
                    write_beat(&path);
                }
            }
        });
}

/// Marks the exit clean: the next boot sees no beat and logs nothing.
pub fn stop() {
    if let Some(timer) = TIMER.get() {
        let mut running = timer
            .running
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        *running = false;
        timer.wake.notify_all();
    }
    if let Some(path) = PATH.get() {
        let _ = std::fs::remove_file(path);
    }
}

fn human(seconds: u64) -> String {
    let hours = seconds / 3_600;
    let minutes = (seconds % 3_600) / 60;
    let rest = seconds % 60;
    if hours > 0 {
        format!("{hours}h {minutes}m")
    } else if minutes > 0 {
        format!("{minutes}m {rest}s")
    } else {
        format!("{rest}s")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_beat_carries_the_process_id_and_time() {
        let text = beat_text(1_795_201_488);
        assert!(text.starts_with(&format!("{} ", std::process::id())));
        assert_eq!(parse(&text), Some(1_795_201_488));
    }

    #[test]
    fn a_damaged_beat_is_ignored() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("1234"), None);
        assert_eq!(parse("1234 not-a-time"), None);
    }

    #[test]
    fn the_alive_span_is_readable() {
        assert_eq!(human(0), "0s");
        assert_eq!(human(65), "1m 5s");
        assert_eq!(human(3_725), "1h 2m");
    }
}
