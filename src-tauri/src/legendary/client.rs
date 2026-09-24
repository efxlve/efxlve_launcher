//! legendary subprocess execution layer.
//!
//! Contract (verified from the source code):
//! - JSON output is written to **stdout** (`--json`).
//! - Logs go to **stderr**; stderr content is not an error indicator.
//! - Success = exit code 0 + parseable stdout.
//! - Unauthenticated `list` -> exit code 1, empty stdout, "No saved credentials" on stderr.
//! - On large libraries the achievements/metadata stream can hit HTTP 429;
//!   legendary writes partial results to disk, so retrying makes progress.

use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use serde::de::DeserializeOwned;

use super::LegendaryError;

const CMD_TIMEOUT_SECS: u64 = 180;
/// The first library sync (hundreds of games) can take minutes.
pub const LIST_TIMEOUT_SECS: u64 = 600;

/// Displayable summary from stderr: prefers lines containing "Error",
/// otherwise falls back to the last lines (the meaningful part instead of a raw traceback).
fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let lines: Vec<&str> = text.lines().collect();
    let mut picked: Vec<&str> = lines
        .iter()
        .filter(|l| {
            let low = l.to_lowercase();
            low.contains("error") || low.contains("exception") || low.contains("failed")
        })
        .take(3)
        .copied()
        .collect();
    if picked.is_empty() {
        picked = lines.iter().rev().take(3).copied().collect();
        picked.reverse();
    }
    let out: String = picked.join("\n").chars().take(600).collect();
    if out.trim().is_empty() {
        "bilinmeyen hata".to_string()
    } else {
        out
    }
}

/// Runs and parses commands that produce JSON output.
pub async fn run_json<T: DeserializeOwned>(
    bin: &Path,
    args: &[&str],
) -> Result<T, LegendaryError> {
    run_json_timeout(bin, args, CMD_TIMEOUT_SECS).await
}

/// JSON command execution with a custom timeout (e.g. the first library sync).
pub async fn run_json_timeout<T: DeserializeOwned>(
    bin: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<T, LegendaryError> {
    let output = run_with_timeout(bin, args, timeout_secs).await?;
    let text = String::from_utf8_lossy(&output.stdout);
    let text = text.trim();
    if text.is_empty() {
        return Err(LegendaryError::ParseError("@t:err.emptyOutput".into()));
    }
    serde_json::from_str(text).map_err(|e| LegendaryError::ParseError(e.to_string()))
}

/// For commands that do not return JSON (auth, import, logout...).
pub async fn run_unit(bin: &Path, args: &[&str]) -> Result<(), LegendaryError> {
    run_with_timeout(bin, args, CMD_TIMEOUT_SECS)
        .await
        .map(|_| ())
}

async fn run_with_timeout(
    bin: &Path,
    args: &[&str],
    timeout_secs: u64,
) -> Result<std::process::Output, LegendaryError> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let fut = cmd.output();
    let output = tokio::time::timeout(Duration::from_secs(timeout_secs), fut)
        .await
        .map_err(|_| LegendaryError::Timeout)?
        .map_err(LegendaryError::from)?;
    if output.status.success() {
        return Ok(output);
    }
    let code = output.status.code().unwrap_or(-1);
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("No saved credentials") {
        return Err(LegendaryError::NotAuthenticated);
    }
    Err(LegendaryError::CommandFailed {
        exit: code,
        stderr_tail: stderr_tail(&output.stderr),
        stderr_full: stderr.into_owned(),
    })
}
