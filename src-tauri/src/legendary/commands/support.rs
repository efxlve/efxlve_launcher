//! Shared Legendary command helpers: binary lookup, error files, retries.

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde::{de::DeserializeOwned, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::legendary::models::LegendaryStatus;
use crate::legendary::{client, cmd_error, paths, skip, transient_reason, LegendaryError};

pub(super) fn resolve_or_err(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    paths::resolve_binary(app).map_err(cmd_error)
}

/// Writes the full error output to a file and returns a user-friendly message.
/// File: `<app_data>/logs/legendary-error.log` (read for diagnostics).
pub(super) fn fail(app: &AppHandle, e: LegendaryError) -> String {
    if let LegendaryError::CommandFailed { stderr_full, .. } = &e {
        let path = app
            .path()
            .app_data_dir()
            .unwrap_or_else(|_| std::env::temp_dir())
            .join("logs")
            .join("legendary-error.log");
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let capped: String = stderr_full.chars().take(30_000).collect();
        let _ = std::fs::write(path, capped);
    }
    cmd_error(e)
}

/// Legendary config dir: when the entitlement database exists at the default location
/// there is no need to run `status`, because even `status --offline` fetches
/// missing metadata one by one, can hit 401, and is slow!
pub(super) async fn config_dir_for(bin: &Path) -> PathBuf {
    let def = skip::default_config_dir();
    if def.join("assets.json").is_file() {
        return def;
    }
    client::run_json::<LegendaryStatus>(bin, &["status", "--offline", "--json"])
        .await
        .map(|st| PathBuf::from(st.config_directory))
        .unwrap_or(def)
}

/// Resilient command runner: on a 401 catalog error it skips the item automatically,
/// and on transient errors (429/network) it waits and retries.
///
/// IMPORTANT: every command that syncs (including `status --offline`) must go through here,
/// because legendary tries to fetch games with missing metadata one by one even in
/// `--offline` mode (the retry path in core.py) and crashes on a broken item.
pub(super) async fn run_with_recovery<T: DeserializeOwned>(
    app: &AppHandle,
    bin: &Path,
    config_dir: &Path,
    args: &[&str],
) -> Result<T, String> {
    let mut last_err: String;
    let mut time_retries = 0u8;
    let mut total_skips = 0u32;
    let mut repeat_guard: Option<(String, u8)> = None;
    loop {
        match client::run_json_timeout(bin, args, client::LIST_TIMEOUT_SECS).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                // 401 catalog error + URL present -> skip the item automatically and continue.
                // No fixed budget: each skip is progress; it stops via the stall guard.
                if let LegendaryError::CommandFailed { stderr_tail, .. } = &e {
                    if let Some((ns, item)) = skip::parse_401_item(stderr_tail) {
                        let key = format!("{ns}:{item}");
                        let repeats = match &repeat_guard {
                            Some((k, n)) if k == &key => *n + 1,
                            _ => 1,
                        };
                        repeat_guard = Some((key, repeats));
                        if repeats >= 3 {
                            last_err = format!(
                                "@t:err.skipStuck\u{1f}{ns}\u{1f}{item}\u{1f}{}",
                                fail(app, e)
                            );
                            break;
                        }
                        if total_skips >= 60 {
                            last_err = fail(app, e);
                            break;
                        }
                        match skip::skip_item(app, config_dir, &ns, &item) {
                            Ok(app_name) => {
                                total_skips += 1;
                                time_retries = 0;
                                let _ = app.emit(
                                    "legendary-library",
                                    LibraryEvent {
                                        state: "skipped".into(),
                                        attempt: total_skips.min(255) as u8,
                                        message: format!(
                                            "@t:lib.itemSkipped\u{1f}{app_name}\u{1f}{total_skips}"
                                        ),
                                    },
                                );
                                continue;
                            }
                            Err(skip_err) => {
                                last_err = format!(
                                    "@t:err.skipFailed\u{1f}{}\u{1f}{skip_err}",
                                    fail(app, e)
                                );
                                break;
                            }
                        }
                    }
                }
                // Transient error (429/network) -> wait and retry (up to 3 times).
                let reason = match &e {
                    LegendaryError::CommandFailed { stderr_tail, .. } => {
                        transient_reason(stderr_tail)
                    }
                    _ => None,
                };
                last_err = fail(app, e);
                let Some(reason) = reason else {
                    break;
                };
                if time_retries >= 3 {
                    break;
                }
                time_retries += 1;
                let wait_secs = if time_retries == 1 { 20 } else { 45 };
                let reason_label = match reason {
                    "rate_limit" => "Rate limit",
                    "session" => "Session expired",
                    "network" => "Network error",
                    other => other,
                };
                let _ = app.emit(
                    "legendary-library",
                    LibraryEvent {
                        state: "retrying".into(),
                        attempt: time_retries,
                        message: format!(
                            "@t:lib.retrying\u{1f}{reason_label}\u{1f}{wait_secs}\u{1f}{time_retries}"
                        ),
                    },
                );
                tokio::time::sleep(Duration::from_secs(wait_secs)).await;
            }
        }
    }
    Err(last_err)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryEvent {
    state: String,
    attempt: u8,
    message: String,
}
