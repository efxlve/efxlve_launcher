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

/// Cap on how often the virtual pad is updated (125 Hz is plenty for games).
const MIN_UPDATE_INTERVAL: Duration = Duration::from_millis(8);

/// Whether the worker should send this state now.
///
/// A *new* button change bypasses the rate gate so a tap is never eaten; a
/// button already attempted (or an analog move) waits for the gate, so a
/// warming-up driver is not retried once per report.
fn should_send(
    state: &PadState,
    last: &PadState,
    last_attempt: &PadState,
    since_last_sent: Option<Duration>,
) -> bool {
    materially_different(state, last)
        && (state.buttons != last_attempt.buttons
            || since_last_sent.map_or(true, |elapsed| elapsed >= MIN_UPDATE_INTERVAL))
}

/// HID axis (0..255, centered near 128) to XInput (-32768..32767).
fn axis(value: u8) -> i16 {
    (((value as i32 - 128) * 32767) / 127).clamp(-32768, 32767) as i16
}

/// HID Y axes grow downwards; XInput grows upwards.
fn axis_y(value: u8) -> i16 {
    axis(value).saturating_neg()
}

/// True when the new state differs enough to be worth a ViGEm update.
///
/// ViGEmBus is a kernel driver: every update is an IOCTL. Analog sticks jitter
/// by a unit or two even when untouched, so comparing exact values would send
/// hundreds of updates per second for nothing. The values themselves are never
/// altered; the trigger simply has a step threshold.
fn materially_different(next: &PadState, last: &PadState) -> bool {
    // Two HID steps are ~516 XInput units, so the step must sit above that to
    // swallow idle jitter; real movement passes well before a game's deadzone.
    const AXIS_STEP: u16 = 1024;
    const TRIGGER_STEP: u8 = 3;
    next.buttons != last.buttons
        || next.left_trigger.abs_diff(last.left_trigger) > TRIGGER_STEP
        || next.right_trigger.abs_diff(last.right_trigger) > TRIGGER_STEP
        || next.thumb_lx.abs_diff(last.thumb_lx) > AXIS_STEP
        || next.thumb_ly.abs_diff(last.thumb_ly) > AXIS_STEP
        || next.thumb_rx.abs_diff(last.thumb_rx) > AXIS_STEP
        || next.thumb_ry.abs_diff(last.thumb_ry) > AXIS_STEP
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

/// Rumble output report for the pad: `large` is the left/big motor, `small`
/// the right/small one, exactly as ViGEm reports them.
///
/// DualShock 4 uses output report 0x05 over USB and 0x11 over Bluetooth;
/// DualSense uses 0x02 and 0x31. Bluetooth reports end with a CRC32 trailer.
pub fn rumble_report(family: PadFamily, bluetooth: bool, large: u8, small: u8) -> Vec<u8> {
    match family {
        PadFamily::DualShock4 => {
            if bluetooth {
                let mut report = vec![0u8; 78];
                report[0] = 0x11;
                report[1] = 0xC0 | 0x04; // HIDP + CRC magic, 4 ms report interval
                report[3] = 0x01; // rumble valid
                report[6] = small;
                report[7] = large;
                append_crc(&mut report);
                report
            } else {
                let mut report = vec![0u8; 32];
                report[0] = 0x05;
                report[1] = 0x01; // rumble valid
                report[4] = small;
                report[5] = large;
                report
            }
        }
        PadFamily::DualSense => {
            // The pad's emulated rumble is stronger than an Xbox pad's, so the
            // values are halved to match (same as SDL does).
            let (large, small) = (large >> 1, small >> 1);
            if bluetooth {
                let mut report = vec![0u8; 78];
                report[0] = 0x31;
                report[3] = 0x03; // rumble emulation on, audio haptics off
                report[5] = small;
                report[6] = large;
                append_crc(&mut report);
                report
            } else {
                let mut report = vec![0u8; 48];
                report[0] = 0x02;
                report[1] = 0x03; // rumble emulation on, audio haptics off
                report[3] = small;
                report[4] = large;
                report
            }
        }
    }
}

/// Bluetooth output reports end with a CRC32 over the HIDP header and payload.
fn append_crc(report: &mut [u8]) {
    let end = report.len() - 4;
    let mut hasher = crc32fast::Hasher::new();
    hasher.update(&[0xA2]);
    hasher.update(&report[..end]);
    report[end..].copy_from_slice(&hasher.finalize().to_le_bytes());
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

/// Starts the bridge. Fails fast when ViGEmBus is missing or the HID stack
/// cannot be opened; the virtual pad itself is plugged as soon as a physical
/// pad appears, so an idle launcher adds no device.
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

    // The virtual pad is plugged only once a physical pad is actually here.
    // Plugging it at startup made Windows play the device-connected chime on
    // every launcher start, even with no controller connected.
    let mut plugged = false;

    // Rumble: ViGEm notifies us whenever a game changes the virtual pad's
    // motors; the values are forwarded to the physical pad's output report.
    let (rumble_tx, rumble_rx) = std::sync::mpsc::channel::<(u8, u8)>();

    let mut api = match hidapi::HidApi::new() {
        Ok(api) => api,
        Err(e) => {
            let _ = ready.send(Err(format!("@t:controller.bridgeNoHid\u{1f}{e}")));
            return;
        }
    };

    // No wait_ready here: some driver versions never signal it and the call
    // would block the worker. Updates simply retry until the driver accepts
    // them, which happens within a frame or two.
    let _ = ready.send(Ok(()));

    let mut open: Option<(hidapi::HidDevice, PadFamily)> = None;
    let mut buffer = [0u8; 128];
    let mut last = PadState::default();
    // The state the last update attempt carried, successful or not: a held or
    // rejected button must not bypass the rate gate on every report.
    let mut last_attempt = PadState::default();
    let mut bluetooth = false;
    let mut last_rumble = (0u8, 0u8);
    // Caps how often the virtual pad is updated (125 Hz is plenty for games).
    let mut last_sent: Option<std::time::Instant> = None;

    while !stop.load(Ordering::Relaxed) {
        // Forward any rumble the game asked for to the physical pad.
        while let Ok((large, small)) = rumble_rx.try_recv() {
            if (large, small) != last_rumble {
                last_rumble = (large, small);
                if let Some((device, family)) = open.as_ref() {
                    let report = rumble_report(*family, bluetooth, large, small);
                    let _ = device.write(&report);
                }
            }
        }
        if open.is_none() {
            // hidapi caches the device list from `new()`, so a pad plugged in
            // after the bridge started needs an explicit refresh.
            let _ = api.refresh_devices();
            open = open_pad(&api);
            if open.is_none() {
                // Keep the virtual pad centered while no physical pad is around.
                if plugged && last != PadState::default() {
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

            // A physical pad is here: plug the virtual one, once per session.
            // The rumble channel starts with it, and a failure drops the handle
            // so the next lap retries instead of feeding a dead target.
            if !plugged {
                if target.plugin().is_err() {
                    if let Ok(mut name) = device_name.lock() {
                        name.clear();
                    }
                    open = None;
                    std::thread::sleep(Duration::from_millis(1000));
                    continue;
                }
                if let Ok(notification) = target.request_notification() {
                    let rumble_tx = rumble_tx.clone();
                    notification.spawn_thread(move |_, data| {
                        let _ = rumble_tx.send((data.large_motor, data.small_motor));
                    });
                }
                plugged = true;
            }
        }

        let Some((device, family)) = open.as_ref() else {
            continue;
        };
        match device.read_timeout(&mut buffer, 50) {
            Ok(0) => {}
            Ok(read) => {
                if let Some(state) = parse_report(*family, &buffer[..read]) {
                    // Report ids 0x11 (DualShock 4) and 0x31 (DualSense) only
                    // exist over Bluetooth.
                    bluetooth = matches!(buffer[0], 0x11 | 0x31);
                    if should_send(&state, &last, &last_attempt, last_sent.map(|sent| sent.elapsed())) {
                        last_attempt = state;
                        last_sent = Some(std::time::Instant::now());
                        if target.update(&to_xgamepad(&state)).is_ok() {
                            last = state;
                        }
                    }
                }
            }
            Err(_) => {
                // Pad unplugged or the handle went stale: stop its motors, wait
                // for the HID stack to settle, then reopen on the next lap. The
                // wait matters: reopening in a tight loop would flood the HID
                // stack when another process holds the device.
                if let Some((device, family)) = open.as_ref() {
                    let _ = device.write(&rumble_report(*family, bluetooth, 0, 0));
                }
                bluetooth = false;
                last_rumble = (0u8, 0u8);
                last_sent = None;
                last_attempt = PadState::default();
                if last != PadState::default() {
                    let _ = target.update(&to_xgamepad(&PadState::default()));
                    last = PadState::default();
                }
                // Take the virtual pad with the physical one. A dead gamepad
                // left plugged lingers for every game, and when it finally goes
                // (launcher exit) Steam announces the disconnect with a sound
                // while no controller is attached.
                if plugged && target.unplug().is_ok() {
                    plugged = false;
                }
                if let Ok(mut name) = device_name.lock() {
                    name.clear();
                }
                open = None;
                std::thread::sleep(Duration::from_millis(500));
            }
        }
    }

    // Center the virtual pad; dropping the target unplugs it.
    if plugged {
        let _ = target.update(&to_xgamepad(&PadState::default()));
    }
}

/// Opens the gamepad HID interface of the first Sony pad found.
///
/// Only the gamepad interface is accepted: the same pad exposes audio and
/// sensor interfaces whose reports this parser cannot read, so falling back to
/// them would feed garbage into the bridge.
#[cfg(windows)]
fn open_pad(api: &hidapi::HidApi) -> Option<(hidapi::HidDevice, PadFamily)> {
    let mut fallback: Option<(&std::ffi::CStr, PadFamily)> = None;
    for info in api.device_list() {
        if info.vendor_id() != SONY_VENDOR {
            continue;
        }
        let Some(family) = family_for_product(info.product_id()) else {
            continue;
        };
        let is_gamepad = info.usage_page() == 0x01 && matches!(info.usage(), 0x04 | 0x05);
        if is_gamepad {
            if let Ok(device) = api.open_path(info.path()) {
                return Some((device, family));
            }
        } else if info.interface_number() == 3 && fallback.is_none() {
            fallback = Some((info.path(), family));
        }
    }
    let (path, family) = fallback?;
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

    /// A new button press skips the rate gate; a held or rejected one waits.
    #[test]
    fn a_new_button_press_bypasses_the_rate_gate() {
        let base = PadState::default();
        let pressed = PadState {
            buttons: X_A,
            ..base
        };
        // Fresh press: sent right away.
        assert!(should_send(&pressed, &base, &base, Some(Duration::from_millis(0))));
        // Already attempted: the gate holds the retry back.
        assert!(!should_send(&pressed, &base, &pressed, Some(Duration::from_millis(2))));
        // Once the gate has elapsed the retry passes.
        assert!(should_send(&pressed, &base, &pressed, Some(Duration::from_millis(9))));
        // Analog-only movement respects the gate.
        let moved = PadState {
            thumb_lx: 20000,
            ..base
        };
        assert!(!should_send(&moved, &base, &base, Some(Duration::from_millis(2))));
        assert!(should_send(&moved, &base, &base, Some(Duration::from_millis(9))));
    }

    /// True when analog jitter is ignored but real movement and buttons pass.
    #[test]
    fn analog_jitter_does_not_trigger_updates() {
        let base = PadState {
            thumb_lx: 1000,
            thumb_ly: -1000,
            left_trigger: 100,
            ..Default::default()
        };
        let jitter = PadState {
            thumb_lx: 1000 + 516, // two HID steps, the idle jitter ceiling
            thumb_ly: -1000 - 516,
            left_trigger: 101,
            ..base
        };
        assert!(!materially_different(&jitter, &base));
        let moved = PadState {
            thumb_lx: 4000,
            ..base
        };
        assert!(materially_different(&moved, &base));
        let pressed = PadState {
            buttons: X_A,
            ..base
        };
        assert!(materially_different(&pressed, &base));
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

    #[test]
    fn rumble_reports_carry_the_motors() {
        let usb = rumble_report(PadFamily::DualShock4, false, 200, 100);
        assert_eq!(usb.len(), 32);
        assert_eq!(usb[0], 0x05);
        assert_eq!(usb[1], 0x01);
        assert_eq!(usb[4], 100); // right/small motor
        assert_eq!(usb[5], 200); // left/large motor

        let bt = rumble_report(PadFamily::DualShock4, true, 200, 100);
        assert_eq!(bt.len(), 78);
        assert_eq!(bt[0], 0x11);
        assert_eq!(bt[6], 100);
        assert_eq!(bt[7], 200);
        // The trailer is the CRC32 over the HIDP header and the payload.
        let mut hasher = crc32fast::Hasher::new();
        hasher.update(&[0xA2]);
        hasher.update(&bt[..74]);
        assert_eq!(&bt[74..], hasher.finalize().to_le_bytes());

        let ds5_usb = rumble_report(PadFamily::DualSense, false, 200, 100);
        assert_eq!(ds5_usb.len(), 48);
        assert_eq!(ds5_usb[0], 0x02);
        assert_eq!(ds5_usb[1], 0x03);
        assert_eq!(ds5_usb[3], 50); // halved to match Xbox strength
        assert_eq!(ds5_usb[4], 100);

        let ds5_bt = rumble_report(PadFamily::DualSense, true, 200, 100);
        assert_eq!(ds5_bt.len(), 78);
        assert_eq!(ds5_bt[0], 0x31);
        assert_eq!(ds5_bt[5], 50);
        assert_eq!(ds5_bt[6], 100);
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
