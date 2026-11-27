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
pub async fn run_json<T: DeserializeOwned>(bin: &Path, args: &[&str]) -> Result<T, LegendaryError> {
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
    if session_invalid(&stderr) {
        return Err(LegendaryError::NotAuthenticated);
    }
    Err(LegendaryError::CommandFailed {
        exit: code,
        stderr_tail: stderr_tail(&output.stderr),
        stderr_full: stderr.into_owned(),
    })
}

/// A session Epic no longer accepts is a login prompt, not a command failure.
///
/// Legendary raises `InvalidCredentialsError` when the refresh token is dead,
/// clears `user.json` and exits 1. Left as a plain `CommandFailed`, the UI keeps
/// the account "Connected" and only shows the offline-cache note, so the player
/// never gets the sign-in step that would fix it.
fn session_invalid(stderr: &str) -> bool {
    stderr.contains("No saved credentials")
        || stderr.contains("Stored credentials are no longer valid")
}

#[cfg(test)]
mod tests {
    use super::session_invalid;

    #[test]
    fn a_rejected_session_is_a_login_prompt() {
        assert!(session_invalid("ValueError: No saved credentials"));
        assert!(session_invalid(
            "ERROR: Stored credentials are no longer valid! Please login again.\nERROR: Login failed, cannot continue!"
        ));
    }

    #[test]
    fn other_failures_stay_command_failures() {
        // A network outage also ends in "Login failed", but signing in again will
        // not help; the retry path needs the command failure.
        assert!(!session_invalid(
            "ERROR: HTTP request for login failed\nERROR: Login failed, cannot continue!"
        ));
        assert!(!session_invalid("HTTPError: 500 Server Error"));
        assert!(!session_invalid("Max retries exceeded with url"));
    }
}
