//! Boot timing: a tiny append-only log the launcher writes while it starts.
//!
//! "Startup feels slow" is only fixable with numbers, so the front end drops
//! marks (`perf_mark`) and the boot-critical commands log their own durations
//! through [`Timer`]. The file lives in `<app_data>/perf.log`, is capped at a
//! few dozen kilobytes, and trims itself by dropping the oldest lines.

use std::io::Write;
use std::path::Path;
use std::time::Instant;
use tauri::{AppHandle, Manager};

/// Trim the log when it grows past this; the newest lines stay.
const MAX_BYTES: u64 = 48 * 1024;
/// Lines kept when trimming.
const KEEP_LINES: usize = 200;

/// Appends one line; never fails loudly (logging must not break a boot).
pub fn write_line(app: &AppHandle, line: &str) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let path = dir.join("perf.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(file, "{line}");
    }
    trim(&path);
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

    pub fn done(self, app: &AppHandle) {
        let ms = self.started.elapsed().as_millis();
        write_line(app, &format!("{ms:>6} ms  {}", self.label));
    }
}

/// The front end's own boot marks (shell paint, first library paint, …).
#[tauri::command]
pub fn perf_mark(app: AppHandle, label: String, ms: u64) {
    write_line(&app, &format!("{ms:>6} ms  {label}"));
}
