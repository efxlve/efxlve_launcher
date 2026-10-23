//! OS-backed storage for cloud credentials.
//!
//! Windows seals the values with DPAPI in a local file; macOS uses the login
//! Keychain through `security`; Linux asks Secret Service through `secret-tool`.
//! When the platform store is unavailable the caller keeps the value in the
//! settings JSON instead of losing it, which matches the old behavior.

use std::collections::BTreeMap;
use std::path::PathBuf;

use crate::legendary::skip::default_config_dir;

#[cfg(unix)]
const SERVICE: &str = "efxlve-launcher";

fn vault_path() -> PathBuf {
    if let Ok(path) = std::env::var("EFXLVE_CLOUD_SECRET_VAULT") {
        if !path.trim().is_empty() {
            return PathBuf::from(path);
        }
    }
    default_config_dir().join("cloud_secrets.bin")
}

#[cfg(windows)]
fn read_windows() -> BTreeMap<String, String> {
    let Ok(sealed) = std::fs::read(vault_path()) else {
        return BTreeMap::new();
    };
    let Ok(plain) = crate::steam_auth::vault::dpapi::unprotect(&sealed) else {
        return BTreeMap::new();
    };
    serde_json::from_slice(&plain).unwrap_or_default()
}

#[cfg(windows)]
fn write_windows(map: &BTreeMap<String, String>) -> Result<(), String> {
    let plain = serde_json::to_vec(map).map_err(|error| error.to_string())?;
    let sealed = crate::steam_auth::vault::dpapi::protect(&plain)?;
    let path = vault_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    std::fs::write(path, sealed).map_err(|error| error.to_string())
}

#[cfg(windows)]
pub fn get(key: &str) -> Option<String> {
    read_windows().remove(key)
}

#[cfg(windows)]
pub fn set(key: &str, value: &str) -> Result<(), String> {
    let mut map = read_windows();
    map.insert(key.to_string(), value.to_string());
    write_windows(&map)
}

#[cfg(windows)]
pub fn delete(key: &str) -> Result<(), String> {
    let mut map = read_windows();
    map.remove(key);
    write_windows(&map)
}

#[cfg(target_os = "macos")]
fn service(key: &str) -> String {
    format!("{SERVICE}:{key}")
}

#[cfg(target_os = "macos")]
pub fn get(key: &str) -> Option<String> {
    let output = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "efxlve",
            "-s",
            &service(key),
            "-w",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(target_os = "macos")]
pub fn set(key: &str, value: &str) -> Result<(), String> {
    let output = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-a",
            "efxlve",
            "-s",
            &service(key),
            "-w",
            value,
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(target_os = "macos")]
pub fn delete(key: &str) -> Result<(), String> {
    let _ = std::process::Command::new("security")
        .args([
            "delete-generic-password",
            "-a",
            "efxlve",
            "-s",
            &service(key),
        ])
        .output();
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn get(key: &str) -> Option<String> {
    let output = std::process::Command::new("secret-tool")
        .args(["lookup", "service", SERVICE, "key", key])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!value.is_empty()).then_some(value)
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn set(key: &str, value: &str) -> Result<(), String> {
    use std::io::Write;
    use std::process::{Command, Stdio};

    let mut child = Command::new("secret-tool")
        .args([
            "store",
            "--label",
            &format!("Efxlve Launcher {key}"),
            "service",
            SERVICE,
            "key",
            key,
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("secret-tool is not available: {error}"))?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(value.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    let output = child.wait_with_output().map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&output.stderr).trim().to_string())
    }
}

#[cfg(all(unix, not(target_os = "macos")))]
pub fn delete(key: &str) -> Result<(), String> {
    let _ = std::process::Command::new("secret-tool")
        .args(["clear", "service", SERVICE, "key", key])
        .output();
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn dpapi_vault_round_trips() {
        let path = std::env::temp_dir().join(format!(
            "efxlve-secret-vault-{}.bin",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        std::env::set_var("EFXLVE_CLOUD_SECRET_VAULT", &path);

        set("cloud_test_key", "super-secret").unwrap();
        assert_eq!(get("cloud_test_key"), Some("super-secret".to_string()));
        assert!(path.is_file());

        delete("cloud_test_key").unwrap();
        assert_eq!(get("cloud_test_key"), None);

        std::env::remove_var("EFXLVE_CLOUD_SECRET_VAULT");
        let _ = std::fs::remove_file(&path);
    }
}
