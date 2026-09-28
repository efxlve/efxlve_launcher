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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reg_sz_data_is_parsed_from_query_output() {
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    C:\\Program Files (x86)\\Steam\r\n\r\n";
        assert_eq!(parse_reg_sz(output), r"C:\Program Files (x86)\Steam");
        assert_eq!(parse_reg_sz("no value here"), "");
    }
}
