//! Epic's Rockstar relay: an `EpicGamesLauncher.exe` stand-in.
//!
//! Rockstar ships its Epic titles behind a small `Play*.exe` stub that starts
//! the Rockstar Games Launcher with the Epic launch parameters. That launcher
//! only continues when a process named `EpicGamesLauncher.exe` is in its
//! ancestor chain — without it, it quits with "Unable to launch game, please
//! try reinstalling the game" and an `0x800401F0` crash.
//!
//! Installing Epic's 500 MB client just for that check is unnecessary: a copy
//! of *this* binary, started under that name, relays the launch. Featured
//! launchers do the same with a small wrapper; the difference here is that the
//! wrapper is already part of the launcher. `legendary launch --wrapper <copy>`
//! passes the game executable and its Epic parameters through unchanged, so the
//! title token still comes from the user's own account and exchange code.
//!
//! The copy must stay alive while the game process tree runs: Rockstar reads
//! the still-running parent chain, and an exited parent fails that lookup
//! ("Could not do OpenProcess on parent process").

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The process name Rockstar's launcher looks for in its ancestor chain.
pub const SHIM_FILE_NAME: &str = "EpicGamesLauncher.exe";

/// True when `name` is the relay copy's file name.
pub fn is_shim_name(name: &str) -> bool {
    name.eq_ignore_ascii_case(SHIM_FILE_NAME)
}

/// The game command this copy was asked to relay, or `None` when this is the
/// normal launcher (not the `EpicGamesLauncher.exe` copy).
pub fn relay_arguments() -> Option<Vec<OsString>> {
    let exe = std::env::current_exe().ok()?;
    let name = exe.file_name()?.to_str()?;
    if !is_shim_name(name) {
        return None;
    }
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    (!args.is_empty()).then_some(args)
}

/// Starts `args[0]` with the remaining arguments from its own folder and waits
/// for it. Returns the process exit code the relay reports to its caller.
pub fn relay(args: &[OsString]) -> i32 {
    let Some(exe) = args.first() else {
        return 1;
    };
    let mut command = Command::new(exe);
    command.args(&args[1..]);
    if let Some(dir) = Path::new(exe).parent() {
        command.current_dir(dir);
    }
    match command.spawn() {
        Ok(mut child) => {
            let _ = child.wait();
            0
        }
        Err(_) => 1,
    }
}

/// Creates (or refreshes) the relay copy of the running launcher inside
/// `bin_dir` and returns its path. `None` when the copy cannot be written; the
/// caller then falls back to asking for the Epic Games Launcher.
pub fn ensure_wrapper_copy(bin_dir: &Path) -> Option<PathBuf> {
    let source = std::env::current_exe().ok()?;
    let target = bin_dir.join(SHIM_FILE_NAME);
    if !copy_is_current(&source, &target) {
        std::fs::create_dir_all(bin_dir).ok()?;
        std::fs::copy(&source, &target).ok()?;
    }
    target.is_file().then_some(target)
}

/// True when the copy matches the launcher it was taken from (same size and
/// not older), so an update replaces it and a normal start does not re-copy it.
fn copy_is_current(source: &Path, target: &Path) -> bool {
    let (Ok(src), Ok(dst)) = (std::fs::metadata(source), std::fs::metadata(target)) else {
        return false;
    };
    if src.len() != dst.len() {
        return false;
    }
    match (src.modified(), dst.modified()) {
        (Ok(src_time), Ok(dst_time)) => dst_time >= src_time,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_relay_copy_name_is_a_shim() {
        assert!(is_shim_name("EpicGamesLauncher.exe"));
        assert!(is_shim_name("epicgameslauncher.EXE"));
        assert!(!is_shim_name("efxlve-launcher.exe"));
        assert!(!is_shim_name("legendary.exe"));
    }

    #[test]
    fn the_wrapper_copy_is_written_once_and_reused() {
        let dir = std::env::temp_dir().join(format!("efxlve-shim-{}", std::process::id()));
        let first = ensure_wrapper_copy(&dir).expect("copy");
        assert_eq!(first.file_name().and_then(|n| n.to_str()), Some(SHIM_FILE_NAME));
        let source_len = std::fs::metadata(std::env::current_exe().expect("test exe"))
            .expect("metadata")
            .len();
        assert_eq!(std::fs::metadata(&first).expect("copy metadata").len(), source_len);
        // Second call keeps the same file (fresh copy is not rewritten).
        let again = ensure_wrapper_copy(&dir).expect("copy again");
        assert_eq!(again, first);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
