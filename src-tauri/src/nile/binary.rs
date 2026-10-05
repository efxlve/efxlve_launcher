//! Nile release binary download and cache.
//!
//! Same contract as the Comet binary: one pinned release per build, downloaded
//! into `<app_data>/bin` once, verified against the SHA-256 published with the
//! release, and executed afterwards.

use std::path::PathBuf;
use std::time::Duration;

use sha2::{Digest, Sha256};
use tauri::AppHandle;

/// Pinned Nile release. Bumping the tag re-downloads the binary.
pub const NILE_VERSION: &str = "v1.2.0";

/// One release asset: file name on GitHub and its published SHA-256.
struct Asset {
    name: &'static str,
    sha256: &'static str,
}

fn asset_for(os: &str, arch: &str) -> Option<Asset> {
    match (os, arch) {
        ("windows", "x86_64") => Some(Asset {
            name: "nile_windows_x86_64.exe",
            sha256: "6531790c59f78cea4a8743bf0582d5afda7fb887f5c143391d7339ad0f42ab88",
        }),
        ("linux", "x86_64") => Some(Asset {
            name: "nile_linux_x86_64",
            sha256: "d73519514df9d52c50c6feec629373cc3a0d9504e087b6c7372a8ca8a95e7bfe",
        }),
        ("linux", "aarch64") => Some(Asset {
            name: "nile_linux_arm64",
            sha256: "197859c629c47e4e4d7ed1d2a290b7bef1e778f891ff8ca42ba65dbb020ba751",
        }),
        ("macos", "x86_64") => Some(Asset {
            name: "nile_macOS_x86_64",
            sha256: "93ef4a5d29a378901569e3a854c289d356a0be3503700ebf7ee70586d401b0b0",
        }),
        ("macos", "aarch64") => Some(Asset {
            name: "nile_macOS_arm64",
            sha256: "6cc74eb19117c8c309b0b94657e1e267642a3b4840d7386a133dcf6f3bffeab0",
        }),
        // Nile publishes no Windows ARM64 build yet.
        _ => None,
    }
}

fn current_asset() -> Option<Asset> {
    asset_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// `<app_data>/bin/nile.exe` (or `nile` elsewhere).
pub fn binary_path(app: &AppHandle) -> PathBuf {
    let name = if cfg!(windows) { "nile.exe" } else { "nile" };
    crate::gogdl::paths::bin_dir(app).join(name)
}

/// Resolves the binary when it is already on disk.
pub fn resolve_binary(app: &AppHandle) -> Option<PathBuf> {
    let path = binary_path(app);
    path.is_file().then_some(path)
}

/// Downloads and verifies the pinned Nile release when it is missing.
pub async fn ensure_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(path) = resolve_binary(app) {
        return Ok(path);
    }
    let asset = current_asset().ok_or("Nile is not published for this platform")?;
    let url = format!(
        "https://github.com/imLinguin/nile/releases/download/{}/{}",
        NILE_VERSION, asset.name
    );

    let target = binary_path(app);
    let dir = crate::gogdl::paths::bin_dir(app);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| e.to_string())?;
    let part = dir.join("nile.part");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("Nile download failed: HTTP {}", resp.status()));
    }
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;

    let digest = format!("{:x}", Sha256::digest(&bytes));
    if digest != asset.sha256 {
        return Err("Nile download failed the checksum check".to_string());
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
    fn every_published_platform_maps_to_a_pinned_digest() {
        for (os, arch) in [
            ("windows", "x86_64"),
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
        // Nile has no Windows ARM64 asset yet.
        assert!(asset_for("windows", "aarch64").is_none());
    }
}
