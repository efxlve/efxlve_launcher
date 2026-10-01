//! legendary auto-download: fetch from GitHub releases if missing, verify with `-V`.
//!
//! Progress is streamed to the frontend via the `legendary-setup` event:
//! `{ state: "downloading" | "ready" | "error", progress, message }`.

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use super::{paths, LegendaryError};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SetupEvent {
    state: String,
    progress: Option<u8>,
    message: String,
}

fn emit(app: &AppHandle, state: &str, progress: Option<u8>, message: String) {
    let _ = app.emit(
        "legendary-setup",
        SetupEvent {
            state: state.into(),
            progress,
            message,
        },
    );
}

/// Resolves the version from `legendary -V` output (`legendary version "0.21.1", ...`).
pub async fn binary_version(bin: &Path) -> Result<String, LegendaryError> {
    let mut cmd = tokio::process::Command::new(bin);
    cmd.arg("-V").stdin(std::process::Stdio::null());
    #[cfg(windows)]
    cmd.creation_flags(0x08000000);
    let out = cmd.output().await?;
    if !out.status.success() {
        return Err(LegendaryError::DownloadFailed(
            "@t:dl.binaryNotWorking".into(),
        ));
    }
    let text = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    let mut parts = text.split('"');
    parts.next();
    parts
        .next()
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| LegendaryError::ParseError("@t:dl.versionReadFailed".into()))
}

/// `legendary -V` with a disk cache.
///
/// Spawning the bundled Python runtime just to read a version string costs about
/// 1.6 s here, and the boot path awaited it before it could paint the library. The
/// answer only changes when the binary is replaced, so it is cached in the legendary
/// config dir, keyed by the binary's path, size and mtime.
pub async fn binary_version_cached(bin: &Path) -> Result<String, LegendaryError> {
    let stamp = binary_stamp(bin);
    if let Some((cached_stamp, version)) = read_version_cache() {
        if cached_stamp == stamp {
            return Ok(version);
        }
    }
    let version = binary_version(bin).await?;
    write_version_cache(&stamp, &version);
    Ok(version)
}

/// Identity of a binary file: a replaced binary changes size and/or mtime.
fn binary_stamp(bin: &Path) -> String {
    let meta = std::fs::metadata(bin).ok();
    let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let mtime = meta
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}|{len}|{mtime}", bin.to_string_lossy())
}

fn version_cache_path() -> PathBuf {
    super::skip::default_config_dir().join("efxlve_binary_version.json")
}

fn read_version_cache() -> Option<(String, String)> {
    let text = std::fs::read_to_string(version_cache_path()).ok()?;
    let val: serde_json::Value = serde_json::from_str(&text).ok()?;
    let stamp = val.get("stamp")?.as_str()?.to_string();
    let version = val.get("version")?.as_str()?.to_string();
    if version.is_empty() {
        return None;
    }
    Some((stamp, version))
}

fn write_version_cache(stamp: &str, version: &str) {
    let body = serde_json::json!({ "stamp": stamp, "version": version });
    if let Ok(text) = serde_json::to_string(&body) {
        let _ = std::fs::write(version_cache_path(), text);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The version cache is only valid while the binary is untouched: replacing it
    /// must change the stamp, otherwise a stale version would be served forever.
    #[test]
    fn binary_stamp_tracks_file_identity() {
        let path = std::env::temp_dir().join(format!("efxlve_stamp_test_{}", std::process::id()));
        std::fs::write(&path, b"first").unwrap();
        let first = binary_stamp(&path);
        assert_eq!(
            first,
            binary_stamp(&path),
            "an untouched file keeps its stamp"
        );

        std::fs::write(&path, b"second-content").unwrap();
        let second = binary_stamp(&path);
        assert_ne!(first, second, "a replaced binary must invalidate the cache");
        assert!(second.contains(&path.to_string_lossy().to_string()));

        let _ = std::fs::remove_file(&path);
        // A missing binary still yields a stamp (the version probe fails on its own).
        assert!(binary_stamp(&path).ends_with("|0|0"));
    }
}

/// Follows the `/releases/latest` redirect and returns the tag name.
async fn latest_tag() -> Result<String, LegendaryError> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| LegendaryError::DownloadFailed(e.to_string()))?;
    let resp = client
        .get(paths::RELEASES_LATEST_URL)
        .send()
        .await
        .map_err(|e| LegendaryError::DownloadFailed(e.to_string()))?;
    let url = resp.url().clone();
    url.path_segments()
        .and_then(|mut s| s.next_back())
        .map(|s| s.to_string())
        .ok_or_else(|| LegendaryError::DownloadFailed("@t:dl.versionNotFound".into()))
}

/// Returns the binary path if ready, otherwise downloads it. Can take a while.
pub async fn ensure_binary(app: &AppHandle) -> Result<PathBuf, LegendaryError> {
    let target = paths::downloaded_binary(app);
    if target.is_file() {
        if binary_version(&target).await.is_ok() {
            return Ok(target);
        }
        // Corrupt file: remove it and download again.
        let _ = tokio::fs::remove_file(&target).await;
    }

    emit(app, "downloading", Some(0), "@t:dl.fetchingVersion".into());
    let tag = latest_tag().await?;
    let url = paths::download_url_for_tag(&tag);
    let dir = paths::bin_dir(app);
    tokio::fs::create_dir_all(&dir).await?;
    let part = dir.join("legendary.exe.part");

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| LegendaryError::DownloadFailed(e.to_string()))?;
    let mut resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| LegendaryError::DownloadFailed(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(LegendaryError::DownloadFailed(format!(
            "HTTP {}",
            resp.status()
        )));
    }
    let total = resp.content_length();
    let mut file = tokio::fs::File::create(&part).await?;
    {
        use tokio::io::AsyncWriteExt;
        let mut done: u64 = 0;
        let mut last = 0u8;
        loop {
            match resp.chunk().await {
                Err(e) => return Err(LegendaryError::DownloadFailed(e.to_string())),
                Ok(None) => break,
                Ok(Some(bytes)) => {
                    file.write_all(&bytes).await?;
                    done += bytes.len() as u64;
                    if let Some(t) = total.filter(|t| *t > 0) {
                        let pct = (done.saturating_mul(100) / t).min(100) as u8;
                        if pct != last {
                            last = pct;
                            emit(
                                app,
                                "downloading",
                                Some(pct),
                                format!("legendary {tag} indiriliyor... %{pct}"),
                            );
                        }
                    }
                }
            }
        }
        file.flush().await?;
    }
    drop(file);
    tokio::fs::rename(&part, &target).await?;
    binary_version(&target).await?;

    emit(app, "ready", Some(100), "@t:auth.legendaryReady".into());
    Ok(target)
}
