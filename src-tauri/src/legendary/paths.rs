//! legendary binary resolution and download URLs.
//!
//! Resolution order: binary downloaded into app_data -> not-found error
//! (then auto-download kicks in).
//!
//! Legendary publishes one self-contained build per OS and architecture. The
//! launcher used to pin the Windows x64 file on every platform; the table below
//! is the same mapping Heroic uses, so the Linux and macOS builds can come up
//! with the same code path.

use std::path::PathBuf;

use tauri::{AppHandle, Manager};

use super::LegendaryError;

pub const RELEASES_LATEST_URL: &str = "https://github.com/legendary-gl/legendary/releases/latest";

/// Release asset for one platform, or `None` when legendary publishes none.
pub fn asset_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("legendary_windows_x64.exe"),
        ("windows", "aarch64") => Some("legendary_windows_arm64.exe"),
        ("linux", "x86_64") => Some("legendary_linux_x64"),
        ("linux", "aarch64") => Some("legendary_linux_arm64"),
        ("macos", "x86_64") => Some("legendary_macOS_x64"),
        ("macos", "aarch64") => Some("legendary_macOS_arm64"),
        _ => None,
    }
}

/// The asset that matches the running build.
pub fn current_asset_name() -> Option<&'static str> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// File name of the downloaded binary.
pub fn binary_name() -> &'static str {
    if cfg!(windows) {
        "legendary.exe"
    } else {
        "legendary"
    }
}

/// `<app_data>/bin` — the auto-downloaded binary lives here.
pub fn bin_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
}

/// `<app_data>/bin/legendary.exe` (or `legendary` elsewhere).
pub fn downloaded_binary(app: &AppHandle) -> PathBuf {
    bin_dir(app).join(binary_name())
}

/// A legendary the user installed themselves. Heroic offers the same choice,
/// and on Linux it keeps the launcher working when GitHub is blocked or the
/// package manager already ships legendary.
#[cfg(unix)]
pub fn system_binary() -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    // A GUI session on macOS does not inherit the shell PATH; package managers
    // install here. Duplicates are harmless for a lookup.
    dirs.push(PathBuf::from("/usr/local/bin"));
    dirs.push(PathBuf::from("/opt/homebrew/bin"));
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("bin"));
    }
    find_executable_in(&dirs, binary_name())
}

/// First executable `name` found in `dirs`.
#[cfg(unix)]
fn find_executable_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    use std::os::unix::fs::PermissionsExt;

    for dir in dirs {
        let candidate = dir.join(name);
        let Ok(meta) = std::fs::metadata(&candidate) else {
            continue;
        };
        if meta.is_file() && meta.permissions().mode() & 0o111 != 0 {
            return Some(candidate);
        }
    }
    None
}

pub fn resolve_binary(app: &AppHandle) -> Result<PathBuf, LegendaryError> {
    let dl = downloaded_binary(app);
    if dl.is_file() {
        return Ok(dl);
    }
    #[cfg(unix)]
    if let Some(system) = system_binary() {
        return Ok(system);
    }
    Err(LegendaryError::BinaryMissing)
}

/// `https://github.com/legendary-gl/legendary/releases/download/<tag>/<asset>`
pub fn download_url_for_tag(tag: &str, asset: &str) -> String {
    format!("https://github.com/legendary-gl/legendary/releases/download/{tag}/{asset}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_platform_picks_its_own_asset() {
        for (os, arch) in [
            ("windows", "x86_64"),
            ("windows", "aarch64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("macos", "x86_64"),
            ("macos", "aarch64"),
        ] {
            let asset = asset_for(os, arch).expect("legendary publishes this platform");
            assert!(!asset.contains("windows") || os == "windows");
            assert!(asset.ends_with(".exe") == (os == "windows"));
        }
        assert!(asset_for("linux", "riscv64").is_none());
    }

    #[test]
    fn url_matches_the_release_layout() {
        assert_eq!(
            download_url_for_tag("0.21.1", "legendary_linux_x64"),
            "https://github.com/legendary-gl/legendary/releases/download/0.21.1/legendary_linux_x64"
        );
    }

    /// A distro package that is not executable (or a directory with the same
    /// name) must not be picked up as the legendary binary.
    #[cfg(unix)]
    #[test]
    fn the_system_lookup_requires_an_executable_file() {
        use std::os::unix::fs::PermissionsExt;

        let dir = std::env::temp_dir().join(format!("efxlve_path_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("legendary");
        std::fs::write(&file, b"#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();

        assert_eq!(find_executable_in(&[dir.clone()], "legendary"), None);

        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_executable_in(&[dir.clone()], "legendary"), Some(file));

        // A directory named legendary is not a binary either.
        let directory = dir.join("dir_only").join("legendary");
        std::fs::create_dir_all(&directory).unwrap();
        assert_eq!(
            find_executable_in(&[dir.join("dir_only")], "legendary"),
            None
        );

        let _ = std::fs::remove_dir_all(&dir);
    }
}
