//! System audio for the clip recorder.
//!
//! Clips were video-only, which a beta tester noticed immediately. This captures
//! what the machine is playing through the default output device (WASAPI
//! loopback — no driver, no virtual cable) and hands it to the AVI writer as
//! 16-bit PCM, the one audio format every player reads.
//!
//! The capture runs on its own thread and buffers into a ring the recorder
//! drains once per video frame, so the two streams stay roughly in step without
//! sharing a clock.

#[cfg(windows)]
pub use imp::AudioCapture;

/// What the AVI header needs to describe the stream.
#[derive(Clone, Copy)]
pub struct AudioInfo {
    pub sample_rate: u32,
    pub channels: u16,
}

impl AudioInfo {
    /// Bytes one second of this stream takes in the file.
    pub fn bytes_per_second(&self) -> u32 {
        self.sample_rate * u32::from(self.channels) * 2
    }

    /// One sample across every channel, in bytes.
    pub fn block_align(&self) -> u16 {
        self.channels * 2
    }
}

#[cfg(windows)]
mod imp {
    use super::AudioInfo;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    /// Samples kept while the recorder is busy; ~2 seconds at 48 kHz stereo.
    const MAX_SAMPLES: usize = 48_000 * 2 * 2;

    pub struct AudioCapture {
        samples: Arc<Mutex<Vec<i16>>>,
        stop: Arc<AtomicBool>,
        info: AudioInfo,
    }

    impl AudioCapture {
        /// Opens the loopback stream on the default output device. `Err` means
        /// the clip is recorded without sound, which is not fatal.
        pub fn start() -> Result<Self, String> {
            let samples: Arc<Mutex<Vec<i16>>> = Arc::new(Mutex::new(Vec::new()));
            let stop = Arc::new(AtomicBool::new(false));
            let info = probe_format()?;

            let thread_samples = Arc::clone(&samples);
            let thread_stop = Arc::clone(&stop);
            std::thread::Builder::new()
                .name("clip-audio".to_string())
                .spawn(move || capture_loop(thread_samples, thread_stop))
                .map_err(|_| "audio thread could not start".to_string())?;

            Ok(Self { samples, stop, info })
        }

        pub fn info(&self) -> AudioInfo {
            self.info
        }

        /// Takes everything captured since the last call, in interleaved i16.
        pub fn drain(&self) -> Vec<i16> {
            self.samples
                .lock()
                .map(|mut buffer| std::mem::take(&mut *buffer))
                .unwrap_or_default()
        }

        pub fn stop(&self) {
            self.stop.store(true, Ordering::SeqCst);
        }
    }

    impl Drop for AudioCapture {
        fn drop(&mut self) {
            self.stop();
        }
    }

