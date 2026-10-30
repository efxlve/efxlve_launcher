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
    use image::codecs::jpeg::JpegEncoder;
    use image::{ExtendedColorType, RgbImage};
    use windows::core::PCWSTR;
    use windows::Win32::Media::MediaFoundation::{
        IMFAttributes, IMFMediaType, IMFSinkWriter, IMFSourceReader, MFAudioFormat_AAC, MFAudioFormat_PCM,
        MFCreateAttributes, MFCreateMediaType, MFCreateMemoryBuffer, MFCreateSample,
        MFCreateSinkWriterFromURL, MFCreateSourceReaderFromURL, MFMediaType_Audio,
        MFMediaType_Video, MFSTARTUP_FULL, MFShutdown, MFStartup, MFVideoFormat_H264,
        MFVideoFormat_RGB32, MF_MT_AAC_AUDIO_PROFILE_LEVEL_INDICATION, MF_MT_AAC_PAYLOAD_TYPE,
        MF_MT_ALL_SAMPLES_INDEPENDENT, MF_MT_AUDIO_AVG_BYTES_PER_SECOND,
        MF_MT_AUDIO_BITS_PER_SAMPLE, MF_MT_AUDIO_BLOCK_ALIGNMENT, MF_MT_AUDIO_NUM_CHANNELS,
        MF_MT_AUDIO_SAMPLES_PER_SECOND, MF_MT_AVG_BITRATE, MF_MT_DEFAULT_STRIDE,
        MF_MT_FRAME_RATE, MF_MT_FRAME_SIZE, MF_MT_INTERLACE_MODE, MF_MT_MAJOR_TYPE,
        MF_MT_SUBTYPE, MF_PD_DURATION, MF_SOURCE_READERF_ENDOFSTREAM,
        MF_SOURCE_READER_ALL_STREAMS, MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,
        MF_SOURCE_READER_FIRST_AUDIO_STREAM, MF_SOURCE_READER_FIRST_VIDEO_STREAM,
        MF_SOURCE_READER_MEDIASOURCE, MF_VERSION, MFVideoInterlace_Progressive,
        MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS,
    };
    use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
    use windows::Win32::System::Variant::VT_I8;

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

        /// One top-down BGRA frame at the recorder's fixed frame rate.
        pub fn write_video(&mut self, bgra: &[u8]) -> Result<(), String> {
            let duration = 10_000_000i64 / self.fps.max(1) as i64;
            let time = self.video_frames as i64 * duration;
            self.write_video_at(bgra, time, duration)
        }

        /// One top-down BGRA frame with an explicit timestamp, used by trim/join.
        pub fn write_video_at(&mut self, bgra: &[u8], time: i64, duration: i64) -> Result<(), String> {
            let expected = self.width as usize * self.height as usize * 4;
            if bgra.len() < expected {
                return Err("short video frame".to_string());
            }
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
                    .SetSampleDuration(duration.max(1))
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
            if self.audio_stream.is_none() || samples.is_empty() || self.sample_rate == 0 {
                return Ok(());
            }
            let channels = self.channels.max(1) as usize;
            let frames = samples.len() / channels;
            if frames == 0 {
                return Ok(());
            }
            let duration = (frames as i64 * 10_000_000) / self.sample_rate as i64;
            let time = (self.audio_frames as i64 * 10_000_000) / self.sample_rate as i64;
            self.write_audio_at(samples, time, duration)
        }

        /// One PCM block with an explicit timestamp, used by trim/join.
        pub fn write_audio_at(&mut self, samples: &[i16], time: i64, duration: i64) -> Result<(), String> {
            let Some(stream) = self.audio_stream else {
                return Ok(());
            };
            if samples.is_empty() {
                return Ok(());
            }
            let channels = self.channels.max(1) as usize;
            let frames = samples.len() / channels;
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
                    .SetSampleDuration(duration.max(1))
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

    fn open_reader(path: &std::path::Path) -> Option<(IMFSourceReader, MfGuard)> {
        unsafe {
            let mf = MfGuard::start().ok()?;
            let mut attributes: Option<IMFAttributes> = None;
            MFCreateAttributes(&mut attributes, 1).ok()?;
            let attributes = attributes?;
            attributes
                .SetUINT32(&MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING, 1)
                .ok()?;
            let wide: Vec<u16> = path
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect();
            let reader = MFCreateSourceReaderFromURL(PCWSTR(wide.as_ptr()), Some(&attributes)).ok()?;
            Some((reader, mf))
        }
    }

    /// Reads one video frame from an MP4 and returns it as JPEG. `seconds` is
    /// clamped by the source reader; a zero asks for the first frame.
    pub fn frame_jpeg(path: &std::path::Path, seconds: f64) -> Option<Vec<u8>> {
        unsafe {
            let (reader, _mf) = match open_reader(path) {
                Some(reader) => reader,
                None => {
                    eprintln!("mf: open_reader failed");
                    return None;
                }
            };
            let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
            if reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false).is_err() {
                eprintln!("mf: deselect failed");
                return None;
            }
            if reader.SetStreamSelection(stream, true).is_err() {
                eprintln!("mf: select failed");
                return None;
            }
            let media = match MFCreateMediaType() {
                Ok(media) => media,
                Err(error) => {
                    eprintln!("mf: type failed {error}");
                    return None;
                }
            };
            let _ = media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video);
            let _ = media.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_RGB32);
            if let Err(error) = reader.SetCurrentMediaType(stream, None, &media) {
                eprintln!("mf: set output type failed {error}");
                return None;
            }
            if seconds > 0.0 {
                let mut position = PROPVARIANT::default();
                let inner = &mut *position.Anonymous.Anonymous;
                std::ptr::write(&mut inner.vt, VT_I8);
                std::ptr::write(&mut inner.Anonymous.hVal, (seconds * 10_000_000.0) as i64);
                let _ = reader.SetCurrentPosition(&windows::core::GUID::zeroed(), &position);
            }
            let mut sample = None;
            for _ in 0..240 {
                let mut flags = 0u32;
                if let Err(error) = reader.ReadSample(stream, 0, None, Some(&mut flags), None, Some(&mut sample)) {
                    eprintln!("mf: read failed {error}");
                    return None;
                }
                if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                    eprintln!("mf: end of stream");
                    return None;
                }
                if sample.is_some() {
                    break;
                }
            }
            let sample = match sample {
                Some(sample) => sample,
                None => {
                    eprintln!("mf: no sample");
                    return None;
                }
            };
            let buffer = match sample.ConvertToContiguousBuffer() {
                Ok(buffer) => buffer,
                Err(error) => {
                    eprintln!("mf: contiguous failed {error}");
                    return None;
                }
            };
            let media = match reader.GetCurrentMediaType(stream) {
                Ok(media) => media,
                Err(error) => {
                    eprintln!("mf: current type failed {error}");
                    return None;
                }
            };
            let packed = media.GetUINT64(&MF_MT_FRAME_SIZE).ok()?;
            let width = (packed >> 32) as u32;
            let height = packed as u32;
            if width < 2 || height < 2 {
                return None;
            }
            let mut pointer: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut pointer, None, None).ok()?;
            let source = std::slice::from_raw_parts(pointer, width as usize * height as usize * 4);
            let mut rgb = RgbImage::new(width, height);
            for (pixel, bgra) in rgb.pixels_mut().zip(source.chunks_exact(4)) {
                *pixel = image::Rgb([bgra[2], bgra[1], bgra[0]]);
            }
            let _ = buffer.Unlock();
            let mut jpeg = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut jpeg, 82);
            encoder
                .encode(rgb.as_raw(), width, height, ExtendedColorType::Rgb8)
                .ok()?;
            Some(jpeg)
        }
    }

    /// MP4 duration from the media source presentation attribute, rounded up.
    pub fn duration_secs(path: &std::path::Path) -> Option<u64> {
        unsafe {
            let (reader, _mf) = open_reader(path)?;
            let value = reader
                .GetPresentationAttribute(MF_SOURCE_READER_MEDIASOURCE.0 as u32, &MF_PD_DURATION)
                .ok()?;
            let hundred_ns = value.Anonymous.Anonymous.Anonymous.uhVal;
            if hundred_ns == 0 {
                None
            } else {
                Some((hundred_ns + 9_999_999) / 10_000_000)
            }
        }
    }

    struct MediaInfo {
        width: u32,
        height: u32,
        fps: u32,
        audio: Option<(u32, u16)>,
    }

    fn media_info(path: &std::path::Path) -> Result<MediaInfo, String> {
        let (reader, _mf) = open_reader(path).ok_or_else(|| "MP4 could not be opened".to_string())?;
        unsafe {
            let video_stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
            let audio_stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
            let _ = reader.SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false);
            reader
                .SetStreamSelection(video_stream, true)
                .map_err(|error| error.to_string())?;
            let video = reader
                .GetNativeMediaType(video_stream, 0)
                .map_err(|error| error.to_string())?;
            let packed = video.GetUINT64(&MF_MT_FRAME_SIZE).map_err(|e| e.to_string())?;
            let rate = video.GetUINT64(&MF_MT_FRAME_RATE).unwrap_or((30u64 << 32) | 1);
            let width = (packed >> 32) as u32;
            let height = packed as u32;
            let fps = ((rate >> 32) as u32 / (rate as u32).max(1)).max(1);
            let audio = if reader.SetStreamSelection(audio_stream, true).is_ok() {
                reader.GetNativeMediaType(audio_stream, 0).ok().and_then(|media| {
                    let rate = media.GetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND).ok()?;
                    let channels = media.GetUINT32(&MF_MT_AUDIO_NUM_CHANNELS).ok()?;
                    Some((rate, channels as u16))
                })
            } else {
                None
            };
            if width < 2 || height < 2 {
                return Err("MP4 has no video size".to_string());
            }
            Ok(MediaInfo { width, height, fps, audio })
        }
    }

    unsafe fn configure_video(reader: &IMFSourceReader, info: &MediaInfo) -> Result<(), String> {
        let stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .map_err(|e| e.to_string())?;
        reader
            .SetStreamSelection(stream, true)
            .map_err(|e| e.to_string())?;
        let media = video_input_type(info.width, info.height, info.fps)?;
        reader
            .SetCurrentMediaType(stream, None, &media)
            .map_err(|e| e.to_string())
    }

    unsafe fn configure_audio(reader: &IMFSourceReader, info: &MediaInfo) -> Result<(), String> {
        let stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        let (rate, channels) = info.audio.ok_or_else(|| "no audio stream".to_string())?;
        reader
            .SetStreamSelection(MF_SOURCE_READER_ALL_STREAMS.0 as u32, false)
            .map_err(|e| e.to_string())?;
        reader
            .SetStreamSelection(stream, true)
            .map_err(|e| e.to_string())?;
        let media = audio_input_type(rate, channels)?;
        reader
            .SetCurrentMediaType(stream, None, &media)
            .map_err(|e| e.to_string())
    }

    unsafe fn seek(reader: &IMFSourceReader, time: i64) {
        let mut position = PROPVARIANT::default();
        let inner = &mut *position.Anonymous.Anonymous;
        std::ptr::write(&mut inner.vt, VT_I8);
        std::ptr::write(&mut inner.Anonymous.hVal, time.max(0));
        let _ = reader.SetCurrentPosition(&windows::core::GUID::zeroed(), &position);
    }

    unsafe fn read_audio(
        reader: &IMFSourceReader,
        start: i64,
        end: i64,
    ) -> Result<Vec<(i64, i64, Vec<i16>)>, String> {
        let stream = MF_SOURCE_READER_FIRST_AUDIO_STREAM.0 as u32;
        let mut out = Vec::new();
        loop {
            let mut flags = 0u32;
            let mut timestamp = 0i64;
            let mut sample = None;
            reader
                .ReadSample(stream, 0, None, Some(&mut flags), Some(&mut timestamp), Some(&mut sample))
                .map_err(|e| e.to_string())?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
            let Some(sample) = sample else { continue };
            if timestamp > end {
                break;
            }
            if timestamp < start {
                continue;
            }
            let duration = sample.GetSampleDuration().unwrap_or(1).max(1);
            let buffer = sample.ConvertToContiguousBuffer().map_err(|e| e.to_string())?;
            let mut pointer: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut pointer, None, None).map_err(|e| e.to_string())?;
            let bytes = buffer.GetCurrentLength().unwrap_or(0) as usize;
            let samples = std::slice::from_raw_parts(
                pointer as *const i16,
                bytes / std::mem::size_of::<i16>(),
            )
            .to_vec();
            let _ = buffer.Unlock();
            out.push((timestamp, duration, samples));
        }
        Ok(out)
    }

    /// Copies one source range into an open recorder at `offset`; returns the
    /// last video timestamp written, relative to the source.
    unsafe fn copy_range(
        source: &std::path::Path,
        recorder: &mut MfRecorder,
        info: &MediaInfo,
        start: i64,
        end: i64,
        offset: i64,
    ) -> Result<i64, String> {
        let (video_reader, _video_mf) =
            open_reader(source).ok_or_else(|| "MP4 could not be opened".to_string())?;
        configure_video(&video_reader, info)?;
        seek(&video_reader, start);
        let audio = if info.audio.is_some() {
            let (audio_reader, _audio_mf) =
                open_reader(source).ok_or_else(|| "MP4 audio could not be opened".to_string())?;
            configure_audio(&audio_reader, info)?;
            seek(&audio_reader, start);
            read_audio(&audio_reader, start, end)?
        } else {
            Vec::new()
        };
        let video_stream = MF_SOURCE_READER_FIRST_VIDEO_STREAM.0 as u32;
        let mut audio_at = 0usize;
        let mut last = 0i64;
        loop {
            let mut flags = 0u32;
            let mut timestamp = 0i64;
            let mut sample = None;
            video_reader
                .ReadSample(video_stream, 0, None, Some(&mut flags), Some(&mut timestamp), Some(&mut sample))
                .map_err(|e| e.to_string())?;
            if flags & MF_SOURCE_READERF_ENDOFSTREAM.0 as u32 != 0 {
                break;
            }
            let Some(sample) = sample else { continue };
            if timestamp > end {
                break;
            }
            if timestamp < start {
                continue;
            }
            let relative = timestamp - start;
            while audio_at < audio.len() && audio[audio_at].0 - start <= relative {
                let (time, duration, samples) = &audio[audio_at];
                recorder.write_audio_at(samples, time - start + offset, *duration)?;
                audio_at += 1;
            }
            let duration = sample
                .GetSampleDuration()
                .unwrap_or(10_000_000 / info.fps.max(1) as i64)
                .max(1);
            let buffer = sample.ConvertToContiguousBuffer().map_err(|e| e.to_string())?;
            let mut pointer: *mut u8 = std::ptr::null_mut();
            buffer.Lock(&mut pointer, None, None).map_err(|e| e.to_string())?;
            let bgra = std::slice::from_raw_parts(
                pointer,
                info.width as usize * info.height as usize * 4,
            );
            recorder.write_video_at(bgra, relative + offset, duration)?;
            let _ = buffer.Unlock();
            last = relative + duration;
        }
        while audio_at < audio.len() {
            let (time, duration, samples) = &audio[audio_at];
            recorder.write_audio_at(samples, time - start + offset, *duration)?;
            audio_at += 1;
        }
        Ok(last)
    }

    /// Re-encodes `[start, end)` into a new MP4.
    pub fn trim(
        source: &std::path::Path,
        target: &std::path::Path,
        start: f64,
        end: f64,
    ) -> Result<(), String> {
        if end <= start {
            return Err("empty trim".to_string());
        }
        let info = media_info(source)?;
        let mut recorder = MfRecorder::create(target, info.width, info.height, info.fps, info.audio)?;
        unsafe {
            let start_100 = (start.max(0.0) * 10_000_000.0) as i64;
            let end_100 = (end * 10_000_000.0) as i64;
            copy_range(source, &mut recorder, &info, start_100, end_100, 0)?;
        }
        recorder.finish()
    }

    /// Re-encodes the sources one after another into a new MP4.
    pub fn join(sources: &[std::path::PathBuf], target: &std::path::Path) -> Result<(), String> {
        if sources.len() < 2 {
            return Err("need two clips".to_string());
        }
        let info = media_info(&sources[0])?;
        let mut recorder = MfRecorder::create(target, info.width, info.height, info.fps, info.audio)?;
        let mut offset = 0i64;
        for source in sources {
            let source_info = media_info(source)?;
            if source_info.width != info.width
                || source_info.height != info.height
                || source_info.fps != info.fps
            {
                return Err("clips have different video settings".to_string());
            }
            let written = unsafe {
                copy_range(source, &mut recorder, &info, 0, i64::MAX, offset)?
            };
            offset += written.max(1);
        }
        recorder.finish()
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
pub use imp::{duration_secs, frame_jpeg, join, trim, MfRecorder};

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

#[cfg(not(windows))]
pub fn frame_jpeg(_path: &std::path::Path, _seconds: f64) -> Option<Vec<u8>> {
    None
}

#[cfg(not(windows))]
pub fn duration_secs(_path: &std::path::Path) -> Option<u64> {
    None
}

#[cfg(not(windows))]
pub fn trim(
    _source: &std::path::Path,
    _target: &std::path::Path,
    _start: f64,
    _end: f64,
) -> Result<(), String> {
    Err("Media Foundation is Windows only".to_string())
}

#[cfg(not(windows))]
pub fn join(_sources: &[std::path::PathBuf], _target: &std::path::Path) -> Result<(), String> {
    Err("Media Foundation is Windows only".to_string())
}

#[cfg(test)]
mod tests {
    #[cfg(windows)]
    #[test]
    #[ignore = "needs a Media Foundation H.264 encoder and writes real MP4s"]
    fn joins_two_mp4s_into_a_new_file() {
        let one = std::env::temp_dir().join(format!("efxlve-mf-join-a-{}.mp4", std::process::id()));
        let two = std::env::temp_dir().join(format!("efxlve-mf-join-b-{}.mp4", std::process::id()));
        let target = std::env::temp_dir().join(format!("efxlve-mf-join-out-{}.mp4", std::process::id()));
        let mut frame = vec![0u8; 320 * 180 * 4];
        for (index, pixel) in frame.chunks_exact_mut(4).enumerate() {
            let value = (index % 255) as u8;
            pixel.copy_from_slice(&[value, value / 2, 255 - value, 255]);
        }
        for path in [&one, &two] {
            let mut recorder = super::MfRecorder::create(path, 320, 180, 30, None).expect("writer");
            for _ in 0..30 {
                recorder.write_video(&frame).expect("frame");
            }
            recorder.finish().expect("finalize");
        }
        super::join(&[one.clone(), two.clone()], &target).expect("join");
        let size = std::fs::metadata(&target).expect("joined file").len();
        assert!(size > 1000, "joined file is {size} bytes");
        assert!(super::duration_secs(&target).unwrap_or(0) >= 1);
        for path in [one, two, target] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a Media Foundation H.264 encoder and writes a real MP4"]
    fn trims_an_mp4_into_a_new_file() {
        let source = std::env::temp_dir().join(format!("efxlve-mf-trim-src-{}.mp4", std::process::id()));
        let target = std::env::temp_dir().join(format!("efxlve-mf-trim-out-{}.mp4", std::process::id()));
        let mut recorder = super::MfRecorder::create(&source, 320, 180, 60, Some((48_000, 2))).expect("writer");
        let mut frame = vec![0u8; 320 * 180 * 4];
        for (index, pixel) in frame.chunks_exact_mut(4).enumerate() {
            let value = (index % 255) as u8;
            pixel.copy_from_slice(&[value, value / 2, 255 - value, 255]);
        }
        let audio = vec![0i16; 800 * 2];
        for _ in 0..120 {
            recorder.write_video(&frame).expect("frame");
            recorder.write_audio(&audio).expect("audio");
        }
        recorder.finish().expect("finalize");
        super::trim(&source, &target, 0.2, 0.8).expect("trim");
        let size = std::fs::metadata(&target).expect("trimmed file").len();
        assert!(size > 1000, "trimmed file is {size} bytes");
        assert!(super::frame_jpeg(&target, 0.0).is_some());
        let _ = std::fs::remove_file(source);
        let _ = std::fs::remove_file(target);
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "needs a Media Foundation H.264 encoder and writes a real MP4"]
    fn reads_a_frame_and_duration_back_from_an_mp4() {
        let path = std::env::temp_dir().join(format!("efxlve-mf-read-{}.mp4", std::process::id()));
        let mut recorder = super::MfRecorder::create(&path, 320, 180, 30, None).expect("writer");
        let mut frame = vec![0u8; 320 * 180 * 4];
        for (index, pixel) in frame.chunks_exact_mut(4).enumerate() {
            let value = (index % 255) as u8;
            pixel.copy_from_slice(&[value, value / 2, 255 - value, 255]);
        }
        for _ in 0..30 {
            recorder.write_video(&frame).expect("frame");
        }
        recorder.finish().expect("finalize");
        let jpeg = super::frame_jpeg(&path, 0.5).expect("frame at 0.5 s");
        assert!(jpeg.len() > 100 && jpeg[0] == 0xFF && jpeg[1] == 0xD8);
        let seconds = super::duration_secs(&path).expect("duration");
        assert!(seconds >= 1, "duration is {seconds}");
        let _ = std::fs::remove_file(path);
    }
}
