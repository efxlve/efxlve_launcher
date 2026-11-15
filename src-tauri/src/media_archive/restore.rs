//! Restore side: find the volumes that belong to a manifest, decode the
//! independent frames and unpack the tar stream into a staging folder before
//! replacing the destination.

use std::fs::File;
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Instant;

use sha2::{Digest, Sha256};

use super::format::{
    decode_block_header, safe_component, MediaManifest, BLOCK_FLAG_STORED,
    BLOCK_HEADER_BYTES,
};
use super::pack::ProgressSink;
use super::profile::free_bytes;
use super::xtool::Xtool;
use super::ArchiveProgress;

const RESTORE_PAD_BYTES: u64 = 64 * 1024 * 1024;

pub struct RestoreJob {
    pub manifest: MediaManifest,
    pub manifest_dir: PathBuf,
    pub extra_dirs: Vec<PathBuf>,
    pub target_parent: PathBuf,
    pub overwrite: bool,
    /// Required only when the manifest says the stream went through xtool.
    pub xtool: Option<Xtool>,
    pub sink: Arc<dyn ProgressSink>,
    pub cancel: Arc<AtomicBool>,
}

pub struct RestoreOutcome {
    pub target: PathBuf,
    pub file_count: u64,
    pub bytes: u64,
}

/// Resolves every volume of a backup. Each file is searched in the manifest
/// folder first, then in the folders the user added for other discs.
pub fn locate_volumes(
    manifest: &MediaManifest,
    manifest_dir: &Path,
    extra_dirs: &[PathBuf],
) -> (Vec<PathBuf>, Vec<u32>) {
    let mut paths = Vec::with_capacity(manifest.volumes.len());
    let mut missing = Vec::new();
    for volume in &manifest.volumes {
        let mut found =
            find_volume_file(manifest_dir, &volume.file_name, volume.bytes, 2);
        if found.is_none() {
            for dir in extra_dirs {
                if dir == manifest_dir {
                    continue;
                }
                found = find_volume_file(dir, &volume.file_name, volume.bytes, 2);
                if found.is_some() {
                    break;
                }
            }
        }
        match found {
            Some(path) => paths.push(path),
            None => missing.push(volume.index),
        }
    }
    (paths, missing)
}

fn file_size(path: &Path) -> Option<u64> {
    std::fs::metadata(path).ok().map(|meta| meta.len())
}

/// Finds a volume by name and exact size. Optical backups put one volume in a
/// `disc-N` folder, so a plain direct lookup is not enough.
pub(super) fn find_volume_file(
    root: &Path,
    name: &str,
    bytes: u64,
    depth: u8,
) -> Option<PathBuf> {
    let direct = root.join(name);
    if direct.is_file() && file_size(&direct) == Some(bytes) {
        return Some(direct);
    }
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(root).ok()?;
    for entry in entries.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let file_type = meta.file_type();
        if !file_type.is_dir() || super::pack::is_link(&file_type) {
            continue;
        }
        let lower = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if lower.starts_with('.')
            || lower == "$recycle.bin"
            || lower == "system volume information"
        {
            continue;
        }
        if let Some(found) = find_volume_file(&entry.path(), name, bytes, depth - 1) {
            return Some(found);
        }
    }
    None
}

pub fn restore_game(job: RestoreJob) -> Result<RestoreOutcome, String> {
    job.manifest.validate()?;
    let precompressed = job.manifest.compression.precompressor.as_deref() == Some("xtool");
    if precompressed && job.xtool.is_none() {
        return Err("@t:archive.xtoolRequired".to_string());
    }
    std::fs::create_dir_all(&job.target_parent)
        .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"))?;
    let target_parent = job
        .target_parent
        .canonicalize()
        .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"))?;
    let target = target_parent.join(&job.manifest.install_dir_name);
    if target == target_parent
        || !safe_component(&job.manifest.install_dir_name)
        || !safe_restore_target(&target)
    {
        return Err("@t:archive.invalidTarget".to_string());
    }
    if target.exists() {
        let meta = std::fs::symlink_metadata(&target)
            .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"))?;
        if super::pack::is_link(&meta.file_type()) {
            return Err("@t:archive.invalidTarget".to_string());
        }
        if !job.overwrite {
            return Err(format!(
                "@t:archive.targetNotEmpty\u{1f}{}",
                target.display()
            ));
        }
    }
    if let Some(free) = free_bytes(&target_parent) {
        let required = job.manifest.original_bytes.saturating_add(RESTORE_PAD_BYTES);
        if free < required {
            return Err(format!(
                "@t:archive.notEnoughSpaceBackend\u{1f}{:.1}\u{1f}{:.1}",
                required as f64 / (1024.0 * 1024.0 * 1024.0),
                free as f64 / (1024.0 * 1024.0 * 1024.0)
            ));
        }
    }

    let (volume_paths, missing) =
        locate_volumes(&job.manifest, &job.manifest_dir, &job.extra_dirs);
    if let Some(index) = missing.first() {
        let name = job
            .manifest
            .volumes
            .iter()
            .find(|volume| volume.index == *index)
            .map(|volume| volume.file_name.clone())
            .unwrap_or_default();
        return Err(format!("@t:archive.missingVolume\u{1f}{index}\u{1f}{name}"));
    }

    let staging_name = format!(
        ".{}.efxlve-restore-{}-{}",
        job.manifest.install_dir_name,
        std::process::id(),
        super::pack::now_seconds()
    );
    let staging = target_parent.join(&staging_name);
    let _ = std::fs::remove_dir_all(&staging);
    let _ = std::fs::remove_file(&staging);
    std::fs::create_dir_all(&staging)
        .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"))?;

    let result = extract_all(&job, &volume_paths, &staging);
    let outcome = match result {
        Ok((file_count, bytes)) => {
            if let Err(error) = replace_target(&staging, &target) {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(error);
            }
            Ok(RestoreOutcome {
                target,
                file_count,
                bytes,
            })
        }
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            Err(error)
        }
    };
    outcome
}

