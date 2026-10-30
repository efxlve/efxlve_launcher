//! Media Foundation H.264 + AAC recorder for the 60/120 fps clip path.
//!
//! `IMFSinkWriter` owns the encoder and the MP4 muxer: the OS picks a hardware
//! H.264 MFT (NVENC, QuickSync, AMF) when one is registered and falls back to
//! the software encoder otherwise. Video arrives as top-down BGRA, audio as the
//! 48 kHz stereo PCM the loopback capture already produces.
//!
//! The MJPEG/AVI writer stays the fallback and the only path on machines where
//! Media Foundation cannot create the writer. Nothing here is used until the
//! recorder selects this backend for rates above 30 fps.

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt;
    use windows::core::PCWSTR;
    use windows::Win32::Media::MediaFoundation::{
        IMFAttributes, IMFMediaType, IMFSinkWriter, MFAudioFormat_AAC, MFAudioFormat_PCM,
        MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
        MFCreateSinkWriterFromURL, MFMediaType_Audio, MFMediaType_Video, MFSTARTUP_FULL,
        MFShutdown, MFStartup, MFVideoFormat_H264, MFVideoFormat_RGB32, MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION,
        MF_MT_AAC_PAYLOAD_TYPE, MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
        MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
        MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE,
        MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
        MF_MT_SUBTYPE, MF_VERSION, MFVideoInterlace_Progressive,
        MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    };

    pub struct MfRecorder {
        writer: IMFSinkWriter,
        video_stream: u32,
        audio_stream: Option<u32>,
        width: u32,
        height: u32,
        fps: u32,
        video_frames: u64,
        audio_frames: u64,
        sample_rate: u32,
        channels: u16,
        _mf: MfGuard,
    }

    struct MfGuard;

    impl MfGuard {
        fn start() -> Result<MfGuard, String> {
            unsafe {
                MFStartup(MF_VERSION, MFSTARTUP_FULL)
                    .map_err(|error| format!("Media Foundation startup failed: {error}"))?;
            }
            Ok(MfGuard)
        }
    }

    impl Drop for MfGuard {
        fn drop(&mut self) {
            unsafe {
                let _ = MFShutdown();
            }
        }
    }

    impl MfRecorder {
        pub fn create(
            path: &std::path::Path,
            width: u32,
            height: u32,
            fps: u32,
            audio: Option<(u32, u16)>,
        ) -> Result<MfRecorder, String> {
            if width < 2 || height < 2 || fps < 2 {
                return Err("invalid recorder dimensions".to_string());
            }
            let mf = MfGuard::start()?;
            unsafe {
                let mut attributes: Option<IMFAttributes> = None;
                MFCreateAttributes(&mut attributes, 2)
                    .map_err(|error| format!("Media Foundation attributes failed: {error}"))?;
                let attributes = attributes.ok_or_else(|| "no Media Foundation attributes".to_string())?;
                let _ = attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1);

                let wide: Vec<u16> = path
                    .as_os_str()
                    .encode_wide()
                    .chain(std::iter::once(0))
                    .collect();
                let writer = MFCreateSinkWriterFromURL(
                    PCWSTR(wide.as_ptr()),
                    None::<&windows::Win32::Media::MediaFoundation::IMFByteStream>,
                    Some(&attributes),
                )
                .map_err(|error| format!("Media Foundation writer failed: {error}"))?;

                let video_out = video_output_type(width, height, fps)?;
                let video_stream = writer
                    .AddStream(&video_out)
                    .map_err(|error| format!("H.264 stream failed: {error}"))?;
                let video_in = video_input_type(width, height, fps)?;
                writer
                    .SetInputMediaType(video_stream, &video_in, None)
                    .map_err(|error| format!("H.264 input type failed: {error}"))?;

                let (audio_stream, sample_rate, channels) = match audio {
                    Some((rate, channels)) if channels > 0 && rate > 0 => {
                        let audio_out = audio_output_type(rate, channels)?;
                        let stream = writer
                            .AddStream(&audio_out)
                            .map_err(|error| format!("AAC stream failed: {error}"))?;
                        let audio_in = audio_input_type(rate, channels)?;
                        writer
                            .SetInputMediaType(stream, &audio_in, None)
                            .map_err(|error| format!("AAC input type failed: {error}"))?;
                        (Some(stream), rate, channels)
                    }
                    _ => (None, 0, 0),
                };

                writer
                    .BeginWriting()
                    .map_err(|error| format!("Media Foundation begin failed: {error}"))?;
                Ok(MfRecorder {
                    writer,
                    video_stream,
                    audio_stream,
                    width,
                    height,
                    fps,
                    video_frames: 0,
                    audio_frames: 0,
                    sample_rate,
                    channels,
                    _mf: mf,
                })
            }
        }

        pub fn frames(&self) -> u64 {
            self.video_frames
        }

        /// One top-down BGRA frame.
        pub fn write_video(&mut self, bgra: &[u8]) -> Result<(), String> {
            let expected = self.width as usize * self.height as usize * 4;
            if bgra.len() < expected {
                return Err("short video frame".to_string());
            }
            let duration = 10_000_000i64 / self.fps.max(1) as i64;
            let time = self.video_frames as i64 * duration;
            unsafe {
                let buffer = MFCreateMemoryBuffer(expected as u32)
                    .map_err(|error| format!("video buffer failed: {error}"))?;
                let mut target: *mut u8 = std::ptr::null_mut();
                buffer
                    .Lock(&mut target, None, None)
                    .map_err(|error| format!("video lock failed: {error}"))?;
                std::ptr::copy_nonoverlapping(bgra.as_ptr(), target, expected);
                buffer
                    .SetCurrentLength(expected as u32)
                    .map_err(|error| format!("video length failed: {error}"))?;
                buffer
                    .Unlock()
                    .map_err(|error| format!("video unlock failed: {error}"))?;
                let sample = MFCreateSample().map_err(|error| format!("video sample failed: {error}"))?;
                sample
                    .AddBuffer(&buffer)
                    .map_err(|error| format!("video buffer attach failed: {error}"))?;
                sample
                    .SetSampleTime(time)
                    .map_err(|error| format!("video time failed: {error}"))?;
                sample
                    .SetSampleDuration(duration)
                    .map_err(|error| format!("video duration failed: {error}"))?;
                self.writer
                    .WriteSample(self.video_stream, &sample)
                    .map_err(|error| format!("video write failed: {error}"))?;
            }
            self.video_frames += 1;
            Ok(())
        }

        /// 16-bit stereo PCM from the loopback capture.
        pub fn write_audio(&mut self, samples: &[i16]) -> Result<(), String> {
            let Some(stream) = self.audio_stream else {
                return Ok(());
            };
            if samples.is_empty() || self.sample_rate == 0 {
                return Ok(());
            }
            let channels = self.channels.max(1) as usize;
            let frames = samples.len() / channels;
            if frames == 0 {
                return Ok(());
            }
            let duration = (frames as i64 * 10_000_000) / self.sample_rate as i64;
            let time = (self.audio_frames as i64 * 10_000_000) / self.sample_rate as i64;
            let bytes = unsafe {
                std::slice::from_raw_parts(
                    samples.as_ptr() as *const u8,
                    samples.len() * std::mem::size_of::<i16>(),
                )
            };
            unsafe {
                let buffer = MFCreateMemoryBuffer(bytes.len() as u32)
                    .map_err(|error| format!("audio buffer failed: {error}"))?;
                let mut target: *mut u8 = std::ptr::null_mut();
                buffer
                    .Lock(&mut target, None, None)
                    .map_err(|error| format!("audio lock failed: {error}"))?;
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), target, bytes.len());
                buffer
                    .SetCurrentLength(bytes.len() as u32)
                    .map_err(|error| format!("audio length failed: {error}"))?;
                buffer
                    .Unlock()
                    .map_err(|error| format!("audio unlock failed: {error}"))?;
                let sample = MFCreateSample().map_err(|error| format!("audio sample failed: {error}"))?;
                sample
                    .AddBuffer(&buffer)
                    .map_err(|error| format!("audio buffer attach failed: {error}"))?;
                sample
                    .SetSampleTime(time)
                    .map_err(|error| format!("audio time failed: {error}"))?;
                sample
                    .SetSampleDuration(duration)
                    .map_err(|error| format!("audio duration failed: {error}"))?;
                self.writer
                    .WriteSample(stream, &sample)
                    .map_err(|error| format!("audio write failed: {error}"))?;
            }
            self.audio_frames += frames as u64;
            Ok(())
        }

        pub fn finish(self) -> Result<(), String> {
            unsafe {
                self.writer
                    .Finalize()
                    .map_err(|error| format!("Media Foundation finalize failed: {error}"))
            }
        }
    }

    fn pack_size(width: u32, height: u32) -> u64 {
        ((width as u64) << 32) | height as u64
    }

    fn pack_rate(numerator: u32, denominator: u32) -> u64 {
        ((numerator as u64) << 32) | denominator as u64
    }

    unsafe fn video_output_type(width: u32, height: u32, fps: u32) -> Result<IMFMediaType, String> {
        let media = MFCreateMediaType().map_err(|error| error.to_string())?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
        media.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264).map_err(|e| e.to_string())?;
        let bitrate = ((width as u64 * height as u64 * fps as u64) / 10).clamp(6_000_000, 40_000_000) as u32;
        media.SetUINT32(&MF_MT_AVG_BITRATE, bitrate).map_err(|e| e.to_string())?;
        media.SetUINT64(&MF_MT_FRAME_SIZE, pack_size(width, height)).map_err(|e| e.to_string())?;
        media.SetUINT64(&MF_MT_FRAME_RATE, pack_rate(fps, 1)).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
        Ok(media)
    }

    unsafe fn video_input_type(width: u32, height: u32, fps: u32) -> Result<IMFMediaType, String> {
        let media = MFCreateMediaType().map_err(|error| error.to_string())?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video).map_err(|e| e.to_string())?;
        media.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32).map_err(|e| e.to_string())?;
        media.SetUINT64(&MF_MT_FRAME_SIZE, pack_size(width, height)).map_err(|e| e.to_string())?;
        media.SetUINT64(&MF_MT_FRAME_RATE, pack_rate(fps, 1)).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_DEFAULT_STRIDE, width * 4).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32).map_err(|e| e.to_string())?;
        Ok(media)
    }

    unsafe fn audio_output_type(rate: u32, channels: u16) -> Result<IMFMediaType, String> {
        let media = MFCreateMediaType().map_err(|error| error.to_string())?;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
        media.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels as u32).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 16_000).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AAC_PAYLOAD_TYPE, 0).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, 0x29).map_err(|e| e.to_string())?;
        Ok(media)
    }

    unsafe fn audio_input_type(rate: u32, channels: u16) -> Result<IMFMediaType, String> {
        let media = MFCreateMediaType().map_err(|error| error.to_string())?;
        let block = channels as u32 * 2;
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio).map_err(|e| e.to_string())?;
        media.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, channels as u32).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, rate).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, block).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, rate * block).map_err(|e| e.to_string())?;
        media.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1).map_err(|e| e.to_string())?;
        Ok(media)
    }
}

