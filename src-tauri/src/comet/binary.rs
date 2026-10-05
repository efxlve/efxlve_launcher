//! Comet release binary download and cache.
//!
//! The launcher pins one Comet release per build. The release asset for this
//! platform is downloaded once into `<app_data>/bin` and its SHA-256 is checked
//! against the digest published with the release before the file is renamed
//! into place, because the binary is executed later.

use std::path::PathBuf;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::AppHandle;

/// Pinned Comet release. Bumping the tag re-downloads the binary.
pub const COMET_VERSION: &str = "v0.3.2";

/// One release asset: file name on GitHub and its published SHA-256.
struct Asset {
    name: &'static str,
    sha256: &'static str,
}

fn asset_for(os: &str, arch: &str) -> Option<Asset> {
    match (os, arch) {
        ("windows", "x86_64") => Some(Asset {
            name: "comet-x86_64-pc-windows-msvc.exe",
            sha256: "181f9a3644eabbdf396037de135583e92cf4a08029be30c9ee4e2479ff11ae8c",
        }),
        ("windows", "aarch64") => Some(Asset {
            name: "comet-aarch64-pc-windows-msvc.exe",
            sha256: "d4dee6ad92beb110b474198ed178dd255e5e3226d4912bd5d658cd5c046af825",
        }),
        ("linux", "x86_64") => Some(Asset {
            name: "comet-x86_64-unknown-linux-gnu",
            sha256: "2d6694d544fd3155d90d540e70bc1be767a6b9fdda130275f2b79616ff14e843",
        }),
        ("linux", "aarch64") => Some(Asset {
            name: "comet-aarch64-unknown-linux-gnu",
            sha256: "c8cd850a03ba66c10bf620eee2735946ddf0b5969cd38cae02c6bede6d15c5b8",
        }),
        ("macos", "x86_64") => Some(Asset {
            name: "comet-x86_64-apple-darwin",
            sha256: "13e909382d01d770dcf44872eaf2fab4b2a831a74798b3466198596c162ccf58",
        }),
        ("macos", "aarch64") => Some(Asset {
            name: "comet-aarch64-apple-darwin",
            sha256: "d53b90a3ac32c9fc61b731a6ced8a241f9476ffa0144b47a77da52db25d2362c",
        }),
        _ => None,
    }
}

fn current_asset() -> Option<Asset> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// `<app_data>/bin/comet.exe` (or `comet` elsewhere).
pub fn binary_path(app: &AppHandle) -> PathBuf {
    let name = if cfg!(windows) { "comet.exe" } else { "comet" };
    crate::gogdl::paths::bin_dir(app).join(name)
}

/// Resolves the binary when it is already on disk.
pub fn resolve_binary(app: &AppHandle) -> Option<PathBuf> {
    let path = binary_path(app);
    path.is_file().then_some(path)
}

/// Downloads and verifies the pinned Comet release when it is missing.
pub async fn ensure_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = resolve_binary(app) {
        return Ok(path);
    }
    let asset = current_asset().ok_or("Comet is not published for this platform")?;
    let url = format!(
        "https://github.com/imLinguin/comet/releases/download/{}/{}",
        COMET_VERSION, asset.name
    );

    let target = binary_path(app);
    let dir = crate::gogdl::paths::bin_dir(app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let part = dir.join("comet.part");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Comet download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != asset.sha256 {
        return Err("Comet download failed the checksum check".to_string());
    }

    tokio::fs::write(&part, &bytes)
        .await
        .map_err(|e| e.to_string())?;
    tokio::fs::rename(&part, &target)
        .await
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
    }
    Ok(target)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_supported_platform_maps_to_a_pinned_digest() {
        for (os, arch) in [
            ("windows", "x86_64"),
            ("windows", "aarch64"),
            ("linux", "x86_64"),
            ("linux", "aarch64"),
            ("macos", "x86_64"),
            ("macos", "aarch64"),
        ] {
            let asset = asset_for(os, arch).expect("platform should have an asset");
            assert_eq!(asset.sha256.len(), 64, "sha256 must be a full digest");
            assert!(
                asset.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "sha256 must be hex"
            );
        }
        assert!(asset_for("windows", "riscv64").is_none());
    }
}
