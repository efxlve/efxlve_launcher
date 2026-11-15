//! Controller support helpers.
//!
//! Windows exposes PlayStation pads (DualSense/DualShock) as DirectInput
//! devices, so games that only read XInput never see them — the same problem
//! Steam solves with its virtual gamepad driver. We cannot ship a kernel
//! driver, but we can detect whether an XInput bridge (ViGEmBus, used by
//! DS4Windows and Steam) is installed and point the user at it. Steam itself is
//! detected too: its Steam Input layer can do the mapping for any game added to
//! the library.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::controller_bridge::PadFamily;
use crate::steam;
use crate::winreg;

/// The HID list changes only when a pad is plugged in or removed. Enumerating
/// the whole stack is not free (hidapi opens every device), so repeated reads
/// share one answer for this long.
const PAD_CACHE_TTL: Duration = Duration::from_secs(15);

static PAD_CACHE: Mutex<Option<(Instant, Vec<ConnectedController>)>> = Mutex::new(None);

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
    /// XInput bridge state and the pad it currently bridges.
    pub bridge_running: bool,
    pub bridge_device: String,
}

/// Reports which controller-bridging layers exist on this machine.
#[tauri::command]
pub fn controller_support_status() -> ControllerSupportStatus {
    let vi_em_bus =
        winreg::query(r"HKLM\SYSTEM\CurrentControlSet\Services\ViGEmBus", None).is_some();
    let steam_path = steam::steam_install_path();
    let bridge = crate::controller_bridge::status();
    ControllerSupportStatus {
        vi_em_bus,
        steam: steam_path.is_some(),
        steam_path: steam_path
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default(),
        bridge_running: bridge.running,
        bridge_device: bridge.device,
    }
}

/// One pad the operating system reports, independent of the WebView.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectedController {
    /// Product name, empty when the pad reports none.
    pub name: String,
    /// One of the frontend `ControllerKind` values.
    pub kind: &'static str,
}

/// Lists the pads on the HID stack.
///
/// Chromium's Gamepad API keeps a connected pad hidden until one of its buttons
/// is pressed (a fingerprinting guard), so `navigator.getGamepads()` cannot
/// answer "is a controller plugged in?" for Settings. The HID device list can:
/// the section shows the pad at once and explains the first button press
/// instead of claiming nothing is connected.
#[tauri::command]
pub async fn controller_connected_pads(force: Option<bool>) -> Vec<ConnectedController> {
    let force = force.unwrap_or(false);
    if !force {
        if let Ok(cache) = PAD_CACHE.lock() {
            if let Some((at, pads)) = cache.as_ref() {
                if at.elapsed() < PAD_CACHE_TTL {
                    return pads.clone();
                }
            }
        }
    }
    // hidapi walks the whole HID stack; keep it off the IPC/main thread.
    let pads = tauri::async_runtime::spawn_blocking(list_pads)
        .await
        .unwrap_or_default();
    if let Ok(mut cache) = PAD_CACHE.lock() {
        *cache = Some((Instant::now(), pads.clone()));
    }
    pads
}

#[cfg(windows)]
fn list_pads() -> Vec<ConnectedController> {
    hid_pads()
}

#[cfg(not(windows))]
fn list_pads() -> Vec<ConnectedController> {
    // Only Windows enumerates the HID stack here; elsewhere the Gamepad API
    // is the single source.
    Vec::new()
}

/// Controller family for a HID pad. Sony pads come from the bridge's product
/// table; other vendors keep the families the Gamepad API reports.
#[cfg_attr(not(windows), allow(dead_code))]
fn pad_kind(vendor: u16, family: Option<PadFamily>) -> &'static str {
    if family.is_some() {
        return "playstation";
    }
    match vendor {
        0x045E => "xbox",
        0x057E => "switch",
        0x28DE => "steamdeck",
        _ => "generic",
    }
}

/// The name a Sony pad family shows in Settings.
#[cfg_attr(not(windows), allow(dead_code))]
fn family_name(family: Option<PadFamily>) -> Option<&'static str> {
    match family? {
        PadFamily::DualShock4 => Some("DualShock 4"),
        PadFamily::DualSense => Some("DualSense"),
    }
}

#[cfg(windows)]
fn hid_pads() -> Vec<ConnectedController> {
    use crate::controller_bridge::{family_for_product, SONY_VENDOR};

    let Ok(api) = hidapi::HidApi::new() else {
        return Vec::new();
    };
    let mut pads = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for info in api.device_list() {
        let family =
            family_for_product(info.product_id()).filter(|_| info.vendor_id() == SONY_VENDOR);
        // Some Sony firmware does not report a generic-desktop usage on the
        // gamepad collection; the bridge falls back to interface 3 for them.
        let sony_fallback = family.is_some() && info.interface_number() == 3;
        if !is_gamepad_usage(info) && !sony_fallback {
            continue;
        }
        // A pad can expose several HID collections; the serial number (or the
        // interface, when the pad has none) keeps it to one row.
        let key = pad_key(info);
        if seen.contains(&key) {
            continue;
        }
        seen.push(key);
        pads.push(ConnectedController {
            name: family_name(family)
                .map(str::to_string)
                .unwrap_or_else(|| info.product_string().unwrap_or_default().trim().to_string()),
            kind: pad_kind(info.vendor_id(), family),
        });
    }
    pads
}

#[cfg(windows)]
fn is_gamepad_usage(info: &hidapi::DeviceInfo) -> bool {
    info.usage_page() == 0x01 && matches!(info.usage(), 0x04 | 0x05 | 0x08)
}

#[cfg(windows)]
fn pad_key(info: &hidapi::DeviceInfo) -> String {
    match info.serial_number().filter(|serial| !serial.is_empty()) {
        Some(serial) => format!("{}:{}:{serial}", info.vendor_id(), info.product_id()),
        None => format!(
            "{}:{}:{}",
            info.vendor_id(),
            info.product_id(),
            info.interface_number()
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pad_kind_names_the_family() {
        assert_eq!(pad_kind(0x054C, Some(PadFamily::DualShock4)), "playstation");
        assert_eq!(pad_kind(0x054C, Some(PadFamily::DualSense)), "playstation");
        assert_eq!(pad_kind(0x045E, None), "xbox");
        assert_eq!(pad_kind(0x057E, None), "switch");
        assert_eq!(pad_kind(0x28DE, None), "steamdeck");
        assert_eq!(pad_kind(0x1234, None), "generic");
    }

    #[test]
    fn family_name_matches_the_settings_row() {
        assert_eq!(family_name(Some(PadFamily::DualShock4)), Some("DualShock 4"));
        assert_eq!(family_name(Some(PadFamily::DualSense)), Some("DualSense"));
        assert_eq!(family_name(None), None);
    }

    /// Hardware smoke test: the HID list Settings reads finds the pad the
    /// Gamepad API may still be hiding. Run with `cargo test -- --ignored`.
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a connected controller"]
    fn hardware_lists_the_connected_pad() {
        let pads = hid_pads();
        println!("{pads:?}");
        assert!(
            pads.iter().any(|pad| pad.kind == "playstation"),
            "no PlayStation pad in the HID list"
        );
    }
}
