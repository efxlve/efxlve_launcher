//! Tauri commands for the media archive. The engine itself lives in `pack` and
//! `restore`; this file owns progress events, cancellation and store glue.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::disc::{self, DiscRecorder};
use super::estimate::{self, ArchiveEstimate};
use super::format::{read_manifest, CompressionInfo, MediaManifest, VolumeInfo, MANIFEST_FILE};
use super::pack::{pack_game, scan_tree, unique_archive_folder, PackJob, ProgressSink};
use super::profile::{self, MediaProfileInfo};
use super::restore::{locate_volumes, restore_game, verify_archive, RestoreJob};
use super::store::{self, RestoreRegistration, StorePending};
use super::xtool::{self, Xtool};
use super::ArchiveProgress;

const SCAN_DEPTH: u8 = 3;
const SCAN_BUDGET: usize = 2_000;

fn parity_reserve_bytes(total: u64, full_volume_recovery: bool) -> u64 {
    if full_volume_recovery {
        total
    } else {
        total / 12
    }
}

fn required_archive_bytes(total: u64, full_volume_recovery: bool) -> u64 {
    total
        .saturating_add(parity_reserve_bytes(total, full_volume_recovery))
        .saturating_add(64 * 1024 * 1024)
}

static ACTIVE: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn active_map() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

struct ActiveGuard {
    key: String,
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut map) = active_map().lock() {
            map.remove(&self.key);
        }
    }
}

fn begin(id: &str) -> Result<(ActiveGuard, Arc<AtomicBool>), String> {
    let mut map = active_map()
        .lock()
        .map_err(|error| error.to_string())?;
    if map.contains_key(id) {
        return Err("@t:archive.alreadyRunning".to_string());
    }
    let cancel = Arc::new(AtomicBool::new(false));
    map.insert(id.to_string(), cancel.clone());
    Ok((
        ActiveGuard {
            key: id.to_string(),
        },
        cancel,
    ))
}

struct AppProgressSink {
    app: AppHandle,
}

impl ProgressSink for AppProgressSink {
    fn emit(&self, progress: ArchiveProgress) {
        let _ = self.app.emit("archive-progress", progress);
    }
}

