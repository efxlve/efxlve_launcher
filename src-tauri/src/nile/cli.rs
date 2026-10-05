//! Running the Nile CLI with launcher-owned state.
//!
//! Nile keeps its library, installed list and encrypted tokens in a config
//! directory. We point it at `<app_data>/nile` via `NILE_CONFIG_PATH`, so the
//! launcher owns the whole state, can read `installed.json` directly, and an
//! uninstall can clean everything up.

use std::path::PathBuf;
use std::process::{Output, Stdio};
use std::time::Duration;

use tauri::{AppHandle, Manager};

/// `<app_data>/nile` — passed to every Nile invocation.
pub fn config_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("nile");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// Builds one Nile invocation with the launcher-owned config and no console
/// window. Callers add args and stdio.
pub fn command(app: &AppHandle, bin: std::path::PathBuf) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.env("NILE_CONFIG_PATH", config_dir(app));
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
        .stderr(Stdio::piped());

    tokio::time::timeout(Duration::from_secs(timeout_secs), cmd.output())
        .await
        .map_err(|_| "Nile timed out".to_string())?
        .map_err(|e| format!("Nile could not run: {e}"))
}

/// Runs one Nile command while streaming its stderr line by line. Nile logs the
/// download progress there, so the caller can forward it to the UI.
pub async fn run_streaming(
    app: &AppHandle,
    args: &[String],
    timeout_secs: u64,
    on_stderr_line: impl FnMut(&str) + Send + 'static,
) -> Result<Output, String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

    let bin = super::ensure_binary(app).await?;
    let mut cmd = command(app, bin);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("Nile could not run: {e}"))?;

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    let mut on_line = on_stderr_line;
    let stderr_task = tokio::spawn(async move {
        let mut text = String::new();
        if let Some(stderr) = stderr {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
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

    let status = tokio::time::timeout(Duration::from_secs(timeout_secs), child.wait())
        .await
        .map_err(|_| "Nile timed out".to_string())?
        .map_err(|e| format!("Nile could not finish: {e}"))?;
    let stderr_text = stderr_task.await.unwrap_or_default();
    let stdout_bytes = stdout_task.await.unwrap_or_default();

    Ok(Output {
        status,
        stdout: stdout_bytes,
        stderr: stderr_text.into_bytes(),
    })
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
