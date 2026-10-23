//! rclone provider: any remote the user configured in rclone itself.
//!
//! rclone exposes 70+ backends (S3, Backblaze B2, Dropbox, OneDrive, Mega,
//! pCloud, Box, ...) through one CLI, so the launcher does not have to ship an
//! OAuth client for every service. The layout is the same as the Folder
//! provider: `<remote>/<safe-key>/<timestamp>.tar.gz`.

use std::path::{Path, PathBuf};

use crate::cloud_backup::models::CloudBackupEntry;
use crate::legendary::backup::{backup_key, format_backup_timestamp};

/// Resolves the rclone executable from PATH or the common install locations.
pub fn rclone_binary() -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "rclone.exe" } else { "rclone" };
    let mut dirs: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    if cfg!(unix) {
        dirs.push(PathBuf::from("/usr/local/bin"));
        dirs.push(PathBuf::from("/opt/homebrew/bin"));
        dirs.push(PathBuf::from("/opt/local/bin"));
        dirs.push(PathBuf::from("/snap/bin"));
        if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".local").join("bin"));
        }
    }
    find_in(&dirs, name).ok_or_else(|| {
        "rclone is not installed. Install it from https://rclone.org/downloads/ and run `rclone config` once."
            .to_string()
    })
}

fn find_in(dirs: &[PathBuf], name: &str) -> Option<PathBuf> {
    for dir in dirs {
        let candidate = dir.join(name);
        let Ok(meta) = std::fs::metadata(&candidate) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if meta.permissions().mode() & 0o111 == 0 {
                continue;
            }
        }
        return Some(candidate);
    }
    None
}

/// Normalizes and validates `<remote>:<path>`.
///
/// A single drive letter (`C:\saves`) is rejected: rclone remotes are names,
/// and accepting a local path here would silently write outside the remote.
pub fn remote_base(remote: &str) -> Result<String, String> {
    let remote = remote.trim().trim_end_matches('/');
    if remote.is_empty() {
        return Err("Set an rclone remote path, for example gdrive:efxlve_saves.".to_string());
    }
    if remote.contains('\0') || remote.contains('\n') || remote.contains('\r') || remote.contains("..")
    {
        return Err("Invalid rclone remote path.".to_string());
    }
    if remote.starts_with('-') {
        return Err("Invalid rclone remote path.".to_string());
    }
    let Some((name, path)) = remote.split_once(':') else {
        return Err("An rclone remote path looks like remote:path.".to_string());
    };
    let valid_name = !name.is_empty()
        && !(name.len() == 1 && name.chars().all(|c| c.is_ascii_alphabetic()))
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'));
    if !valid_name {
        return Err("Invalid rclone remote name.".to_string());
    }
    if path.starts_with('/') {
        return Err("The path inside an rclone remote is relative.".to_string());
    }
    Ok(remote.to_string())
}

fn app_dir(base: &str, app_name: &str) -> String {
    format!("{base}/{}", backup_key(app_name))
}

fn validate_remote_id(base: &str, remote_id: &str) -> Result<(), String> {
    let prefix = format!("{base}/");
    if remote_id.contains('\0')
        || remote_id.contains('\n')
        || remote_id.contains('\r')
        || remote_id.contains("..")
        || !remote_id.starts_with(&prefix)
    {
        return Err("Invalid backup path.".to_string());
    }
    Ok(())
}

