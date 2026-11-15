//! Packing side: walk a game folder, write a tar stream through independent
//! zstd frames, and rotate to a new volume before the current media is full.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use sha2::{Digest, Sha256};
use zstd::bulk::Compressor;

use super::bypass::should_store_raw;
use super::format::{
    encode_block_header, sha256_bytes, write_manifest, CompressionInfo, MediaManifest, StoreMeta,
    VolumeInfo, BLOCK_FLAG_STORED, FORMAT_NAME, FORMAT_VERSION, MANIFEST_FILE,
};
use super::profile::{worst_case_volumes, MediaProfileInfo};
use super::xtool::Xtool;
use super::ArchiveProgress;

/// Progress events leave the engine through a trait so the pack tests never
/// need a Tauri application handle.
pub trait ProgressSink: Send + Sync {
    fn emit(&self, progress: ArchiveProgress);
}

#[cfg(test)]
pub struct NoopSink;

#[cfg(test)]
impl ProgressSink for NoopSink {
    fn emit(&self, _progress: ArchiveProgress) {}
}

#[derive(Debug, Clone)]
pub struct FileEntry {
    pub rel: String,
    pub source: PathBuf,
    pub size: u64,
    pub mtime: u64,
    pub mode: u32,
    pub is_dir: bool,
}

#[derive(Debug, Default)]
pub struct ScanResult {
    pub entries: Vec<FileEntry>,
    pub total_bytes: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub skipped_links: u64,
}

pub struct PackJob {
    pub app_name: String,
    pub title: String,
    pub install_path: PathBuf,
    pub target_root: PathBuf,
    pub profile: MediaProfileInfo,
    pub level: i32,
    pub window_log: u32,
    /// Optional precompressor. The tar stream is piped through it before zstd.
    pub xtool: Option<Xtool>,
    pub store_meta: StoreMeta,
    pub sink: Arc<dyn ProgressSink>,
    pub cancel: Arc<AtomicBool>,
}

pub struct PackOutcome {
    pub manifest: MediaManifest,
    pub manifest_path: PathBuf,
    pub folder: PathBuf,
    pub stored_bytes: u64,
}

/// Walks a game folder without following links. A junction can point outside
/// the game or back into itself; neither belongs in a restore.
pub fn scan_tree(root: &Path) -> Result<ScanResult, String> {
    if !root.is_dir() {
        return Err(format!("@t:archive.installMissing\u{1f}{}", root.display()));
    }
    let mut scan = ScanResult::default();
    walk(root, root, &mut scan)?;
    scan.entries.sort_by(|left, right| left.rel.cmp(&right.rel));
    Ok(scan)
}

fn walk(root: &Path, dir: &Path, scan: &mut ScanResult) -> Result<(), String> {
    let entries = std::fs::read_dir(dir)
        .map_err(|error| format!("@t:archive.readFailed\u{1f}{error}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match std::fs::symlink_metadata(&path) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let file_type = meta.file_type();
        if is_link(&file_type) {
            scan.skipped_links += 1;
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .unwrap_or(&path)
            .to_string_lossy()
            .replace('\\', "/");
        if rel.is_empty() {
            continue;
        }
        if file_type.is_dir() {
            scan.dir_count += 1;
            scan.entries.push(FileEntry {
                rel,
                source: path.clone(),
                size: 0,
                mtime: modified_seconds(&path),
                mode: file_mode(&meta, true),
                is_dir: true,
            });
            walk(root, &path, scan)?;
        } else if file_type.is_file() {
            let size = meta.len();
            scan.total_bytes = scan.total_bytes.saturating_add(size);
            scan.file_count += 1;
            scan.entries.push(FileEntry {
                rel,
                source: path.clone(),
                size,
                mtime: modified_seconds(&path),
                mode: file_mode(&meta, false),
                is_dir: false,
            });
        }
    }
    Ok(())
}

/// Keeps the executable bit across a Unix restore; Windows has no POSIX mode.
fn file_mode(meta: &std::fs::Metadata, is_dir: bool) -> u32 {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = meta.permissions().mode() & 0o7777;
        if mode != 0 {
            return mode;
        }
    }
    let _ = meta;
    if is_dir {
        0o755
    } else {
        0o644
    }
}

/// Symlinks and Windows junctions both point outside the tree. A junction is
/// not always reported by `FileType::is_symlink`, so the Windows reparse-point
/// check is separate.
pub fn is_link(file_type: &std::fs::FileType) -> bool {
    if file_type.is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileTypeExt;
        if file_type.is_symlink_dir() || file_type.is_symlink_file() {
            return true;
        }
    }
    false
}

