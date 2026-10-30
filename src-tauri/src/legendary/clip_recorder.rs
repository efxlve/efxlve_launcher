//! Game clip recorder: MJPEG inside an AVI container.
//!
//! A lightweight recorder that needs no extra binary and no codec licence: the
//! screen is grabbed at N frames per second, every frame is JPEG-encoded by
//! GDI+ (the same encoder the screenshots already use) and the frames are
//! appended to a plain AVI file. Players — including Windows' own — open MJPEG
//! AVI natively, and the format is simple enough to write by hand.
//!
//! The recorder runs on its own thread while a game is in the foreground and
//! stops on the hotkey, on the maximum duration, or when the game exits.
//!
//! Sound comes from the default output device through WASAPI loopback
//! (`clip_audio`) and is written into the same file as 16-bit PCM, interleaved
//! between the frames.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

use crate::legendary::clip_audio::AudioInfo;

/// Default cap: a clip stops by itself here so a forgotten recording cannot
/// fill the disk (12 fps × ~300 KB ≈ 3.5 MB/s, 5 minutes ≈ 1 GB).
pub const DEFAULT_MAX_SECS: u64 = 300;

static RUNNING: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static FPS: AtomicU32 = AtomicU32::new(30);
static QUALITY: AtomicU32 = AtomicU32::new(80);
static MAX_SECS: AtomicU32 = AtomicU32::new(DEFAULT_MAX_SECS as u32);
/// Frame height; 0 keeps the screen's own size.
static HEIGHT: AtomicU32 = AtomicU32::new(0);
static CLIP_HOTKEY: AtomicU32 = AtomicU32::new(0x78); // VK_F9
static STARTED_AT: Mutex<Option<Instant>> = Mutex::new(None);
static TARGET: Mutex<Option<PathBuf>> = Mutex::new(None);
static FRAMES: AtomicU32 = AtomicU32::new(0);
static LAST_ERROR: Mutex<Option<String>> = Mutex::new(None);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipStatus {
    pub running: bool,
    pub seconds: u64,
    pub frames: u32,
    pub fps: u32,
    pub path: String,
    pub error: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipItem {
    pub path: String,
    pub name: String,
    pub size_bytes: u64,
    pub date_str: String,
    /// Seconds, parsed back out of the AVI header.
    pub seconds: u64,
}

pub fn running() -> bool {
    RUNNING.load(Ordering::SeqCst)
}

pub fn set_hotkey(vkey: u32) {
    CLIP_HOTKEY.store(vkey, Ordering::SeqCst);
}

pub fn hotkey() -> u32 {
    CLIP_HOTKEY.load(Ordering::SeqCst)
}

/// The clips folder for a game, under the user's Videos directory.
fn clip_dir(title: &str) -> PathBuf {
    let clean = if title.trim().is_empty() {
        "Unknown".to_string()
    } else {
        crate::legendary::screenshots::clean_folder_name(title)
    };
    crate::legendary::screenshots::get_user_videos_dir()
        .join("Efxlve")
        .join(clean)
}

/* ---------- AVI writing ---------- */

/// Little-endian helpers: the container is a sequence of tagged chunks.
fn fourcc(text: &[u8; 4]) -> [u8; 4] {
    *text
}

/// The largest clip the container can describe: every size field in an AVI is
/// 32-bit, so a file past 4 GB gets a wrapped RIFF header and players stop
/// reading it where the number went wrong. The cap leaves room for the index.
///
/// It is reachable: at quality 80 a 720p frame measures 83 KB, so 30 fps is
/// about 2.4 MB/s — 0.7 GB for the default five minutes. Scale that by pixels
/// and 1440p lands at 2.9 GB and 4K at 6.6 GB, which is where the header would
/// have wrapped.
const MAX_CLIP_BYTES: u64 = 3_500_000_000;

/// The largest chunk a reader will believe. Real MJPEG frames and audio blocks
/// are far below this, so anything bigger is a corrupt size field — and one that
/// was trusted would become a multi-gigabyte allocation.
const MAX_CHUNK_BYTES: usize = 64 * 1024 * 1024;

struct AviWriter {
    file: File,
    frames: u32,
    /// One entry per chunk: offset from the start of movi, length, chunk tag.
    index: Vec<(u32, u32, [u8; 4])>,
    frame_bytes: u32,
    /// Everything written so far, header included: what the RIFF size will be.
    bytes: u64,
    movi_start: u64,
    /// Audio block size; 0 means the file has no audio stream.
    audio_block_align: u16,
    audio_bytes: u64,
    /// Where the header fields that are only known at the end live. With a
    /// second stream every later offset shifts, so they are recorded while
    /// writing the header instead of being recomputed from the layout.
    avih_at: u64,
    video_strh_at: u64,
    audio_length_at: Option<u64>,
}

/// Where the next chunk written into LIST hdrl lands in the file: the RIFF
/// header (12 bytes) plus the LIST tag, size and type (12 bytes), plus
/// everything already built.
fn hdrl_payload_at(hdrl: &[u8]) -> u64 {
    24 + hdrl.len() as u64
}

impl AviWriter {
    /// Writes the headers with placeholder sizes; they are patched on finish.
    /// `audio` adds a PCM stream, which is what gives a clip its sound.
    fn create(
        path: &Path,
        width: u32,
        height: u32,
        fps: u32,
        audio: Option<AudioInfo>,
    ) -> std::io::Result<Self> {
        let mut file = File::create(path)?;
        let micros = 1_000_000 / fps.max(1);

        // RIFF header (size patched later).
        file.write_all(b"RIFF")?;
        file.write_all(&0u32.to_le_bytes())?;
        file.write_all(b"AVI ")?;

        // LIST hdrl
        let mut hdrl: Vec<u8> = Vec::new();
        // avih: main header, 56 bytes.
        let mut avih: Vec<u8> = Vec::new();
        avih.extend_from_slice(&micros.to_le_bytes());
        avih.extend_from_slice(&0u32.to_le_bytes()); // dwMaxBytesPerSec
        avih.extend_from_slice(&0u32.to_le_bytes()); // dwPaddingGranularity
        avih.extend_from_slice(&0x0000_0010u32.to_le_bytes()); // AVIF_HASINDEX
        avih.extend_from_slice(&0u32.to_le_bytes()); // dwTotalFrames (patched)
        avih.extend_from_slice(&0u32.to_le_bytes()); // dwInitialFrames
        avih.extend_from_slice(&(if audio.is_some() { 2u32 } else { 1u32 }).to_le_bytes()); // dwStreams
        avih.extend_from_slice(&0u32.to_le_bytes()); // dwSuggestedBufferSize
        avih.extend_from_slice(&width.to_le_bytes());
        avih.extend_from_slice(&height.to_le_bytes());
        avih.extend_from_slice(&[0u8; 16]); // reserved
        // avih's payload sits 8 bytes into the hdrl payload.
        let avih_at = hdrl_payload_at(&hdrl) + 8;
        write_chunk(&mut hdrl, b"avih", &avih);

        // LIST strl { strh, strf }
        let mut strh: Vec<u8> = Vec::new();
        strh.extend_from_slice(&fourcc(b"vids"));
        strh.extend_from_slice(&fourcc(b"MJPG"));
        strh.extend_from_slice(&0u32.to_le_bytes()); // dwFlags
        strh.extend_from_slice(&0u16.to_le_bytes()); // wPriority
        strh.extend_from_slice(&0u16.to_le_bytes()); // wLanguage
        strh.extend_from_slice(&0u32.to_le_bytes()); // dwInitialFrames
        strh.extend_from_slice(&1u32.to_le_bytes()); // dwScale
        strh.extend_from_slice(&fps.max(1).to_le_bytes()); // dwRate
        strh.extend_from_slice(&0u32.to_le_bytes()); // dwStart
        strh.extend_from_slice(&0u32.to_le_bytes()); // dwLength (patched)
        strh.extend_from_slice(&0u32.to_le_bytes()); // dwSuggestedBufferSize
        strh.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // dwQuality = -1
        strh.extend_from_slice(&0u32.to_le_bytes()); // dwSampleSize
        strh.extend_from_slice(&0i16.to_le_bytes()); // rcFrame.left
        strh.extend_from_slice(&0i16.to_le_bytes()); // rcFrame.top
        strh.extend_from_slice(&(width as i16).to_le_bytes());
        strh.extend_from_slice(&(height as i16).to_le_bytes());

        let mut strf: Vec<u8> = Vec::new();
        strf.extend_from_slice(&40u32.to_le_bytes()); // biSize
        strf.extend_from_slice(&width.to_le_bytes());
        strf.extend_from_slice(&height.to_le_bytes());
        strf.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
        strf.extend_from_slice(&24u16.to_le_bytes()); // biBitCount
        strf.extend_from_slice(&fourcc(b"MJPG")); // biCompression
        strf.extend_from_slice(&(width * height * 3).to_le_bytes()); // biSizeImage
        strf.extend_from_slice(&0u32.to_le_bytes());
        strf.extend_from_slice(&0u32.to_le_bytes());
        strf.extend_from_slice(&0u32.to_le_bytes());
        strf.extend_from_slice(&0u32.to_le_bytes());

        let mut strl: Vec<u8> = Vec::new();
        write_chunk(&mut strl, b"strh", &strh);
        write_chunk(&mut strl, b"strf", &strf);
        // strh's payload sits 12 (LIST header) + 8 (chunk header) bytes into the
        // strl list.
        let video_strh_at = hdrl_payload_at(&hdrl) + 12 + 8;
        write_list(&mut hdrl, b"strl", &strl)?;

        let audio_length_at = match audio {
            Some(info) => {
                // Audio stream: 16-bit PCM at the device's own mix format.
                let mut astrh: Vec<u8> = Vec::new();
                astrh.extend_from_slice(&fourcc(b"auds"));
                astrh.extend_from_slice(&0u32.to_le_bytes()); // fccHandler
                astrh.extend_from_slice(&0u32.to_le_bytes()); // dwFlags
                astrh.extend_from_slice(&0u16.to_le_bytes()); // wPriority
                astrh.extend_from_slice(&0u16.to_le_bytes()); // wLanguage
                astrh.extend_from_slice(&0u32.to_le_bytes()); // dwInitialFrames
                // For PCM, dwScale is one block and dwRate the bytes per second,
                // so dwRate / dwScale comes out as the sample rate.
                astrh.extend_from_slice(&u32::from(info.block_align()).to_le_bytes()); // dwScale
                astrh.extend_from_slice(&info.bytes_per_second().to_le_bytes()); // dwRate
                astrh.extend_from_slice(&0u32.to_le_bytes()); // dwStart
                astrh.extend_from_slice(&0u32.to_le_bytes()); // dwLength (patched)
                astrh.extend_from_slice(&info.bytes_per_second().to_le_bytes()); // dwSuggestedBufferSize
                astrh.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // dwQuality = -1
                astrh.extend_from_slice(&u32::from(info.block_align()).to_le_bytes()); // dwSampleSize
                astrh.extend_from_slice(&[0u8; 8]); // rcFrame

                // The audio strf is a WAVEFORMATEX, 18 bytes.
                let mut astrf: Vec<u8> = Vec::new();
                astrf.extend_from_slice(&1u16.to_le_bytes()); // WAVE_FORMAT_PCM
                astrf.extend_from_slice(&info.channels.to_le_bytes());
                astrf.extend_from_slice(&info.sample_rate.to_le_bytes());
                astrf.extend_from_slice(&info.bytes_per_second().to_le_bytes());
                astrf.extend_from_slice(&info.block_align().to_le_bytes());
                astrf.extend_from_slice(&16u16.to_le_bytes()); // wBitsPerSample
                astrf.extend_from_slice(&0u16.to_le_bytes()); // cbSize

                let mut strl: Vec<u8> = Vec::new();
                write_chunk(&mut strl, b"strh", &astrh);
                write_chunk(&mut strl, b"strf", &astrf);
                let at = hdrl_payload_at(&hdrl) + 12 + 8 + 32;
                write_list(&mut hdrl, b"strl", &strl)?;
                Some(at)
            }
            None => None,
        };

        write_list(&mut file, b"hdrl", &hdrl)?;

        // LIST movi (size patched later); the frame data follows it.
        file.write_all(b"LIST")?;
        file.write_all(&0u32.to_le_bytes())?;
        file.write_all(b"movi")?;
        let movi_start = file.stream_position()?;

        Ok(Self {
            file,
            frames: 0,
            index: Vec::new(),
            frame_bytes: 0,
            bytes: movi_start,
            movi_start,
            audio_block_align: audio.map(|info| info.block_align()).unwrap_or(0),
            audio_bytes: 0,
            avih_at,
            video_strh_at,
            audio_length_at,
        })
    }

    fn add_frame(&mut self, jpeg: &[u8]) -> std::io::Result<()> {
        let offset = self.file.stream_position()?;
        self.file.write_all(b"00dc")?;
        self.file.write_all(&(jpeg.len() as u32).to_le_bytes())?;
        self.file.write_all(jpeg)?;
        // Chunks are word-aligned.
        if jpeg.len() % 2 == 1 {
            self.file.write_all(&[0u8])?;
        }
        self.index.push(((offset - self.movi_start) as u32, jpeg.len() as u32, *b"00dc"));
        self.frames += 1;
        self.frame_bytes = self.frame_bytes.max(jpeg.len() as u32);
        // Chunk header, payload, padding.
        self.bytes += 8 + jpeg.len() as u64 + (jpeg.len() % 2) as u64;
        Ok(())
    }

    /// Everything in the file so far, header included.
    fn bytes(&self) -> u64 {
        self.bytes
    }

    /// Appends the sound captured since the last frame. AVI players want the two
    /// streams interleaved, not one after the other, so this runs between frames
    /// rather than in one go at the end. A video-only file ignores it.
    fn add_audio(&mut self, samples: &[i16]) -> std::io::Result<()> {
        let mut payload = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            payload.extend_from_slice(&sample.to_le_bytes());
        }
        self.add_audio_bytes(&payload)
    }

    /// The same, for PCM that is already in bytes: trimming copies the original
    /// audio chunks instead of converting them again.
    fn add_audio_bytes(&mut self, payload: &[u8]) -> std::io::Result<()> {
        if self.audio_block_align == 0 || payload.is_empty() {
            return Ok(());
        }
        let offset = self.file.stream_position()?;
        self.file.write_all(b"01wb")?;
        self.file.write_all(&(payload.len() as u32).to_le_bytes())?;
        self.file.write_all(payload)?;
        if payload.len() % 2 == 1 {
            self.file.write_all(&[0u8])?;
        }
        self.index
            .push(((offset - self.movi_start) as u32, payload.len() as u32, *b"01wb"));
        self.audio_bytes += payload.len() as u64;
        self.bytes += 8 + payload.len() as u64 + (payload.len() % 2) as u64;
        Ok(())
    }

    /// Patches the sizes and appends the index, leaving a playable file.
    ///
    /// `elapsed` is how long the recording actually ran. The rate written into
    /// the header is the measured one, not the requested one: a machine that can
    /// only grab 16 frames a second while 30 are asked for would otherwise write
    /// a picture that runs at nearly twice real speed, and every player then
    /// drifts away from the sound and clicks trying to catch up.
    fn finish(self, fps: u32, elapsed: Duration) -> std::io::Result<()> {
        let seconds = elapsed.as_secs_f64();
        let micros = if self.frames > 0 && seconds > 0.0 {
            ((seconds * 1_000_000.0) / f64::from(self.frames)).round().max(1.0) as u32
        } else {
            1_000_000 / fps.max(1)
        };
        self.finish_at(fps, micros)
    }

    /// The same, with the frame duration given: a trim copies the source's own
    /// rate instead of measuring a recording that already happened.
    fn finish_at(mut self, fps: u32, micros: u32) -> std::io::Result<()> {
        let index_start = self.file.stream_position()?;
        self.file.write_all(b"idx1")?;
        self.file.write_all(&((self.index.len() * 16) as u32).to_le_bytes())?;
        for (offset, length, tag) in &self.index {
            self.file.write_all(tag)?;
            self.file.write_all(&0x0000_0010u32.to_le_bytes())?; // AVIIF_KEYFRAME
            self.file.write_all(&offset.to_le_bytes())?;
            self.file.write_all(&length.to_le_bytes())?;
        }
        let index_size = self.file.stream_position()? - index_start;

        let movi_size = index_start - self.movi_start;
        // The LIST size field sits 8 bytes before the payload start: [LIST][size][movi].
        // Like every other list, the size counts the 4-byte type as well.
        self.file.seek(SeekFrom::Start(self.movi_start - 8))?;
        self.file.write_all(&((movi_size + 4) as u32).to_le_bytes())?;

        // avih: the frame duration and the frame count.
        self.file.seek(SeekFrom::Start(self.avih_at))?;
        self.file.write_all(&micros.to_le_bytes())?;
        self.file.seek(SeekFrom::Start(self.avih_at + 16))?;
        self.file.write_all(&self.frames.to_le_bytes())?;
        // Video strh: dwScale is one frame and dwRate a second, so a player
        // computes dwLength * dwScale / dwRate and lands on the real duration.
        self.file.seek(SeekFrom::Start(self.video_strh_at + 20))?;
        self.file.write_all(&micros.to_le_bytes())?; // dwScale
        self.file.write_all(&1_000_000u32.to_le_bytes())?; // dwRate
        self.file.seek(SeekFrom::Start(self.video_strh_at + 32))?;
        self.file.write_all(&self.frames.to_le_bytes())?; // dwLength
        if let Some(at) = self.audio_length_at {
            // An audio dwLength counts blocks, not bytes.
            let blocks = (self.audio_bytes / u64::from(self.audio_block_align)) as u32;
            self.file.seek(SeekFrom::Start(at))?;
            self.file.write_all(&blocks.to_le_bytes())?;
        }

        let riff_size = index_start + index_size - 8;
        self.file.seek(SeekFrom::Start(4))?;
        self.file.write_all(&(riff_size as u32).to_le_bytes())?;

        // Keep the frame rate readable for the list command.
        let _ = fps;
        self.file.flush()?;
        Ok(())
    }
}