/// Runs one rclone command with conservative network timeouts.
async fn run(args: &[&str]) -> Result<String, String> {
    let bin = rclone_binary()?;
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["--timeout", "60s", "--contimeout", "10s", "--retries", "1"])
        .args(args)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(0x08000000);
    }
    let out = cmd
        .output()
        .await
        .map_err(|error| format!("rclone could not start: {error}"))?;
    if !out.status.success() {
        let detail = String::from_utf8_lossy(&out.stderr).trim().to_string();
        let detail: String = detail.chars().take(300).collect();
        return Err(if detail.is_empty() {
            "rclone failed.".to_string()
        } else {
            format!("rclone failed: {detail}")
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Creates the remote folder when needed and reports the configured path.
pub async fn test_rclone(remote: &str) -> Result<String, String> {
    let base = remote_base(remote)?;
    run(&["mkdir", base.as_str()]).await?;
    run(&["lsd", base.as_str()]).await?;
    let version = run(&["version"]).await.unwrap_or_default();
    let first = version.lines().next().unwrap_or("rclone");
    Ok(format!("{first} ready: {base}"))
}

/// Lists remotes from the user's rclone config, without leaking credentials.
pub async fn list_remotes() -> Result<Vec<String>, String> {
    let output = run(&["listremotes"]).await?;
    Ok(parse_remotes(&output))
}

fn parse_remotes(output: &str) -> Vec<String> {
    output
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && line.ends_with(':'))
        .map(str::to_string)
        .collect()
}

pub async fn upload_backup_rclone(
    remote: &str,
    app_name: &str,
    backup_id: &str,
    archive: &Path,
) -> Result<String, String> {
    let base = remote_base(remote)?;
    let dir = app_dir(&base, app_name);
    run(&["mkdir", dir.as_str()]).await?;
    let target = format!("{dir}/{backup_id}.tar.gz");
    let source = archive.to_string_lossy().to_string();
    run(&["copyto", source.as_str(), target.as_str()]).await?;
    Ok(target)
}

pub async fn list_backups_rclone(
    remote: &str,
    app_name: &str,
) -> Result<Vec<CloudBackupEntry>, String> {
    let base = remote_base(remote)?;
    let dir = app_dir(&base, app_name);
    let json = match run(&["lsjson", dir.as_str(), "--files-only", "--max-depth", "1"]).await {
        Ok(text) => text,
        Err(error) => {
            let lower = error.to_lowercase();
            if lower.contains("not found") || lower.contains("directory not found") {
                return Ok(Vec::new());
            }
            return Err(error);
        }
    };
    let items: Vec<serde_json::Value> = if json.trim().is_empty() {
        Vec::new()
    } else {
        serde_json::from_str(&json)
            .map_err(|error| format!("rclone list could not be read: {error}"))?
    };

    let mut list = Vec::new();
    for item in items {
        let Some(name) = item.get("Name").and_then(|value| value.as_str()) else {
            continue;
        };
        let Some(backup_id) = name.strip_suffix(".tar.gz") else {
            continue;
        };
        if backup_id.is_empty() || !backup_id.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let timestamp = backup_id.parse::<u64>().unwrap_or(0);
        let size = item
            .get("Size")
            .and_then(|value| value.as_u64())
            .unwrap_or(0);
        list.push(CloudBackupEntry {
            backup_id: backup_id.to_string(),
            app_name: app_name.to_string(),
            timestamp,
            formatted_date: format_backup_timestamp(timestamp),
            size_bytes: size,
            file_count: 0,
            sha256: String::new(),
            provider: "rclone".to_string(),
            remote_id: format!("{dir}/{name}"),
        });
    }
    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(list)
}

pub async fn download_backup_rclone(
    remote: &str,
    remote_id: &str,
    target: &Path,
) -> Result<(), String> {
    let base = remote_base(remote)?;
    validate_remote_id(&base, remote_id)?;
    let target = target.to_string_lossy().to_string();
    let result = run(&["copyto", remote_id, target.as_str()]).await;
    if result.is_err() {
        let _ = std::fs::remove_file(target);
    }
    result.map(|_| ())
}

pub async fn delete_backup_rclone(remote: &str, remote_id: &str) -> Result<(), String> {
    let base = remote_base(remote)?;
    validate_remote_id(&base, remote_id)?;
    match run(&["deletefile", remote_id]).await {
        Ok(_) => Ok(()),
        // A file that is already gone is not an error for the caller.
        Err(error) if error.to_lowercase().contains("not found") => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_are_validated() {
        assert_eq!(
            remote_base("gdrive:efxlve_saves").unwrap(),
            "gdrive:efxlve_saves"
        );
        assert_eq!(remote_base(" s3:bucket/saves/ ").unwrap(), "s3:bucket/saves");
        assert!(remote_base("").is_err());
        assert!(remote_base("no-colon").is_err());
        assert!(remote_base("C:\\Saves").is_err());
        assert!(remote_base("gdrive:../outside").is_err());
        assert!(remote_base("-gdrive:saves").is_err());
        assert!(remote_base("bad name:saves").is_err());
        assert!(remote_base("gdrive:/absolute").is_err());
    }

    #[test]
    fn remote_ids_stay_inside_the_base_path() {
        let base = "gdrive:efxlve_saves";
        assert!(validate_remote_id(base, "gdrive:efxlve_saves/gog__123/1.tar.gz").is_ok());
        assert!(validate_remote_id(base, "gdrive:other/gog__123/1.tar.gz").is_err());
        assert!(validate_remote_id(base, "gdrive:efxlve_saves/../x/1.tar.gz").is_err());
        assert!(validate_remote_id(base, "gdrive:efxlve_saves/gog__123/1.tar.gz\n--dry-run").is_err());
    }

    #[test]
    fn remote_list_ignores_noise() {
        let remotes = parse_remotes("gdrive:\n\n s3: \nbad-line\n");
        assert_eq!(remotes, vec!["gdrive:", "s3:"]);
    }

    #[test]
    fn app_folders_use_the_safe_backup_key() {
        assert_eq!(app_dir("gdrive:saves", "gog::123"), "gdrive:saves/gog__123");
    }
}
