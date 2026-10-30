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
    /// 0.0 to 1.0.
    pub volume: f32,
    pub muted: bool,
    /// The shared "System Sounds" session (pid 0).
    pub system: bool,
}

/// The mixer's answer: the master bus plus every session on the endpoint.
#[derive(Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct AudioState {
    pub master: f32,
    pub master_muted: bool,
    pub sessions: Vec<AudioSession>,
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
    use super::{sort_sessions, AudioSession, AudioState};
    use windows::core::{Interface, PWSTR};
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioSessionControl2, IAudioSessionManager2, IMMDeviceEnumerator,
        ISimpleAudioVolume, MMDeviceEnumerator,
    };
    use windows::Win32::System::Com::{CoCreateInstance, CoTaskMemFree, CLSCTX_ALL};
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
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
                let name = if system {
                    String::new()
                } else {
                    process_name(pid)
                };
                list.push(AudioSession {
                    id,
                    pid,
                    name,
                    display_name,
                    volume: volume.GetMasterVolume().unwrap_or(1.0),
                    muted: volume
                        .GetMute()
                        .map(|muted| muted.as_bool())
                        .unwrap_or(false),
                    system,
                });
            }
            sort_sessions(&mut list);
            Ok(AudioState {
                master,
                master_muted,
                sessions: list,
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

    fn process_name(pid: u32) -> String {
        if pid == 0 {
            return String::new();
        }
        unsafe {
            let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
                return String::new();
            };
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
                return String::new();
            }
            let path = String::from_utf16_lossy(&buffer[..size as usize]);
            std::path::Path::new(&path)
                .file_stem()
                .and_then(|stem| stem.to_str())
                .unwrap_or("")
                .to_string()
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
}

#[cfg(test)]
mod tests {
    use super::{clamp_volume, sort_sessions, AudioSession};

    fn session(name: &str, pid: u32, system: bool) -> AudioSession {
        AudioSession {
            id: name.to_string(),
            pid,
            name: name.to_string(),
            display_name: String::new(),
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
