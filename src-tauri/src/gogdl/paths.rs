//! GOG binary and file system paths.

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

use super::GogError;

#[allow(dead_code)]
pub const GOGDL_RELEASES_URL: &str =
    "https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/latest";
/// Pinned gogdl release. Bumping the tag re-downloads the binary on the next run.
pub const GOGDL_VERSION: &str = "v1.3.1";

/// Release asset for one platform, or `None` when gogdl publishes none.
pub fn asset_for(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("windows", "x86_64") => Some("gogdl_windows_x86_64.exe"),
        ("windows", "aarch64") => Some("gogdl_windows_arm64.exe"),
        ("linux", "x86_64") => Some("gogdl_linux_x86_64"),
        ("linux", "aarch64") => Some("gogdl_linux_arm64"),
        ("macos", "x86_64") => Some("gogdl_macos_x86_64"),
        ("macos", "aarch64") => Some("gogdl_macos_arm64"),
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
        "gogdl.exe"
    } else {
        "gogdl"
    }
}

/// `https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/download/<tag>/<asset>`
pub fn download_url_for_tag(tag: &str, asset: &str) -> String {
    format!("https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/download/{tag}/{asset}")
}

/// `<app_data>/bin` directory for external helper binaries.
pub fn bin_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("bin")
}

/// `<app_data>/bin/gogdl.exe` (or `gogdl` elsewhere).
pub fn downloaded_binary(app: &AppHandle) -> PathBuf {
    bin_dir(app).join(binary_name())
}

/// Resolves the executable path for the downloaded gogdl.
pub fn resolve_binary(app: &AppHandle) -> Result<PathBuf, GogError> {
    let dl = downloaded_binary(app);
    if dl.is_file() {
        return Ok(dl);
    }
    Err(GogError::BinaryMissing)
}

/// Ensures gogdl is present on disk, downloading the platform build if missing.
pub async fn ensure_binary(app: &AppHandle) -> Result<PathBuf, GogError> {
    if let Ok(p) = resolve_binary(app) {
        return Ok(p);
    }
    let asset = current_asset_name()
        .ok_or_else(|| GogError::DownloadFailed("@t:dl.platformUnsupported".into()))?;
    let target = downloaded_binary(app);
    let dir = bin_dir(app);
    let _ = tokio::fs::create_dir_all(&dir).await;
    // A startup prepare and a first transfer can both reach this point. Give
    // each attempt its own part file and let the loser accept the winner's
    // binary instead of failing on the rename.
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    let part = dir.join(format!("{}.{stamp}.part", binary_name()));

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| GogError::Http(e.to_string()))?;

    let resp = client
        .get(download_url_for_tag(GOGDL_VERSION, asset))
        .send()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(GogError::Http(format!(
            "Failed to download gogdl binary: HTTP {}",
            resp.status()
        )));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| GogError::Http(e.to_string()))?;
    tokio::fs::write(&part, &bytes)
        .await
        .map_err(|e| GogError::Io(e.to_string()))?;

    if let Err(error) = tokio::fs::rename(&part, &target).await {
        let _ = tokio::fs::remove_file(&part).await;
        if target.is_file() {
            // Another concurrent prepare finished first; its file is the same
            // pinned release, so use it.
            return Ok(target);
        }
        return Err(GogError::Io(error.to_string()));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = tokio::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).await;
    }

    Ok(target)
}

/// `<app_data>/gog` configuration and storage directory.
pub fn gog_config_dir(app: &AppHandle) -> PathBuf {
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("gog");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

/// `<app_data>/gog/auth.json` containing OAuth2 tokens.
pub fn auth_json_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("auth.json")
}

/// `<app_data>/gog/installed.json` containing local installation metadata.
pub fn installed_json_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("installed.json")
}

/// `<app_data>/gog/efxlve_gog_library_snapshot.json`
pub fn library_snapshot_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("efxlve_gog_library_snapshot.json")
}

/// `<app_data>/gog/achievements_cache.json` containing cached achievement summaries.
pub fn achievements_cache_path(app: &AppHandle) -> PathBuf {
    gog_config_dir(app).join("achievements_cache.json")
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
            let asset = asset_for(os, arch).expect("gogdl publishes this platform");
            assert!(asset.ends_with(".exe") == (os == "windows"));
        }
        assert!(asset_for("macos", "riscv64").is_none());
    }

    #[test]
    fn url_matches_the_release_layout() {
        assert_eq!(
            download_url_for_tag("v1.3.1", "gogdl_linux_x86_64"),
            "https://github.com/Heroic-Games-Launcher/heroic-gogdl/releases/download/v1.3.1/gogdl_linux_x86_64"
        );
    }
}