fn write_chunk(out: &mut Vec<u8>, tag: &[u8; 4], payload: &[u8]) {
    out.extend_from_slice(tag);
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(payload);
    if payload.len() % 2 == 1 {
        out.push(0);
    }
}

fn write_list<W: Write>(out: &mut W, kind: &[u8; 4], payload: &[u8]) -> std::io::Result<()> {
    out.write_all(b"LIST")?;
    out.write_all(&((payload.len() + 4) as u32).to_le_bytes())?;
    out.write_all(kind)?;
    out.write_all(payload)
}

/* ---------- Recording ---------- */

/// Starts a recording for the given game. Refuses when one is already running.
pub fn start(app: &tauri::AppHandle, title: &str) -> Result<(), String> {
    #[cfg(not(windows))]
    {
        let _ = (app, title);
        return Err("Clip recording is only available on Windows.".to_string());
    }
    if running() {
        return Err("@t:ss.recordingBusy".to_string());
    }
    let dir = clip_dir(title);
    std::fs::create_dir_all(&dir).map_err(|_| "@t:ss.recordFailed".to_string())?;
    let stamp = crate::legendary::screenshots::get_local_now_systemtime();
    let name = if stamp.w_year >= 2020 {
        format!(
            "{}_{:04}-{:02}-{:02}_{:02}-{:02}-{:02}.avi",
            crate::legendary::screenshots::clean_folder_name(title).replace(' ', "_"),
            stamp.w_year,
            stamp.w_month,
            stamp.w_day,
            stamp.w_hour,
            stamp.w_minute,
            stamp.w_second
        )
    } else {
        format!("Clip_{}.avi", std::process::id())
    };
    let path = dir.join(name);

    STOP.store(false, Ordering::SeqCst);
    FRAMES.store(0, Ordering::SeqCst);
    if let Ok(mut guard) = LAST_ERROR.lock() {
        *guard = None;
    }
    if let Ok(mut guard) = STARTED_AT.lock() {
        *guard = Some(Instant::now());
    }
    if let Ok(mut guard) = TARGET.lock() {
        *guard = Some(path.clone());
    }
    RUNNING.store(true, Ordering::SeqCst);

    let app = app.clone();
    log(&app, &format!("start: {}", path.display()));
    // The in-game overlay turns this into a card over the game: F9 is easy to
    // press twice by accident, and a recording nobody notices is a recording
    // nobody stops.
    let _ = app.emit(
        "clip-started",
        serde_json::json!({ "path": path.to_string_lossy(), "title": title }),
    );
    std::thread::spawn(move || record_loop(app, path));
    Ok(())
}

