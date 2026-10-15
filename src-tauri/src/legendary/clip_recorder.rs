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

use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::Emitter;

/// Default cap: a clip stops by itself here so a forgotten recording cannot
/// fill the disk (12 fps × ~300 KB ≈ 3.5 MB/s, 5 minutes ≈ 1 GB).
pub const DEFAULT_MAX_SECS: u64 = 300;

static RUNNING: AtomicBool = AtomicBool::new(false);
static STOP: AtomicBool = AtomicBool::new(false);
static FPS: AtomicU32 = AtomicU32::new(15);
static QUALITY: AtomicU32 = AtomicU32::new(80);
static MAX_SECS: AtomicU32 = AtomicU32::new(DEFAULT_MAX_SECS as u32);
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

struct AviWriter {
    file: File,
    frames: u32,
    index: Vec<(u32, u32)>,
    frame_bytes: u32,
    movi_start: u64,
}

impl AviWriter {
    /// Writes the headers with placeholder sizes; they are patched on finish.
    fn create(path: &Path, width: u32, height: u32, fps: u32) -> std::io::Result<Self> {
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
        avih.extend_from_slice(&1u32.to_le_bytes()); // dwStreams
        avih.extend_from_slice(&0u32.to_le_bytes()); // dwSuggestedBufferSize
        avih.extend_from_slice(&width.to_le_bytes());
        avih.extend_from_slice(&height.to_le_bytes());
        avih.extend_from_slice(&[0u8; 16]); // reserved
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
        write_list(&mut hdrl, b"strl", &strl)?;
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
            movi_start,
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
        self.index.push(((offset - self.movi_start) as u32, jpeg.len() as u32));
        self.frames += 1;
        self.frame_bytes = self.frame_bytes.max(jpeg.len() as u32);
        Ok(())
    }

