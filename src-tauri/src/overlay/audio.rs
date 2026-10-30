//! Per-application audio mixer for the in-game overlay.
//!
//! Windows exposes every process that renders audio as an `IAudioSession` on
//! the default output endpoint. `ISimpleAudioVolume` gives each session its own
//! volume and mute switch, and `IAudioEndpointVolume` does the same for the
//! master bus. The mixer is the EarTrumpet/Xbox Game Bar model: no driver, no
//! hook, no extra process.
//!
//! Every command runs on a blocking worker with its own COM apartment. The
//! objects are cheap to recreate and a two-second poll is the only recurring
//! work, so a long-lived worker thread would add lifecycle for no gain.

use serde::Serialize;

/// One audio session on the default render endpoint.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioSession {
    /// Stable session instance id; the frontend echoes it back to set volume.
    pub id: String,
    pub pid: u32,
    /// Process file stem (`chrome`, `Spotify`), empty when it cannot be read.
    pub name: String,
    /// The session's own display name, localized by the app that owns it.
    pub display_name: String,
    /// Small PNG data URL of the owning process icon, empty when unavailable.
    #[serde(default)]
    pub icon: String,
    /// 0.0 to 1.0.
    pub volume: f32,
    pub muted: bool,
    /// The shared "System Sounds" session (pid 0).
    pub system: bool,
}

/// One render endpoint the user can switch to.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevice {
    /// The endpoint id from `IMMDevice::GetId`.
    pub id: String,
    pub name: String,
    pub default: bool,
}

/// The mixer's answer: the master bus plus every session on the endpoint.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    pub master: f32,
    pub master_muted: bool,
    pub sessions: Vec<AudioSession>,
    pub devices: Vec<AudioDevice>,
    pub default_device: String,
}

/// The overlay's audio tab reads this once on open and every two seconds.
#[tauri::command]
pub async fn overlay_audio_state() -> Result<AudioState, String> {
    tauri::async_runtime::spawn_blocking(|| with_com(imp::state))
        .await
        .map_err(|error| error.to_string())?
}

/// Sets one session's volume. `id` is the instance id from `overlay_audio_state`.
#[tauri::command]
pub async fn overlay_audio_set_volume(id: String, volume: f32) -> Result<(), String> {
    let volume = clamp_volume(volume);
    tauri::async_runtime::spawn_blocking(move || with_com(|| imp::set_volume(&id, volume)))
        .await
        .map_err(|error| error.to_string())?
}

/// Mutes or unmutes one session.
#[tauri::command]
pub async fn overlay_audio_set_mute(id: String, muted: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_com(|| imp::set_mute(&id, muted)))
        .await
        .map_err(|error| error.to_string())?
}

/// Sets the default output device's master volume.
#[tauri::command]
pub async fn overlay_audio_set_master(volume: f32) -> Result<(), String> {
    let volume = clamp_volume(volume);
    tauri::async_runtime::spawn_blocking(move || with_com(|| imp::set_master(volume)))
        .await
        .map_err(|error| error.to_string())?
}

/// Mutes or unmutes the default output device.
#[tauri::command]
pub async fn overlay_audio_set_master_mute(muted: bool) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_com(|| imp::set_master_mute(muted)))
        .await
        .map_err(|error| error.to_string())?
}

/// Sets the default output device. `id` is from `overlay_audio_state`.
#[tauri::command]
pub async fn overlay_audio_set_device(id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || with_com(|| imp::set_default_device(&id)))
        .await
        .map_err(|error| error.to_string())?
}

fn clamp_volume(volume: f32) -> f32 {
    if volume.is_finite() {
        volume.clamp(0.0, 1.0)
    } else {
        0.0
    }
}

/// Non-system sessions first, named processes before unnamed ones, then a
/// case-folded name order. System sounds always land at the bottom.
#[cfg_attr(not(windows), allow(dead_code))]
fn sort_sessions(sessions: &mut [AudioSession]) {
    sessions.sort_by(|a, b| {
        a.system
            .cmp(&b.system)
            .then_with(|| a.name.is_empty().cmp(&b.name.is_empty()))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
            .then_with(|| a.display_name.cmp(&b.display_name))
            .then_with(|| a.pid.cmp(&b.pid))
    });
}

#[cfg(windows)]
fn with_com<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

    // S_FALSE means this thread is already in an MTA and still needs its
    // matching uninitialize. RPC_E_CHANGED_MODE means an existing STA, which
    // CoreAudio also supports; that apartment belongs to someone else.
    let initialized = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED).is_ok() };
    let result = work();
    if initialized {
        unsafe { CoUninitialize() };
    }
    result
}