/// Appends one line to `<app_data>/logs/clip.log`. The recorder had no trace at
/// all, which is why a report of "F9 never wrote a file" could not be answered.
pub fn log(app: &tauri::AppHandle, line: &str) {
    use std::io::Write;
    use tauri::Manager;
    let Ok(dir) = app.path().app_data_dir().map(|dir| dir.join("logs")) else {
        return;
    };
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("clip.log"))
    {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "[{stamp}] {line}");
    }
}

/// Asks the recorder to stop; the thread finalises the file by itself.
pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
}

fn record_loop(app: tauri::AppHandle, path: PathBuf) {
    let fps = FPS.load(Ordering::SeqCst).max(1);
    let quality = QUALITY.load(Ordering::SeqCst).clamp(10, 100) as u8;
    let max_secs = MAX_SECS.load(Ordering::SeqCst).max(5) as u64;
    let target_height = HEIGHT.load(Ordering::SeqCst);
    let interval = Duration::from_millis(1000 / fps as u64);

    let mut writer: Option<AviWriter> = None;
    let started = Instant::now();
    let mut next_frame = Instant::now();
    log(&app, &format!("loop: fps={fps} quality={quality} max={max_secs}s"));

    // Sound: the loopback stream is opened with the video, and its samples are
    // drained once per frame so the two stay roughly in step. A machine with no
    // output device records video only — that is not fatal.
    let mut audio = match crate::legendary::clip_audio::AudioCapture::start() {
        Ok(capture) => {
            let info = capture.info();
            log(
                &app,
                &format!(
                    "audio: {} Hz, {} ch, {} bytes/s",
                    info.sample_rate,
                    info.channels,
                    info.bytes_per_second()
                ),
            );
            Some(capture)
        }
        Err(err) => {
            log(&app, &format!("audio: unavailable ({err}); recording video only"));
            None
        }
    };
    let mut audio_samples: u64 = 0;

    let mut dxgi = crate::legendary::clip_dxgi::DxgiCapture::open();
    let mut dxgi_misses = 0u32;
    log(
        &app,
        &format!(
            "loop: capture backend = {}",
            if dxgi.is_some() { "dxgi duplication" } else { "gdi fallback" }
        ),
    );

    while !STOP.load(Ordering::SeqCst) && started.elapsed().as_secs() < max_secs {
        // No game in the foreground any more: stop instead of recording the
        // desktop (the hotkey path already knows how to find the game).
        if crate::legendary::screenshots::get_active_running_game().is_none() {
            log(&app, "loop: no game in the foreground, stopping");
            break;
        }
        // DXGI hands us a GPU texture; the GDI grabber stays as the fallback
        // when duplication is unavailable. A `None` from DXGI is a tick with no
        // new desktop frame, not a reason to pay for a second GDI read.
        let frame: Result<Option<(Vec<u8>, u32, u32)>, String> = match dxgi.as_mut() {
            Some(capture) => Ok(capture.frame_jpeg(quality, target_height)),
            None => crate::legendary::screenshots::capture_frame_jpeg(quality, target_height)
                .map(Some),
        };
        match frame {
            Ok(Some((jpeg, width, height))) => {
                dxgi_misses = 0;
                if writer.is_none() {
                    let audio_info = audio.as_ref().map(|capture| capture.info());
                    match AviWriter::create(&path, width, height, fps, audio_info) {
                        Ok(created) => {
                            log(&app, &format!("loop: first frame {width}x{height}, {}", path.display()));
                            writer = Some(created);
                        }
                        Err(err) => {
                            log(&app, &format!("loop: writer failed: {err}"));
                            if let Ok(mut guard) = LAST_ERROR.lock() {
                                *guard = Some(format!("@t:ss.recordFailed\u{1f}{err}"));
                            }
                            break;
                        }
                    }
                }
                // Sound collected since the previous frame goes in right after
                // it, so the two streams stay interleaved in the file.
                let samples = audio
                    .as_mut()
                    .map(|capture| capture.drain())
                    .unwrap_or_default();
                audio_samples += samples.len() as u64;
                if let Some(active) = writer.as_mut() {
                    if let Err(err) = active.add_frame(&jpeg) {
                        log(&app, &format!("loop: frame write failed: {err}"));
                        break;
                    }
                    FRAMES.store(active.frames, Ordering::SeqCst);
                    if let Err(err) = active.add_audio(&samples) {
                        log(&app, &format!("loop: audio write failed: {err}"));
                        break;
                    }
                    // Past the cap the 32-bit sizes would wrap and the file would
                    // stop playing where the number went wrong: end it cleanly.
                    if active.bytes() >= MAX_CLIP_BYTES {
                        log(
                            &app,
                            &format!(
                                "loop: size cap reached ({} MB), stopping",
                                active.bytes() / 1_000_000
                            ),
                        );
                        break;
                    }
                }
            }
            Ok(None) => {
                // A static desktop produces no new frame. Keep the loop's pace,
                // and after ~4 s of misses drop back to GDI for this clip.
                dxgi_misses += 1;
                if dxgi_misses > fps.saturating_mul(4).max(30) {
                    log(&app, "loop: no duplicated frames, falling back to gdi");
                    dxgi = None;
                    dxgi_misses = 0;
                }
            }
            Err(err) => {
                log(&app, &format!("loop: capture failed: {err}"));
                if let Ok(mut guard) = LAST_ERROR.lock() {
                    *guard = Some(err.clone());
                }
                if writer.is_none() {
                    // Nothing was written: tell the UI instead of failing silently.
                    let _ = app.emit("clip-error", err);
                }
                break;
            }
        }
        next_frame += interval;
        let now = Instant::now();
        if next_frame > now {
            std::thread::sleep(next_frame - now);
        } else {
            next_frame = now;
        }
    }

    if let Some(capture) = audio.as_mut() {
        // Whatever the loopback still held when the hotkey arrived.
        let tail = capture.drain();
        audio_samples += tail.len() as u64;
        if let Some(active) = writer.as_mut() {
            let _ = active.add_audio(&tail);
        }
        capture.stop();
        log(&app, &format!("audio: {audio_samples} samples captured"));
    }
    if let Some(active) = writer {
        let frames = active.frames;
        let elapsed = started.elapsed();
        let _ = active.finish(fps, elapsed);
        let measured = if elapsed.as_secs_f64() > 0.0 {
            f64::from(frames) / elapsed.as_secs_f64()
        } else {
            0.0
        };
        // The measured rate is what the file claims, so it is worth reporting:
        // a machine that cannot hold the requested rate is visible right here.
        log(
            &app,
            &format!(
                "loop: finished, {frames} frames in {:.1}s ({measured:.1} fps, asked {fps}) -> {}",
                elapsed.as_secs_f64(),
                path.display()
            ),
        );
        if frames > 0 {
            let _ = app.emit(
                "clip-saved",
                serde_json::json!({
                    "path": path.to_string_lossy(),
                    "frames": frames,
                    "seconds": elapsed.as_secs(),
                }),
            );
        }
    } else {
        log(&app, "loop: ended without a single frame");
    }
    RUNNING.store(false, Ordering::SeqCst);
    if let Ok(mut guard) = STARTED_AT.lock() {
        *guard = None;
    }
}