fn extract_all(
    job: &RestoreJob,
    volume_paths: &[PathBuf],
    staging: &Path,
) -> Result<(u64, u64), String> {
    let total_bytes = job.manifest.original_bytes;
    let current_file = Arc::new(Mutex::new(String::new()));
    let processed = Arc::new(AtomicU64::new(0));
    let reader = VolumeSequenceReader::new(volume_paths.to_vec());
    let block_reader = BlockReader {
        inner: reader,
        decompressor: zstd::bulk::Decompressor::new()
            .map_err(|error| format!("@t:archive.readFailed\u{1f}{error}"))?,
        pending: Vec::new(),
        pos: 0,
        block_index: 0,
        total_blocks: job.manifest.total_blocks(),
        max_frame_bytes: job.manifest.compression.frame_bytes,
        volume_for_block: job.manifest.volume_for_blocks(),
        processed: processed.clone(),
        total_bytes,
        sink: job.sink.clone(),
        cancel: job.cancel.clone(),
        id: job.manifest.app_name.clone(),
        current_file: current_file.clone(),
        start: Instant::now(),
        last_emit: Instant::now(),
    };
    let mut archive = tar::Archive::new(
        if job.manifest.compression.precompressor.as_deref() == Some("xtool") {
            match &job.xtool {
                Some(xtool) => RestoreSource::Xtool(XtoolReader::new(xtool, block_reader)?),
                None => return Err("@t:archive.xtoolRequired".to_string()),
            }
        } else {
            RestoreSource::Direct(block_reader)
        },
    );
    let entries = archive.entries().map_err(extraction_error)?;
    let mut file_count = 0u64;
    let mut bytes = 0u64;
    for entry in entries {
        if job.cancel.load(Ordering::Relaxed) {
            return Err("@t:archive.cancelled".to_string());
        }
        let mut entry = entry.map_err(extraction_error)?;
        let path = entry
            .path()
            .map_err(|error| format!("@t:archive.readFailed\u{1f}{error}"))?
            .into_owned();
        let Some(rel) = safe_rel_path(&path) else {
            return Err(format!(
                "@t:archive.unsafePath\u{1f}{}",
                path.to_string_lossy()
            ));
        };
        let kind = entry.header().entry_type();
        let mode = entry.header().mode().unwrap_or(0o644);
        if kind.is_dir() {
            let dir = staging.join(&rel);
            std::fs::create_dir_all(&dir)
                .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?;
            apply_mode(&dir, if mode == 0 { 0o755 } else { mode });
            continue;
        }
        if !kind.is_file() {
            // The packer never writes links or devices. A foreign tar member
            // must not be followed.
            continue;
        }
        if let Ok(mut current) = current_file.lock() {
            *current = rel.to_string_lossy().to_string();
        }
        let target_file = staging.join(&rel);
        if let Some(parent) = target_file.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?;
        }
        let mut file = std::fs::File::create(&target_file)
            .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?;
        let copied = io::copy(&mut entry, &mut file)
            .map_err(extraction_error)?;
        file.flush()
            .map_err(|error| format!("@t:archive.writeFailed\u{1f}{error}"))?;
        apply_mode(&target_file, if mode == 0 { 0o644 } else { mode });
        file_count += 1;
        bytes = bytes.saturating_add(copied);
    }
    archive.into_inner().finish()?;
    Ok((file_count, bytes))
}