fn failure_progress(id: &str, total: u64, error: &str) -> ArchiveProgress {
    ArchiveProgress {
        id: id.to_string(),
        stage: "failed".to_string(),
        percent: 0.0,
        processed_bytes: 0,
        total_bytes: total,
        output_bytes: 0,
        speed_bytes: 0.0,
        eta_seconds: 0,
        current_file: String::new(),
        volume: 0,
        volume_count: 0,
        error: Some(error.to_string()),
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchivePlan {
    pub app_name: String,
    pub title: String,
    pub install_path: String,
    pub original_bytes: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub skipped_links: u64,
    pub volume_bytes: u64,
    pub frame_bytes: u64,
    pub estimated_volumes: u32,
    pub target_root: String,
    pub folder_name: String,
    pub archive_path: String,
    pub free_bytes: Option<u64>,
    pub target_file_system: Option<String>,
    pub required_bytes: u64,
    pub enough_space: bool,
    pub volume_fits: bool,
    /// False when the target folder (or its nearest existing parent) cannot be
    /// written to without elevation, e.g. `C:\Program Files`.
    pub writable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveSummary {
    pub app_name: String,
    pub title: String,
    pub store: String,
    pub folder: String,
    pub manifest_path: String,
    pub original_bytes: u64,
    pub stored_bytes: u64,
    pub volume_count: u32,
    pub volumes: Vec<VolumeInfo>,
    pub compression: CompressionInfo,
    pub created_at: u64,
    pub disc_layout: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveDisc {
    pub volume_index: u32,
    pub folder: String,
    pub manifest_path: String,
    pub bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FoundArchive {
    pub manifest_path: String,
    pub manifest: MediaManifest,
    pub missing_volumes: Vec<u32>,
    pub stored_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreResult {
    pub target: String,
    pub file_count: u64,
    pub bytes: u64,
    pub registration: RestoreRegistration,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveVerifyResult {
    pub app_name: String,
    pub title: String,
    pub blocks: u32,
    pub volume_count: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DefaultTarget {
    pub target_parent: String,
    pub install_dir_name: String,
    pub final_path: String,
}

#[tauri::command]
pub fn archive_profiles() -> Vec<MediaProfileInfo> {
    profile::all()
}

#[tauri::command]
pub async fn archive_plan(
    app_name: String,
    title: String,
    install_path: String,
    target_root: String,
    profile_id: String,
    custom_mib: Option<u64>,
    full_volume_recovery: bool,
) -> Result<ArchivePlan, String> {
    let profile = profile::resolve(&profile_id, custom_mib)?;
    let install = PathBuf::from(&install_path);
    let target = if target_root.trim().is_empty() {
        default_target(&app_name, &install_path, Some("backup"), None).target_parent
    } else {
        target_root
    };
    let target_path = PathBuf::from(&target);
    let scan = {
        let install = install.clone();
        tauri::async_runtime::spawn_blocking(move || scan_tree(&install))
            .await
            .map_err(|error| error.to_string())??
    };
    let title = if title.trim().is_empty() {
        install
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("game")
            .to_string()
    } else {
        title
    };
    let folder_name = unique_archive_folder(&target_path, &title);
    let archive_path = target_path.join(&folder_name);
    let required_bytes = required_archive_bytes(scan.total_bytes, full_volume_recovery);
    let writable = can_write_under(&target_path);
    let target_info = profile::target_info(&target_path);
    let free = target_info.free_bytes;
    let fat32 = target_info
        .file_system
        .as_deref()
        .map(|name| name.eq_ignore_ascii_case("fat32"))
        .unwrap_or(false);
    let volume_fits = !(fat32 && profile.volume_bytes > 4_294_967_295);
    Ok(ArchivePlan {
        app_name,
        title,
        install_path,
        original_bytes: scan.total_bytes,
        file_count: scan.file_count,
        dir_count: scan.dir_count,
        skipped_links: scan.skipped_links,
        volume_bytes: profile.volume_bytes,
        frame_bytes: profile.frame_bytes,
        estimated_volumes: profile::worst_case_volumes(
            scan.total_bytes,
            super::pack::effective_volume_bytes(
                profile.volume_bytes,
                super::pack::DEFAULT_PARITY_SHARDS,
                full_volume_recovery,
            ),
        ),
        target_root: target,
        folder_name,
        archive_path: archive_path.display().to_string(),
        free_bytes: free,
        target_file_system: target_info.file_system,
        required_bytes,
        enough_space: free.map(|bytes| bytes >= required_bytes).unwrap_or(true),
        volume_fits,
        writable,
    })
}

#[tauri::command]
pub async fn archive_estimate(
    app_name: String,
    install_path: String,
    profile_id: String,
    custom_mib: Option<u64>,
    level: String,
    xtool_path: Option<String>,
    full_volume_recovery: bool,
) -> Result<ArchiveEstimate, String> {
    let (_active, cancel) = begin(&app_name)?;
    let profile = profile::resolve(&profile_id, custom_mib)?;
    let (compression_level, window_log) = compression_setting(&level)?;
    let xtool = match xtool_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(path) => Some(Xtool::new(path)?),
        None => None,
    };
    tauri::async_runtime::spawn_blocking(move || {
        estimate::estimate_archive(
            Path::new(&install_path),
            &profile,
            compression_level,
            window_log,
            xtool.as_ref(),
            full_volume_recovery,
            &cancel,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn archive_xtool_install(app: AppHandle) -> Result<String, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let _install = xtool::begin_install()?;
    let _awake = crate::keep_awake::keep_awake();
    let exe = xtool::install_with_progress(&root, |progress| {
        let _ = app.emit("xtool-progress", progress);
    })
    .await?;
    Ok(exe.display().to_string())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn archive_start(
    app: AppHandle,
    app_name: String,
    title: String,
    install_path: String,
    target_root: String,
    profile_id: String,
    custom_mib: Option<u64>,
    level: String,
    xtool_path: Option<String>,
    full_volume_recovery: bool,
) -> Result<ArchiveSummary, String> {
    let profile = profile::resolve(&profile_id, custom_mib)?;
    let (compression_level, window_log) = compression_setting(&level)?;
    let xtool = match xtool_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(path) => Some(Xtool::new(path)?),
        None => None,
    };
    if let Some((running, _)) = crate::legendary::screenshots::get_active_running_game() {
        if running == app_name {
            return Err("@t:archive.gameRunning".to_string());
        }
    }
    let (guard, cancel) = begin(&app_name)?;
    let sink: Arc<dyn ProgressSink> = Arc::new(AppProgressSink { app: app.clone() });
    let install = PathBuf::from(&install_path);
    let target = if target_root.trim().is_empty() {
        default_target(&app_name, &install_path, Some("backup"), None).target_parent
    } else {
        target_root
    };
    let target_info = profile::target_info(Path::new(&target));
    let fat32 = target_info
        .file_system
        .as_deref()
        .map(|name| name.eq_ignore_ascii_case("fat32"))
        .unwrap_or(false);
    if fat32 && profile.volume_bytes > 4_294_967_295 {
        return Err("@t:archive.fat32Limit".to_string());
    }
    let store_meta = store::capture(&app, &app_name, &install);
    let title = if title.trim().is_empty() {
        install
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("game")
            .to_string()
    } else {
        title
    };
    sink.emit(ArchiveProgress {
        id: app_name.clone(),
        stage: "scanning".to_string(),
        percent: 0.0,
        processed_bytes: 0,
        total_bytes: 0,
        output_bytes: 0,
        speed_bytes: 0.0,
        eta_seconds: 0,
        current_file: String::new(),
        volume: 1,
        volume_count: 0,
        error: None,
    });
    let job = PackJob {
        app_name: app_name.clone(),
        title,
        install_path: install,
        target_root: PathBuf::from(target),
        profile,
        level: compression_level,
        window_log,
        parity_shards: super::pack::DEFAULT_PARITY_SHARDS,
        full_volume_recovery,
        xtool,
        store_meta,
        sink: sink.clone(),
        cancel: cancel.clone(),
    };
    let _awake = crate::keep_awake::keep_awake();
    let result = tauri::async_runtime::spawn_blocking(move || pack_game(job))
        .await
        .map_err(|error| error.to_string())?;
    drop(_awake);
    drop(guard);
    match result {
        Ok(outcome) => {
            let manifest = outcome.manifest;
            sink.emit(ArchiveProgress {
                id: app_name,
                stage: "done".to_string(),
                percent: 100.0,
                processed_bytes: manifest.original_bytes,
                total_bytes: manifest.original_bytes,
                output_bytes: outcome.stored_bytes,
                speed_bytes: 0.0,
                eta_seconds: 0,
                current_file: String::new(),
                volume: manifest.volumes.len() as u32,
                volume_count: manifest.volumes.len() as u32,
                error: None,
            });
            Ok(ArchiveSummary {
                app_name: manifest.app_name,
                title: manifest.title,
                store: manifest.store,
                folder: outcome.folder.display().to_string(),
                manifest_path: outcome.manifest_path.display().to_string(),
                original_bytes: manifest.original_bytes,
                stored_bytes: outcome.stored_bytes,
                volume_count: manifest.volumes.len() as u32,
                volumes: manifest.volumes,
                compression: manifest.compression,
                created_at: manifest.created_at,
                disc_layout: manifest.disc_layout,
            })
        }
        Err(error) => {
            sink.emit(failure_progress(&app_name, 0, &error));
            Err(error)
        }
    }
}

fn compression_setting(level: &str) -> Result<(i32, u32), String> {
    match level {
        "fast" => Ok((3, 24)),
        "balanced" | "" => Ok((10, 27)),
        "max" => Ok((19, 27)),
        _ => Err("@t:archive.invalidProfile".to_string()),
    }
}

#[tauri::command]
pub fn archive_cancel(app_name: String) -> bool {
    let Ok(map) = active_map().lock() else {
        return false;
    };
    if let Some(flag) = map.get(&app_name) {
        flag.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

#[tauri::command]
pub async fn archive_scan_folder(root: String) -> Result<Vec<FoundArchive>, String> {
    let root = PathBuf::from(root);
    if !root.is_dir() {
        return Err("@t:archive.sourceMissing".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut found = Vec::new();
        let mut budget = SCAN_BUDGET;
        scan_manifests(&root, SCAN_DEPTH, &mut budget, &mut found);
        // A disc-layout backup repeats the manifest in every `disc-N` folder.
        // Keep one entry per archive, preferring the copy with the most parts.
        let mut unique: HashMap<String, FoundArchive> = HashMap::new();
        for item in found {
            let key = format!(
                "{}|{}|{}",
                item.manifest.app_name,
                item.manifest.created_at,
                item.manifest.install_dir_name
            );
            let score = item
                .manifest
                .volumes
                .len()
                .saturating_sub(item.missing_volumes.len());
            match unique.get(&key) {
                Some(existing)
                    if existing
                        .manifest
                        .volumes
                        .len()
                        .saturating_sub(existing.missing_volumes.len())
                        >= score => {}
                _ => {
                    unique.insert(key, item);
                }
            }
        }
        let mut found: Vec<FoundArchive> = unique.into_values().collect();
        found.sort_by_key(|item| std::cmp::Reverse(item.manifest.created_at));
        Ok(found)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn scan_manifests(
    dir: &Path,
    depth: u8,
    budget: &mut usize,
    out: &mut Vec<FoundArchive>,
) {
    if *budget == 0 {
        return;
    }
    *budget -= 1;
    let manifest_path = dir.join(MANIFEST_FILE);
    if manifest_path.is_file() {
        if let Ok(manifest) = read_manifest(&manifest_path) {
            let (paths, missing) = locate_volumes(&manifest, dir, &[]);
            let stored_bytes = stored_bytes_on_disk(&manifest, &paths);
            out.push(FoundArchive {
                manifest_path: manifest_path.display().to_string(),
                manifest,
                missing_volumes: missing,
                stored_bytes,
            });
        }
        return;
    }
    if depth == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(meta) = std::fs::symlink_metadata(entry.path()) else {
            continue;
        };
        let file_type = meta.file_type();
        if !file_type.is_dir() || super::pack::is_link(&file_type) {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.starts_with('.')
            || name == "$recycle.bin"
            || name == "system volume information"
        {
            continue;
        }
        scan_manifests(&entry.path(), depth - 1, budget, out);
    }
}

#[tauri::command]
pub fn archive_inspect(manifest_path: String) -> Result<FoundArchive, String> {
    let path = PathBuf::from(&manifest_path);
    let (path, dir) = resolve_manifest_path(&path)?;
    let manifest = read_manifest(&path)?;
    let (paths, missing) = locate_volumes(&manifest, &dir, &[]);
    let stored_bytes = stored_bytes_on_disk(&manifest, &paths);
    Ok(FoundArchive {
        manifest_path: path.display().to_string(),
        manifest,
        missing_volumes: missing,
        stored_bytes,
    })
}

#[tauri::command]
pub fn archive_locate(
    manifest_path: String,
    extra_dirs: Vec<String>,
) -> Result<Vec<u32>, String> {
    let path = PathBuf::from(&manifest_path);
    let (path, dir) = resolve_manifest_path(&path)?;
    let manifest = read_manifest(&path)?;
    let extras: Vec<PathBuf> = extra_dirs.into_iter().map(PathBuf::from).collect();
    let (_, missing) = locate_volumes(&manifest, &dir, &extras);
    Ok(missing)
}

fn stored_bytes_on_disk(manifest: &MediaManifest, paths: &[PathBuf]) -> u64 {
    let mut total = paths
        .iter()
        .filter_map(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .fold(0u64, u64::saturating_add);
    if manifest.parity.is_some() {
        let mut dirs: Vec<PathBuf> = paths
            .iter()
            .filter_map(|path| path.parent().map(Path::to_path_buf))
            .collect();
        dirs.sort();
        dirs.dedup();
        for dir in dirs {
            if let Ok(entries) = std::fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    if entry.file_name().to_string_lossy().contains(".efxpar.") {
                        if let Ok(meta) = entry.metadata() {
                            total = total.saturating_add(meta.len());
                        }
                    }
                }
            }
        }
    }
    total
}

fn resolve_manifest_path(path: &Path) -> Result<(PathBuf, PathBuf), String> {
    if path.is_dir() {
        let candidate = path.join(MANIFEST_FILE);
        if !candidate.is_file() {
            return Err("@t:archive.manifestMissing\u{1f}manifest.efxmeta.json".to_string());
        }
        return Ok((candidate.clone(), path.to_path_buf()));
    }
    if !path.is_file() {
        return Err("@t:archive.manifestMissing\u{1f}manifest.efxmeta.json".to_string());
    }
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .ok_or_else(|| "@t:archive.invalidTarget".to_string())?;
    Ok((path.to_path_buf(), dir))
}

#[tauri::command]
pub fn archive_discs(manifest_path: String) -> Result<Vec<ArchiveDisc>, String> {
    let path = PathBuf::from(&manifest_path);
    let (path, dir) = resolve_manifest_path(&path)?;
    let manifest = read_manifest(&path)?;
    if !manifest.disc_layout {
        return Ok(Vec::new());
    }
    let mut discs = Vec::new();
    for volume in &manifest.volumes {
        let Some(file) =
            super::restore::find_volume_file(&dir, &volume.file_name, volume.bytes, 2)
        else {
            continue;
        };
        let folder = file.parent().unwrap_or(&dir).to_path_buf();
        let disc_manifest = folder.join(MANIFEST_FILE);
        if !disc_manifest.is_file() {
            let _ = std::fs::copy(&path, &disc_manifest);
        }
        let mut bytes = volume.bytes;
        if let Ok(entries) = std::fs::read_dir(&folder) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                if name.to_string_lossy().contains(".efxpar.") {
                    if let Ok(meta) = entry.metadata() {
                        bytes = bytes.saturating_add(meta.len());
                    }
                }
            }
        }
        discs.push(ArchiveDisc {
            volume_index: volume.index,
            folder: folder.display().to_string(),
            manifest_path: disc_manifest.display().to_string(),
            bytes,
        });
    }
    Ok(discs)
}

#[tauri::command]
pub async fn disc_list_recorders() -> Result<Vec<DiscRecorder>, String> {
    let _disc = disc::begin_disc_job()?;
    tauri::async_runtime::spawn_blocking(disc::list_recorders)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn disc_burn_folder(folder: String, recorder_id: String) -> Result<(), String> {
    let _disc = disc::begin_disc_job()?;
    let _awake = crate::keep_awake::keep_awake();
    tauri::async_runtime::spawn_blocking(move || {
        disc::burn_folder(Path::new(&folder), &recorder_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn disc_erase(recorder_id: String, full: bool) -> Result<(), String> {
    let _disc = disc::begin_disc_job()?;
    let _awake = crate::keep_awake::keep_awake();
    tauri::async_runtime::spawn_blocking(move || disc::erase(&recorder_id, full))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn archive_default_target(
    app_name: String,
    install_path: String,
    purpose: Option<String>,
    preferred: Option<String>,
) -> DefaultTarget {
    default_target(
        &app_name,
        &install_path,
        purpose.as_deref(),
        preferred.as_deref(),
    )
}

static WRITE_PROBE: AtomicU64 = AtomicU64::new(0);

/// Tests the nearest existing ancestor, so a backup folder that will be created
/// later is still checked against the permissions of its parent.
fn can_write_under(path: &Path) -> bool {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        let Some(parent) = probe.parent() else {
            return false;
        };
        if parent == probe {
            return false;
        }
        probe = parent.to_path_buf();
    }
    if !probe.is_dir() {
        return false;
    }
    let name = format!(
        ".efxlve-write-{}-{}.tmp",
        std::process::id(),
        WRITE_PROBE.fetch_add(1, Ordering::Relaxed)
    );
    let candidate = probe.join(name);
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&candidate)
    {
        Ok(_) => {
            let _ = std::fs::remove_file(&candidate);
            true
        }
        Err(_) => false,
    }
}

fn removable_backup_root() -> Option<PathBuf> {
    let disks = sysinfo::Disks::new_with_refreshed_list();
    disks
        .iter()
        .filter(|disk| disk.is_removable() && disk.available_space() > 0)
        .filter(|disk| !disk.file_system().is_empty())
        .filter(|disk| can_write_under(disk.mount_point()))
        .max_by_key(|disk| disk.available_space())
        .map(|disk| disk.mount_point().to_path_buf())
}

/// A last-used target is reused only when it is an absolute path that can still
/// be written to; an unplugged USB or a removed folder falls through.
fn preferred_backup_root(preferred: Option<&str>) -> Option<PathBuf> {
    let trimmed = preferred?.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() || !can_write_under(&path) {
        return None;
    }
    Some(path)
}

fn documents_backup_root() -> PathBuf {
    if cfg!(windows) {
        if let Some(home) = std::env::var_os("USERPROFILE") {
            let home = PathBuf::from(home);
            let documents = home.join("Documents").join("Efxlve Backups");
            if home.join("Documents").is_dir() && can_write_under(&documents) {
                return documents;
            }
            return home.join("Efxlve").join("Backups");
        }
        PathBuf::from(r"C:\Games")
    } else {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .map(|home| home.join("Efxlve").join("Backups"))
            .unwrap_or_else(|| PathBuf::from("."))
    }
}

fn default_target(
    app_name: &str,
    install_path: &str,
    purpose: Option<&str>,
    preferred: Option<&str>,
) -> DefaultTarget {
    let backup = purpose == Some("backup");
    let install = PathBuf::from(install_path.trim());
    let install_dir_name = install
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Game")
        .to_string();
    let mut parent = None;
    if !backup && store::store_of(app_name) == "steam" {
        parent = install
            .ancestors()
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.eq_ignore_ascii_case("steamapps"))
            })
            .map(|steamapps| steamapps.join("common"));
        if parent.is_none() {
            if let Some(steam) = crate::steam::steam_install_path() {
                if let Some(first) = crate::steam::library_folders(&steam).into_iter().next() {
                    parent = Some(first.join("common"));
                }
            }
        }
    }
    let parent = if backup {
        preferred_backup_root(preferred)
            .or_else(removable_backup_root)
            .unwrap_or_else(documents_backup_root)
    } else {
        parent
            .or_else(|| {
                install
                    .parent()
                    .filter(|value| !value.as_os_str().is_empty() && value.is_dir())
                    .map(Path::to_path_buf)
            })
            .unwrap_or_else(|| {
                if cfg!(windows) {
                    PathBuf::from(r"C:\Games")
                } else {
                    std::env::var_os("HOME")
                        .map(PathBuf::from)
                        .unwrap_or_default()
                        .join("Games")
                        .join("Efxlve")
                }
            })
    };
    let final_path = parent.join(&install_dir_name);
    DefaultTarget {
        target_parent: parent.display().to_string(),
        install_dir_name,
        final_path: final_path.display().to_string(),
    }
}

#[tauri::command]
pub async fn archive_restore(
    app: AppHandle,
    manifest_path: String,
    target_parent: String,
    extra_dirs: Vec<String>,
    overwrite: bool,
    xtool_path: Option<String>,
) -> Result<RestoreResult, String> {
    let path = PathBuf::from(&manifest_path);
    let (path, manifest_dir) = resolve_manifest_path(&path)?;
    let manifest = read_manifest(&path)?;
    let xtool = if manifest.compression.precompressor.as_deref() == Some("xtool") {
        let path = xtool_path
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty());
        match path {
            Some(path) => Some(Xtool::new(path)?),
            None => return Err("@t:archive.xtoolRequired".to_string()),
        }
    } else {
        None
    };
    let id = manifest.app_name.clone();
    if let Some((running, _)) = crate::legendary::screenshots::get_active_running_game() {
        if running == id {
            return Err("@t:archive.gameRunning".to_string());
        }
    }
    let (guard, cancel) = begin(&id)?;
    let sink: Arc<dyn ProgressSink> = Arc::new(AppProgressSink { app: app.clone() });
    let target = if target_parent.trim().is_empty() {
        default_target(&id, &manifest.original_install_path, None, None).target_parent
    } else {
        target_parent
    };
    let extras: Vec<PathBuf> = extra_dirs.into_iter().map(PathBuf::from).collect();
    sink.emit(ArchiveProgress {
        id: id.clone(),
        stage: "restoring".to_string(),
        percent: 0.0,
        processed_bytes: 0,
        total_bytes: manifest.original_bytes,
        output_bytes: 0,
        speed_bytes: 0.0,
        eta_seconds: 0,
        current_file: String::new(),
        volume: 1,
        volume_count: manifest.volumes.len() as u32,
        error: None,
    });
    let job = RestoreJob {
        manifest: manifest.clone(),
        manifest_dir,
        extra_dirs: extras,
        target_parent: PathBuf::from(target),
        overwrite,
        xtool,
        sink: sink.clone(),
        cancel,
    };
    let _awake = crate::keep_awake::keep_awake();
    let result = tauri::async_runtime::spawn_blocking(move || restore_game(job))
        .await
        .map_err(|error| error.to_string())?;
    let outcome = match result {
        Ok(outcome) => outcome,
        Err(error) => {
            sink.emit(failure_progress(&id, manifest.original_bytes, &error));
            drop(guard);
            return Err(error);
        }
    };
    sink.emit(ArchiveProgress {
        id: id.clone(),
        stage: "registering".to_string(),
        percent: 99.9,
        processed_bytes: outcome.bytes,
        total_bytes: manifest.original_bytes,
        output_bytes: 0,
        speed_bytes: 0.0,
        eta_seconds: 0,
        current_file: String::new(),
        volume: manifest.volumes.len() as u32,
        volume_count: manifest.volumes.len() as u32,
        error: None,
    });
    let local = store::register_local(&app, &manifest, &outcome.target);
    let registration = match local.pending {
        Some(StorePending::Epic(game)) => {
            store::finish_pending(&app, StorePending::Epic(game), &outcome.target).await
        }
        Some(StorePending::Amazon(product)) => {
            store::finish_pending(&app, StorePending::Amazon(product), &outcome.target).await
        }
        None => local.registration,
    };
    sink.emit(ArchiveProgress {
        id: id.clone(),
        stage: "done".to_string(),
        percent: 100.0,
        processed_bytes: outcome.bytes,
        total_bytes: manifest.original_bytes,
        output_bytes: 0,
        speed_bytes: 0.0,
        eta_seconds: 0,
        current_file: String::new(),
        volume: manifest.volumes.len() as u32,
        volume_count: manifest.volumes.len() as u32,
        error: None,
    });
    drop(guard);
    Ok(RestoreResult {
        target: outcome.target.display().to_string(),
        file_count: outcome.file_count,
        bytes: outcome.bytes,
        registration,
    })
}

#[tauri::command]
pub async fn archive_verify(
    app: AppHandle,
    manifest_path: String,
    extra_dirs: Vec<String>,
) -> Result<ArchiveVerifyResult, String> {
    let path = PathBuf::from(&manifest_path);
    let (path, manifest_dir) = resolve_manifest_path(&path)?;
    let manifest = read_manifest(&path)?;
    let (guard, cancel) = begin(&manifest.app_name)?;
    let extras: Vec<PathBuf> = extra_dirs.into_iter().map(PathBuf::from).collect();
    let sink: Arc<dyn ProgressSink> = Arc::new(AppProgressSink { app });
    sink.emit(ArchiveProgress {
        id: manifest.app_name.clone(),
        stage: "verifying".to_string(),
        percent: 0.0,
        processed_bytes: 0,
        total_bytes: manifest.original_bytes,
        output_bytes: 0,
        speed_bytes: 0.0,
        eta_seconds: 0,
        current_file: String::new(),
        volume: 1,
        volume_count: manifest.volumes.len() as u32,
        error: None,
    });
    let app_name = manifest.app_name.clone();
    let title = manifest.title.clone();
    let _awake = crate::keep_awake::keep_awake();
    let result = tauri::async_runtime::spawn_blocking(move || {
        verify_archive(&manifest, &manifest_dir, &extras, sink, cancel)
    })
    .await
    .map_err(|error| error.to_string())?;
    drop(guard);
    let outcome = result?;
    Ok(ArchiveVerifyResult {
        app_name,
        title,
        blocks: outcome.blocks,
        volume_count: outcome.volume_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "efxlve-archive-plan-{name}-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn backup_default_prefers_a_writable_last_target() {
        let root = temp_root("preferred");
        let install = root.join("Games").join("Game");
        let target = default_target(
            "epic::1",
            &install.display().to_string(),
            Some("backup"),
            Some(&root.display().to_string()),
        );
        assert_eq!(PathBuf::from(target.target_parent), root);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn restore_default_keeps_the_install_parent() {
        let root = temp_root("restore");
        let install_parent = root.join("Games");
        let install = install_parent.join("Game");
        std::fs::create_dir_all(&install).unwrap();
        let target = default_target("epic::1", &install.display().to_string(), None, None);
        assert_eq!(PathBuf::from(target.target_parent), install_parent);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_file_is_not_a_writable_target() {
        let root = temp_root("writable");
        let file = root.join("save.sav");
        std::fs::write(&file, b"data").unwrap();
        assert!(!can_write_under(&file));
        assert!(can_write_under(&root));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn full_volume_recovery_doubles_the_free_space_reserve() {
        let total = 1_000_000_000u64;
        let normal = required_archive_bytes(total, false);
        let full = required_archive_bytes(total, true);
        assert!(full > normal);
        assert!(full >= total.saturating_mul(2));
        assert!(normal < total.saturating_mul(2));
        assert!(full >= normal.saturating_mul(3) / 2);
    }

    #[test]
    fn full_volume_recovery_needs_more_discs() {
        let volume_bytes = 4_700_000_000u64;
        let normal_volume = crate::media_archive::pack::effective_volume_bytes(
            volume_bytes,
            crate::media_archive::pack::DEFAULT_PARITY_SHARDS,
            false,
        );
        let full_volume = crate::media_archive::pack::effective_volume_bytes(
            volume_bytes,
            crate::media_archive::pack::DEFAULT_PARITY_SHARDS,
            true,
        );
        assert!(full_volume < normal_volume);
        let normal = crate::media_archive::profile::worst_case_volumes(volume_bytes, normal_volume);
        let full = crate::media_archive::profile::worst_case_volumes(volume_bytes, full_volume);
        assert!(full > normal, "full={full} normal={normal}");
        assert_eq!(
            crate::media_archive::pack::effective_volume_bytes(0, 4, true),
            0
        );
    }
}