fn modified_seconds(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

pub fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// The final folder name for one game, with a numeric suffix when the target
/// already holds a backup of the same title.
pub fn unique_archive_folder(target_root: &Path, title: &str) -> String {
    let base = crate::custom_games::slugify(title);
    let mut candidate = base.clone();
    let mut serial = 2;
    while target_root.join(&candidate).exists() {
        candidate = format!("{base}-{serial}");
        serial += 1;
    }
    candidate
}

pub fn pack_game(job: PackJob) -> Result<PackOutcome, String> {
    let install = job
        .install_path
        .canonicalize()
        .map_err(|error| format!("@t:archive.installMissing\u{1f}{error}"))?;
    if !install.is_dir() {
        return Err(format!(
            "@t:archive.installMissing\u{1f}{}",
            install.display()
        ));
    }
    std::fs::create_dir_all(&job.target_root)
        .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"))?;
    let target = job
        .target_root
        .canonicalize()
        .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"))?;
    if target == install || target.starts_with(&install) {
        return Err("@t:archive.targetInsideSource".to_string());
    }

    let scan = scan_tree(&install)?;
    if scan.file_count == 0 {
        return Err("@t:archive.emptyGame".to_string());
    }
    let install_dir_name = install
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("game")
        .to_string();
    let folder_name = unique_archive_folder(&target, &job.title);
    let final_dir = target.join(&folder_name);
    let staging = target.join(format!(
        ".{folder_name}.partial-{}-{}",
        std::process::id(),
        now_seconds()
    ));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"))?;

    let result = pack_into(
        &job,
        &install,
        &install_dir_name,
        &folder_name,
        &scan,
        &staging,
    );
    match result {
        Ok((manifest, stored_bytes)) => {
            let manifest_path = match write_manifest(&staging, &manifest) {
                Ok(path) => path,
                Err(error) => {
                    let _ = std::fs::remove_dir_all(&staging);
                    return Err(error);
                }
            };
            if manifest.disc_layout {
                for volume in &manifest.volumes {
                    let disc = staging.join(format!("disc-{}", volume.index));
                    let copied = std::fs::create_dir_all(&disc).and_then(|_| {
                        std::fs::copy(&manifest_path, disc.join(MANIFEST_FILE))
                    });
                    if let Err(error) = copied {
                        let _ = std::fs::remove_dir_all(&staging);
                        return Err(format!("@t:archive.manifestWrite\u{1f}{error}"));
                    }
                }
            }
            if let Err(error) = std::fs::rename(&staging, &final_dir) {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(format!("@t:archive.targetFailed\u{1f}{error}"));
            }
            Ok(PackOutcome {
                manifest,
                manifest_path: final_dir.join(MANIFEST_FILE),
                folder: final_dir,
                stored_bytes,
            })
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(error)
        }
    }
}

fn pack_into(
    job: &PackJob,
    install: &Path,
    install_dir_name: &str,
    folder_name: &str,
    scan: &ScanResult,
    staging: &Path,
) -> Result<(MediaManifest, u64), String> {
    let estimated_volumes = worst_case_volumes(scan.total_bytes, job.profile.volume_bytes);
    let ctx = PackCtx {
        sink: job.sink.clone(),
        id: job.app_name.clone(),
        total_bytes: scan.total_bytes,
        processed: Arc::new(AtomicU64::new(0)),
        output: Arc::new(AtomicU64::new(0)),
        volume: Arc::new(AtomicU32::new(1)),
        volume_count: estimated_volumes,
        cancel: job.cancel.clone(),
        start: Instant::now(),
        last_emit_ms: Arc::new(AtomicU64::new(0)),
    };

    let mut compressor = Compressor::new(job.level)
        .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
    compressor
        .set_parameter(zstd::zstd_safe::CParameter::WindowLog(job.window_log))
        .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;

    let writer = VolumeWriter::new(
        staging.to_path_buf(),
        folder_name.to_string(),
        job.profile.volume_bytes,
        job.profile.disc_layout(),
        ctx.output.clone(),
        ctx.volume.clone(),
    );
    let sink = FrameSink {
        pending: Vec::with_capacity(job.profile.frame_bytes as usize),
        frame_bytes: job.profile.frame_bytes as usize,
        compressor,
        writer,
        block_index: 0,
        output: ctx.output.clone(),
        storing: false,
    };
    let sink = match &job.xtool {
        Some(xtool) => ArchiveSink::Xtool(XtoolSink::new(xtool, sink)?),
        None => ArchiveSink::Direct(sink),
    };
    let mut builder = tar::Builder::new(sink);

    for entry in &scan.entries {
        if job.cancel.load(Ordering::Relaxed) {
            return Err("@t:archive.cancelled".to_string());
        }
        let rel = Path::new(&entry.rel);
        if entry.is_dir {
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Directory);
            header.set_size(0);
            header.set_mode(entry.mode);
            header.set_mtime(entry.mtime);
            builder
                .append_data(&mut header, rel, io::empty())
                .map_err(|error| tar_error(error, &job.cancel))?;
        } else {
            let bypass = should_store_raw(&entry.rel, entry.size);
            if bypass {
                builder.get_mut().begin_store()?;
            }
            let file = File::open(&entry.source)
                .map_err(|error| format!("@t:archive.readFailed\u{1f}{error}"))?;
            let mut header = tar::Header::new_gnu();
            header.set_entry_type(tar::EntryType::Regular);
            header.set_size(entry.size);
            header.set_mode(entry.mode);
            header.set_mtime(entry.mtime);
            let reader = ProgressReader {
                inner: BufReader::with_capacity(1024 * 1024, file).take(entry.size),
                ctx: ctx.clone(),
                current: entry.rel.clone(),
                remaining: entry.size,
            };
            builder
                .append_data(&mut header, rel, reader)
                .map_err(|error| tar_error(error, &job.cancel))?;
            if bypass {
                builder.get_mut().end_store()?;
            }
            ctx.tick(&entry.rel, false);
        }
    }

    let sink = builder
        .into_inner()
        .map_err(|error| tar_error(error, &job.cancel))?;
    let writer = sink.finish()?;
    let volumes = writer.finish()?;
    let stored_bytes = volumes.iter().map(|volume| volume.bytes).sum();
    let manifest = MediaManifest {
        format: FORMAT_NAME.to_string(),
        format_version: FORMAT_VERSION,
        created_at: now_seconds(),
        launcher_version: env!("CARGO_PKG_VERSION").to_string(),
        app_name: job.app_name.clone(),
        store: super::store::store_of(&job.app_name).to_string(),
        title: job.title.clone(),
        install_dir_name: install_dir_name.to_string(),
        original_install_path: install.to_string_lossy().to_string(),
        original_bytes: scan.total_bytes,
        file_count: scan.file_count,
        dir_count: scan.dir_count,
        skipped_links: scan.skipped_links,
        compression: CompressionInfo {
            algorithm: if job.xtool.is_some() {
                "zstd+xtool".to_string()
            } else {
                "zstd".to_string()
            },
            level: job.level,
            window_log: job.window_log,
            frame_bytes: job.profile.frame_bytes,
            precompressor: job.xtool.as_ref().map(|_| "xtool".to_string()),
        },
        volume_bytes: job.profile.volume_bytes,
        volumes,
        store_meta: job.store_meta.clone(),
        complete: true,
        disc_layout: job.profile.disc_layout(),
    };
    ctx.emit("finalizing", 100.0, "");
    Ok((manifest, stored_bytes))
}

