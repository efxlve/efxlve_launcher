//! PlayStation controller to XInput bridge (Windows).
//!
//! DualShock 4 and DualSense pads speak HID; games that only read XInput
//! (Dead by Daylight and friends) never see them. The bridge reads the pad's
//! own HID reports and feeds a virtual Xbox 360 controller through ViGEmBus,
//! the same driver DS4Windows and Steam Input use. It is opt-in, read-only for
//! the physical pad, and stops the moment the toggle is turned off.
//!
//! Only the four Sony pads are bridged: Xbox pads are XInput already, and a
//! second virtual pad would double their input.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

/// One parsed HID report in XInput terms.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct PadState {
    pub buttons: u16,
    pub left_trigger: u8,
    pub right_trigger: u8,
    pub thumb_lx: i16,
    pub thumb_ly: i16,
    pub thumb_rx: i16,
    pub thumb_ry: i16,
}

/// Which pad family a report came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PadFamily {
    DualShock4,
    DualSense,
}

// XInput button flags (mirrors vigem_client::XButtons so the parser is testable
// without the driver).
const X_UP: u16 = 0x0001;
const X_DOWN: u16 = 0x0002;
const X_LEFT: u16 = 0x0004;
const X_RIGHT: u16 = 0x0008;
const X_START: u16 = 0x0010;
const X_BACK: u16 = 0x0020;
const X_LTHUMB: u16 = 0x0040;
const X_RTHUMB: u16 = 0x0080;
const X_LB: u16 = 0x0100;
const X_RB: u16 = 0x0200;
const X_GUIDE: u16 = 0x0400;
const X_A: u16 = 0x1000;
const X_B: u16 = 0x2000;
const X_X: u16 = 0x4000;
const X_Y: u16 = 0x8000;

/// Sony's USB vendor id.
pub const SONY_VENDOR: u16 = 0x054C;

/// Maps a Sony product id to its pad family. DualShock 4 v1/v2, DualSense and
/// DualSense Edge are understood; anything else returns `None`.
pub fn family_for_product(product: u16) -> Option<PadFamily> {
    match product {
        0x05C4 | 0x09CC => Some(PadFamily::DualShock4),
        0x0CE6 | 0x0DF2 => Some(PadFamily::DualSense),
        _ => None,
    }
}

/// HID axis (0..255, centered near 128) to XInput (-32768..32767).
fn axis(value: u8) -> i16 {
    (((value as i32 - 128) * 32767) / 127).clamp(-32768, 32767) as i16
}

/// HID Y axes grow downwards; XInput grows upwards.
fn axis_y(value: u8) -> i16 {
    axis(value).saturating_neg()
}

fn button_state(b1: u8, b2: u8, b3: u8) -> u16 {
    let mut buttons = 0u16;
    if b1 & 0x20 != 0 {
        buttons |= X_A; // Cross
    }
    if b1 & 0x40 != 0 {
        buttons |= X_B; // Circle
    }
    if b1 & 0x10 != 0 {
        buttons |= X_X; // Square
    }
    if b1 & 0x80 != 0 {
        buttons |= X_Y; // Triangle
    }
    if b2 & 0x01 != 0 {
        buttons |= X_LB;
    }
    if b2 & 0x02 != 0 {
        buttons |= X_RB;
    }
    if b2 & 0x10 != 0 {
        buttons |= X_BACK; // Share / Create
    }
    if b2 & 0x20 != 0 {
        buttons |= X_START; // Options
    }
    if b2 & 0x40 != 0 {
        buttons |= X_LTHUMB;
    }
    if b2 & 0x80 != 0 {
        buttons |= X_RTHUMB;
    }
    if b3 & 0x01 != 0 {
        buttons |= X_GUIDE; // PS button
    }
    // The D-pad is a hat in the low nibble of the first button byte; 8 is neutral.
    buttons |= match b1 & 0x0F {
        0 => X_UP,
        1 => X_UP | X_RIGHT,
        2 => X_RIGHT,
        3 => X_DOWN | X_RIGHT,
        4 => X_DOWN,
        5 => X_DOWN | X_LEFT,
        6 => X_LEFT,
        7 => X_UP | X_LEFT,
        _ => 0,
    };
    buttons
}