    /// The mix format of the default output device, read once for the AVI header.
    fn probe_format() -> Result<AudioInfo, String> {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
                    .map_err(|_| "audio device enumerator unavailable".to_string())?;
            let device = enumerator
                .GetDefaultAudioEndpoint(eRender, eConsole)
                .map_err(|_| "no default output device".to_string())?;
            let client: IAudioClient = device
                .Activate(CLSCTX_ALL, None)
                .map_err(|_| "audio client unavailable".to_string())?;
            let format = client
                .GetMixFormat()
                .map_err(|_| "mix format unavailable".to_string())?;
            let info = AudioInfo {
                sample_rate: (*format).nSamplesPerSec,
                channels: (*format).nChannels,
            };
            windows::Win32::System::Com::CoTaskMemFree(Some(format as *const _ as *const _));
            CoUninitialize();
            Ok(info)
        }
    }

    /// One capture thread: pull the loopback buffer, convert to i16, buffer it.
    fn capture_loop(samples: Arc<Mutex<Vec<i16>>>, stop: Arc<AtomicBool>) {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
            let Ok(enumerator) = CoCreateInstance::<_, IMMDeviceEnumerator>(
                &MMDeviceEnumerator,
                None,
                CLSCTX_ALL,
            ) else {
                return;
            };
            let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) else {
                return;
            };
            let Ok(client) = device.Activate::<IAudioClient>(CLSCTX_ALL, None) else {
                return;
            };
            let Ok(format) = client.GetMixFormat() else {
                return;
            };
            let bits = (*format).wBitsPerSample;
            let is_float = (*format).wFormatTag == 3 || bits == 32;
            // 100 ms of buffer: long enough to survive a busy frame, short
            // enough that a stop does not wait.
            let buffer_duration = 1_000_000i64;
            if client
                .Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    buffer_duration,
                    0,
                    format,
                    None,
                )
                .is_err()
            {
                windows::Win32::System::Com::CoTaskMemFree(Some(format as *const _ as *const _));
                return;
            }
            let Ok(capture) = client.GetService::<IAudioCaptureClient>() else {
                return;
            };
            if client.Start().is_err() {
                return;
            }

            while !stop.load(Ordering::SeqCst) {
                let Ok(mut frames) = capture.GetNextPacketSize() else {
                    break;
                };
                while frames > 0 {
                    let mut data: *mut u8 = std::ptr::null_mut();
                    let mut count = 0u32;
                    let mut flags = 0u32;
                    if capture
                        .GetBuffer(&mut data, &mut count, &mut flags, None, None)
                        .is_err()
                    {
                        frames = 0;
                        break;
                    }
                    // AUDCLNT_BUFFERFLAGS_SILENT: no data, but the clock advanced.
                    if flags & 0x2 == 0 && !data.is_null() && count > 0 {
                        let converted = convert(data, count as usize, bits, is_float);
                        if let Ok(mut buffer) = samples.lock() {
                            if buffer.len() + converted.len() > MAX_SAMPLES {
                                // The recorder is behind: drop the oldest audio
                                // instead of growing without bound.
                                let drop_count = (buffer.len() + converted.len() - MAX_SAMPLES)
                                    .min(buffer.len());
                                buffer.drain(0..drop_count);
                            }
                            buffer.extend_from_slice(&converted);
                        }
                    }
                    let _ = capture.ReleaseBuffer(count);
                    let Ok(next) = capture.GetNextPacketSize() else { break };
                    frames = next;
                }
                std::thread::sleep(std::time::Duration::from_millis(5));
            }

            let _ = client.Stop();
            windows::Win32::System::Com::CoTaskMemFree(Some(format as *const _ as *const _));
            CoUninitialize();
        }
    }

    /// Mix format to interleaved 16-bit PCM. WASAPI hands out 32-bit float in
    /// shared mode, so that is the branch that actually runs; the integer paths
    /// are there for devices that report 16 or 24 bits.
    fn convert(data: *const u8, frames: usize, bits: u16, is_float: bool) -> Vec<i16> {
        unsafe {
            if is_float || bits == 32 {
                let floats = std::slice::from_raw_parts(data as *const f32, frames);
                floats
                    .iter()
                    .map(|value| (value.clamp(-1.0, 1.0) * 32_767.0).round() as i16)
                    .collect()
            } else if bits == 16 {
                let values = std::slice::from_raw_parts(data as *const i16, frames);
                values.to_vec()
            } else if bits == 24 {
                let bytes = std::slice::from_raw_parts(data, frames * 3);
                bytes
                    .chunks_exact(3)
                    .map(|chunk| ((chunk[2] as i16 as i32) << 8 | chunk[1] as i32) as i16)
                    .collect()
            } else {
                Vec::new()
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AudioInfo;

    #[test]
    fn the_stream_math_matches_pcm16() {
        let info = AudioInfo {
            sample_rate: 48_000,
            channels: 2,
        };
        assert_eq!(info.block_align(), 4);
        assert_eq!(info.bytes_per_second(), 192_000);
    }
}