fn tar_error(error: io::Error, cancel: &Arc<AtomicBool>) -> String {
    if cancel.load(Ordering::Relaxed) {
        return "@t:archive.cancelled".to_string();
    }
    let text = error.to_string();
    if text.contains("file changed while archiving") {
        return "@t:archive.fileChanged".to_string();
    }
    for marker in [
        "@t:archive.writeFailed",
        "@t:archive.compressFailed",
        "@t:archive.blockTooLarge",
        "@t:archive.fat32Limit",
        "@t:archive.xtoolFailed",
        "@t:archive.xtoolMissing",
        "@t:archive.xtoolLibraries",
    ] {
        if let Some(index) = text.find(marker) {
            return text[index..].to_string();
        }
    }
    format!("@t:archive.compressFailed\u{1f}{text}")
}

#[derive(Clone)]
struct PackCtx {
    sink: Arc<dyn ProgressSink>,
    id: String,
    total_bytes: u64,
    processed: Arc<AtomicU64>,
    output: Arc<AtomicU64>,
    volume: Arc<AtomicU32>,
    volume_count: u32,
    cancel: Arc<AtomicBool>,
    start: Instant,
    last_emit_ms: Arc<AtomicU64>,
}

impl PackCtx {
    fn tick(&self, current_file: &str, force: bool) {
        let elapsed_ms = self.start.elapsed().as_millis() as u64;
        let last = self.last_emit_ms.load(Ordering::Relaxed);
        if !force && elapsed_ms.saturating_sub(last) < 250 {
            return;
        }
        self.last_emit_ms.store(elapsed_ms, Ordering::Relaxed);
        self.emit("compressing", 0.0, current_file);
    }