/// Parses one HID input report. `None` when the report carries no pad state
/// (feature reports, USB setup packets, a different family's layout).
pub fn parse_report(family: PadFamily, report: &[u8]) -> Option<PadState> {
    match family {
        // DualShock 4: USB input reports use id 0x01, Bluetooth 0x11 with two
        // extra header bytes.
        PadFamily::DualShock4 => match report.first()? {
            0x01 if report.len() >= 10 => Some(parse_ds4(report, 0)),
            0x11 if report.len() >= 12 => Some(parse_ds4(report, 2)),
            _ => None,
        },
        // DualSense: USB uses 0x01, Bluetooth 0x31 with one extra byte.
        PadFamily::DualSense => match report.first()? {
            0x01 if report.len() >= 11 => Some(parse_ds5(report, 0)),
            0x31 if report.len() >= 12 => Some(parse_ds5(report, 1)),
            _ => None,
        },
    }
}

fn parse_ds4(report: &[u8], o: usize) -> PadState {
    PadState {
        buttons: button_state(report[o + 5], report[o + 6], report[o + 7]),
        left_trigger: report[o + 8],
        right_trigger: report[o + 9],
        thumb_lx: axis(report[o + 1]),
        thumb_ly: axis_y(report[o + 2]),
        thumb_rx: axis(report[o + 3]),
        thumb_ry: axis_y(report[o + 4]),
    }
}

fn parse_ds5(report: &[u8], o: usize) -> PadState {
    PadState {
        buttons: button_state(report[o + 8], report[o + 9], report[o + 10]),
        left_trigger: report[o + 5],
        right_trigger: report[o + 6],
        thumb_lx: axis(report[o + 1]),
        thumb_ly: axis_y(report[o + 2]),
        thumb_rx: axis(report[o + 3]),
        thumb_ry: axis_y(report[o + 4]),
    }
}

/// What the Settings page shows for the bridge.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BridgeStatus {
    pub running: bool,
    /// Product name of the pad currently bridged (empty while waiting).
    pub device: String,
}

struct BridgeHandle {
    stop: Arc<AtomicBool>,
    device: Arc<Mutex<String>>,
    thread: std::thread::JoinHandle<()>,
}

static HANDLE: Mutex<Option<BridgeHandle>> = Mutex::new(None);

pub fn status() -> BridgeStatus {
    match HANDLE.lock() {
        Ok(guard) => match guard.as_ref() {
            Some(handle) => BridgeStatus {
                running: true,
                device: handle
                    .device
                    .lock()
                    .map(|name| name.clone())
                    .unwrap_or_default(),
            },
            None => BridgeStatus {
                running: false,
                device: String::new(),
            },
        },
        Err(_) => BridgeStatus {
            running: false,
            device: String::new(),
        },
    }
}

/// Starts the bridge. Fails fast when ViGEmBus is missing or the virtual pad
/// cannot be plugged in; otherwise the worker keeps reconnecting the pad.
pub fn start() -> Result<BridgeStatus, String> {
    {
        let guard = HANDLE.lock().map_err(|_| "bridge lock poisoned".to_string())?;
        if guard.is_some() {
            return Ok(status());
        }
    }

    let stop = Arc::new(AtomicBool::new(false));
    let device = Arc::new(Mutex::new(String::new()));
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

    let thread = {
        let stop = stop.clone();
        let device = device.clone();
        std::thread::Builder::new()
            .name("controller-bridge".into())
            .spawn(move || worker(stop, device, ready_tx))
            .map_err(|e| e.to_string())?
    };

    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(())) => {}
        Ok(Err(message)) => {
            let _ = thread.join();
            return Err(message);
        }
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            let _ = thread.join();
            return Err("@t:controller.bridgeStartTimeout".into());
        }
    }

    {
        let mut guard = HANDLE.lock().map_err(|_| "bridge lock poisoned".to_string())?;
        *guard = Some(BridgeHandle {
            stop,
            device,
            thread,
        });
    }
    Ok(status())
}

pub fn stop() -> BridgeStatus {
    let handle = HANDLE.lock().ok().and_then(|mut guard| guard.take());
    if let Some(handle) = handle {
        handle.stop.store(true, Ordering::Relaxed);
        let _ = handle.thread.join();
    }
    status()
}

#[tauri::command]
pub fn controller_bridge_start() -> Result<BridgeStatus, String> {
    start()
}

#[tauri::command]
pub fn controller_bridge_stop() -> BridgeStatus {
    stop()
}

