//! Boot timing: a tiny append-only log the launcher writes while it starts.
//!
//! "Startup feels slow" is only fixable with numbers, so the front end drops
//! marks (`perf_mark`) and the boot-critical commands log their own durations
//! through [`Timer`]. The file lives in `<app_data>/perf.log`, is capped at a
//! few dozen kilobytes, and trims itself by dropping the oldest lines.
//!
//! The log directory is captured once at startup ([`init`]), so modules that
//! never see an `AppHandle` can still write a line.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Instant;
use tauri::{AppHandle, Manager};

/// Trim the log when it grows past this; the newest lines stay.
const MAX_BYTES: u64 = 48 * 1024;
/// Lines kept when trimming.
const KEEP_LINES: usize = 200;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

/// Called once from `setup` so every module can log without an `AppHandle`.
pub fn init(dir: PathBuf) {
    let _ = LOG_PATH.set(dir.join("perf.log"));
}

/// Appends one line; never fails loudly (logging must not break a boot).
pub fn write_line_global(line: &str) {
    let Some(path) = LOG_PATH.get() else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
    trim(path);
}

/// Same as [`write_line_global`]; kept for call sites that hold the handle.
pub fn write_line(_app: &AppHandle, line: &str) {
    write_line_global(line);
}

fn trim(path: &Path) {
    let Ok(meta) = std::fs::metadata(path) else {
        return;
    };
    if meta.len() <= MAX_BYTES {
        return;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return;
    };
    let kept: Vec<&str> = text.lines().rev().take(KEEP_LINES).collect();
    let rebuilt = kept.into_iter().rev().collect::<Vec<_>>().join("\n");
    let _ = std::fs::write(path, format!("{rebuilt}\n"));
}

/// Times one command and logs it when the work is done.
pub struct Timer {
    started: Instant,
    label: String,
}

impl Timer {
    pub fn start(label: &str) -> Self {
        Self {
            started: Instant::now(),
            label: label.to_string(),
        }
    }

    pub fn elapsed_ms(&self) -> u128 {
        self.started.elapsed().as_millis()
    }

    pub fn done(self, app: &AppHandle) {
        write_line(app, &format!("{:>6} ms  {}", self.elapsed_ms(), self.label));
    }

    /// For modules that have no `AppHandle` at hand.
    pub fn done_global(self) {
        write_line_global(&format!("{:>6} ms  {}", self.elapsed_ms(), self.label));
    }
}

/// The front end's own boot marks (shell paint, first library paint, …).
#[tauri::command]
pub fn perf_mark(app: AppHandle, label: String, ms: u64) {
    write_line(&app, &format!("{ms:>6} ms  {label}"));
}