    fn emit(&self, stage: &str, forced_percent: f64, current_file: &str) {
        let processed = self.processed.load(Ordering::Relaxed);
        let percent = if forced_percent > 0.0 {
            forced_percent
        } else if self.total_bytes > 0 {
            ((processed as f64 / self.total_bytes as f64) * 100.0).min(100.0)
        } else {
            0.0
        };
        let elapsed = self.start.elapsed().as_secs_f64();
        let speed = if elapsed > 0.0 {
            processed as f64 / elapsed
        } else {
            0.0
        };
        let remaining = self.total_bytes.saturating_sub(processed);
        let eta = if speed > 0.0 {
            (remaining as f64 / speed) as u64
        } else {
            0
        };
        self.sink.emit(ArchiveProgress {
            id: self.id.clone(),
            stage: stage.to_string(),
            percent: (percent * 10.0).round() / 10.0,
            processed_bytes: processed,
            total_bytes: self.total_bytes,
            output_bytes: self.output.load(Ordering::Relaxed),
            speed_bytes: speed,
            eta_seconds: eta,
            current_file: current_file.to_string(),
            volume: self.volume.load(Ordering::Relaxed),
            volume_count: self.volume_count,
            error: None,
        });
    }
}

struct ProgressReader<R: Read> {
    inner: R,
    ctx: PackCtx,
    current: String,
    remaining: u64,
}

impl<R: Read> Read for ProgressReader<R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.ctx.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "@t:archive.cancelled",
            ));
        }
        let read = self.inner.read(buf)?;
        if read == 0 && self.remaining > 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "file changed while archiving",
            ));
        }
        if read > 0 {
            self.remaining = self.remaining.saturating_sub(read as u64);
            self.ctx
                .processed
                .fetch_add(read as u64, Ordering::Relaxed);
            self.ctx.tick(&self.current, false);
        }
        Ok(read)
    }
}

struct FrameSink {
    pending: Vec<u8>,
    frame_bytes: usize,
    compressor: Compressor<'static>,
    writer: VolumeWriter,
    block_index: u32,
    output: Arc<AtomicU64>,
    /// While true every frame is written as a stored block. The packer turns
    /// this on around a file whose bytes are already compressed.
    storing: bool,
}

impl FrameSink {
    fn push_frame(&mut self, frame: Vec<u8>) -> Result<(), String> {
        if frame.is_empty() {
            return Ok(());
        }
        let raw_len = frame.len();
        let raw_sha = sha256_bytes(&frame);
        let (payload, flags) = if self.storing {
            (frame, BLOCK_FLAG_STORED)
        } else {
            let compressed = self
                .compressor
                .compress(&frame)
                .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
            (compressed, 0)
        };
        let payload_len = payload.len();
        self.writer
            .write_block(&payload, raw_len, &raw_sha, flags, self.block_index)?;
        self.output
            .fetch_add(payload_len as u64, Ordering::Relaxed);
        self.block_index += 1;
        Ok(())
    }

