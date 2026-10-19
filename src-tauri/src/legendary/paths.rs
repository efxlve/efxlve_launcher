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

pub fn resolve_binary(app: &AppHandle) -> Result<PathBuf, LegendaryError> {
    let dl = downloaded_binary(app);
    if dl.is_file() {
        return Ok(dl);
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
}