#[cfg(windows)]
fn worker(
    stop: Arc<AtomicBool>,
    device_name: Arc<Mutex<String>>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    use vigem_client::{Client, TargetId, Xbox360Wired};

    let client = match Client::connect() {
        Ok(client) => client,
        Err(_) => {
            let _ = ready.send(Err("@t:controller.bridgeNoDriver".into()));
            return;
        }
    };
    let mut target = Xbox360Wired::new(client, TargetId::XBOX360_WIRED);
    if let Err(e) = target.plugin() {
        let _ = ready.send(Err(format!("@t:controller.bridgeError\u{1f}{e}")));
        return;
    }
    // No wait_ready here: some driver versions never signal it and the call
    // would block the worker. Updates simply retry until the driver accepts
    // them, which happens within a frame or two.
    let _ = ready.send(Ok(()));

    let api = match hidapi::HidApi::new() {
        Ok(api) => api,
        Err(_) => {
            let _ = target.update(&to_xgamepad(&PadState::default()));
            return;
        }
    };

    let mut open: Option<(hidapi::HidDevice, PadFamily)> = None;
    let mut buffer = [0u8; 64];
    let mut last = PadState::default();

    while !stop.load(Ordering::Relaxed) {
        if open.is_none() {
            open = open_pad(&api);
            if open.is_none() {
                // Keep the virtual pad centered while no physical pad is around.
                if last != PadState::default() {
                    let _ = target.update(&to_xgamepad(&PadState::default()));
                    last = PadState::default();
                }
                std::thread::sleep(Duration::from_millis(1000));
                continue;
            }
            if let Some((_, family)) = &open {
                if let Ok(mut name) = device_name.lock() {
                    *name = match family {
                        PadFamily::DualShock4 => "DualShock 4".to_string(),
                        PadFamily::DualSense => "DualSense".to_string(),
                    };
                }
            }
        }

        let Some((device, family)) = open.as_ref() else {
            continue;
        };
        match device.read_timeout(&mut buffer, 50) {
            Ok(0) => {}
            Ok(read) => {
                if let Some(state) = parse_report(*family, &buffer[..read]) {
                    if state != last {
                        // Retry until the driver accepts the state: the virtual
                        // pad may still be warming up right after plugin.
                        if target.update(&to_xgamepad(&state)).is_ok() {
                            last = state;
                        }
                    }
                }
            }
            Err(_) => {
                // Pad unplugged or the handle went stale: reopen on the next lap.
                if last != PadState::default() {
                    let _ = target.update(&to_xgamepad(&PadState::default()));
                    last = PadState::default();
                }
                if let Ok(mut name) = device_name.lock() {
                    name.clear();
                }
                open = None;
            }
        }
    }

    // Center the virtual pad; dropping the target unplugs it.
    let _ = target.update(&to_xgamepad(&PadState::default()));
}

/// Opens the gamepad HID interface of the first Sony pad found.
#[cfg(windows)]
fn open_pad(api: &hidapi::HidApi) -> Option<(hidapi::HidDevice, PadFamily)> {
    let mut best: Option<(&std::ffi::CStr, PadFamily)> = None;
    for info in api.device_list() {
        if info.vendor_id() != SONY_VENDOR {
            continue;
        }
        let Some(family) = family_for_product(info.product_id()) else {
            continue;
        };
        let is_gamepad = info.usage_page() == 0x01 && info.usage() == 0x05;
        if is_gamepad || info.interface_number() == 3 || best.is_none() {
            let candidate = (info.path(), family);
            if is_gamepad {
                best = Some(candidate);
                break;
            }
            if best.is_none() {
                best = Some(candidate);
            }
        }
    }
    let (path, family) = best?;
    api.open_path(path).ok().map(|device| (device, family))
}

#[cfg(windows)]
fn to_xgamepad(state: &PadState) -> vigem_client::XGamepad {
    vigem_client::XGamepad {
        buttons: vigem_client::XButtons(state.buttons),
        left_trigger: state.left_trigger,
        right_trigger: state.right_trigger,
        thumb_lx: state.thumb_lx,
        thumb_ly: state.thumb_ly,
        thumb_rx: state.thumb_rx,
        thumb_ry: state.thumb_ry,
    }
}

#[cfg(not(windows))]
fn worker(
    _stop: Arc<AtomicBool>,
    _device_name: Arc<Mutex<String>>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let _ = ready.send(Err("The controller bridge is Windows only".into()));
}

#[cfg(test)]
mod tests {
    use super::*;

    /// DualShock 4 over USB: Cross pressed, left stick up-left, L2 half.
    #[test]
    fn dualshock4_usb_report_maps_to_xinput() {
        let mut report = [0u8; 64];
        report[0] = 0x01;
        report[1] = 64; // LX left of center
        report[2] = 64; // LY up
        report[3] = 128;
        report[4] = 128;
        report[5] = 0x20 | 0x08; // Cross, D-pad neutral
        report[6] = 0x00;
        report[7] = 0x00;
        report[8] = 128; // L2 half
        report[9] = 0;
        let state = parse_report(PadFamily::DualShock4, &report).expect("state");
        assert_eq!(state.buttons, X_A);
        assert_eq!(state.thumb_lx, -16512);
        assert_eq!(state.thumb_ly, 16512);
        assert_eq!(state.left_trigger, 128);
        assert_eq!(state.right_trigger, 0);
    }