    /// Ends the current frame so the next bytes can start a stored run.
    fn flush_pending(&mut self) -> Result<(), String> {
        if self.pending.is_empty() {
            return Ok(());
        }
        let frame = std::mem::take(&mut self.pending);
        self.push_frame(frame)
    }

    fn begin_store(&mut self) -> Result<(), String> {
        self.flush_pending()?;
        self.storing = true;
        Ok(())
    }

    fn end_store(&mut self) -> Result<(), String> {
        self.flush_pending()?;
        self.storing = false;
        Ok(())
    }

    fn finish(mut self) -> Result<VolumeWriter, String> {
        if !self.pending.is_empty() {
            let frame = std::mem::take(&mut self.pending);
            self.push_frame(frame)?;
        }
        Ok(self.writer)
    }
}

impl Write for FrameSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(buf);
        while self.pending.len() >= self.frame_bytes {
            let rest = self.pending.split_off(self.frame_bytes);
            let frame = std::mem::replace(&mut self.pending, rest);
            self.push_frame(frame)
                .map_err(io::Error::other)?;
        }
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

/// The tar stream either goes straight into the zstd frames or through an
/// external precompressor first. Both wrappers finish with the same writer.
#[allow(clippy::large_enum_variant)]
enum ArchiveSink {
    Direct(FrameSink),
    Xtool(XtoolSink),
}

impl Write for ArchiveSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        match self {
            Self::Direct(sink) => sink.write(buf),
            Self::Xtool(sink) => sink.write(buf),
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        match self {
            Self::Direct(sink) => sink.flush(),
            Self::Xtool(sink) => sink.flush(),
        }
    }
}

impl ArchiveSink {
    fn begin_store(&mut self) -> Result<(), String> {
        match self {
            Self::Direct(sink) => sink.begin_store(),
            // The precompressor owns the byte stream: a member cannot be cut
            // out of it, so the whole tar stream keeps the same mode.
            Self::Xtool(_) => Ok(()),
        }
    }

    fn end_store(&mut self) -> Result<(), String> {
        match self {
            Self::Direct(sink) => sink.end_store(),
            Self::Xtool(_) => Ok(()),
        }
    }

    fn finish(self) -> Result<VolumeWriter, String> {
        match self {
            Self::Direct(sink) => sink.finish(),
            Self::Xtool(sink) => sink.finish(),
        }
    }
}

/// Feeds the tar bytes into `xtool precomp` and compresses its output on a
/// reader thread. A child process needs both pipe ends drained at the same
/// time, so the frames cannot live on the thread that writes the tar stream.
struct XtoolSink {
    stdin: Option<ChildStdin>,
    child: Child,
    reader: Option<JoinHandle<()>>,
    result: Receiver<Result<VolumeWriter, String>>,
}

impl XtoolSink {
    fn new(xtool: &Xtool, sink: FrameSink) -> Result<Self, String> {
        let mut child = xtool.precompress()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "@t:archive.xtoolFailed\u{1f}stdin".to_string())?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| "@t:archive.xtoolFailed\u{1f}stdout".to_string())?;
        let (tx, result) = mpsc::channel();
        let reader = std::thread::spawn(move || {
            let mut sink = sink;
            let mut failure: Option<String> = None;
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                match stdout.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if failure.is_none() {
                            if let Err(error) = sink.write_all(&buffer[..read]) {
                                failure = Some(error.to_string());
                            }
                        }
                    }
                    Err(error) => {
                        failure.get_or_insert_with(|| {
                            format!("@t:archive.xtoolFailed\u{1f}{error}")
                        });
                        break;
                    }
                }
            }
            let finished = sink.finish();
            let message = match (failure, finished) {
                (Some(error), _) => Err(error),
                (None, Ok(writer)) => Ok(writer),
                (None, Err(error)) => Err(error),
            };
            let _ = tx.send(message);
        });
        Ok(Self {
            stdin: Some(stdin),
            child,
            reader: Some(reader),
            result,
        })
    }

    fn finish(mut self) -> Result<VolumeWriter, String> {
        drop(self.stdin.take());
        let status = self
            .child
            .wait()
            .map_err(|error| format!("@t:archive.xtoolFailed\u{1f}{error}"))?;
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
        let finished = self
            .result
            .recv()
            .map_err(|_| "@t:archive.xtoolFailed\u{1f}reader".to_string())?;
        if !status.success() {
            return Err(format!("@t:archive.xtoolFailed\u{1f}{status}"));
        }
        finished
    }
}

