//! One rolling log for every store CLI transfer.
//!
//! legendary, gogdl and Nile each print their failure cause on a stream the
//! UI never shows, so a support report needs the last lines of the attempt.
//! `logs/download.log` stays small and is attached to feedback reports.

use std::path::Path;
use std::sync::Mutex;

use tauri::{AppHandle, Manager};

/// Enough for preparation, each retry and the final error.
const MAX_LINES: usize = 400;
/// The file is rolled away once it grows past this.
const MAX_BYTES: u64 = 512 * 1024;
/// Two stores can finish at the same moment; one append at a time keeps their
/// sections from interleaving.
static APPEND_LOCK: Mutex<()> = Mutex::new(());

/// Appends one attempt with the store CLI tail. Failures are rare enough that
/// the size check on every call is cheaper than a background rotation task.
pub fn append(app: &AppHandle, label: &str, result: &Result<(), String>, lines: &[String]) {
    let _guard = APPEND_LOCK
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let Ok(data_dir) = app.path().app_data_dir() else {
        return;
    };
    let log_dir = data_dir.join("logs");
    if std::fs::create_dir_all(&log_dir).is_err() {
        return;
    }
    let path = log_dir.join("download.log");
    if std::fs::metadata(&path)
        .map(|meta| meta.len() > MAX_BYTES)
        .unwrap_or(false)
    {
        let _ = std::fs::remove_file(&path);
    }
    append_to(&path, label, result, lines);
}

pub fn append_to(path: &Path, label: &str, result: &Result<(), String>, lines: &[String]) {
    use std::io::Write;

    let mut text = format!(
        "\n===== {} | {} | v{} =====\n",
        crate::clock::stamp(std::time::SystemTime::now()),
        label,
        env!("CARGO_PKG_VERSION")
    );
    match result {
        Ok(()) => text.push_str("result: success\n"),
        Err(error) => {
            text.push_str("result: failed: ");
            text.push_str(error);
            text.push('\n');
        }
    }
    let start = lines.len().saturating_sub(MAX_LINES);
    for line in &lines[start..] {
        text.push_str(line);
        text.push('\n');
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = file.write_all(text.as_bytes());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_last_lines_of_an_attempt_are_kept() {
        let dir = std::env::temp_dir().join(format!(
            "efxlve_download_log_tail_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("download.log");
        let lines: Vec<String> = (0..450).map(|i| format!("line-{i}")).collect();
        append_to(&path, "TestGame", &Ok(()), &lines);
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(!text.contains("line-0\n"));
        assert!(text.contains("line-449"));
        assert!(text.contains("result: success"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
