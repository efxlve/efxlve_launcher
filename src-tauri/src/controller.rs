//! Controller support helpers.
//!
//! Windows exposes PlayStation pads (DualSense/DualShock) as DirectInput
//! devices, so games that only read XInput never see them — the same problem
//! Steam solves with its virtual gamepad driver. We cannot ship a kernel
//! driver, but we can detect whether an XInput bridge (ViGEmBus, used by
//! DS4Windows and Steam) is installed and point the user at it. Steam itself is
//! detected too: its Steam Input layer can do the mapping for any game added to
//! the library.

use std::process::Command;

use serde::Serialize;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Support status shown in Settings > Controller.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerSupportStatus {
    /// ViGEmBus driver present (the virtual Xbox pad used by DS4Windows/Steam).
    pub vi_em_bus: bool,
    /// Steam is installed (its Steam Input layer can map PlayStation pads).
    pub steam: bool,
    /// Steam install directory when known (empty otherwise).
    pub steam_path: String,
}

/// Reads a registry value with `reg query`; returns the raw output when found.
fn reg_query(key: &str, value: Option<&str>) -> Option<String> {
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

/// Extracts the Steam install path from `reg query` output.
///
/// The value is named `SteamPath` under HKCU and `InstallPath` under HKLM, so
/// the parser keys off the `REG_SZ` data column instead of the value name.
fn parse_steam_path(output: &str) -> String {
    output
        .lines()
        .find(|l| l.contains("REG_SZ"))
        .and_then(|l| l.split("REG_SZ").nth(1))
        .map(|v| v.trim().to_string())
        .unwrap_or_default()
}

/// Reports which controller-bridging layers exist on this machine.
#[tauri::command]
pub fn controller_support_status() -> ControllerSupportStatus {
    let vi_em_bus = reg_query(r"HKLM\SYSTEM\CurrentControlSet\Services\ViGEmBus", None).is_some();
    let steam_output = reg_query(r"HKCU\Software\Valve\Steam", Some("SteamPath"))
        .or_else(|| reg_query(r"HKLM\SOFTWARE\WOW6432Node\Valve\Steam", Some("InstallPath")));
    let steam_path = steam_output.as_deref().map(parse_steam_path).unwrap_or_default();
    ControllerSupportStatus {
        vi_em_bus,
        steam: !steam_path.is_empty(),
        steam_path,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steam_path_is_parsed_from_reg_output() {
        let output = "\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    C:\\Program Files (x86)\\Steam\r\n\r\n";
        assert_eq!(parse_steam_path(output), r"C:\Program Files (x86)\Steam");
        assert_eq!(parse_steam_path("no value here"), "");
    }
}