/// A damaged frame surfaces from the block reader while the tar entry is being
/// copied. Keep that message instead of burying it under a generic file error.
fn extraction_error(error: io::Error) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(&error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    for marker in [
        "@t:archive.blockCorrupt",
        "@t:archive.volumeCorrupt",
        "@t:archive.cancelled",
    ] {
        if let Some(index) = text.find(marker) {
            return text[index..].to_string();
        }
    }
    format!("@t:archive.writeFailed\u{1f}{text}")
}

#[cfg(unix)]
fn apply_mode(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(
        path,
        std::fs::Permissions::from_mode(mode & 0o7777),
    );
}

#[cfg(not(unix))]
fn apply_mode(_path: &Path, _mode: u32) {}

/// A restore replaces a whole folder. A manifest from an untrusted USB must
/// never be able to name `C:\Windows\System32` or a drive root as the target.
fn safe_restore_target(target: &Path) -> bool {
    if !target.is_absolute() || target.file_name().is_none() {
        return false;
    }
    let key = normalize_path(target);
    let roots = protected_roots();
    if roots.iter().any(|root| root == &key) {
        return false;
    }
    #[cfg(windows)]
    if let Ok(windir) = std::env::var("WINDIR") {
        let windir = normalize_path(Path::new(&windir));
        if key.starts_with(&format!("{windir}\\")) {
            return false;
        }
    }
    #[cfg(not(windows))]
    for root in ["/proc", "/sys", "/dev"] {
        let root = normalize_path(Path::new(root));
        if key == root || key.starts_with(&format!("{root}\\")) {
            return false;
        }
    }
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(
        name.as_str(),
        "windows"
            | "program files"
            | "program files (x86)"
            | "programdata"
            | "system volume information"
            | "$recycle.bin"
            | "users"
            | "windowsapps"
    ) {
        return false;
    }
    let inside_system = target
        .ancestors()
        .skip(1)
        .filter_map(|ancestor| ancestor.file_name())
        .map(|value| value.to_string_lossy().to_ascii_lowercase())
        .any(|value| {
            matches!(
                value.as_str(),
                "windowsapps" | "$recycle.bin" | "system volume information"
            )
        });
    !inside_system
}

fn protected_roots() -> Vec<String> {
    let mut roots = Vec::new();
    #[cfg(windows)]
    {
        for letter in b'A'..=b'Z' {
            roots.push(normalize_path(Path::new(&format!("{}:\\", letter as char))));
        }
        for key in [
            "WINDIR",
            "ProgramFiles",
            "ProgramFiles(x86)",
            "ProgramData",
            "PUBLIC",
        ] {
            if let Ok(value) = std::env::var(key) {
                roots.push(normalize_path(Path::new(&value)));
            }
        }
        if let Ok(home) = std::env::var("USERPROFILE") {
            let home = PathBuf::from(home);
            roots.push(normalize_path(&home));
            roots.push(normalize_path(&home.join("Desktop")));
            roots.push(normalize_path(&home.join("Documents")));
            roots.push(normalize_path(&home.join("Downloads")));
            roots.push(normalize_path(&home.join("Pictures")));
            roots.push(normalize_path(&home.join("Videos")));
            roots.push(normalize_path(&home.join("Music")));
            roots.push(normalize_path(&home.join("AppData")));
            roots.push(normalize_path(&home.join("OneDrive")));
        }
        roots.push(normalize_path(Path::new(r"C:\Users")));
    }
    #[cfg(not(windows))]
    {
        for path in ["/", "/usr", "/etc", "/var", "/tmp", "/opt", "/boot"] {
            roots.push(normalize_path(Path::new(path)));
        }
        if let Ok(home) = std::env::var("HOME") {
            let home = PathBuf::from(home);
            roots.push(normalize_path(&home));
            roots.push(normalize_path(&home.join("Desktop")));
            roots.push(normalize_path(&home.join("Documents")));
            roots.push(normalize_path(&home.join("Downloads")));
        }
    }
    roots
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches(['\\', '/'])
        .to_ascii_lowercase()
}

fn safe_rel_path(path: &Path) -> Option<PathBuf> {
    if path.is_absolute() {
        return None;
    }
    let mut clean = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(part) => clean.push(part),
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return None,
        }
    }
    (!clean.as_os_str().is_empty()).then_some(clean)
}

