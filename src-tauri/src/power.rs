//! Session power actions used by the download finish setting.
//!
//! The frontend owns the sixty-second countdown and every cancellation rule;
//! this module only performs the final sleep or shutdown after that choice has
//! already been made. Nothing is queued or persisted here, so a restart cannot
//! replay an old power command.

use std::process::{Command, Stdio};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PowerAction {
    Sleep,
    Shutdown,
}

impl PowerAction {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "sleep" => Ok(Self::Sleep),
            "shutdown" => Ok(Self::Shutdown),
            other => Err(format!("unknown power action: {other}")),
        }
    }
}

/// Sleeps or shuts down the current session. Called only after the countdown
/// in `src/features/downloads/finish-action.ts` reaches zero.
#[tauri::command]
pub fn app_power_action(action: String) -> Result<(), String> {
    match PowerAction::parse(&action)? {
        PowerAction::Sleep => sleep_now(),
        PowerAction::Shutdown => shutdown_now(),
    }
}

fn spawn(program: &str, args: &[&str]) -> Result<(), String> {
    Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("{program}: {error}"))
}

#[cfg(windows)]
fn sleep_now() -> Result<(), String> {
    // `powrprof.dll` sleeps with hibernate = 0; hibernation stays whatever the
    // user configured. The call blocks until the machine resumes, which is why
    // the command returns void and the UI does not wait for a result.
    #[link(name = "powrprof")]
    extern "system" {
        fn SetSuspendState(hibernate: i32, force: i32, disable_wake_event: i32) -> i32;
    }
    // SAFETY: constant arguments; the function has no pointer parameters.
    let ok = unsafe { SetSuspendState(0, 1, 0) };
    if ok == 0 {
        Err("the system refused the sleep request".into())
    } else {
        Ok(())
    }
}

#[cfg(windows)]
fn shutdown_now() -> Result<(), String> {
    // `shutdown.exe` enables the shutdown privilege for the interactive user,
    // which a plain ExitWindowsEx call from this process would have to do first.
    spawn("shutdown", &["/s", "/t", "0"])
}

#[cfg(target_os = "linux")]
fn sleep_now() -> Result<(), String> {
    spawn("systemctl", &["suspend"])
}

#[cfg(target_os = "linux")]
fn shutdown_now() -> Result<(), String> {
    spawn("systemctl", &["poweroff"])
}

#[cfg(target_os = "macos")]
fn sleep_now() -> Result<(), String> {
    spawn("pmset", &["sleepnow"])
}

#[cfg(target_os = "macos")]
fn shutdown_now() -> Result<(), String> {
    spawn(
        "osascript",
        &["-e", "tell application \"System Events\" to shut down"],
    )
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn sleep_now() -> Result<(), String> {
    Err("sleep is not supported on this platform".into())
}

#[cfg(not(any(windows, target_os = "linux", target_os = "macos")))]
fn shutdown_now() -> Result<(), String> {
    Err("shutdown is not supported on this platform".into())
}

#[cfg(test)]
mod tests {
    use super::PowerAction;

    #[test]
    fn parses_the_two_supported_actions() {
        assert_eq!(PowerAction::parse("sleep"), Ok(PowerAction::Sleep));
        assert_eq!(PowerAction::parse("shutdown"), Ok(PowerAction::Shutdown));
    }

    #[test]
    fn rejects_an_unknown_action() {
        assert!(PowerAction::parse("hibernate").is_err());
        assert!(PowerAction::parse("").is_err());
    }
}