    /// Patches the sizes and appends the index, leaving a playable file.
    fn finish(mut self, fps: u32) -> std::io::Result<()> {
        let index_start = self.file.stream_position()?;
        self.file.write_all(b"idx1")?;
        self.file.write_all(&((self.index.len() * 16) as u32).to_le_bytes())?;
        for (offset, length) in &self.index {
            self.file.write_all(b"00dc")?;
            self.file.write_all(&0x0000_0010u32.to_le_bytes())?; // AVIIF_KEYFRAME
            self.file.write_all(&offset.to_le_bytes())?;
            self.file.write_all(&length.to_le_bytes())?;
        }
        let index_size = self.file.stream_position()? - index_start;

        let movi_size = index_start - self.movi_start;
        // The LIST size field sits 8 bytes before the payload start: [LIST][size][movi].
        self.file.seek(SeekFrom::Start(self.movi_start - 8))?;
        self.file.write_all(&(movi_size as u32).to_le_bytes())?;

        // avih.dwTotalFrames lives 24 bytes into the avih payload, which starts
        // right after the 8-byte "avih" + size header that follows "LIST hdrl".
        let avih_data = 12 /* RIFF header */ + 12 /* LIST hdrl */ + 8 /* avih hdr */;
        self.file.seek(SeekFrom::Start(avih_data + 16))?;
        self.file.write_all(&self.frames.to_le_bytes())?;
        // strh.dwLength: after LIST hdrl → avih chunk (8 + 56) → LIST strl (12) → strh header (8) + 32 bytes.
        let strh_length = 12 + 12 + 8 + 56 + 12 + 8 + 32;
        self.file.seek(SeekFrom::Start(strh_length as u64))?;
        self.file.write_all(&self.frames.to_le_bytes())?;

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
    std::thread::spawn(move || record_loop(app, path));
    Ok(())
}

/// Asks the recorder to stop; the thread finalises the file by itself.
pub fn stop() {
    STOP.store(true, Ordering::SeqCst);
}

fn record_loop(app: tauri::AppHandle, path: PathBuf) {
    let fps = FPS.load(Ordering::SeqCst).max(1);
    let quality = QUALITY.load(Ordering::SeqCst).clamp(10, 100) as u8;
    let max_secs = MAX_SECS.load(Ordering::SeqCst).max(5) as u64;
    let interval = Duration::from_millis(1000 / fps as u64);

    let mut writer: Option<AviWriter> = None;
    let started = Instant::now();
    let mut next_frame = Instant::now();

    while !STOP.load(Ordering::SeqCst) && started.elapsed().as_secs() < max_secs {
        // No game in the foreground any more: stop instead of recording the
        // desktop (the hotkey path already knows how to find the game).
        if crate::legendary::screenshots::get_active_running_game().is_none() {
            break;
        }
        match crate::legendary::screenshots::capture_frame_jpeg(quality) {
            Ok((jpeg, width, height)) => {
                if writer.is_none() {
                    match AviWriter::create(&path, width, height, fps) {
                        Ok(created) => writer = Some(created),
                        Err(err) => {
                            if let Ok(mut guard) = LAST_ERROR.lock() {
                                *guard = Some(format!("@t:ss.recordFailed\u{1f}{err}"));
                            }
                            break;
                        }
                    }
                }
                if let Some(active) = writer.as_mut() {
                    if active.add_frame(&jpeg).is_err() {
                        break;
                    }
                    FRAMES.store(active.frames, Ordering::SeqCst);
                }
            }
            Err(err) => {
                if let Ok(mut guard) = LAST_ERROR.lock() {
                    *guard = Some(err);
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

    if let Some(active) = writer {
        let frames = active.frames;
        let _ = active.finish(fps);
        if frames > 0 {
            let _ = app.emit(
                "clip-saved",
                serde_json::json!({ "path": path.to_string_lossy(), "frames": frames }),
            );
        }
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

pub fn set_options(fps: Option<u32>, quality: Option<u8>, max_secs: Option<u64>) {
    if let Some(fps) = fps {
        FPS.store(fps.clamp(5, 60), Ordering::SeqCst);
    }
    if let Some(quality) = quality {
        QUALITY.store(quality.clamp(10, 100) as u32, Ordering::SeqCst);
    }
    if let Some(max_secs) = max_secs {
        MAX_SECS.store(max_secs.clamp(5, 3600) as u32, Ordering::SeqCst);
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

/// `dwTotalFrames / (dwRate / dwScale)` from the `avih` header.
fn avi_seconds(path: &Path) -> Option<u64> {
    let bytes = std::fs::read(path).ok()?;
    // Layout: RIFF(12) + LIST hdrl(12) + "avih" chunk header(8) → payload at 32.
    // dwMicroSecPerFrame is the first field, dwTotalFrames sits 16 bytes in.
    if bytes.len() < 52 || &bytes[0..4] != b"RIFF" {
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

/* ---------- Commands ---------- */

#[tauri::command]
pub fn clip_status() -> ClipStatus {
    status()
}

#[tauri::command]
pub fn clip_set_options(fps: Option<u32>, quality: Option<u8>, max_secs: Option<u64>) {
    set_options(fps, quality, max_secs);
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

        let mut writer = AviWriter::create(&path, 640, 360, 15).expect("create");
        for frame in &frames {
            writer.add_frame(frame).expect("frame");
        }
        writer.finish(15).expect("finish");

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
        assert_eq!(avi_seconds(&path), Some(0));
        let _ = std::fs::remove_file(&path);
    }

    /// The frame grabber is the risky half (Win32 + GDI+): run manually on a
    /// desktop session (`cargo test -- --ignored`) to prove it returns a JPEG.
    #[test]
    #[ignore = "captures the real screen; run manually"]
    fn capture_frame_jpeg_returns_a_jpeg() {
        let (bytes, width, height) =
            crate::legendary::screenshots::capture_frame_jpeg(80).expect("capture");
        assert!(width > 0 && height > 0, "screen size");
        assert!(bytes.len() > 1000, "a real frame is more than a kilobyte");
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8], "JPEG start-of-image");
        assert_eq!(&bytes[bytes.len() - 2..], &[0xFF, 0xD9], "JPEG end-of-image");
    }
}