/* ---------- Status and listing ---------- */

pub fn status() -> ClipStatus {
    let seconds = STARTED_AT
        .lock()
        .ok()
        .and_then(|guard| guard.map(|at| at.elapsed().as_secs()))
        .unwrap_or(0);
    let path = TARGET
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    let error = LAST_ERROR
        .lock()
        .ok()
        .and_then(|guard| guard.clone())
        .unwrap_or_default();
    ClipStatus {
        running: running(),
        seconds,
        frames: FRAMES.load(Ordering::SeqCst),
        fps: FPS.load(Ordering::SeqCst),
        path,
        error,
    }
}

pub fn set_options(fps: Option<u32>, quality: Option<u8>, max_secs: Option<u64>, height: Option<u32>) {
    if let Some(fps) = fps {
        FPS.store(fps.clamp(5, 240), Ordering::SeqCst);
    }
    if let Some(quality) = quality {
        QUALITY.store(quality.clamp(10, 100) as u32, Ordering::SeqCst);
    }
    if let Some(max_secs) = max_secs {
        MAX_SECS.store(max_secs.clamp(5, 3600) as u32, Ordering::SeqCst);
    }
    if let Some(height) = height {
        // 0 means native; anything else is clamped to something sane.
        HEIGHT.store(if height == 0 { 0 } else { height.clamp(240, 4320) }, Ordering::SeqCst);
    }
}

/// Every clip under `Videos/Efxlve`, newest first, with the duration read back
/// out of the AVI header.
pub fn list() -> Vec<ClipItem> {
    let root = crate::legendary::screenshots::get_user_videos_dir().join("Efxlve");
    let mut out = Vec::new();
    collect_clips(&root, &mut out);
    out.sort_by(|a, b| b.date_str.cmp(&a.date_str));
    out
}

fn collect_clips(dir: &Path, out: &mut Vec<ClipItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_clips(&path, out);
            continue;
        }
        if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("avi")) != Some(true)
        {
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        out.push(ClipItem {
            path: path.to_string_lossy().to_string(),
            name: path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default(),
            size_bytes: meta.len(),
            date_str: crate::legendary::screenshots::get_file_local_datetime_str(
                &path,
                &meta,
                meta.modified()
                    .ok()
                    .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0),
            ),
            seconds: avi_seconds(&path).unwrap_or(0),
        });
    }
}

/// The clip's first frame as a JPEG data URL, for the clips list.
///
/// The container is ours, so this is a walk to the first `00dc` chunk and a
/// base64 of its bytes: no decoder, and nothing that depends on a codec the
/// machine may not have. Only the head of the file is read — a clip is hundreds
/// of megabytes and its first frame is at the front.
pub fn first_frame_data_url(path: &Path) -> Option<String> {
    use base64::Engine;
    use std::io::Read;

    const HEAD: u64 = 2 * 1024 * 1024;
    let mut head = Vec::new();
    File::open(path).ok()?.take(HEAD).read_to_end(&mut head).ok()?;

    // LIST movi: [LIST][size][movi], then the chunks.
    let movi = head.windows(4).position(|w| w == b"movi")?;
    let mut pos = movi + 4;
    while pos + 8 <= head.len() {
        let size = u32::from_le_bytes([
            head[pos + 4],
            head[pos + 5],
            head[pos + 6],
            head[pos + 7],
        ]) as usize;
        if &head[pos..pos + 4] == b"00dc" {
            let frame = head.get(pos + 8..pos + 8 + size)?;
            // Only our own JPEG frames: a wrong guess would show garbage.
            if frame.len() > 2 && frame[0] == 0xFF && frame[1] == 0xD8 {
                let encoded = base64::engine::general_purpose::STANDARD.encode(frame);
                return Some(format!("data:image/jpeg;base64,{encoded}"));
            }
            return None;
        }
        pos += 8 + size + (size % 2);
    }
    None
}

/// The frame at a moment inside a clip, as a JPEG data URL. The trim dialog's
/// strip is a handful of these, and they come out of the file the same way the
/// thumbnail does: a walk to the wanted `00dc` chunk.
pub fn frame_at(path: &Path, seconds: f64) -> Option<String> {
    use base64::Engine;

    let header = read_clip_header(path).ok()?;
    let wanted = header.frame_at(seconds);
    let mut file = File::open(path).ok()?;
    file.seek(SeekFrom::Start(header.movi_at)).ok()?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut buffer: Vec<u8> = Vec::new();
    let mut frame = 0u32;

    loop {
        let mut tag = [0u8; 4];
        reader.read_exact(&mut tag).ok()?;
        let mut size_bytes = [0u8; 4];
        reader.read_exact(&mut size_bytes).ok()?;
        let size = u32::from_le_bytes(size_bytes) as usize;
        let pad = (size % 2) as i64;
        if &tag == b"00dc" {
            if frame == wanted {
                if size > MAX_CHUNK_BYTES {
                    return None;
                }
                buffer.clear();
                buffer.resize(size, 0);
                reader.read_exact(&mut buffer).ok()?;
                if buffer.len() > 2 && buffer[0] == 0xFF && buffer[1] == 0xD8 {
                    let encoded = base64::engine::general_purpose::STANDARD.encode(&buffer);
                    return Some(format!("data:image/jpeg;base64,{encoded}"));
                }
                return None;
            }
            frame += 1;
        } else if &tag != b"01wb" {
            return None;
        }
        reader.seek_relative(size as i64 + pad).ok()?;
    }
}

/// `dwTotalFrames / (dwRate / dwScale)` from the `avih` header.
fn avi_seconds(path: &Path) -> Option<u64> {
    // The duration sits in the first 52 bytes. Reading the whole file pulled
    // every recording — hundreds of megabytes each — through memory just to
    // fill in a length column in the clips list.
    let mut bytes = [0u8; 52];
    File::open(path).ok()?.read_exact(&mut bytes).ok()?;
    // Layout: RIFF(12) + LIST hdrl(12) + "avih" chunk header(8) → payload at 32.
    // dwMicroSecPerFrame is the first field, dwTotalFrames sits 16 bytes in.
    if &bytes[0..4] != b"RIFF" {
        return None;
    }
    let read_u32 = |offset: usize| -> u32 {
        u32::from_le_bytes([bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]])
    };
    let micros = read_u32(32);
    let frames = read_u32(32 + 16);
    if micros == 0 || frames == 0 {
        return None;
    }
    Some(((frames as u64) * (micros as u64)) / 1_000_000)
}

/* ---------- Trimming and joining ---------- */

/// What a copy needs to know about an existing clip, read from its header.
struct ClipHeader {
    width: u32,
    height: u32,
    /// Frame duration in microseconds: the rate the file itself measured.
    micros: u32,
    audio: Option<AudioInfo>,
    /// First chunk, right after the `movi` tag.
    movi_at: u64,
}

impl ClipHeader {
    fn fps(&self) -> u32 {
        (1_000_000 / self.micros.max(1)).max(1)
    }

    fn frame_at(&self, seconds: f64) -> u32 {
        let micros = f64::from(self.micros.max(1));
        (seconds.max(0.0) * 1_000_000.0 / micros).round() as u32
    }

    /// True when two clips can go into one file: a container has a single video
    /// format and a single audio format, so the parts have to agree.
    fn matches(&self, other: &ClipHeader) -> bool {
        self.width == other.width
            && self.height == other.height
            && self.micros == other.micros
            && match (&self.audio, &other.audio) {
                (None, None) => true,
                (Some(a), Some(b)) => a.sample_rate == b.sample_rate && a.channels == b.channels,
                _ => false,
            }
    }
}