    /// DualShock 4 over Bluetooth: two extra header bytes, Circle + Options.
    #[test]
    fn dualshock4_bluetooth_report_is_offset_by_two() {
        let mut report = [0u8; 78];
        report[0] = 0x11;
        report[3] = 128;
        report[4] = 128;
        report[5] = 128;
        report[6] = 128;
        report[7] = 0x40 | 0x08; // Circle, D-pad neutral
        report[8] = 0x20; // Options
        report[9] = 0x00;
        let state = parse_report(PadFamily::DualShock4, &report).expect("state");
        assert_eq!(state.buttons, X_B | X_START);
    }

    /// DualSense over USB: Triangle, L1, D-pad right, R2 full.
    #[test]
    fn dualsense_usb_report_maps_buttons() {
        let mut report = [0u8; 64];
        report[0] = 0x01;
        report[1] = 128;
        report[2] = 128;
        report[3] = 128;
        report[4] = 128;
        report[5] = 0; // L2
        report[6] = 255; // R2
        report[8] = 0x80 | 0x02; // Triangle + D-pad right
        report[9] = 0x01; // L1
        report[10] = 0x00;
        let state = parse_report(PadFamily::DualSense, &report).expect("state");
        assert_eq!(state.buttons, X_Y | X_LB | X_RIGHT);
        assert_eq!(state.right_trigger, 255);
    }

    /// DualSense over Bluetooth: one extra byte, D-pad down-left, PS pressed.
    #[test]
    fn dualsense_bluetooth_report_is_offset_by_one() {
        let mut report = [0u8; 78];
        report[0] = 0x31;
        report[2] = 128;
        report[3] = 128;
        report[4] = 128;
        report[5] = 128;
        report[6] = 0;
        report[7] = 0;
        report[9] = 0x05; // D-pad down-left
        report[10] = 0;
        report[11] = 0x01; // PS
        let state = parse_report(PadFamily::DualSense, &report).expect("state");
        assert_eq!(state.buttons, X_DOWN | X_LEFT | X_GUIDE);
    }

    #[test]
    fn unrelated_reports_are_ignored() {
        assert!(parse_report(PadFamily::DualShock4, &[0x02, 0, 0]).is_none());
        assert!(parse_report(PadFamily::DualSense, &[0x31]).is_none());
        assert!(parse_report(PadFamily::DualShock4, &[]).is_none());
        assert_eq!(family_for_product(0x09CC), Some(PadFamily::DualShock4));
        assert_eq!(family_for_product(0x0CE6), Some(PadFamily::DualSense));
        assert_eq!(family_for_product(0x028E), None);
    }

    #[test]
    fn stick_axis_is_centered_and_signed() {
        assert_eq!(axis(128), 0);
        assert_eq!(axis(0), -32768);
        assert_eq!(axis(255), 32767);
        assert_eq!(axis_y(0), 32767);
        assert_eq!(axis_y(255), -32767);
    }

    /// Hardware smoke test: reads reports from a connected Sony pad and parses
    /// them. Run with `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs a connected DualShock/DualSense"]
    fn hardware_reports_parse() {
        let api = hidapi::HidApi::new().expect("hidapi");
        let (device, family) = open_pad(&api).expect("no Sony pad found");
        let mut buffer = [0u8; 64];
        let mut parsed = 0;
        for _ in 0..400 {
            if let Ok(read) = device.read_timeout(&mut buffer, 500) {
                if read > 0 {
                    if let Some(state) = parse_report(family, &buffer[..read]) {
                        println!("{family:?}: {state:?}");
                        parsed += 1;
                        if parsed >= 3 {
                            break;
                        }
                    }
                }
            }
        }
        assert!(parsed > 0, "no input reports arrived");
    }

    /// End-to-end smoke test: plugs in the virtual Xbox pad, bridges the real
    /// pad for a second, then unplugs. Run with
    /// `cargo test -- --ignored --nocapture`.
    #[test]
    #[ignore = "needs ViGEmBus and a connected DualShock/DualSense"]
    fn hardware_bridge_starts_and_stops() {
        let started = start().expect("bridge start");
        assert!(started.running);
        std::thread::sleep(Duration::from_secs(2));
        let status = status();
        println!("bridging: {:?}", status.device);
        assert!(status.running);
        let stopped = stop();
        assert!(!stopped.running);
    }
}
