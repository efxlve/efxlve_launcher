//! User-triggered feedback reports.
//!
//! A report is a small zip the user can attach to a GitHub issue. It contains
//! the note, environment details, the window and boot state, the performance
//! log, and a sanitized copy of the settings. Logs are copied only when the
//! user leaves diagnostics enabled; account vaults and Spotify tokens are never
//! included.

use std::io::Write;
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

const NOTE_LIMIT: usize = 8_000;
const LOG_LIMIT: u64 = 4 * 1024 * 1024;
const SETTINGS_FILE: &str = "settings.json";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackReport {
    pub path: String,
    pub folder: String,
    pub files: Vec<String>,
    pub issue_title: String,
    pub issue_body: String,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn report_stamp() -> String {
    format!("efxlve-feedback-{}", now_secs())
}

fn first_line(note: &str) -> String {
    let line = note
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("Feedback");
    line.chars().take(72).collect()
}

/// Removes secrets from a settings tree while keeping harmless preferences and
/// paths. The key check is deliberately broad: a token must never slip through.
fn redact_settings(value: &mut Value) {
    match value {
        Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                let lower = key.to_ascii_lowercase();
                if ["key", "token", "secret", "password", "auth", "cookie", "session"]
                    .iter()
                    .any(|needle| lower.contains(needle))
                {
                    *child = Value::String("<redacted>".into());
                } else {
                    redact_settings(child);
                }
            }
        }
        Value::Array(rows) => {
            for row in rows {
                redact_settings(row);
            }
        }
        _ => {}
    }
}

fn redacted_settings(app: &AppHandle) -> Option<String> {
    let path = app.path().app_data_dir().ok()?.join(SETTINGS_FILE);
    let text = std::fs::read_to_string(path).ok()?;
    let mut value: Value = serde_json::from_str(&text).ok()?;
    redact_settings(&mut value);
    serde_json::to_string_pretty(&value).ok()
}

fn read_limited(path: &Path) -> Option<Vec<u8>> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() as u64 <= LOG_LIMIT {
        return Some(bytes);
    }
    let start = bytes.len().saturating_sub(LOG_LIMIT as usize);
    let mut tail = b"[... earlier log lines omitted ...]\n".to_vec();
    tail.extend_from_slice(&bytes[start..]);
    Some(tail)
}

fn add_bytes(
    archive: &mut zip::ZipWriter<std::io::Cursor<Vec<u8>>>,
    options: zip::write::SimpleFileOptions,
    name: &str,
    bytes: &[u8],
    files: &mut Vec<String>,
) -> Result<(), String> {
    archive
        .start_file(name, options)
        .map_err(|error| error.to_string())?;
    archive
        .write_all(bytes)
        .map_err(|error| error.to_string())?;
    files.push(name.to_string());
    Ok(())
}

fn system_text(app: &AppHandle) -> String {
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|path| path.to_string_lossy().to_string())
        .unwrap_or_else(|_| "<unknown>".into());
    let processors = std::env::var("NUMBER_OF_PROCESSORS").unwrap_or_else(|_| "?".into());
    let architecture = std::env::var("PROCESSOR_ARCHITECTURE").unwrap_or_else(|_| "?".into());
    let windows = if cfg!(windows) {
        let key = r"HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion";
        let build = crate::winreg::query(key, Some("CurrentBuild"))
            .map(|out| crate::winreg::parse_reg_sz(&out))
            .unwrap_or_default();
        let name = crate::winreg::query(key, Some("ProductName"))
            .map(|out| crate::winreg::parse_reg_sz(&out))
            .unwrap_or_default();
        format!("{name} build {build}")
    } else {
        "n/a".to_string()
    };
    format!(
        "Efxlve Launcher: v{}\nOS: {} ({})\nWindows: {}\nArchitecture: {}\nProcessors: {}\nApp data: {}\nCreated (unix): {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        windows,
        architecture,
        processors,
        data_dir,
        now_secs(),
    )
}