/// Reads the header of a clip this launcher wrote. Anything else — another
/// program's AVI, a file that is not an AVI at all — is refused, because the
/// copy path assumes our own chunk layout.
fn read_clip_header(path: &Path) -> Result<ClipHeader, String> {
    let mut file = File::open(path).map_err(|_| "@t:ss.fileNotFound".to_string())?;
    let mut head = vec![0u8; 8192];
    let read = file
        .read(&mut head)
        .map_err(|_| "@t:ss.clipUnreadable".to_string())?;
    head.truncate(read);

    if head.len() < 64 || &head[0..4] != b"RIFF" || &head[8..12] != b"AVI " {
        return Err("@t:ss.notOurClip".to_string());
    }
    let u32_at = |at: usize| -> Option<u32> {
        head.get(at..at + 4)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    };
    let micros = u32_at(32).filter(|m| *m > 0).ok_or("@t:ss.notOurClip")?;
    let width = u32_at(64).ok_or("@t:ss.notOurClip")?;
    let height = u32_at(68).ok_or("@t:ss.notOurClip")?;
    let movi = head
        .windows(4)
        .position(|w| w == b"movi")
        .ok_or("@t:ss.notOurClip")?;

    // The audio format sits in the second strf, an 18-byte WAVEFORMATEX. The
    // video strf is 40 bytes, so its size tells them apart.
    let mut audio = None;
    let mut at = 0usize;
    while let Some(offset) = head[at..].windows(4).position(|w| w == b"strf") {
        let pos = at + offset;
        let size = head
            .get(pos + 4..pos + 8)
            .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
            .unwrap_or(0) as usize;
        let payload = pos + 8;
        if size == 18 {
            if let (Some(channels), Some(rate)) = (
                head.get(payload + 2..payload + 4)
                    .map(|s| u16::from_le_bytes([s[0], s[1]])),
                head.get(payload + 4..payload + 8)
                    .map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]])),
            ) {
                audio = Some(AudioInfo {
                    sample_rate: rate,
                    channels,
                });
            }
        }
        at = payload + size;
        if at >= head.len() {
            break;
        }
    }

    Ok(ClipHeader {
        width,
        height,
        micros,
        audio,
        movi_at: movi as u64 + 4,
    })
}

/// Copies the frames in `[from_frame, to_frame)` and the sound that goes with
/// them. Nothing is decoded: the chunks are the file, so a cut is a copy and the
/// picture stays exactly as it was recorded.
fn copy_range(
    source: &Path,
    writer: &mut AviWriter,
    from_frame: u32,
    to_frame: u32,
) -> Result<u32, String> {
    let header = read_clip_header(source)?;
    let mut file = File::open(source).map_err(|_| "@t:ss.fileNotFound".to_string())?;
    file.seek(SeekFrom::Start(header.movi_at))
        .map_err(|_| "@t:ss.clipUnreadable".to_string())?;
    let mut reader = BufReader::with_capacity(1 << 20, file);
    let mut buffer: Vec<u8> = Vec::new();
    let mut frame = 0u32;
    let mut copied = 0u32;

    loop {
        if frame >= to_frame {
            break;
        }
        let mut tag = [0u8; 4];
        if reader.read_exact(&mut tag).is_err() {
            break;
        }
        let mut size_bytes = [0u8; 4];
        if reader.read_exact(&mut size_bytes).is_err() {
            break;
        }
        let size = u32::from_le_bytes(size_bytes) as usize;
        let keep = frame >= from_frame;
        let is_video = &tag == b"00dc";
        let is_audio = &tag == b"01wb";

        if (is_video || is_audio) && keep {
            if size > MAX_CHUNK_BYTES {
                return Err("@t:ss.clipUnreadable".to_string());
            }
            buffer.clear();
            buffer.resize(size, 0);
            if reader.read_exact(&mut buffer).is_err() {
                break;
            }
            let written = if is_video {
                writer.add_frame(&buffer)
            } else {
                writer.add_audio_bytes(&buffer)
            };
            if written.is_err() {
                return Err("@t:ss.clipWriteFailed".to_string());
            }
            if is_video {
                copied += 1;
            }
            // The writer adds its own padding, but the source's has to be read
            // past or the next chunk header starts one byte late.
            if size % 2 == 1 && reader.seek_relative(1).is_err() {
                break;
            }
        } else {
            // Skipping is a seek: a trimmed-out minute costs nothing.
            let skip = size as u64 + (size % 2) as u64;
            if reader.seek_relative(skip as i64).is_err() {
                break;
            }
        }
        if is_video {
            frame += 1;
        }
    }

    Ok(copied)
}

/// `<stem><suffix>.avi` next to the source. Nothing is ever overwritten: a name
/// that is taken gets a number.
fn sibling_path(source: &Path, suffix: &str) -> PathBuf {
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "clip".to_string());
    let dir = source.parent().map(Path::to_path_buf).unwrap_or_default();
    let mut candidate = dir.join(format!("{stem}{suffix}.avi"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem}{suffix}{n}.avi"));
        n += 1;
    }
    candidate
}

/// One entry for a clip that was just written, so the list can show it without
/// a full rescan.
fn item_for(path: &Path) -> ClipItem {
    let meta = std::fs::metadata(path);
    let size_bytes = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .as_ref()
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let date_str = match meta.as_ref() {
        Ok(meta) => crate::legendary::screenshots::get_file_local_datetime_str(path, meta, modified),
        Err(_) => String::new(),
    };
    ClipItem {
        path: path.to_string_lossy().to_string(),
        name: path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
        size_bytes,
        date_str,
        seconds: avi_seconds(path).unwrap_or(0),
    }
}

/// Finishes a clip and, when anything goes wrong, removes the half-written file
/// first: a broken `.avi` left in the clips folder would show up in the gallery
/// as a real clip.
fn finish_clip(target: &Path, writer: AviWriter, fps: u32, micros: u32) -> Result<PathBuf, String> {
    match writer.finish_at(fps, micros) {
        Ok(()) => Ok(target.to_path_buf()),
        Err(_) => {
            let _ = std::fs::remove_file(target);
            Err("@t:ss.clipWriteFailed".to_string())
        }
    }
}

/// Removes a target the writer still holds open. Windows refuses to delete a
/// file with an open handle, so the writer has to go first.
fn drop_and_remove(writer: AviWriter, target: &Path) {
    drop(writer);
    let _ = std::fs::remove_file(target);
}

/// Cuts a clip down to a range, losslessly, into a new file next to it.
pub fn trim(path: &Path, start_secs: f64, end_secs: f64) -> Result<PathBuf, String> {
    let target = sibling_path(path, "_trim");
    trim_to(path, start_secs, end_secs, &target)?;
    Ok(target)
}

/// The same cut, written wherever the caller asks: the Discord share path trims
/// into the temp folder so nothing is left in the user's Videos.
pub fn trim_to(path: &Path, start_secs: f64, end_secs: f64, target: &Path) -> Result<PathBuf, String> {
    let header = read_clip_header(path)?;
    let from = header.frame_at(start_secs);
    let to = header.frame_at(end_secs);
    if to <= from {
        return Err("@t:ss.trimEmpty".to_string());
    }
    let mut writer = AviWriter::create(
        target,
        header.width,
        header.height,
        header.fps(),
        header.audio,
    )
    .map_err(|_| "@t:ss.clipWriteFailed".to_string())?;
    let copied = match copy_range(path, &mut writer, from, to) {
        Ok(copied) => copied,
        Err(err) => {
            drop_and_remove(writer, target);
            return Err(err);
        }
    };
    if copied == 0 {
        drop_and_remove(writer, target);
        return Err("@t:ss.trimEmpty".to_string());
    }
    finish_clip(target, writer, header.fps(), header.micros)
}

/// Puts clips one after another into a new file, without re-encoding.
pub fn join(paths: &[PathBuf]) -> Result<PathBuf, String> {
    if paths.len() < 2 {
        return Err("@t:ss.joinNeedsTwo".to_string());
    }
    let first = read_clip_header(&paths[0])?;
    for path in paths.iter().skip(1) {
        if !first.matches(&read_clip_header(path)?) {
            return Err("@t:ss.joinMismatch".to_string());
        }
    }

    let target = sibling_path(&paths[0], "_joined");
    let mut writer = AviWriter::create(
        &target,
        first.width,
        first.height,
        first.fps(),
        first.audio,
    )
    .map_err(|_| "@t:ss.clipWriteFailed".to_string())?;
    for path in paths {
        match copy_range(path, &mut writer, 0, u32::MAX) {
            Ok(0) => {
                drop_and_remove(writer, &target);
                return Err("@t:ss.trimEmpty".to_string());
            }
            Ok(_) => {}
            Err(err) => {
                drop_and_remove(writer, &target);
                return Err(err);
            }
        }
        // The result carries the same 32-bit size fields as a recording, so a
        // join that would pass the cap is refused rather than written corrupt.
        if writer.bytes() >= MAX_CLIP_BYTES {
            drop_and_remove(writer, &target);
            return Err("@t:ss.joinTooLarge".to_string());
        }
    }
    finish_clip(&target, writer, first.fps(), first.micros)
}

/* ---------- Commands ---------- */

#[tauri::command]
pub fn clip_status() -> ClipStatus {
    status()
}