impl Write for XtoolSink {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let Some(stdin) = self.stdin.as_mut() else {
            return Err(io::Error::other("@t:archive.xtoolFailed\u{1f}closed"));
        };
        stdin
            .write(buf)
            .map_err(|error| io::Error::other(format!("@t:archive.xtoolFailed\u{1f}{error}")))
    }

    fn flush(&mut self) -> io::Result<()> {
        match self.stdin.as_mut() {
            Some(stdin) => stdin.flush(),
            None => Ok(()),
        }
    }
}

impl Drop for XtoolSink {
    fn drop(&mut self) {
        // A cancelled or failed pack drops the sink without calling finish.
        // The child would otherwise keep running and the reader thread would
        // keep writing into a folder that is about to be removed.
        drop(self.stdin.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

struct HashWriter {
    file: File,
    hasher: Sha256,
}

impl Write for HashWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.file.write(buf)?;
        self.hasher.update(&buf[..written]);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl HashWriter {
    fn finish(mut self) -> io::Result<(File, String)> {
        self.file.flush()?;
        self.file.sync_all()?;
        Ok((self.file, format!("{:x}", self.hasher.finalize())))
    }
}

struct CurrentVolume {
    index: u32,
    file_name: String,
    writer: BufWriter<HashWriter>,
    bytes: u64,
    blocks: u32,
}

struct VolumeWriter {
    dir: PathBuf,
    base: String,
    max_bytes: u64,
    disc_layout: bool,
    next_index: u32,
    current: Option<CurrentVolume>,
    volumes: Vec<VolumeInfo>,
    output: Arc<AtomicU64>,
    active: Arc<AtomicU32>,
}

impl VolumeWriter {
    fn new(
        dir: PathBuf,
        base: String,
        max_bytes: u64,
        disc_layout: bool,
        output: Arc<AtomicU64>,
        active: Arc<AtomicU32>,
    ) -> Self {
        Self {
            dir,
            base,
            max_bytes,
            disc_layout,
            next_index: 1,
            current: None,
            volumes: Vec::new(),
            output,
            active,
        }
    }

    fn open_next(&mut self) -> Result<(), String> {
        let index = self.next_index;
        self.next_index += 1;
        let file_name = format!("{}.efxpak.{index:03}", self.base);
        let volume_dir = if self.disc_layout {
            let dir = self.dir.join(format!("disc-{index}"));
            std::fs::create_dir_all(&dir)
                .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?;
            dir
        } else {
            self.dir.clone()
        };
        let path = volume_dir.join(&file_name);
        let file = File::create(&path)
            .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?;
        self.active.store(index, Ordering::Relaxed);
        self.current = Some(CurrentVolume {
            index,
            file_name,
            writer: BufWriter::with_capacity(1024 * 1024, HashWriter {
                file,
                hasher: Sha256::new(),
            }),
            bytes: 0,
            blocks: 0,
        });
        Ok(())
    }

    fn write_block(
        &mut self,
        payload: &[u8],
        raw_len: usize,
        raw_sha: &[u8; 32],
        flags: u32,
        block_index: u32,
    ) -> Result<(), String> {
        let record = 64usize
            .checked_add(payload.len())
            .ok_or_else(|| "@t:archive.blockTooLarge".to_string())?;
        if record as u64 > self.max_bytes {
            return Err("@t:archive.blockTooLarge".to_string());
        }
        if self.current.is_none() {
            self.open_next()?;
        }
        let rotate = self
            .current
            .as_ref()
            .map(|current| current.bytes > 0 && current.bytes + record as u64 > self.max_bytes)
            .unwrap_or(false);
        if rotate {
            self.finish_current()?;
            self.open_next()?;
        }
        let Some(current) = self.current.as_mut() else {
            return Err("@t:archive.writeFailed\u{1f}no volume".to_string());
        };
        let compressed_len = u32::try_from(payload.len())
            .map_err(|_| "@t:archive.blockTooLarge".to_string())?;
        let raw_len = u32::try_from(raw_len)
            .map_err(|_| "@t:archive.blockTooLarge".to_string())?;
        let header = encode_block_header(block_index, compressed_len, raw_len, flags, raw_sha);
        current
            .writer
            .write_all(&header)
            .and_then(|_| current.writer.write_all(payload))
            .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?;
        current.bytes += record as u64;
        current.blocks += 1;
        self.output.store(
            self.volumes.iter().map(|v| v.bytes).sum::<u64>() + current.bytes,
            Ordering::Relaxed,
        );
        Ok(())
    }

    fn finish_current(&mut self) -> Result<(), String> {
        let Some(current) = self.current.take() else {
            return Ok(());
        };
        let CurrentVolume {
            index,
            file_name,
            writer,
            bytes,
            blocks,
        } = current;
        let (_file, sha256) = writer
            .into_inner()
            .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?
            .finish()
            .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?;
        self.volumes.push(VolumeInfo {
            index,
            file_name,
            bytes,
            sha256,
            blocks,
        });
        Ok(())
    }

    fn finish(mut self) -> Result<Vec<VolumeInfo>, String> {
        self.finish_current()?;
        if self.volumes.is_empty() {
            return Err("@t:archive.emptyGame".to_string());
        }
        Ok(self.volumes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_archive::format::MANIFEST_FILE;
    use crate::media_archive::profile::{resolve, MediaProfileInfo};

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "efxlve-pack-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn noisy(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        let mut out = Vec::with_capacity(len);
        for _ in 0..len {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            out.push((state >> 24) as u8);
        }
        out
    }

    #[test]
    fn scan_skips_nothing_it_cannot_read() {
        let root = temp_root("scan");
        let game = root.join("Game");
        std::fs::create_dir_all(game.join("bin")).unwrap();
        std::fs::write(game.join("bin").join("a.dat"), b"hello").unwrap();
        std::fs::write(game.join("readme.txt"), b"world").unwrap();
        let scan = scan_tree(&game).unwrap();
        assert_eq!(scan.file_count, 2);
        assert_eq!(scan.dir_count, 1);
        assert_eq!(scan.total_bytes, 10);
        assert!(scan.entries.iter().any(|entry| entry.rel == "bin/a.dat"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_backup_rotates_at_frame_boundaries() {
        let root = temp_root("rotate");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();
        for index in 0..8 {
            std::fs::write(
                game.join(format!("file{index}.bin")),
                noisy(32 * 1024, index as u64 + 1),
            )
            .unwrap();
        }
        let target = root.join("media");
        std::fs::create_dir_all(&target).unwrap();
        let outcome = pack_game(PackJob {
            app_name: "steam::1".to_string(),
            title: "Rotate".to_string(),
            install_path: game,
            target_root: target.clone(),
            profile: MediaProfileInfo {
                id: "test".to_string(),
                volume_bytes: 64 * 1024,
                frame_bytes: 16 * 1024,
                file_system: "test".to_string(),
            },
            level: 3,
            window_log: 20,
            xtool: None,
            store_meta: StoreMeta::default(),
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        assert!(outcome.manifest.volumes.len() > 1);
        assert_eq!(outcome.manifest.file_count, 8);
        assert!(outcome.manifest_path.is_file());
        for volume in &outcome.manifest.volumes {
            let path = outcome.folder.join(&volume.file_name);
            assert_eq!(std::fs::metadata(&path).unwrap().len(), volume.bytes);
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn optical_layout_puts_one_volume_and_a_manifest_in_each_disc_folder() {
        let root = temp_root("discs");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();
        for index in 0..3 {
            std::fs::write(
                game.join(format!("part{index}.bin")),
                noisy(60 * 1024, index as u64 + 80),
            )
            .unwrap();
        }
        let target = root.join("media");
        std::fs::create_dir_all(&target).unwrap();
        let outcome = pack_game(PackJob {
            app_name: "steam::3".to_string(),
            title: "Disc Layout".to_string(),
            install_path: game,
            target_root: target,
            profile: MediaProfileInfo {
                id: "dvd5".to_string(),
                volume_bytes: 128 * 1024,
                frame_bytes: 32 * 1024,
                file_system: "UDF".to_string(),
            },
            level: 3,
            window_log: 20,
            xtool: None,
            store_meta: StoreMeta::default(),
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        assert!(outcome.manifest.disc_layout);
        assert!(outcome.manifest.volumes.len() >= 2);
        for volume in &outcome.manifest.volumes {
            let disc = outcome.folder.join(format!("disc-{}", volume.index));
            assert!(disc.join(&volume.file_name).is_file());
            assert!(disc.join(MANIFEST_FILE).is_file());
        }
        let manifest =
            crate::media_archive::format::read_manifest(&outcome.manifest_path).unwrap();
        let (paths, missing) =
            crate::media_archive::restore::locate_volumes(&manifest, &outcome.folder, &[]);
        assert!(missing.is_empty());
        assert_eq!(paths.len(), manifest.volumes.len());
        let discs = crate::media_archive::commands::archive_discs(
            outcome.manifest_path.display().to_string(),
        )
        .unwrap();
        assert_eq!(discs.len(), manifest.volumes.len());
        let per_disc = crate::media_archive::commands::archive_discs(
            outcome
                .folder
                .join("disc-1")
                .join(MANIFEST_FILE)
                .display()
                .to_string(),
        )
        .unwrap();
        assert_eq!(per_disc.len(), 1);
        assert_eq!(per_disc[0].volume_index, 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn already_compressed_files_are_stored_without_recompressing() {
        let root = temp_root("bypass");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("intro.mp4"), noisy(400 * 1024, 5)).unwrap();
        std::fs::write(game.join("data.bin"), noisy(400 * 1024, 6)).unwrap();
        let target = root.join("media");
        std::fs::create_dir_all(&target).unwrap();
        let outcome = pack_game(PackJob {
            app_name: "steam::9".to_string(),
            title: "Bypass".to_string(),
            install_path: game,
            target_root: target,
            profile: MediaProfileInfo {
                id: "test".to_string(),
                volume_bytes: 4 * 1024 * 1024,
                frame_bytes: 64 * 1024,
                file_system: "test".to_string(),
            },
            level: 3,
            window_log: 20,
            xtool: None,
            store_meta: StoreMeta::default(),
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        let mut stored = 0u64;
        let mut compressed = 0u32;
        for volume in &outcome.manifest.volumes {
            let bytes = std::fs::read(outcome.folder.join(&volume.file_name)).unwrap();
            let mut pos = 0usize;
            while pos + 64 <= bytes.len() {
                let header: [u8; 64] = bytes[pos..pos + 64].try_into().unwrap();
                let decoded =
                    crate::media_archive::format::decode_block_header(&header).unwrap();
                if decoded.flags == BLOCK_FLAG_STORED {
                    assert_eq!(decoded.compressed_len, decoded.raw_len);
                    stored += u64::from(decoded.raw_len);
                } else {
                    compressed += 1;
                }
                pos += 64 + decoded.compressed_len as usize;
            }
        }
        assert!(stored >= 400 * 1024, "stored {stored}");
        assert!(compressed > 0, "the .bin file must still compress");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn packing_refuses_a_target_inside_the_game() {
        let root = temp_root("inside");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("a.bin"), b"x").unwrap();
        let error = pack_game(PackJob {
            app_name: "steam::1".to_string(),
            title: "Inside".to_string(),
            install_path: game.clone(),
            target_root: game.join("backup"),
            profile: resolve("fat32", None).unwrap(),
            level: 3,
            window_log: 20,
            xtool: None,
            store_meta: StoreMeta::default(),
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .err()
        .expect("target inside source must fail");
        assert!(error.contains("targetInsideSource"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