fn replace_target(staging: &Path, target: &Path) -> Result<(), String> {
    if !target.exists() {
        return std::fs::rename(staging, target)
            .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"));
    }
    let parent = target
        .parent()
        .ok_or_else(|| "@t:archive.invalidTarget".to_string())?;
    let name = target
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("game");
    let old = parent.join(format!(
        ".{name}.efxlve-old-{}-{}",
        std::process::id(),
        super::pack::now_seconds()
    ));
    let _ = std::fs::remove_dir_all(&old);
    let _ = std::fs::remove_file(&old);
    std::fs::rename(target, &old)
        .map_err(|error| format!("@t:archive.targetFailed\u{1f}{error}"))?;
    match std::fs::rename(staging, target) {
        Ok(()) => {
            if old.is_dir() {
                let _ = std::fs::remove_dir_all(&old);
            } else {
                let _ = std::fs::remove_file(&old);
            }
            Ok(())
        }
        Err(error) => {
            let _ = std::fs::rename(&old, target);
            Err(format!("@t:archive.targetFailed\u{1f}{error}"))
        }
    }
}

struct VolumeSequenceReader {
    paths: Vec<PathBuf>,
    index: usize,
    current: Option<BufReader<File>>,
}

impl VolumeSequenceReader {
    fn new(paths: Vec<PathBuf>) -> Self {
        Self {
            paths,
            index: 0,
            current: None,
        }
    }
}

impl Read for VolumeSequenceReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.current.is_none() {
                if self.index >= self.paths.len() {
                    return Ok(0);
                }
                let file = File::open(&self.paths[self.index])?;
                self.current = Some(BufReader::with_capacity(1024 * 1024, file));
                self.index += 1;
            }
            let read = self.current.as_mut().unwrap().read(buf)?;
            if read > 0 {
                return Ok(read);
            }
            self.current = None;
        }
    }
}

struct BlockReader {
    inner: VolumeSequenceReader,
    decompressor: zstd::bulk::Decompressor<'static>,
    pending: Vec<u8>,
    pos: usize,
    block_index: u32,
    total_blocks: u32,
    max_frame_bytes: u64,
    volume_for_block: Vec<u32>,
    processed: Arc<AtomicU64>,
    total_bytes: u64,
    sink: Arc<dyn ProgressSink>,
    cancel: Arc<AtomicBool>,
    id: String,
    current_file: Arc<Mutex<String>>,
    start: Instant,
    last_emit: Instant,
}

impl BlockReader {
    fn volume_of(&self, block: u32) -> u32 {
        self.volume_for_block
            .get(block as usize)
            .copied()
            .unwrap_or(0)
    }

    fn fill(&mut self) -> io::Result<bool> {
        if self.block_index >= self.total_blocks {
            return Ok(false);
        }
        if self.cancel.load(Ordering::Relaxed) {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "@t:archive.cancelled",
            ));
        }
        let volume = self.volume_of(self.block_index);
        let mut header = [0u8; BLOCK_HEADER_BYTES];
        self.inner.read_exact(&mut header).map_err(|error| {
            io::Error::other(format!(
                "@t:archive.volumeCorrupt\u{1f}{volume}\u{1f}{}\u{1f}{error}",
                self.block_index
            ))
        })?;
        let decoded = decode_block_header(&header).map_err(|error| {
            io::Error::other(format!(
                "@t:archive.volumeCorrupt\u{1f}{volume}\u{1f}{}\u{1f}{error}",
                self.block_index
            ))
        })?;
        if decoded.block_index != self.block_index {
            return Err(io::Error::other(format!(
                "@t:archive.volumeCorrupt\u{1f}{volume}\u{1f}{}",
                self.block_index
            )));
        }
        if decoded.raw_len == 0
            || u64::from(decoded.raw_len) > self.max_frame_bytes
            || u64::from(decoded.compressed_len)
                > self.max_frame_bytes.saturating_add(1024 * 1024)
        {
            return Err(io::Error::other(format!(
                "@t:archive.volumeCorrupt\u{1f}{volume}\u{1f}{}",
                self.block_index
            )));
        }
        let mut payload = vec![0u8; decoded.compressed_len as usize];
        self.inner.read_exact(&mut payload).map_err(|error| {
            io::Error::other(format!(
                "@t:archive.volumeCorrupt\u{1f}{volume}\u{1f}{}\u{1f}{error}",
                self.block_index
            ))
        })?;
        let raw = if decoded.flags == BLOCK_FLAG_STORED {
            // A bypassed file is stored byte for byte; only an identical
            // payload length can be a valid member of the stream.
            if decoded.compressed_len != decoded.raw_len {
                return Err(io::Error::other(format!(
                    "@t:archive.volumeCorrupt\u{1f}{volume}\u{1f}{}",
                    self.block_index
                )));
            }
            payload
        } else if decoded.flags != 0 {
            return Err(io::Error::other(format!(
                "@t:archive.volumeCorrupt\u{1f}{volume}\u{1f}{}",
                self.block_index
            )));
        } else {
            self.decompressor
                .decompress(&payload, decoded.raw_len as usize)
                .map_err(|error| {
                    io::Error::other(format!(
                        "@t:archive.volumeCorrupt\u{1f}{volume}\u{1f}{}\u{1f}{error}",
                        self.block_index
                    ))
                })?
        };
        let digest: [u8; 32] = Sha256::digest(&raw).into();
        if digest != decoded.raw_sha {
            return Err(io::Error::other(format!(
                "@t:archive.blockCorrupt\u{1f}{volume}\u{1f}{}",
                self.block_index
            )));
        }
        self.processed
            .fetch_add(raw.len() as u64, Ordering::Relaxed);
        self.block_index += 1;
        self.pending = raw;
        self.pos = 0;
        self.emit();
        Ok(!self.pending.is_empty())
    }

    fn emit(&mut self) {
        if self.last_emit.elapsed().as_millis() < 200
            && self.block_index < self.total_blocks
        {
            return;
        }
        self.last_emit = Instant::now();
        let processed = self.processed.load(Ordering::Relaxed);
        let percent = if self.total_bytes > 0 {
            ((processed as f64 / self.total_bytes as f64) * 100.0).min(99.9)
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
        let current = self
            .current_file
            .lock()
            .map(|value| value.clone())
            .unwrap_or_default();
        self.sink.emit(ArchiveProgress {
            id: self.id.clone(),
            stage: "restoring".to_string(),
            percent: (percent * 10.0).round() / 10.0,
            processed_bytes: processed,
            total_bytes: self.total_bytes,
            output_bytes: 0,
            speed_bytes: speed,
            eta_seconds: eta,
            current_file: current,
            volume: self.volume_of(self.block_index.saturating_sub(1)) + 1,
            volume_count: self.volume_for_block.iter().max().copied().unwrap_or(0) + 1,
            error: None,
        });
    }
}