#[tauri::command]
pub fn clip_set_options(fps: Option<u32>, quality: Option<u8>, max_secs: Option<u64>, height: Option<u32>) {
    set_options(fps, quality, max_secs, height);
}

#[tauri::command]
pub fn clip_set_hotkey(vkey: u32) {
    set_hotkey(vkey);
}

#[tauri::command]
pub fn clip_start(app: tauri::AppHandle) -> Result<(), String> {
    let Some((_, title)) = crate::legendary::screenshots::get_active_running_game() else {
        return Err("@t:ss.notInGame".to_string());
    };
    start(&app, &title)
}

#[tauri::command]
pub fn clip_stop() -> Result<(), String> {
    if !running() {
        return Err("@t:ss.notRecording".to_string());
    }
    stop();
    Ok(())
}

#[tauri::command]
pub fn clip_list() -> Vec<ClipItem> {
    list()
}

/// One frame of a clip, for the list's thumbnail. `None` when the file is not
/// one of our AVIs or its first frame is unreadable.
#[tauri::command]
pub fn clip_thumbnail(path: String) -> Option<String> {
    first_frame_data_url(Path::new(&path))
}

/// One frame at a time inside a clip, for the trim dialog's strip.
#[tauri::command]
pub fn clip_frame(path: String, seconds: f64) -> Option<String> {
    frame_at(Path::new(&path), seconds)
}

/// Cuts a clip to a range and returns the new clip. The original is untouched.
#[tauri::command]
pub fn clip_trim(path: String, start_secs: f64, end_secs: f64) -> Result<ClipItem, String> {
    let source = PathBuf::from(&path);
    if !source.starts_with(crate::legendary::screenshots::get_user_videos_dir().join("Efxlve")) {
        return Err("@t:ss.outsideRoot".to_string());
    }
    let target = trim(&source, start_secs, end_secs)?;
    Ok(item_for(&target))
}

/// Puts clips together, in the order given, and returns the new clip.
#[tauri::command]
pub fn clip_join(paths: Vec<String>) -> Result<ClipItem, String> {
    let root = crate::legendary::screenshots::get_user_videos_dir().join("Efxlve");
    let sources: Vec<PathBuf> = paths.iter().map(PathBuf::from).collect();
    if sources.iter().any(|path| !path.starts_with(&root)) {
        return Err("@t:ss.outsideRoot".to_string());
    }
    let target = join(&sources)?;
    Ok(item_for(&target))
}

/// Sends a range of a clip to a Discord webhook.
///
/// A webhook takes 8 MB, which a clip passes in seconds at full quality, so the
/// range is cut down first with the same lossless copy the trim dialog uses.
/// Cutting a whole clip would only duplicate it, so that case sends the file
/// itself. Returns the number of bytes that went out.
#[tauri::command]
pub async fn clip_share_discord(
    webhook: String,
    path: String,
    start_secs: f64,
    end_secs: f64,
    message: String,
) -> Result<u64, String> {
    let webhook = crate::legendary::screenshots::checked_webhook(&webhook)?;
    let source = PathBuf::from(&path);
    if !source.starts_with(crate::legendary::screenshots::get_user_videos_dir().join("Efxlve")) {
        return Err("@t:ss.outsideRoot".to_string());
    }

    // `end_secs <= 0` means "the whole clip": that is the one case where the
    // file goes out as it is, because cutting it would only duplicate it.
    let mut temp: Option<PathBuf> = None;
    let upload = if end_secs <= 0.0 {
        source.clone()
    } else {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let target = std::env::temp_dir().join(format!("efxlve-share-{stamp}.avi"));
        let cut = trim_to(&source, start_secs, end_secs, &target)?;
        temp = Some(cut.clone());
        cut
    };

    let result = async {
        let bytes = std::fs::read(&upload).map_err(|_| "@t:ss.fileNotFound".to_string())?;
        if bytes.len() as u64 > crate::legendary::screenshots::DISCORD_WEBHOOK_LIMIT {
            return Err("@t:ss.shareTooLarge".to_string());
        }
        let name = upload
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "clip.avi".to_string());
        crate::legendary::screenshots::post_webhook_file(
            &webhook,
            &bytes,
            &name,
            "video/x-msvideo",
            &message,
        )
        .await?;
        Ok(bytes.len() as u64)
    }
    .await;

    if let Some(temp) = &temp {
        let _ = std::fs::remove_file(temp);
    }
    result
}

/// The clips root, so the UI can open it in the file manager.
#[tauri::command]
pub fn clip_folder_path() -> String {
    crate::legendary::screenshots::get_user_videos_dir()
        .join("Efxlve")
        .to_string_lossy()
        .to_string()
}

