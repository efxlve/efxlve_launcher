//! Controller support helpers.
//!
//! Windows exposes PlayStation pads (DualSense/DualShock) as DirectInput
//! devices, so games that only read XInput never see them — the same problem
//! Steam solves with its virtual gamepad driver. We cannot ship a kernel
//! driver, but we can detect whether an XInput bridge (ViGEmBus, used by
//! DS4Windows and Steam) is installed and point the user at it. Steam itself is
//! detected too: its Steam Input layer can do the mapping for any game added to
//! the library.

use serde::Serialize;

use crate::steam;
use crate::winreg;

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

/// Reports which controller-bridging layers exist on this machine.
#[tauri::command]
pub fn controller_support_status() -> ControllerSupportStatus {
    let vi_em_bus =
        winreg::query(r"HKLM\SYSTEM\CurrentControlSet\Services\ViGEmBus", None).is_some();
    let steam_path = steam::steam_install_path();
    ControllerSupportStatus {
        vi_em_bus,
        steam: steam_path.is_some(),
        steam_path: steam_path
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
    }
}