#[cfg(windows)]
pub use imp::MfRecorder;

#[cfg(not(windows))]
pub struct MfRecorder;

#[cfg(not(windows))]
impl MfRecorder {
    pub fn create(
        _path: &std::path::Path,
        _width: u32,
        _height: u32,
        _fps: u32,
        _audio: Option<(u32, u16)>,
    ) -> Result<MfRecorder, String> {
        Err("Media Foundation is Windows only".to_string())
    }
    pub fn frames(&self) -> u64 {
        0
    }
    pub fn write_video(&mut self, _bgra: &[u8]) -> Result<(), String> {
        Err("Media Foundation is Windows only".to_string())
    }
    pub fn write_audio(&mut self, _samples: &[i16]) -> Result<(), String> {
        Err("Media Foundation is Windows only".to_string())
    }
    pub fn finish(self) -> Result<(), String> {
        Err("Media Foundation is Windows only".to_string())
    }
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a real desktop, Desktop Duplication and a Media Foundation H.264 encoder"]
    fn records_the_desktop_to_an_h264_mp4() {
        let mut capture = crate::legendary::clip_dxgi::DxgiCapture::open().expect("dxgi");
        let (frame, width, height) = capture.frame_bgra().expect("first frame");
        let path = std::env::temp_dir().join(format!("efxlve-mf-desktop-{}.mp4", std::process::id()));
        let mut recorder = super::MfRecorder::create(&path, width, height, 60, Some((48_000, 2)))
            .expect("sink writer");
        let audio = vec![0i16; 800 * 2];
        for _ in 0..60 {
            recorder.write_video(&frame).expect("video frame");
            recorder.write_audio(&audio).expect("audio block");
        }
        recorder.finish().expect("finalize");
        let size = std::fs::metadata(&path).expect("mp4 exists").len();
        assert!(size > 1000, "encoded file is {size} bytes");
        let _ = std::fs::remove_file(path);
    }
}