#[tauri::command]
pub fn clip_delete(path: String) -> Result<bool, String> {
    let file = PathBuf::from(&path);
    // Only clips under the Efxlve folder can be removed from the UI.
    if !file.starts_with(crate::legendary::screenshots::get_user_videos_dir().join("Efxlve")) {
        return Err("@t:ss.outsideRoot".to_string());
    }
    if file.is_file() {
        std::fs::remove_file(file)
            .map(|_| true)
            .map_err(|e| e.to_string())
    } else {
        Err("@t:ss.fileNotFound".to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The container has to be structurally valid: RIFF/AVI tags, a movi list
    /// with one `00dc` per frame, and an index that matches the frame count.
    #[test]
    fn avi_writer_produces_a_valid_container() {
        let dir = std::env::temp_dir().join("efxlve-clip-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("clip.avi");
        let frames: Vec<Vec<u8>> = vec![vec![0xFF, 0xD8, 1, 2, 3, 0xFF, 0xD9], vec![0xFF, 0xD8, 9, 9, 0xFF, 0xD9]];

        let mut writer = AviWriter::create(&path, 640, 360, 15, None).expect("create");
        for frame in &frames {
            writer.add_frame(frame).expect("frame");
        }
        writer.finish(15, Duration::from_secs(2)).expect("finish");

        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"AVI ");
        let riff_size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
        assert_eq!(riff_size + 8, bytes.len());
        assert_eq!(&bytes[12..16], b"LIST");
        assert_eq!(&bytes[20..24], b"hdrl");
        // avih.dwTotalFrames: RIFF(12) + LIST hdrl(12) + avih header(8) + 16.
        let total = u32::from_le_bytes([bytes[48], bytes[49], bytes[50], bytes[51]]);
        assert_eq!(total, frames.len() as u32);
        // movi list and one 00dc per frame (the index repeats the tag, so the
        // count stops at idx1)
        let movi = bytes
            .windows(4)
            .position(|w| w == b"movi")
            .expect("movi list");
        let idx = bytes
            .windows(4)
            .position(|w| w == b"idx1")
            .expect("idx1");
        assert!(movi < idx);
        let after = &bytes[movi + 4..idx];
        assert_eq!(after.windows(4).filter(|w| *w == b"00dc").count(), frames.len());
        // idx1 index
        assert!(bytes.windows(4).any(|w| w == b"idx1"));
        // The header carries the measured rate: two frames in two seconds means
        // a frame a second, so the file says one second, not 2 / 15.
        let micros = u32::from_le_bytes([bytes[32], bytes[33], bytes[34], bytes[35]]);
        assert_eq!(micros, 1_000_000);
        assert_eq!(avi_seconds(&path), Some(2));
        let _ = std::fs::remove_file(&path);
    }

    /// With sound the container carries two streams: an `auds` PCM stream and
    /// `01wb` chunks interleaved between the frames, each one indexed.
    #[test]
    fn avi_writer_muxes_a_pcm_audio_stream() {
        let dir = std::env::temp_dir().join("efxlve-clip-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("clip-audio.avi");
        let info = AudioInfo {
            sample_rate: 48_000,
            channels: 2,
        };
        // 480 samples = 10 ms of 48 kHz stereo = 240 blocks of 4 bytes.
        let block: Vec<i16> = (0..480).map(|i| (i % 100) as i16).collect();

        let mut writer = AviWriter::create(&path, 640, 360, 30, Some(info)).expect("create");
        for _ in 0..3 {
            writer
                .add_frame(&[0xFF, 0xD8, 1, 2, 0xFF, 0xD9])
                .expect("frame");
            writer.add_audio(&block).expect("audio");
        }
        writer.finish(30, Duration::from_millis(100)).expect("finish");

        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(&bytes[0..4], b"RIFF");
        let riff_size = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
        assert_eq!(riff_size + 8, bytes.len());
        // avih.dwStreams: video plus audio.
        assert_eq!(
            u32::from_le_bytes([bytes[56], bytes[57], bytes[58], bytes[59]]),
            2
        );
        // The audio stream header, with dwLength counted in blocks.
        let auds = bytes.windows(4).position(|w| w == b"auds").expect("auds");
        let blocks = u32::from_le_bytes([
            bytes[auds + 32],
            bytes[auds + 33],
            bytes[auds + 34],
            bytes[auds + 35],
        ]);
        assert_eq!(blocks, 240 * 3);
        // Its WAVEFORMATEX: PCM, stereo, 48 kHz, 16-bit.
        assert_eq!(&bytes[auds + 56..auds + 60], b"strf");
        assert_eq!(
            u32::from_le_bytes([
                bytes[auds + 60],
                bytes[auds + 61],
                bytes[auds + 62],
                bytes[auds + 63]
            ]),
            18
        );
        let wfx = auds + 64;
        assert_eq!(u16::from_le_bytes([bytes[wfx], bytes[wfx + 1]]), 1);
        assert_eq!(u16::from_le_bytes([bytes[wfx + 2], bytes[wfx + 3]]), 2);
        assert_eq!(
            u32::from_le_bytes([bytes[wfx + 4], bytes[wfx + 5], bytes[wfx + 6], bytes[wfx + 7]]),
            48_000
        );
        assert_eq!(u16::from_le_bytes([bytes[wfx + 14], bytes[wfx + 15]]), 16);
        // Both streams sit inside movi, interleaved.
        let movi = bytes.windows(4).position(|w| w == b"movi").expect("movi");
        let idx = bytes.windows(4).position(|w| w == b"idx1").expect("idx1");
        let body = &bytes[movi + 4..idx];
        assert_eq!(body.windows(4).filter(|w| *w == b"00dc").count(), 3);
        assert_eq!(body.windows(4).filter(|w| *w == b"01wb").count(), 3);
        // …and every one of the six chunks is in the index.
        let index_size = u32::from_le_bytes([bytes[idx + 4], bytes[idx + 5], bytes[idx + 6], bytes[idx + 7]]);
        assert_eq!(index_size, 6 * 16);
        let _ = std::fs::remove_file(&path);
    }

    /// The foundation of the size cap: the running count has to agree with what
    /// is on disk, or the recorder would stop at the wrong moment — too early on
    /// a slow clip, too late on one that would wrap the 32-bit sizes.
    #[test]
    fn the_writer_counts_the_bytes_it_writes() {
        let path = std::env::temp_dir().join("efxlve-avi-bytes.avi");
        let mut writer = AviWriter::create(
            &path,
            64,
            48,
            30,
            Some(AudioInfo {
                sample_rate: 48_000,
                channels: 2,
            }),
        )
        .expect("create");
        for i in 0..7u32 {
            // Odd and even lengths both, so the padding is counted too.
            writer.add_frame(&vec![0x11u8; 100 + i as usize]).expect("frame");
            writer.add_audio(&[0i16; 96]).expect("audio");
        }
        let on_disk = writer.file.metadata().expect("metadata").len();
        assert_eq!(
            writer.bytes(),
            on_disk,
            "the running count and the file agree before the index is written"
        );
        let _ = std::fs::remove_file(&path);
    }

    /// The whole path on a real machine: a real screen frame plus real loopback
    /// sound, muxed into one file. Run manually (`cargo test -- --ignored`) on a
    /// desktop session; the file is left next to the workspace to listen to.
    ///
    /// The test renders its own silence first: WASAPI loopback hands out nothing
    /// while the endpoint is idle, so on a quiet machine the capture would come
    /// back empty and the run would look like a failure.
    #[cfg(windows)]
    #[test]
    #[ignore = "grabs the real screen and speakers; run manually"]
    fn a_real_clip_gets_a_sound_track() {
        let (jpeg, width, height) =
            crate::legendary::screenshots::capture_frame_jpeg(70, 720).expect("capture");
        let _silence =
            crate::legendary::clip_audio::SilencePlayer::start().expect("silent render stream");
        let capture = crate::legendary::clip_audio::AudioCapture::start().expect("loopback");
        let info = capture.info();
        assert!(info.sample_rate >= 8_000, "a sane sample rate");
        assert!(info.channels >= 1, "at least one channel");

        let path = PathBuf::from("tmp-clip-audio-check.avi");
        let mut writer = AviWriter::create(&path, width, height, 30, Some(info)).expect("create");
        let mut blocks = 0usize;
        let started = Instant::now();
        for _ in 0..30 {
            writer.add_frame(&jpeg).expect("frame");
            std::thread::sleep(Duration::from_millis(33));
            let samples = capture.drain();
            blocks += samples.len() * 2 / usize::from(info.block_align());
            writer.add_audio(&samples).expect("audio");
        }
        let elapsed = started.elapsed();
        capture.stop();
        writer.finish(30, elapsed).expect("finish");

        let bytes = std::fs::read(&path).expect("read");
        assert_eq!(
            u32::from_le_bytes([bytes[56], bytes[57], bytes[58], bytes[59]]),
            2,
            "two streams"
        );
        // The picture and the sound must describe the same length of time: this
        // is exactly what was wrong when the header claimed the requested rate.
        let micros = u32::from_le_bytes([bytes[32], bytes[33], bytes[34], bytes[35]]);
        let video_seconds = 30.0 * f64::from(micros) / 1e6;
        assert!(
            (video_seconds - elapsed.as_secs_f64()).abs() < 0.2,
            "the file says {video_seconds:.2}s of picture for {:.2}s of recording",
            elapsed.as_secs_f64()
        );
        let movi = bytes.windows(4).position(|w| w == b"movi").expect("movi");
        let idx = bytes.windows(4).position(|w| w == b"idx1").expect("idx1");
        let chunks = bytes[movi + 4..idx]
            .windows(4)
            .filter(|w| *w == b"01wb")
            .count();
        assert!(chunks > 0, "the file has sound chunks");
        // A second of recording should bring in about a second of audio.
        assert!(blocks > 8_000, "about a second of blocks, got {blocks}");
        // The list's thumbnail comes out of the same file, from a real GDI+
        // frame this time.
        let thumb = first_frame_data_url(&path).expect("a thumbnail from a real clip");
        assert!(thumb.len() > 5_000, "a real frame is more than a few kilobytes");

        // Cutting and joining the real thing, with its real sound.
        let trimmed = trim(&path, 0.2, 0.8).expect("trim");
        let trimmed_bytes = std::fs::read(&trimmed).expect("read");
        let kept = u32::from_le_bytes([
            trimmed_bytes[48],
            trimmed_bytes[49],
            trimmed_bytes[50],
            trimmed_bytes[51],
        ]);
        assert!((14..=22).contains(&kept), "about 0.6 s at 30 fps, got {kept}");
        let joined = join(&[trimmed.clone(), trimmed.clone()]).expect("join");
        assert_eq!(
            avi_seconds(&joined),
            Some(1),
            "two copies of the cut are one second"
        );
        println!(
            "{}: {blocks} blocks in {chunks} chunks, thumbnail {} KB, cut {kept} frames",
            path.display(),
            thumb.len() / 1024
        );
        // The cut and the join stay next to the workspace (`src-tauri/tmp-*`,
        // ignored by git) so an outside tool can check them by hand.
        println!("left behind: {} and {}", trimmed.display(), joined.display());
    }

    /// What a frame costs at each height, so a requested rate can be checked
    /// against the machine. Run manually (`cargo test -- --ignored --nocapture`).
    #[test]
    #[ignore = "captures the real screen; run manually"]
    fn frame_cost_by_height() {
        for target in [0u32, 1080, 720, 240] {
            let started = Instant::now();
            let count = 12;
            for _ in 0..count {
                let _ = crate::legendary::screenshots::capture_frame_jpeg(80, target)
                    .expect("capture");
            }
            let per_frame = started.elapsed().as_secs_f64() / f64::from(count);
            println!(
                "height {:>4}: {:>6.1} ms/frame → {:>5.1} fps ceiling",
                if target == 0 { 1600 } else { target },
                per_frame * 1000.0,
                1.0 / per_frame
            );
        }
    }

    /// The clips list wants a picture of each clip: the first frame has to come
    /// back out of our own container, byte for byte.
    #[test]
    fn the_first_frame_comes_back_as_a_jpeg_data_url() {
        use base64::Engine;

        let dir = std::env::temp_dir().join("efxlve-clip-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("clip-thumb.avi");
        let frame = [0xFF, 0xD8, 42, 42, 42, 0xFF, 0xD9];
        let mut writer = AviWriter::create(&path, 64, 36, 15, None).expect("create");
        writer.add_frame(&frame).expect("frame");
        writer.add_frame(&[0xFF, 0xD8, 7, 7, 0xFF, 0xD9]).expect("frame");
        writer.finish(15, Duration::from_secs(1)).expect("finish");

        let url = first_frame_data_url(&path).expect("a thumbnail");
        let encoded = url.strip_prefix("data:image/jpeg;base64,").expect("data URL");
        assert_eq!(
            base64::engine::general_purpose::STANDARD.decode(encoded).expect("decode"),
            frame,
            "the first frame, not the second"
        );
        // Anything that is not one of our clips reports nothing at all.
        let other = dir.join("not-a-clip.bin");
        std::fs::write(&other, b"RIFF not an avi").expect("write");
        assert_eq!(first_frame_data_url(&other), None);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&other);
    }

    /// A cut is a copy: the frames that survive have to be the source's own
    /// bytes, the length has to match the range, and the sound has to come along.
    #[test]
    fn a_trim_copies_the_chosen_range() {
        let dir = std::env::temp_dir().join("efxlve-clip-test");
        let _ = std::fs::create_dir_all(&dir);
        let source = dir.join("source.avi");
        let info = AudioInfo {
            sample_rate: 48_000,
            channels: 2,
        };

        // Two seconds at 10 fps: every frame is recognisable by its first byte.
        let frames: Vec<Vec<u8>> = (0..20u8)
            .map(|i| vec![0xFF, 0xD8, i, 0xAB, 0xFF, 0xD9])
            .collect();
        let mut writer = AviWriter::create(&source, 320, 180, 10, Some(info)).expect("create");
        for (index, frame) in frames.iter().enumerate() {
            writer.add_frame(frame).expect("frame");
            // 4800 samples = 10 ms of 48 kHz stereo, the frame's own slice.
            let block: Vec<i16> = vec![index as i16; 4800 * 2];
            writer.add_audio(&block).expect("audio");
        }
        writer.finish(10, Duration::from_secs(2)).expect("finish");

        // 0.5 s to 1.5 s: ten frames, the sixth through the fifteenth.
        let trimmed = trim(&source, 0.5, 1.5).expect("trim");
        let bytes = std::fs::read(&trimmed).expect("read");
        let micros = u32::from_le_bytes([bytes[32], bytes[33], bytes[34], bytes[35]]);
        assert_eq!(micros, 100_000, "10 fps stays 10 fps");
        assert_eq!(avi_seconds(&trimmed), Some(1), "one second of picture");
        // The frames are the source's own bytes, starting at the sixth.
        let movi = bytes.windows(4).position(|w| w == b"movi").expect("movi");
        let idx = bytes.windows(4).position(|w| w == b"idx1").expect("idx1");
        let body = &bytes[movi + 4..idx];
        let kept: Vec<u8> = body
            .windows(6)
            .filter(|w| w[0] == 0xFF && w[1] == 0xD8 && w[4] == 0xFF && w[5] == 0xD9)
            .map(|w| w[2])
            .collect();
        assert_eq!(kept.len(), 10, "ten frames in, ten frames out");
        assert_eq!(kept.first(), Some(&5), "the first frame is the sixth of the source");
        assert_eq!(kept.last(), Some(&14), "and the last is the fifteenth");
        // The sound came along: ten frames of audio, 9600 blocks each.
        let chunks = body.windows(4).filter(|w| *w == b"01wb").count();
        assert_eq!(chunks, 10, "one audio chunk per kept frame");
        let _ = std::fs::remove_file(&trimmed);
        let _ = std::fs::remove_file(&source);
    }

    /// A corrupt size field must not turn into a four-gigabyte allocation, and a
    /// cut that fails must not leave a file behind for the gallery to show.
    #[test]
    fn a_corrupt_chunk_size_is_refused_and_leaves_no_file() {
        let dir = std::env::temp_dir().join("efxlve-clip-test");
        let _ = std::fs::create_dir_all(&dir);
        let source = dir.join("corrupt-source.avi");
        let mut writer = AviWriter::create(&source, 64, 48, 10, None).expect("create");
        for i in 0..6u8 {
            writer
                .add_frame(&[0xFF, 0xD8, i, 0xFF, 0xD9])
                .expect("frame");
        }
        writer.finish(10, Duration::from_millis(600)).expect("finish");

        // Claim the first frame is four gigabytes long.
        let mut bytes = std::fs::read(&source).expect("read");
        let movi = bytes.windows(4).position(|w| w == b"movi").expect("movi");
        let size_at = movi + 4 + 4;
        bytes[size_at..size_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&source, &bytes).expect("write");

        let target = dir.join("corrupt-trim.avi");
        assert_eq!(
            trim_to(&source, 0.0, 0.5, &target),
            Err("@t:ss.clipUnreadable".to_string())
        );
        assert!(!target.is_file(), "the half-written file is gone");
        let _ = std::fs::remove_file(&source);
    }

    /// The trim dialog's strip reads frames by walking the file. A corrupt size
    /// there has to return nothing, not allocate what the field claims.
    #[test]
    fn a_frame_read_refuses_a_corrupt_size() {
        let dir = std::env::temp_dir().join("efxlve-clip-test");
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("frame-corrupt.avi");
        let mut writer = AviWriter::create(&path, 64, 48, 10, None).expect("create");
        for i in 0..4u8 {
            writer
                .add_frame(&[0xFF, 0xD8, i, 0xFF, 0xD9])
                .expect("frame");
        }
        writer.finish(10, Duration::from_millis(400)).expect("finish");

        let mut bytes = std::fs::read(&path).expect("read");
        let movi = bytes.windows(4).position(|w| w == b"movi").expect("movi");
        let size_at = movi + 8;
        bytes[size_at..size_at + 4].copy_from_slice(&u32::MAX.to_le_bytes());
        std::fs::write(&path, &bytes).expect("write");

        assert_eq!(frame_at(&path, 0.0), None, "no frame, and no allocation");
        let _ = std::fs::remove_file(&path);
    }

    /// Joining has to refuse what a container cannot hold: two formats in one
    /// file is not something the header can describe.
    #[test]
    fn a_join_refuses_mixed_formats_and_adds_up_the_rest() {
        let dir = std::env::temp_dir().join("efxlve-clip-test");
        let _ = std::fs::create_dir_all(&dir);
        let make = |name: &str, frames: u8, width: u32| -> PathBuf {
            let path = dir.join(name);
            let mut writer = AviWriter::create(&path, width, 180, 10, None).expect("create");
            for i in 0..frames {
                writer.add_frame(&[0xFF, 0xD8, i, 0xFF, 0xD9]).expect("frame");
            }
            writer
                .finish(10, Duration::from_millis(u64::from(frames) * 100))
                .expect("finish");
            path
        };
        let a = make("join-a.avi", 10, 320);
        let b = make("join-b.avi", 5, 320);
        let c = make("join-c.avi", 4, 640);

        let joined = join(&[a.clone(), b.clone()]).expect("join");
        let bytes = std::fs::read(&joined).expect("read");
        let total = u32::from_le_bytes([bytes[48], bytes[49], bytes[50], bytes[51]]);
        assert_eq!(total, 15, "ten plus five frames");
        assert_eq!(avi_seconds(&joined), Some(1), "1.5 s of picture at 10 fps");

        assert_eq!(join(&[a.clone()]), Err("@t:ss.joinNeedsTwo".to_string()));
        assert_eq!(
            join(&[a.clone(), c.clone()]),
            Err("@t:ss.joinMismatch".to_string()),
            "a different frame size cannot share the file"
        );
        let _ = std::fs::remove_file(&joined);
        let _ = std::fs::remove_file(&a);
        let _ = std::fs::remove_file(&b);
        let _ = std::fs::remove_file(&c);
    }

    /// The share path cuts into the temp folder, so the cut has to land exactly
    /// where it was asked to, not next to the source.
    #[test]
    fn a_cut_can_be_written_wherever_it_is_asked_to() {
        let dir = std::env::temp_dir().join("efxlve-clip-test");
        let _ = std::fs::create_dir_all(&dir);
        let source = dir.join("share-source.avi");
        let mut writer = AviWriter::create(&source, 160, 90, 10, None).expect("create");
        for i in 0..10u8 {
            writer.add_frame(&[0xFF, 0xD8, i, 0xFF, 0xD9]).expect("frame");
        }
        writer.finish(10, Duration::from_secs(1)).expect("finish");

        let target = dir.join("share-target.avi");
        let _ = std::fs::remove_file(&target);
        let written = trim_to(&source, 0.0, 0.5, &target).expect("trim_to");
        assert_eq!(written, target, "the caller's path is the one written");
        assert!(target.is_file(), "and it exists");
        assert_eq!(avi_seconds(&target), Some(0), "half a second of picture");
        // Nothing appears next to the source.
        assert!(!dir.join("share-source_trim.avi").is_file());
        let _ = std::fs::remove_file(&target);
        let _ = std::fs::remove_file(&source);
    }

    /// The frame grabber is the risky half (Win32 + GDI+): run manually on a
    /// desktop session (`cargo test -- --ignored`) to prove it returns a JPEG.
    #[cfg(windows)]
    #[test]
    #[ignore = "captures the real screen; run manually"]
    fn capture_frame_jpeg_returns_a_jpeg() {
        let (bytes, width, height) =
            crate::legendary::screenshots::capture_frame_jpeg(80, 0).expect("capture");
        assert!(width > 0 && height > 0, "screen size");
        assert!(bytes.len() > 1000, "a real frame is more than a kilobyte");
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "JPEG start-of-image");
        assert_eq!(&bytes[bytes.len() - 2..], &[0xFF, 0xD9], "JPEG end-of-image");
        // Kept for the orientation check against a .NET capture of the same
        // screen; the file is written next to the workspace, never committed.
        let _ = std::fs::write("tmp-rust-frame.jpg", &bytes);
    }
}