impl Read for BlockReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        loop {
            if self.pos < self.pending.len() {
                let available = self.pending.len() - self.pos;
                let take = available.min(buf.len());
                buf[..take].copy_from_slice(&self.pending[self.pos..self.pos + take]);
                self.pos += take;
                return Ok(take);
            }
            if !self.fill()? {
                return Ok(0);
            }
        }
    }
}

/// Tar input for the restore: either the decoded frames directly or the output
/// of `xtool decode`, which rebuilds the original tar bytes.
enum RestoreSource {
    Direct(BlockReader),
    Xtool(XtoolReader),
}

impl Read for RestoreSource {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self {
            Self::Direct(reader) => reader.read(buf),
            Self::Xtool(reader) => reader.read(buf),
        }
    }
}

impl RestoreSource {
    fn finish(self) -> Result<(), String> {
        match self {
            Self::Direct(_) => Ok(()),
            Self::Xtool(reader) => reader.finish(),
        }
    }
}

struct XtoolReader {
    stdout: Option<ChildStdout>,
    child: Child,
    feeder: Option<JoinHandle<()>>,
    failure: Arc<Mutex<Option<String>>>,
}

fn record_failure(slot: &Mutex<Option<String>>, message: String) {
    if let Ok(mut slot) = slot.lock() {
        if slot.is_none() {
            *slot = Some(message);
        }
    }
}

impl XtoolReader {
    fn new(xtool: &Xtool, mut reader: BlockReader) -> Result<Self, String> {
        let mut child = xtool.decode()?;
        let mut stdin = child
            .stdin
            .take()
            .ok_or_else(|| "@t:archive.xtoolFailed\u{1f}stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "@t:archive.xtoolFailed\u{1f}stdout".to_string())?;
        let failure = Arc::new(Mutex::new(None));
        let shared = failure.clone();
        // The block reader has to feed the child while the tar parser reads its
        // output; doing both on one thread would deadlock once a pipe fills.
        let feeder = std::thread::spawn(move || {
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(read) => {
                        if let Err(error) = stdin.write_all(&buffer[..read]) {
                            record_failure(
                                &shared,
                                format!("@t:archive.xtoolFailed\u{1f}{error}"),
                            );
                            return;
                        }
                    }
                    Err(error) => {
                        record_failure(&shared, error.to_string());
                        return;
                    }
                }
            }
        });
        Ok(Self {
            stdout: Some(stdout),
            child,
            feeder: Some(feeder),
            failure,
        })
    }

    /// Drains the remaining output and reports the first failure from either
    /// side. A damaged block must surface as a corrupt-volume message, not as
    /// a truncated tar stream.
    fn finish(mut self) -> Result<(), String> {
        if let Some(mut stdout) = self.stdout.take() {
            let _ = io::copy(&mut stdout, &mut io::sink());
        }
        let status = self
            .child
            .wait()
            .map_err(|error| format!("@t:archive.xtoolFailed\u{1f}{error}"))?;
        if let Some(feeder) = self.feeder.take() {
            let _ = feeder.join();
        }
        if let Some(error) = self.failure.lock().ok().and_then(|mut slot| slot.take()) {
            return Err(error);
        }
        if !status.success() {
            return Err(format!("@t:archive.xtoolFailed\u{1f}{status}"));
        }
        Ok(())
    }
}