#[cfg(not(windows))]
fn with_com<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    work()
}

#[cfg(windows)]
mod imp {
    use super::{sort_sessions, AudioDevice, AudioSession, AudioState};
    use std::collections::HashMap;
    use std::os::windows::ffi::OsStrExt;
    use std::sync::{Mutex, OnceLock};
    use image::codecs::png::PngEncoder;
    use image::{ExtendedColorType, ImageEncoder};
    use windows::core::{GUID, Interface, PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, PROPERTYKEY};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
    };
    use windows::Win32::System::Com::StructuredStorage::{
        PropVariantClear, PropVariantToStringAlloc,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL, STGM_READ};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, GetObjectW, ReleaseDC,
        SelectObject, BITMAP, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };
    use windows::Win32::UI::Shell::ExtractIconExW;
    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyIcon, DrawIconEx, GetIconInfo, HICON, ICONINFO, DI_NORMAL,
    };

    pub fn state() -> Result<AudioState, String> {
        unsafe {
            let enumerator = enumerator()?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|_| "no default output device".to_string())?;

            let endpoint: IAudioEndpointVolume = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|_| "endpoint volume unavailable".to_string())?;
            let master = endpoint.GetMasterVolumeLevelScalar().unwrap_or(0.0);
            let master_muted = endpoint
                .GetMute()
                .map(|muted| muted.as_bool())
                .unwrap_or(false);

            let manager: IAudioSessionManager2 = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|_| "session manager unavailable".to_string())?;
            let sessions = manager
                .GetSessionEnumerator()
                .map_err(|_| "session enumerator unavailable".to_string())?;
            let count = sessions.GetCount().unwrap_or(0);
            let mut list = Vec::with_capacity(count.max(0) as usize);
            for index in 0..count {
                let Ok(control) = sessions.GetSession(index) else {
                    continue;
                };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let Ok(volume) = control.cast::<ISimpleAudioVolume>() else {
                    continue;
                };
                let pid = control2.GetProcessId().unwrap_or(0);
                let system = control2.IsSystemSoundsSession().is_ok();
                let id = take_pwstr(control2.GetSessionInstanceIdentifier().ok())
                    .filter(|id| !id.is_empty())
                    .unwrap_or_else(|| {
                        if system {
                            "system".to_string()
                        } else {
                            format!("{pid}:{index}")
                        }
                    });
                let display_name = take_pwstr(control.GetDisplayName().ok()).unwrap_or_default();
                let (name, icon) = if system {
                    (String::new(), String::new())
                } else {
                    match process_path(pid) {
                        Some(path) => (
                            path.file_stem()
                                .and_then(|stem| stem.to_str())
                                .unwrap_or("")
                                .to_string(),
                            icon_data_url(&path).unwrap_or_default(),
                        ),
                        None => (String::new(), String::new()),
                    }
                };
                list.push(AudioSession {
                    id,
                    pid,
                    name,
                    display_name,
                    icon,
                    volume: volume.GetMasterVolume().unwrap_or(1.0),
                    muted: volume
                        .GetMute()
                        .map(|muted| muted.as_bool())
                        .unwrap_or(false),
                    system,
                });
            }
            sort_sessions(&mut list);
            let default_device = take_pwstr(device.GetId().ok()).unwrap_or_default();
            let devices = render_devices(&enumerator, &default_device);
            Ok(AudioState {
                master,
                master_muted,
                sessions: list,
                devices,
                default_device,
            })
        }
    }

    pub fn set_volume(id: &str, volume: f32) -> Result<(), String> {
        unsafe {
            find_session(id)?
                .SetMasterVolume(volume, std::ptr::null())
                .map_err(|_| "session volume could not be set".to_string())
        }
    }

    pub fn set_mute(id: &str, muted: bool) -> Result<(), String> {
        unsafe {
            find_session(id)?
                .SetMute(muted, std::ptr::null())
                .map_err(|_| "session mute could not be set".to_string())
        }
    }

    pub fn set_master(volume: f32) -> Result<(), String> {
        unsafe {
            endpoint()?
                .SetMasterVolumeLevelScalar(volume, std::ptr::null())
                .map_err(|_| "master volume could not be set".to_string())
        }
    }

    pub fn set_master_mute(muted: bool) -> Result<(), String> {
        unsafe {
            endpoint()?
                .SetMute(muted, std::ptr::null())
                .map_err(|_| "master mute could not be set".to_string())
        }
    }

    fn enumerator() -> Result<IMMDeviceEnumerator, String> {
        unsafe {
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                .map_err(|_| "audio device enumerator unavailable".to_string())
        }
    }

    const PKEY_DEVICE_FRIENDLY_NAME: PROPERTYKEY = PROPERTYKEY {
        fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 14,
    };

    fn render_devices(enumerator: &IMMDeviceEnumerator, default_id: &str) -> Vec<AudioDevice> {
        unsafe {
            let Ok(collection) = enumerator.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) else {
                return Vec::new();
            };
            let count = collection.GetCount().unwrap_or(0);
            let mut devices = Vec::with_capacity(count as usize);
            for index in 0..count {
                let Ok(device) = collection.Item(index) else {
                    continue;
                };
                let id = take_pwstr(device.GetId().ok()).unwrap_or_default();
                if id.is_empty() {
                    continue;
                }
                let name = device_friendly_name(&device).unwrap_or_else(|| id.clone());
                devices.push(AudioDevice {
                    default: id == default_id,
                    id,
                    name,
                });
            }
            devices
        }
    }

    fn device_friendly_name(device: &windows::Win32::Media::Audio::IMMDevice) -> Option<String> {
        unsafe {
            let store = device.OpenPropertyStore(STGM_READ).ok()?;
            let mut value = store.GetValue(&PKEY_DEVICE_FRIENDLY_NAME).ok()?;
            let text = PropVariantToStringAlloc(&value)
                .ok()
                .and_then(|wide| take_pwstr(Some(wide)));
            let _ = PropVariantClear(&mut value);
            text.filter(|name| !name.trim().is_empty())
        }
    }

    /// Switches the default render endpoint. Windows exposes no documented API
    /// for this; the policy client is the same COM object the Sound control
    /// panel uses. The vtable slot is called directly because the interface is
    /// not in the Windows metadata.
    pub fn set_default_device(id: &str) -> Result<(), String> {
        if id.trim().is_empty() {
            return Err("no audio device selected".to_string());
        }
        unsafe {
            #[link(name = "ole32")]
            extern "system" {
                fn CoCreateInstance(
                    rclsid: *const GUID,
                    punkouter: *mut core::ffi::c_void,
                    dwclscontext: u32,
                    riid: *const GUID,
                    ppv: *mut *mut core::ffi::c_void,
                ) -> i32;
            }
            let candidates = [
                (
                    GUID::from_u128(0x870af99c_171d_4f9e_af0d_e63df40c2bc9),
                    GUID::from_u128(0xf8679f50_850a_4090_9c72_430f5824f0f6),
                ),
                (
                    GUID::from_u128(0x294935ce_f637_4e7c_a41b_ab255460b862),
                    GUID::from_u128(0x568b9108_44bf_40b4_9006_86afe5b5a620),
                ),
            ];
            let mut raw: *mut core::ffi::c_void = std::ptr::null_mut();
            let mut last = 0i32;
            for (clsid, iid) in candidates {
                last = CoCreateInstance(
                    &clsid,
                    std::ptr::null_mut(),
                    CLSCTX_ALL.0,
                    &iid,
                    &mut raw,
                );
                if last >= 0 && !raw.is_null() {
                    break;
                }
            }
            if last < 0 || raw.is_null() {
                return Err(format!("audio policy client unavailable (0x{last:08x})"));
            }
            let vtable = *(raw as *const *const usize);
            // 0 QueryInterface, 1 AddRef, 2 Release, then the interface methods;
            // SetDefaultEndpoint is slot 13.
            let set_default: unsafe extern "system" fn(*mut core::ffi::c_void, PCWSTR, i32) -> i32 =
                std::mem::transmute(*vtable.add(13));
            let release: unsafe extern "system" fn(*mut core::ffi::c_void) -> u32 =
                std::mem::transmute(*vtable.add(2));
            let wide: Vec<u16> = id.encode_utf16().chain(std::iter::once(0)).collect();
            let device = PCWSTR(wide.as_ptr());
            // eConsole, eMultimedia, eCommunications: all three follow the pick.
            for role in 0..3 {
                let result = set_default(raw, device, role);
                if result < 0 {
                    let _ = release(raw);
                    return Err(format!("default audio device could not be set (0x{result:08x})"));
                }
            }
            let _ = release(raw);
            Ok(())
        }
    }

    fn endpoint() -> Result<IAudioEndpointVolume, String> {
        unsafe {
            let device = enumerator()?
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|_| "no default output device".to_string())?;
            device
                .Activate(CLSCTX_ALL, None)
                .map_err(|_| "endpoint volume unavailable".to_string())
        }
    }

    /// Finds the live session behind an instance id. A session that exited
    /// between the poll and the change returns a clear error; the next poll
    /// removes its row.
    fn find_session(id: &str) -> Result<ISimpleAudioVolume, String> {
        unsafe {
            let manager: IAudioSessionManager2 = enumerator()?
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|_| "no default output device".to_string())?
                .Activate(CLSCTX_ALL, None)
                .map_err(|_| "session manager unavailable".to_string())?;
            let sessions = manager
                .GetSessionEnumerator()
                .map_err(|_| "session enumerator unavailable".to_string())?;
            let count = sessions.GetCount().unwrap_or(0);
            for index in 0..count {
                let Ok(control) = sessions.GetSession(index) else {
                    continue;
                };
                let Ok(control2) = control.cast::<IAudioSessionControl2>() else {
                    continue;
                };
                let instance =
                    take_pwstr(control2.GetSessionInstanceIdentifier().ok()).unwrap_or_default();
                let system = control2.IsSystemSoundsSession().is_ok();
                if instance == id || (id == "system" && system) {
                    return control
                        .cast::<ISimpleAudioVolume>()
                        .map_err(|_| "session volume unavailable".to_string());
                }
            }
            Err("audio session is gone".to_string())
        }
    }

    fn process_path(pid: u32) -> Option<std::path::PathBuf> {
        if pid == 0 {
            return None;
        }
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buffer = [0u16; 1024];
            let mut size = buffer.len() as u32;
            let result = QueryFullProcessImageNameW(
                handle,
                PROCESS_NAME_WIN32,
                PWSTR(buffer.as_mut_ptr()),
                &mut size,
            );
            let _ = CloseHandle(handle);
            if result.is_err() {
                return None;
            }
            Some(std::path::PathBuf::from(String::from_utf16_lossy(
                &buffer[..size as usize],
            )))
        }
    }

    static ICON_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

    pub(super) fn icon_data_url(path: &std::path::Path) -> Option<String> {
        let key = path.to_string_lossy().to_string();
        let cache = ICON_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
        if let Ok(cache) = cache.lock() {
            if let Some(value) = cache.get(&key) {
                return (!value.is_empty()).then_some(value.clone());
            }
        }
        let value = extract_icon(path).unwrap_or_default();
        if let Ok(mut cache) = cache.lock() {
            cache.insert(key, value.clone());
        }
        (!value.is_empty()).then_some(value)
    }

    fn extract_icon(path: &std::path::Path) -> Option<String> {
        unsafe {
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let mut icon = HICON::default();
            let count = ExtractIconExW(PCWSTR(wide.as_ptr()), 0, None, Some(&mut icon), 1);
            if count == 0 || icon.0.is_null() {
                return None;
            }
            let result = hicon_to_png(icon);
            let _ = DestroyIcon(icon);
            result
        }
    }

    unsafe fn hicon_to_png(icon: HICON) -> Option<String> {
        unsafe {
            let mut info = ICONINFO::default();
            GetIconInfo(icon, &mut info).ok()?;
            let color = info.hbmColor;
            let mask = info.hbmMask;
            let mut bitmap = BITMAP::default();
            let copied = GetObjectW(
                HGDIOBJ(color.0),
                std::mem::size_of::<BITMAP>() as i32,
                Some(&mut bitmap as *mut _ as *mut core::ffi::c_void),
            );
            if copied == 0 || bitmap.bmWidth <= 0 || bitmap.bmHeight <= 0 {
                let _ = DeleteObject(HGDIOBJ(color.0));
                let _ = DeleteObject(HGDIOBJ(mask.0));
                return None;
            }
            let width = bitmap.bmWidth;
            let height = bitmap.bmHeight;
            let screen = GetDC(None);
            let memory = CreateCompatibleDC(Some(screen));
            let mut bmi = BITMAPINFO::default();
            bmi.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
            bmi.bmiHeader.biWidth = width;
            bmi.bmiHeader.biHeight = -height;
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB.0 as u32;
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let dib = CreateDIBSection(Some(memory), &bmi, DIB_RGB_COLORS, &mut bits, None, 0).ok();
            let Some(dib) = dib else {
                let _ = DeleteDC(memory);
                let _ = ReleaseDC(None, screen);
                let _ = DeleteObject(HGDIOBJ(color.0));
                let _ = DeleteObject(HGDIOBJ(mask.0));
                return None;
            };
            let old = SelectObject(memory, HGDIOBJ(dib.0));
            let _ = DrawIconEx(memory, 0, 0, icon, width, height, 0, None, DI_NORMAL);
            let source = std::slice::from_raw_parts(
                bits as *const u8,
                width as usize * height as usize * 4,
            );
            let mut rgba = vec![0u8; width as usize * height as usize * 4];
            let mut any_alpha = false;
            for (pixel, source) in rgba.chunks_exact_mut(4).zip(source.chunks_exact(4)) {
                pixel[0] = source[2];
                pixel[1] = source[1];
                pixel[2] = source[0];
                pixel[3] = source[3];
                any_alpha |= source[3] != 0;
            }
            if !any_alpha {
                for pixel in rgba.chunks_exact_mut(4) {
                    pixel[3] = 255;
                }
            }
            SelectObject(memory, old);
            let _ = DeleteObject(HGDIOBJ(dib.0));
            let _ = DeleteDC(memory);
            let _ = ReleaseDC(None, screen);
            let _ = DeleteObject(HGDIOBJ(color.0));
            let _ = DeleteObject(HGDIOBJ(mask.0));

            let mut png = Vec::new();
            PngEncoder::new(&mut png)
                .write_image(&rgba, width as u32, height as u32, ExtendedColorType::Rgba8)
                .ok()?;
            use base64::Engine;
            let encoded = base64::engine::general_purpose::STANDARD.encode(png);
            Some(format!("data:image/png;base64,{encoded}"))
        }
    }

    /// Copies a COM-allocated wide string and releases it. The pointer is owned
    /// by the caller, not by the interface, so skipping the free leaks it.
    unsafe fn take_pwstr(value: Option<PWSTR>) -> Option<String> {
        unsafe {
            let value = value?;
            if value.0.is_null() {
                return None;
            }
            let mut len = 0usize;
            while *value.0.add(len) != 0 {
                len += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(value.0, len));
            CoTaskMemFree(Some(value.0 as *const core::ffi::c_void));
            Some(text)
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::AudioState;

    pub fn state() -> Result<AudioState, String> {
        Ok(AudioState::default())
    }
    pub fn set_volume(_id: &str, _volume: f32) -> Result<(), String> {
        Err("audio mixer is Windows only".to_string())
    }
    pub fn set_mute(_id: &str, _muted: bool) -> Result<(), String> {
        Err("audio mixer is Windows only".to_string())
    }
    pub fn set_master(_volume: f32) -> Result<(), String> {
        Err("audio mixer is Windows only".to_string())
    }
    pub fn set_master_mute(_muted: bool) -> Result<(), String> {
        Err("audio mixer is Windows only".to_string())
    }
    pub fn set_default_device(_id: &str) -> Result<(), String> {
        Err("audio mixer is Windows only".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::{clamp_volume, sort_sessions, AudioSession};

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a real process icon"]
    fn extracts_a_process_icon_as_a_png_data_url() {
        let path = std::path::Path::new(r"C:\Windows\explorer.exe");
        let icon = super::imp::icon_data_url(path).expect("explorer icon");
        assert!(icon.starts_with("data:image/png;base64,"));
        assert!(icon.len() > 200);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs an active render endpoint"]
    fn enumerates_render_endpoints_and_marks_the_default() {
        let state = super::with_com(super::imp::state).expect("audio state");
        assert!(!state.devices.is_empty(), "no render endpoints");
        assert!(state.devices.iter().any(|device| device.default));
        assert!(!state.default_device.is_empty());
        // Re-apply the current default: exercises the policy vtable without
        // changing the user's actual output.
        super::with_com(|| super::imp::set_default_device(&state.default_device))
            .expect("set default endpoint");
    }

    fn session(name: &str, pid: u32, system: bool) -> AudioSession {
        AudioSession {
            id: name.to_string(),
            pid,
            name: name.to_string(),
            display_name: String::new(),
            icon: String::new(),
            volume: 1.0,
            muted: false,
            system,
        }
    }

    #[test]
    fn volumes_stay_inside_the_mixer_range() {
        assert_eq!(clamp_volume(-0.5), 0.0);
        assert_eq!(clamp_volume(1.5), 1.0);
        assert_eq!(clamp_volume(0.42), 0.42);
        assert_eq!(clamp_volume(f32::NAN), 0.0);
    }

    #[test]
    fn named_apps_sort_before_system_sounds() {
        let mut sessions = vec![
            session("", 0, true),
            session("Zebra", 2, false),
            session("alpha", 1, false),
        ];
        sort_sessions(&mut sessions);
        let names: Vec<&str> = sessions.iter().map(|entry| entry.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "Zebra", ""]);
        assert!(sessions[2].system);
    }
}