#[tauri::command]
pub async fn feedback_create_report(
    app: AppHandle,
    note: String,
    include_logs: bool,
) -> Result<FeedbackReport, String> {
    tauri::async_runtime::spawn_blocking(move || create_report(app, note, include_logs))
        .await
        .map_err(|error| error.to_string())?
}

fn create_report(
    app: AppHandle,
    note: String,
    include_logs: bool,
) -> Result<FeedbackReport, String> {
    let note: String = note.trim().chars().take(NOTE_LIMIT).collect();
    if note.is_empty() {
        return Err("feedback.noteRequired".to_string());
    }

    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let folder = data_dir.join("feedback");
    std::fs::create_dir_all(&folder).map_err(|error| error.to_string())?;

    let mut path = folder.join(format!("{}.zip", report_stamp()));
    let mut suffix = 1;
    while path.exists() {
        path = folder.join(format!("{}-{}.zip", report_stamp(), suffix));
        suffix += 1;
    }

    let title = format!("[Feedback] {}", first_line(&note));
    let body = format!(
        "### What happened\n{}\n\n### Environment\n- Efxlve Launcher: v{}\n- OS: {} ({})\n- Report: `{}`\n\n> Diagnostics were generated by the launcher. Settings are redacted and account tokens are not included; please review the zip before attaching it.\n",
        note,
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("report.zip"),
    );

    let report_text = format!(
        "Efxlve Launcher feedback\n\
         Version: {}\n\
         OS: {} ({})\n\
         Note:\n{}\n\n\
         Attach this zip to the GitHub issue.\n\
         Diagnostics: {}\n",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH,
        note,
        if include_logs {
            "included"
        } else {
            "not included"
        },
    );

    let mut files = Vec::new();
    let mut archive = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);

    add_bytes(
        &mut archive,
        options,
        "report.txt",
        report_text.as_bytes(),
        &mut files,
    )?;
    add_bytes(
        &mut archive,
        options,
        "system.txt",
        system_text(&app).as_bytes(),
        &mut files,
    )?;
    add_bytes(
        &mut archive,
        options,
        "boot.txt",
        boot_text(&app, include_logs).as_bytes(),
        &mut files,
    )?;

    if include_logs {
        if let Some(settings) = redacted_settings(&app) {
            add_bytes(
                &mut archive,
                options,
                "settings-redacted.json",
                settings.as_bytes(),
                &mut files,
            )?;
        }
        let perf = data_dir.join("perf.log");
        if let Some(bytes) = read_limited(&perf) {
            add_bytes(&mut archive, options, "perf.log", &bytes, &mut files)?;
        }
        for name in ["crash.log", "legendary-error.log", "clip.log", "discord-rpc.log"] {
            let log = data_dir.join("logs").join(name);
            if let Some(bytes) = read_limited(&log) {
                add_bytes(
                    &mut archive,
                    options,
                    &format!("logs/{name}"),
                    &bytes,
                    &mut files,
                )?;
            }
        }
    }

    let bytes = archive
        .finish()
        .map_err(|error| error.to_string())?
        .into_inner();
    std::fs::write(&path, bytes).map_err(|error| error.to_string())?;

    Ok(FeedbackReport {
        path: path.to_string_lossy().to_string(),
        folder: folder.to_string_lossy().to_string(),
        files,
        issue_title: title,
        issue_body: body,
    })
}

/// True when a previous run wrote a crash log. The feedback dialog can use this
/// to tell the user that there is something worth attaching.
#[tauri::command]
pub fn feedback_has_crash(app: AppHandle) -> bool {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("logs").join("crash.log"))
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len() > 0)
        .unwrap_or(false)
}

/// True when the previous process ended without reaching a clean exit.
#[tauri::command]
pub fn feedback_recovery_pending(state: tauri::State<'_, crate::RunMarker>) -> bool {
    state.recovery
}

/// One line about the window at report time.
fn window_state(app: &AppHandle) -> String {
    let Some(window) = app.get_window("main") else {
        return "Main window: missing".into();
    };
    let flag = |value: tauri::Result<bool>| match value {
        Ok(true) => "true",
        Ok(false) => "false",
        Err(_) => "?",
    };
    format!(
        "Main window: visible={} minimized={} focused={}\n{}",
        flag(window.is_visible()),
        flag(window.is_minimized()),
        flag(window.is_focused()),
        crate::display_line(&window),
    )
}

