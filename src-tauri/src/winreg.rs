//! Minimal Windows registry helper shared by the integration modules.
//!
//! `reg query` is used instead of a registry crate: it is already the pattern
//! the rest of the backend follows (screenshots, EOS overlay) and it avoids a
//! new dependency for two lookups.

use std::process::Command;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Runs `reg query` for one key (optionally one value) and returns stdout when
/// the key exists. `None` means "missing, unreadable or on another platform".
pub fn query(key: &str, value: Option<&str>) -> Option<String> {
    let mut args: Vec<&str> = vec!["query", key];
    if let Some(value) = value {
        args.push("/v");
        args.push(value);
    }
    let mut command = Command::new("reg");
    command.args(&args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Runs `reg query <key> /s /v <value>`: every subkey that carries the value
/// (and the key's own value) ends up in the output.
pub fn query_all(key: &str, value: &str) -> Option<String> {
    let mut command = Command::new("reg");
    command.args(["query", key, "/s", "/v", value]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let output = command.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

/// Extracts the `REG_SZ` data column from `reg query` output.
///
/// The value name differs between registry views (for example `SteamPath`
/// under HKCU and `InstallPath` under HKLM), so callers parse the data column
/// instead of matching the value name.
pub fn parse_reg_sz(output: &str) -> String {
    output
        .lines()
        .find(|l| l.contains("REG_SZ"))
        .and_then(|l| l.split("REG_SZ").nth(1))
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

/// Writes a `REG_SZ` value with `reg add /f` (creates the key when needed).
pub fn set_string(key: &str, value: &str, data: &str) -> bool {
    let mut command = Command::new("reg");
    command.args(["add", key, "/v", value, "/t", "REG_SZ", "/d", data, "/f"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

/// Deletes one value with `reg delete /f`. A missing value still counts as gone.
pub fn delete_value(key: &str, value: &str) -> bool {
    let mut command = Command::new("reg");
    command.args(["delete", key, "/v", value, "/f"]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verifies the real write path: `reg add` must keep the quotes Windows
    /// needs for paths with spaces. Writes to a throwaway HKCU key.
    #[test]
    #[ignore = "writes to HKCU"]
    fn set_string_keeps_quotes() {
        let key = r"HKCU\Software\EfxlveLauncherProbe";
        assert!(set_string(key, "Path", "\"C:\\Program Files\\App\\app.exe\""));
        let out = query(key, Some("Path")).expect("value present");
        println!("{out}");
        assert!(out.contains("\"C:\\Program Files\\App\\app.exe\""));
        assert!(delete_value(key, "Path"));
    }

    #[test]
    fn reg_sz_data_is_parsed_from_query_output() {
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    C:\\Program Files (x86)\\Steam\r\n\r\n";
        assert_eq!(parse_reg_sz(output), r"C:\Program Files (x86)\Steam");
        assert_eq!(parse_reg_sz("no value here"), "");
    }
}