impl Read for XtoolReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        match self.stdout.as_mut() {
            Some(stdout) => stdout.read(buf),
            None => Ok(0),
        }
    }
}

impl Drop for XtoolReader {
    fn drop(&mut self) {
        // A corrupt block aborts the restore before finish() runs. Close the
        // pipes and join the feeder so no thread outlives the staging folder.
        drop(self.stdout.take());
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(feeder) = self.feeder.take() {
            let _ = feeder.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_archive::pack::{pack_game, NoopSink, PackJob};
    use crate::media_archive::format::{StoreMeta, MANIFEST_FILE};
    use crate::media_archive::profile::MediaProfileInfo;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "efxlve-restore-{name}-{}",
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

    fn pack_fixture(root: &Path, volume_bytes: u64) -> (PathBuf, PathBuf, PathBuf) {
        let game = root.join("Game");
        std::fs::create_dir_all(game.join("bin")).unwrap();
        std::fs::write(game.join("bin").join("a.dat"), noisy(80 * 1024, 42)).unwrap();
        std::fs::write(game.join("readme.txt"), b"hello world").unwrap();
        std::fs::create_dir_all(game.join("empty")).unwrap();
        let media = root.join("media");
        std::fs::create_dir_all(&media).unwrap();
        let outcome = pack_game(PackJob {
            app_name: "steam::1".to_string(),
            title: "Restore Fixture".to_string(),
            install_path: game.clone(),
            target_root: media,
            profile: MediaProfileInfo {
                id: "test".to_string(),
                volume_bytes,
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
        (game, outcome.folder, outcome.manifest_path)
    }

    #[test]
    fn backup_and_restore_round_trip_across_volumes() {
        let root = temp_root("roundtrip");
        let (game, folder, manifest_path) = pack_fixture(&root, 32 * 1024);
        let manifest = crate::media_archive::format::read_manifest(&manifest_path).unwrap();
        assert!(manifest.volumes.len() > 1);
        let target_parent = root.join("target");
        std::fs::create_dir_all(&target_parent).unwrap();
        let outcome = restore_game(RestoreJob {
            manifest,
            manifest_dir: folder,
            extra_dirs: Vec::new(),
            xtool: None,
            target_parent: target_parent.clone(),
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        assert_eq!(outcome.file_count, 2);
        assert_eq!(
            std::fs::read(outcome.target.join("bin").join("a.dat")).unwrap(),
            noisy(80 * 1024, 42)
        );
        assert_eq!(
            std::fs::read(outcome.target.join("readme.txt")).unwrap(),
            b"hello world"
        );
        assert!(outcome.target.join("empty").is_dir());
        assert_eq!(
            std::fs::read(game.join("readme.txt")).unwrap(),
            std::fs::read(outcome.target.join("readme.txt")).unwrap()
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_disc_layout_backup_restores_from_the_root_or_from_disc_folders() {
        let root = temp_root("disc-layout");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();
        for index in 0..4 {
            std::fs::write(
                game.join(format!("part{index}.bin")),
                noisy(70 * 1024, index as u64 + 120),
            )
            .unwrap();
        }
        let media = root.join("media");
        std::fs::create_dir_all(&media).unwrap();
        let packed = pack_game(PackJob {
            app_name: "steam::4".to_string(),
            title: "Disc Layout Restore".to_string(),
            install_path: game,
            target_root: media,
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
        assert!(packed.manifest.disc_layout);
        assert!(packed.manifest.volumes.len() >= 2);

        let root_target = root.join("root-target");
        std::fs::create_dir_all(&root_target).unwrap();
        let from_root = restore_game(RestoreJob {
            manifest: packed.manifest.clone(),
            manifest_dir: packed.folder.clone(),
            extra_dirs: Vec::new(),
            xtool: None,
            target_parent: root_target,
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        assert_eq!(from_root.file_count, 4);

        let disc1 = packed.folder.join("disc-1");
        let manifest =
            crate::media_archive::format::read_manifest(&disc1.join(MANIFEST_FILE)).unwrap();
        let extras: Vec<PathBuf> = packed
            .manifest
            .volumes
            .iter()
            .skip(1)
            .map(|volume| packed.folder.join(format!("disc-{}", volume.index)))
            .collect();
        let disc_target = root.join("disc-target");
        std::fs::create_dir_all(&disc_target).unwrap();
        let from_disc = restore_game(RestoreJob {
            manifest,
            manifest_dir: disc1,
            extra_dirs: extras,
            xtool: None,
            target_parent: disc_target,
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        assert_eq!(from_disc.file_count, 4);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn stored_blocks_restore_byte_for_byte() {
        let root = temp_root("stored");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();
        let movie = noisy(300 * 1024, 77);
        std::fs::write(game.join("movie.mp4"), &movie).unwrap();
        std::fs::write(game.join("notes.txt"), b"hello").unwrap();
        let media = root.join("media");
        std::fs::create_dir_all(&media).unwrap();
        let packed = pack_game(PackJob {
            app_name: "steam::5".to_string(),
            title: "Stored Blocks".to_string(),
            install_path: game,
            target_root: media,
            profile: MediaProfileInfo {
                id: "test".to_string(),
                volume_bytes: 128 * 1024,
                frame_bytes: 32 * 1024,
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
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let restored = restore_game(RestoreJob {
            manifest: packed.manifest,
            manifest_dir: packed.folder,
            extra_dirs: Vec::new(),
            xtool: None,
            target_parent: target,
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        assert_eq!(
            std::fs::read(restored.target.join("movie.mp4")).unwrap(),
            movie
        );
        assert_eq!(
            std::fs::read(restored.target.join("notes.txt")).unwrap(),
            b"hello"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_xtool_backup_needs_xtool_to_restore() {
        let root = temp_root("xtool-required");
        let (_game, folder, manifest_path) = pack_fixture(&root, 128 * 1024);
        let mut manifest = crate::media_archive::format::read_manifest(&manifest_path).unwrap();
        manifest.compression.precompressor = Some("xtool".to_string());
        let target = root.join("target");
        let error = restore_game(RestoreJob {
            manifest,
            manifest_dir: folder,
            extra_dirs: Vec::new(),
            xtool: None,
            target_parent: target.clone(),
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .err()
        .expect("an xtool backup without xtool must fail");
        assert!(error.contains("xtoolRequired"));
        assert!(!target.join("Game").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "needs EFXLVE_XTOOL pointing at a local xtool.exe"]
    fn xtool_backup_and_restore_round_trip() {
        use flate2::write::ZlibEncoder;
        use flate2::Compression;
        use std::io::Write;

        let path = std::env::var("EFXLVE_XTOOL").expect("set EFXLVE_XTOOL");
        let xtool = Xtool::new(&path).unwrap();
        let root = temp_root("xtool-roundtrip");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();

        // A zlib stream is what xtool opens: zstd alone can only store it, so
        // the xtool archive must come out smaller than the direct one.
        let mut text = Vec::new();
        for line in 0..200_000 {
            text.extend_from_slice(
                format!("line {line}: the quick brown fox jumps over the lazy dog\n").as_bytes(),
            );
        }
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::new(6));
        encoder.write_all(&text).unwrap();
        let zlib_stream = encoder.finish().unwrap();
        std::fs::write(game.join("assets.bin"), &zlib_stream).unwrap();
        let binary = noisy(300 * 1024, 91);
        std::fs::write(game.join("data.bin"), &binary).unwrap();

        let pack = |name: &str, xtool: Option<Xtool>| {
            let media = root.join(name);
            std::fs::create_dir_all(&media).unwrap();
            pack_game(PackJob {
                app_name: "steam::7".to_string(),
                title: format!("Xtool {name}"),
                install_path: game.clone(),
                target_root: media,
                profile: MediaProfileInfo {
                    id: "test".to_string(),
                    volume_bytes: 4 * 1024 * 1024,
                    frame_bytes: 1024 * 1024,
                    file_system: "test".to_string(),
                },
                level: 3,
                window_log: 20,
                xtool,
                store_meta: StoreMeta::default(),
                sink: Arc::new(NoopSink),
                cancel: Arc::new(AtomicBool::new(false)),
            })
            .unwrap()
        };

        let direct = pack("direct", None);
        let packed = pack("xtool", Some(xtool.clone()));
        assert!(direct.stored_bytes > 0);
        assert!(
            packed.stored_bytes < direct.stored_bytes,
            "xtool {} vs direct {}",
            packed.stored_bytes,
            direct.stored_bytes
        );
        assert_eq!(
            packed.manifest.compression.precompressor.as_deref(),
            Some("xtool")
        );

        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let restored = restore_game(RestoreJob {
            manifest: packed.manifest,
            manifest_dir: packed.folder,
            extra_dirs: Vec::new(),
            xtool: Some(xtool),
            target_parent: target,
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        assert_eq!(
            std::fs::read(restored.target.join("assets.bin")).unwrap(),
            zlib_stream
        );
        assert_eq!(
            std::fs::read(restored.target.join("data.bin")).unwrap(),
            binary
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn system_folders_are_not_restore_targets() {
        #[cfg(windows)]
        {
            assert!(!safe_restore_target(Path::new(r"C:\Windows\System32")));
            assert!(!safe_restore_target(Path::new(r"C:\Users")));
            assert!(!safe_restore_target(Path::new(r"C:\Program Files")));
            assert!(safe_restore_target(Path::new(r"D:\Games\Game")));
        }
        #[cfg(not(windows))]
        {
            assert!(!safe_restore_target(Path::new("/usr")));
            assert!(safe_restore_target(Path::new("/tmp/game")));
        }
    }

    #[test]
    fn incompressible_files_cross_volume_boundaries() {
        let root = temp_root("boundaries");
        let game = root.join("Game");
        std::fs::create_dir_all(&game).unwrap();
        for index in 0..3 {
            std::fs::write(
                game.join(format!("part{index}.bin")),
                noisy(700 * 1024, index as u64 + 40),
            )
            .unwrap();
        }
        let media = root.join("media");
        std::fs::create_dir_all(&media).unwrap();
        let outcome = pack_game(PackJob {
            app_name: "steam::2".to_string(),
            title: "Boundaries".to_string(),
            install_path: game,
            target_root: media,
            profile: MediaProfileInfo {
                id: "test".to_string(),
                volume_bytes: 1024 * 1024,
                frame_bytes: 256 * 1024,
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
        assert!(outcome.manifest.volumes.len() >= 2);
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let restored = restore_game(RestoreJob {
            manifest: outcome.manifest,
            manifest_dir: outcome.folder,
            extra_dirs: Vec::new(),
            xtool: None,
            target_parent: target,
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        for index in 0..3 {
            assert_eq!(
                std::fs::read(restored.target.join(format!("part{index}.bin"))).unwrap(),
                noisy(700 * 1024, index as u64 + 40)
            );
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_missing_volume_is_named_before_any_file_is_written() {
        let root = temp_root("missing");
        let (_game, folder, manifest_path) = pack_fixture(&root, 32 * 1024);
        let manifest = crate::media_archive::format::read_manifest(&manifest_path).unwrap();
        let second = folder.join(&manifest.volumes[1].file_name);
        std::fs::remove_file(&second).unwrap();
        let target = root.join("target");
        let error = restore_game(RestoreJob {
            manifest,
            manifest_dir: folder,
            extra_dirs: Vec::new(),
            xtool: None,
            target_parent: target,
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .err()
        .expect("missing volume must fail");
        assert!(error.contains("missingVolume"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn extra_folders_supply_the_other_discs() {
        let root = temp_root("extra");
        let (_game, folder, manifest_path) = pack_fixture(&root, 32 * 1024);
        let manifest = crate::media_archive::format::read_manifest(&manifest_path).unwrap();
        let extra = root.join("discs");
        std::fs::create_dir_all(extra.join("disc-2")).unwrap();
        for volume in manifest.volumes.iter().skip(1) {
            std::fs::rename(
                folder.join(&volume.file_name),
                extra.join("disc-2").join(&volume.file_name),
            )
            .unwrap();
        }
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let outcome = restore_game(RestoreJob {
            manifest,
            manifest_dir: folder,
            extra_dirs: vec![extra],
            xtool: None,
            target_parent: target,
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .unwrap();
        assert_eq!(outcome.file_count, 2);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_flipped_byte_fails_its_block_and_never_reaches_the_target() {
        let root = temp_root("corrupt");
        let (_game, folder, manifest_path) = pack_fixture(&root, 32 * 1024);
        let manifest = crate::media_archive::format::read_manifest(&manifest_path).unwrap();
        let path = folder.join(&manifest.volumes[0].file_name);
        let mut bytes = std::fs::read(&path).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&path, bytes).unwrap();
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let error = restore_game(RestoreJob {
            manifest,
            manifest_dir: folder,
            extra_dirs: Vec::new(),
            xtool: None,
            target_parent: target.clone(),
            overwrite: false,
            sink: Arc::new(NoopSink),
            cancel: Arc::new(AtomicBool::new(false)),
        })
        .err()
        .expect("a damaged block must fail");
        assert!(error.contains("blockCorrupt") || error.contains("volumeCorrupt"));
        assert!(!target.join("Game").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