/// The window and boot lines of one log text, newest session only. Walking the
/// log backwards stops at the session header, which is why a trimmed log still
/// yields the run that matters.
fn session_lines(text: &str) -> Vec<String> {
    let mut kept = Vec::new();
    for line in text.lines().rev() {
        if line.starts_with("=== ") {
            kept.push(line.to_string());
            break;
        }
        if (line.starts_with("win:") || line.starts_with("boot:")) && kept.len() < 200 {
            kept.push(line.to_string());
        }
    }
    kept.reverse();
    kept
}

fn last_session_lines(app: &AppHandle) -> Vec<String> {
    let Ok(dir) = app.path().app_data_dir() else {
        return Vec::new();
    };
    let Ok(text) = std::fs::read_to_string(dir.join("perf.log")) else {
        return Vec::new();
    };
    session_lines(&text)
}

/// `boot.txt`: the state a "it opened and then closed by itself" report needs.
fn boot_text(app: &AppHandle, include_logs: bool) -> String {
    let previous = match app.try_state::<crate::RunMarker>() {
        Some(marker) if marker.recovery => "no (the run before this one left its marker behind)",
        Some(_) => "yes",
        None => "unknown",
    };
    let mut text = format!(
        "Efxlve Launcher: v{}\nRecorded: {} (UTC)\nPrevious session ended cleanly: {}\nRuns without a clean exit in a row: {}\n{}\n",
        env!("CARGO_PKG_VERSION"),
        crate::clock::stamp(std::time::SystemTime::now()),
        previous,
        crate::read_crash_streak(app),
        window_state(app),
    );
    if include_logs {
        let lines = last_session_lines(app);
        text.push_str("\nTimeline (last launch):\n");
        if lines.is_empty() {
            text.push_str("no window events recorded (build before the trace existed)\n");
        } else {
            for line in lines {
                text.push_str(&line);
                text.push('\n');
            }
        }
    }
    text
}

#[cfg(test)]
mod tests {
    use super::{redact_settings, session_lines};
    use serde_json::json;

    #[test]
    fn settings_secrets_are_redacted_but_paths_stay() {
        let mut value = json!({
            "steam_api_key": "secret",
            "install_dir": "D:/Games",
            "nested": { "refresh_token": "token", "theme": "aero" }
        });
        redact_settings(&mut value);
        assert_eq!(value["steam_api_key"], "<redacted>");
        assert_eq!(value["nested"]["refresh_token"], "<redacted>");
        assert_eq!(value["install_dir"], "D:/Games");
        assert_eq!(value["nested"]["theme"], "aero");
    }

    #[test]
    fn only_the_last_launch_is_reported() {
        let log = "\
=== v0.1.36 2026-10-23 20:00:00 ===
  121 ms  main:module
win: visible=true minimized=false at +0 ms
win: visible=false minimized=false at +2310 ms
=== v0.1.37 2026-10-24 21:00:00 ===
  125 ms  main:module
win: visible=true minimized=false at +0 ms
boot: exit requested
boot: exit
";
        let lines = session_lines(log);
        assert_eq!(lines[0], "=== v0.1.37 2026-10-24 21:00:00 ===");
        assert!(lines.contains(&"win: visible=true minimized=false at +0 ms".to_string()));
        assert!(lines.contains(&"boot: exit".to_string()));
        assert!(
            !lines.iter().any(|line| line.contains("2310 ms")),
            "the previous launch must not be mixed into the report"
        );
        assert!(
            !lines.iter().any(|line| line.contains("main:module")),
            "timings are already in perf.log"
        );
    }

    #[test]
    fn a_log_without_a_header_still_yields_its_lines() {
        let lines = session_lines("win: close requested; hidden to the tray\nboot: exit");
        assert_eq!(
            lines,
            vec![
                "win: close requested; hidden to the tray".to_string(),
                "boot: exit".to_string()
            ]
        );
    }
}
