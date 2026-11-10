//! Local save backup and restore manager.
//!
//! Backups are kept under `%USERPROFILE%\.config\legendary\backups\<app_name>\<backup_id>\`.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SaveBackupInfo {
    pub id: String,
    pub app_name: String,
    pub timestamp: u64,
    pub formatted_date: String,
    pub size_bytes: u64,
    pub file_count: usize,
    pub save_path: String,
    /// Recognized logical root (`LocalAppData`, `Documents`, `SavedGames`,
    /// `RoamingAppData`, `Home`) or `Absolute` when no known root matches.
    #[serde(default)]
    pub save_root: String,
    /// Path below `save_root`, with forward slashes. Empty for `Absolute`.
    #[serde(default)]
    pub save_rel: String,
    /// SHA-256 of the copied save tree, independent of timestamps. Older
    /// backups have no value and fall back to the timestamp conflict check.
    #[serde(default)]
    pub content_hash: Option<String>,
    /// A human title carried by an imported archive, so a game that is not
    /// installed yet still has a name in the backups list.
    #[serde(default)]
    pub title: Option<String>,
    /// The game key this archive was exported from, when it was imported from
    /// another store or PC. `None` for a backup made on this game.
    #[serde(default)]
    pub origin_app_name: Option<String>,
    /// UNIX seconds when the archive was imported; `None` for a local backup.
    #[serde(default)]
    pub imported_at: Option<u64>,
}

/// File under the legendary config dir that stores a user-chosen local backup
/// root. Missing or empty means `backups` next to it.
const LOCAL_BACKUP_DIR_FILE: &str = "local_backup_dir.txt";

/// The root of the local save backups, honouring a user-chosen folder.
pub fn backups_base_dir() -> PathBuf {
    let config = super::skip::default_config_dir();
    match configured_backups_dir() {
        text if !text.is_empty() => PathBuf::from(text),
        _ => config.join("backups"),
    }
}

/// The configured override, or an empty string when the default is used.
fn configured_backups_dir() -> String {
    std::fs::read_to_string(super::skip::default_config_dir().join(LOCAL_BACKUP_DIR_FILE))
        .ok()
        .map(|text| text.trim().to_string())
        .unwrap_or_default()
}

/// What the settings field shows: the saved override and the folder in use.
#[derive(Debug, Clone, Serialize)]
pub struct LocalBackupRoot {
    pub configured: String,
    pub effective: String,
}

pub fn local_backup_root() -> LocalBackupRoot {
    LocalBackupRoot {
        configured: configured_backups_dir(),
        effective: backups_base_dir().display().to_string(),
    }
}

/// Stores a user-chosen backup root. An empty value restores the default.
pub fn set_backups_dir(path: &str) -> Result<(), String> {
    let config = super::skip::default_config_dir();
    let target = config.join(LOCAL_BACKUP_DIR_FILE);
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return match std::fs::remove_file(&target) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("@t:cloud.localDirWrite\u{1f}{error}")),
        };
    }
    let dir = PathBuf::from(trimmed);
    if !dir.is_dir() {
        return Err("@t:cloud.localDirMissing".to_string());
    }
    let probe = dir.join(".efxlve-write-test");
    std::fs::write(&probe, b"ok").map_err(|error| format!("@t:cloud.localDirWrite\u{1f}{error}"))?;
    let _ = std::fs::remove_file(&probe);
    std::fs::create_dir_all(&config).map_err(|error| format!("@t:cloud.localDirWrite\u{1f}{error}"))?;
    std::fs::write(&target, trimmed).map_err(|error| format!("@t:cloud.localDirWrite\u{1f}{error}"))
}

/// A filesystem-safe folder name for a game key. Store keys contain `::`
/// (`gog::123`, `steam::456`), which is invalid in a Windows path segment and
/// made every non-Epic local backup fail. Epic names pass through unchanged.
pub fn backup_key(app_name: &str) -> String {
    let mut key = String::with_capacity(app_name.len());
    let mut chars = app_name.chars().peekable();
    while let Some(c) = chars.next() {
        if c == ':' && chars.peek() == Some(&':') {
            chars.next();
            key.push_str("__");
        } else if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
            key.push(c);
        } else {
            key.push('_');
        }
    }
    let trimmed = key.trim_matches(|c| c == '_' || c == '.');
    if trimmed.is_empty() {
        "game".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn app_backup_dir(app_name: &str) -> PathBuf {
    backups_base_dir().join(backup_key(app_name))
}

/// Moves a backup folder created before `backup_key` (`gog::123`, `steam::456`)
/// under the current safe key, so the list keeps showing old backups.
///
/// The legacy name is the raw app key, which used to be a valid Windows folder
/// name for Epic titles and an invalid one for every other store. Only the base
/// directory is touched; separators are rejected so a key can never climb out.
fn migrate_legacy_dir_in(base: &Path, app_name: &str) -> Option<PathBuf> {
    let key = backup_key(app_name);
    if key == app_name
        || app_name.is_empty()
        || app_name == "."
        || app_name == ".."
        || app_name.contains(['/', '\\'])
    {
        return None;
    }
    let legacy = base.join(app_name);
    let target = base.join(&key);
    if !legacy.is_dir() || legacy == target {
        return None;
    }
    if !target.exists() {
        return std::fs::rename(&legacy, &target).ok().map(|_| target);
    }
    // A backup taken after the fix already owns the safe folder: move the old
    // children in without overwriting, then drop the now-empty legacy folder.
    let Ok(entries) = std::fs::read_dir(&legacy) else {
        return None;
    };
    for entry in entries.flatten() {
        let destination = target.join(entry.file_name());
        if !destination.exists() {
            let _ = std::fs::rename(entry.path(), destination);
        }
    }
    let _ = std::fs::remove_dir(&legacy);
    Some(target)
}

fn migrate_legacy_dir(app_name: &str) -> Option<PathBuf> {
    migrate_legacy_dir_in(&backups_base_dir(), app_name)
}

/// Shared by the local list and the folder provider so both show the same date.
pub fn format_backup_timestamp(ts: u64) -> String {
    let days = ts / 86400;
    let rem = ts % 86400;
    let hours = rem / 3600;
    let minutes = (rem % 3600) / 60;
    let approx_year = 1970 + days / 365;
    format!("{approx_year:04} ({hours:02}:{minutes:02} UTC)")
}

fn copy_dir_all(src: &Path, dst: &Path) -> std::io::Result<(u64, usize)> {
    let mut total_bytes = 0u64;
    let mut file_count = 0usize;

    if !dst.exists() {
        std::fs::create_dir_all(dst)?;
    }

    if src.is_file() {
        let n = std::fs::copy(src, dst.join(src.file_name().unwrap_or_default()))?;
        return Ok((n, 1));
    }

    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());

        if ty.is_dir() {
            let (sub_bytes, sub_count) = copy_dir_all(&from, &to)?;
            total_bytes += sub_bytes;
            file_count += sub_count;
        } else {
            let bytes = std::fs::copy(&from, &to)?;
            total_bytes += bytes;
            file_count += 1;
        }
    }

    Ok((total_bytes, file_count))
}

/// Copies the current save folder into the local backup store before a restore
/// overwrites it. A failed snapshot aborts the restore: losing the current
/// saves is worse than a refused restore.
/// Collects every regular file under a save tree with its relative path.
fn collect_tree_files(root: &Path, base: &Path, files: &mut Vec<(String, PathBuf)>) {
    let Ok(entries) = std::fs::read_dir(root) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        let path = entry.path();
        if file_type.is_dir() {
            collect_tree_files(&path, base, files);
        } else if file_type.is_file() {
            let rel = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            files.push((rel, path));
        }
    }
}

/// SHA-256 over sorted relative paths and file bytes. Timestamps are ignored,
/// so the same saves produce the same hash on Windows and Unix.
pub fn tree_content_hash(root: &Path) -> Option<String> {
    if !root.is_dir() {
        return None;
    }
    let mut files = Vec::new();
    collect_tree_files(root, root, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    let mut hasher = Sha256::new();
    for (rel, path) in files {
        hasher.update(rel.as_bytes());
        hasher.update([0]);
        let Ok(mut file) = std::fs::File::open(&path) else {
            continue;
        };
        let mut buffer = [0u8; 16384];
        loop {
            match file.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => hasher.update(&buffer[..count]),
                Err(_) => break,
            }
        }
        hasher.update([0]);
    }
    Some(format!("{:x}", hasher.finalize()))
}

fn classify_save_path_with(
    path: &Path,
    home: &Path,
    local: Option<&Path>,
    roaming: Option<&Path>,
) -> (String, String) {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    let mut candidates: Vec<(&str, PathBuf)> = Vec::new();
    if let Some(local) = local {
        candidates.push(("LocalAppData", local.to_path_buf()));
    }
    if let Some(roaming) = roaming {
        candidates.push(("RoamingAppData", roaming.to_path_buf()));
    }
    candidates.push(("Documents", home.join("Documents")));
    candidates.push(("SavedGames", home.join("Saved Games")));
    candidates.push(("Home", home.to_path_buf()));
    for (kind, root) in candidates {
        let Ok(root) = root.canonicalize() else {
            continue;
        };
        if let Ok(rel) = canonical.strip_prefix(&root) {
            if !rel.as_os_str().is_empty() {
                return (
                    kind.to_string(),
                    rel.to_string_lossy().replace('\\', "/"),
                );
            }
        }
    }
    ("Absolute".to_string(), String::new())
}

/// Splits a save folder into a recognized root and a relative path. Older
/// backups only stored the absolute path; these fields make the same archive
/// restorable on another user account or a different PC.
pub fn save_root_kind(path: &Path) -> (String, String) {
    let Some(home) = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
    else {
        return ("Absolute".to_string(), String::new());
    };
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    classify_save_path_with(path, &home, local.as_deref(), roaming.as_deref())
}

fn root_path_with(
    kind: &str,
    home: &Path,
    local: Option<&Path>,
    roaming: Option<&Path>,
) -> Option<PathBuf> {
    let path = match kind {
        "LocalAppData" => local
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("XDG_DATA_HOME").map(PathBuf::from))
            .or_else(|| Some(home.join(".local").join("share"))),
        "RoamingAppData" => roaming
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from))
            .or_else(|| Some(home.join(".config"))),
        "Documents" => Some(home.join("Documents")),
        "SavedGames" => Some(home.join("Saved Games")),
        "Home" => Some(home.to_path_buf()),
        _ => None,
    }?;
    path.is_dir().then_some(path)
}

fn safe_save_rel(value: &str) -> Option<PathBuf> {
    let path = Path::new(value);
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

/// Resolves a stored logical root on this machine. `None` means the caller
/// should fall back to the absolute path and the old detection order.
pub fn backup_destination(info: &SaveBackupInfo) -> Option<PathBuf> {
    if info.save_root.is_empty() || info.save_rel.is_empty() {
        return None;
    }
    let rel = safe_save_rel(&info.save_rel)?;
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)?;
    let local = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    let roaming = std::env::var_os("APPDATA").map(PathBuf::from);
    let base = root_path_with(&info.save_root, &home, local.as_deref(), roaming.as_deref())?;
    Some(base.join(rel))
}

/// The folder a restore writes. The preview and the restore both call this,
/// so the dialog can never name a different folder from the one the copy
/// touches. Order: a logical profile root on this PC, the recorded absolute
/// path, a custom save path, a re-rooted old profile path, then detection.
fn resolve_restore_destination(app_name: &str, info: &SaveBackupInfo) -> PathBuf {
    let logical = backup_destination(info);
    let mut dest = logical
        .clone()
        .unwrap_or_else(|| PathBuf::from(&info.save_path));
    if logical.is_some() || dest.exists() {
        return dest;
    }

    let cfgs = super::commands::load_all_game_custom_configs();
    let custom = cfgs
        .get(app_name)
        .and_then(|cfg| cfg.custom_save_path.as_deref())
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.exists());
    if let Some(path) = custom {
        dest = path;
    } else if let Ok(current_user) =
        std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME"))
    {
        let path_str = info.save_path.replace('\\', "/");
        for marker in ["/Saved Games/", "/Documents/", "/AppData/"] {
            if let Some(index) = path_str.find(marker) {
                dest = Path::new(&current_user)
                    .join(path_str[index + 1..].replace('/', std::path::MAIN_SEPARATOR_STR));
                break;
            }
        }
    }
    if !dest.exists() {
        let installed = super::cache::read_installed(&super::skip::default_config_dir());
        let installed_game = installed.into_iter().find(|g| g.app_name == app_name);
        let title = installed_game.as_ref().map(|g| g.title.as_str());
        let install_path = installed_game.as_ref().map(|g| g.install_path.as_str());
        if let Some(detected) = detect_save_path(app_name, title, install_path) {
            dest = PathBuf::from(detected);
        }
    }
    dest
}

/// How many files a restore preview lists. The rest are summarized by count,
/// so a 40,000-file save tree never builds a huge IPC payload.
const PREVIEW_FILE_LIMIT: usize = 200;

/// One file inside a local backup, relative to its `data/` folder.
#[derive(Debug, Clone, Serialize)]
pub struct BackupPreviewFile {
    pub path: String,
    pub size: u64,
}

/// What the user sees before a local backup overwrites the save folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupPreview {
    pub app_name: String,
    pub backup_id: String,
    pub timestamp: u64,
    pub formatted_date: String,
    pub total_bytes: u64,
    pub file_count: usize,
    pub files: Vec<BackupPreviewFile>,
    pub truncated: bool,
    pub save_path: String,
    /// `logical` when the path was rebuilt from a profile root on this PC,
    /// `absolute` when the record only held a literal path.
    pub path_source: String,
    pub current_hash: Option<String>,
    pub backup_hash: Option<String>,
    /// True when the files in `data/` no longer match the checksum recorded
    /// when the backup was created. A damaged backup is never restored.
    pub damaged: bool,
    /// True when the save folder already matches the backup byte for byte.
    pub same_content: bool,
    pub target_exists: bool,
    /// The game key this archive was exported from, when it was imported from
    /// another store or PC.
    pub origin_app_name: Option<String>,
    /// UNIX seconds when the archive was imported; `None` for a local backup.
    pub imported_at: Option<u64>,
}

/// A backup id is one folder name: `1750000000` or `pre-restore-…`. Anything
/// with a separator, a drive prefix or `..` would escape the backup root.
fn safe_backup_id(value: &str) -> Result<&str, String> {
    let trimmed = value.trim();
    let mut components = Path::new(trimmed).components();
    let single = matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none();
    if trimmed.is_empty() || !single {
        return Err("@t:backup.invalidId".to_string());
    }
    Ok(trimmed)
}

/// Verifies the copied save tree against the checksum recorded when the backup
/// was made. Older backups carry no checksum and stay restorable; a checksum
/// mismatch means the files changed or were corrupted on disk.
fn verify_backup_tree(info: &SaveBackupInfo, data_src: &Path) -> Result<(), String> {
    let Some(recorded) = info
        .content_hash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    else {
        return Ok(());
    };
    let actual = tree_content_hash(data_src)
        .ok_or_else(|| "@t:backup.dataFolderNotFound".to_string())?;
    if actual != recorded {
        return Err("@t:backup.damaged".to_string());
    }
    Ok(())
}

fn preview_from_backup_dir(
    app_name: &str,
    backup_id: &str,
    backup_dir: &Path,
) -> Result<BackupPreview, String> {
    let info_path = backup_dir.join("backup_info.json");
    if !info_path.exists() {
        return Err("@t:backup.infoNotFound".to_string());
    }
    let content = std::fs::read_to_string(&info_path).map_err(|e| e.to_string())?;
    let info: SaveBackupInfo = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    let data_src = backup_dir.join("data");
    if !data_src.is_dir() {
        return Err("@t:backup.dataFolderNotFound".to_string());
    }

    // The same resolution restore_backup uses, so the preview never promises a
    // different folder from the one the restore would write.
    let destination = resolve_restore_destination(app_name, &info);
    let path_source = if backup_destination(&info).is_some() {
        "logical"
    } else if destination == PathBuf::from(&info.save_path) {
        "absolute"
    } else {
        "detected"
    };
    let target_exists = destination.is_dir();
    let current_hash = tree_content_hash(&destination);
    let actual_backup_hash = tree_content_hash(&data_src);
    let recorded_hash = info
        .content_hash
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let damaged = matches!(
        (recorded_hash, actual_backup_hash.as_deref()),
        (Some(recorded), Some(actual)) if recorded != actual
    );
    let backup_hash = recorded_hash
        .map(str::to_string)
        .or(actual_backup_hash);
    let same_content = matches!(
        (&current_hash, &backup_hash),
        (Some(current), Some(backup)) if current == backup
    );

    let mut tree = Vec::new();
    collect_tree_files(&data_src, &data_src, &mut tree);
    tree.sort_by(|left, right| left.0.cmp(&right.0));
    let file_count = if info.file_count > 0 {
        info.file_count
    } else {
        tree.len()
    };
    let truncated = tree.len() > PREVIEW_FILE_LIMIT;
    let total_bytes = if info.size_bytes > 0 {
        info.size_bytes
    } else {
        tree.iter()
            .filter_map(|(_, path)| std::fs::metadata(path).ok())
            .map(|meta| meta.len())
            .sum()
    };
    let files = tree
        .into_iter()
        .take(PREVIEW_FILE_LIMIT)
        .map(|(path, source)| {
            let size = std::fs::metadata(&source).map(|meta| meta.len()).unwrap_or(0);
            BackupPreviewFile { path, size }
        })
        .collect();

    Ok(BackupPreview {
        app_name: app_name.to_string(),
        backup_id: backup_id.to_string(),
        timestamp: info.timestamp,
        formatted_date: info.formatted_date,
        total_bytes,
        file_count,
        files,
        truncated,
        save_path: destination.to_string_lossy().to_string(),
        path_source: path_source.to_string(),
        current_hash,
        backup_hash,
        damaged,
        same_content,
        target_exists,
        origin_app_name: info.origin_app_name,
        imported_at: info.imported_at,
    })
}

/// True when the save tree on disk still has the hash the preview described.
fn save_tree_matches(destination: &Path, expected: &str) -> bool {
    tree_content_hash(destination).as_deref() == Some(expected)
}

/// Describes a local backup without touching the save folder.
pub fn preview_backup(app_name: &str, backup_id: &str) -> Result<BackupPreview, String> {
    migrate_legacy_dir(app_name);
    let id = safe_backup_id(backup_id)?;
    preview_from_backup_dir(app_name, id, &app_backup_dir(app_name).join(id))
}

fn snapshot_before_restore(app_name: &str, save_path: &Path) -> Result<Option<String>, String> {
    if !save_path.exists() {
        return Ok(None);
    }

    let now_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let mut backup_id = format!("pre-restore-{now_ts}");
    let mut target = app_backup_dir(app_name).join(&backup_id);
    let mut suffix = 1;
    while target.exists() {
        backup_id = format!("pre-restore-{now_ts}-{suffix}");
        target = app_backup_dir(app_name).join(&backup_id);
        suffix += 1;
    }
    std::fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let (size_bytes, file_count) = copy_dir_all(save_path, &target.join("data"))
        .map_err(|error| format!("@t:backup.copyFailed\u{1f}{error}"))?;
    let content_hash = tree_content_hash(&target.join("data"));
    let (save_root, save_rel) = save_root_kind(save_path);
    let info = SaveBackupInfo {
        id: backup_id.clone(),
        app_name: app_name.to_string(),
        timestamp: now_ts,
        formatted_date: format_backup_timestamp(now_ts),
        size_bytes,
        file_count,
        save_path: save_path.to_string_lossy().to_string(),
        save_root,
        save_rel,
        content_hash,
        title: None,

        origin_app_name: None,
        imported_at: None,
    };
    let info_json = serde_json::to_string_pretty(&info).map_err(|error| error.to_string())?;
    std::fs::write(target.join("backup_info.json"), info_json).map_err(|error| error.to_string())?;
    Ok(Some(backup_id))
}

fn normalize_for_match(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn build_search_candidates(
    app_name: &str,
    title: Option<&str>,
    install_path: Option<&str>,
) -> (Vec<String>, Vec<String>) {
    let mut names: Vec<String> = Vec::new();

    let app_clean = app_name.trim();
    if !app_clean.is_empty() {
        names.push(app_clean.to_string());
        names.push(app_clean.replace(' ', ""));
        names.push(app_clean.replace([':', '-', '_', '\'', '\"', '™', '®', '©'], ""));
    }

    if let Some(t) = title {
        let t_clean = t.trim();
        if !t_clean.is_empty() {
            names.push(t_clean.to_string());
            names.push(t_clean.replace(' ', ""));
            names.push(t_clean.replace([':', '-', '_', '\'', '\"', '™', '®', '©'], ""));

            if let Some((main, sub)) = t_clean.split_once(':') {
                let m = main.trim();
                let s = sub.trim();
                if !m.is_empty() {
                    names.push(m.to_string());
                    names.push(m.replace([':', '-', '_', '\'', '\"', '™', '®', '©'], ""));
                }
                if !s.is_empty() {
                    names.push(s.to_string());
                    names.push(s.replace([':', '-', '_', '\'', '\"', '™', '®', '©'], ""));
                }
            } else if let Some((main, sub)) = t_clean.split_once(" - ") {
                let m = main.trim();
                let s = sub.trim();
                if !m.is_empty() {
                    names.push(m.to_string());
                }
                if !s.is_empty() {
                    names.push(s.to_string());
                }
            }
        }
    }

    if let Some(ip) = install_path {
        let p = Path::new(ip);
        if let Some(fn_os) = p.file_name().and_then(|n| n.to_str()) {
            let fn_trim = fn_os.trim();
            if !fn_trim.is_empty() {
                names.push(fn_trim.to_string());
                names.push(fn_trim.replace([':', '-', '_', '\'', '\"'], ""));
            }
        }
    }

    names.retain(|n| !n.trim().is_empty());
    names.dedup();

    let mut normalized: Vec<String> = names
        .iter()
        .map(|n| normalize_for_match(n))
        .filter(|k| !k.is_empty())
        .collect();
    normalized.dedup();

    (names, normalized)
}

fn is_dir_match(dir_name: &str, names: &[String], normalized: &[String]) -> bool {
    for n in names {
        if n.eq_ignore_ascii_case(dir_name) {
            return true;
        }
    }
    let dir_norm = normalize_for_match(dir_name);
    if !dir_norm.is_empty() {
        for k in normalized {
            if k == &dir_norm {
                return true;
            }
        }
    }
    false
}

fn scan_folder_for_game(
    base: &Path,
    names: &[String],
    normalized: &[String],
    allow_nested: bool,
    require_save_files: bool,
) -> Option<PathBuf> {
    if !base.is_dir() {
        return None;
    }

    let entries = match std::fs::read_dir(base) {
        Ok(e) => e.flatten().collect::<Vec<_>>(),
        Err(_) => return None,
    };

    // 1. Direct children
    for entry in &entries {
        if let Ok(file_type) = entry.file_type() {
            if file_type.is_dir() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if is_dir_match(&name_str, names, normalized) {
                    let path = entry.path();
                    if !require_save_files || has_save_like_files(&path) {
                        return Some(path);
                    }
                }
            }
        }
    }

    // 2. 1-level nested children (Publisher/Studio folder, e.g. CD Projekt Red, Rockstar Games, etc.)
    if allow_nested {
        for entry in &entries {
            if let Ok(file_type) = entry.file_type() {
                if file_type.is_dir() {
                    let pub_path = entry.path();
                    if let Ok(sub_entries) = std::fs::read_dir(&pub_path) {
                        for sub_entry in sub_entries.flatten() {
                            if let Ok(sub_type) = sub_entry.file_type() {
                                if sub_type.is_dir() {
                                    let sub_name = sub_entry.file_name();
                                    let sub_name_str = sub_name.to_string_lossy();
                                    if is_dir_match(&sub_name_str, names, normalized) {
                                        let path = sub_entry.path();
                                        if !require_save_files || has_save_like_files(&path) {
                                            return Some(path);
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    None
}

fn check_unreal_or_direct(candidate: &Path) -> Option<PathBuf> {
    let saved_games = candidate.join("Saved").join("SaveGames");
    if saved_games.is_dir() {
        return Some(saved_games);
    }
    let saved = candidate.join("Saved");
    if saved.is_dir() {
        return Some(saved);
    }
    if has_save_like_files(candidate) {
        return Some(candidate.to_path_buf());
    }
    None
}

/// Helper that checks if a directory contains save-related files or subdirectories
fn has_save_like_files(dir: &Path) -> bool {
    let mut dirs_to_check = vec![dir.to_path_buf()];
    let mut depth = 0;

    while let Some(current_dir) = dirs_to_check.pop() {
        if let Ok(entries) = std::fs::read_dir(&current_dir) {
            for entry in entries.flatten() {
                let p = entry.path();
                let name_low = p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                if p.is_file() {
                    if name_low.contains("save")
                        || name_low.ends_with(".sav")
                        || name_low.ends_with(".dat")
                        || name_low.ends_with(".bin")
                        || name_low.ends_with(".json")
                        || name_low.ends_with(".xml")
                        || name_low.ends_with(".profile")
                        || name_low.ends_with(".sl2")
                        || name_low.ends_with(".vdf")
                        || name_low.starts_with("srdr")
                        || name_low.starts_with("sgta")
                    {
                        return true;
                    }
                } else if p.is_dir() && depth < 2 {
                    if name_low.contains("save")
                        || name_low == "profiles"
                        || name_low == "users"
                        || name_low == "data"
                        || (name_low.len() >= 16 && name_low.chars().all(|c| c.is_ascii_hexdigit()))
                    {
                        return true;
                    }
                    dirs_to_check.push(p);
                }
            }
        }
        depth += 1;
        if depth > 3 {
            break;
        }
    }

    if let Ok(mut entries) = std::fs::read_dir(dir) {
        if entries.next().is_some() {
            return true;
        }
    }
    false
}

/// Attempts to automatically discover the local save directory for a game.
///
/// Windows searches the standard profile locations (Saved Games, Documents,
/// LocalAppData, LocalLow, Roaming). Linux/macOS search the XDG data/config
/// homes, Documents, Unity's `unity3d` tree and the Wine/Proton prefixes the
/// launcher creates.
/// Steam keeps per-account saves under `userdata/<account>/<appid>`. The
/// folder is shared by every PC, so it is a stronger signal than a title match.
/// Returns the newest non-empty `remote` folder across accounts.
fn steam_userdata_save(app_name: &str) -> Option<PathBuf> {
    let app_id = app_name.strip_prefix("steam::")?;
    if app_id.is_empty() || !app_id.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let root = crate::steam::steam_install_path()?;
    let accounts = std::fs::read_dir(root.join("userdata")).ok()?;
    let mut best: Option<(u64, PathBuf)> = None;
    for account in accounts.flatten() {
        if !account.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let base = account.path().join(app_id);
        for candidate in [base.join("remote"), base] {
            if !candidate.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&candidate) else {
                continue;
            };
            let mut newest = 0u64;
            let mut has_file = false;
            for file in files.flatten() {
                let Ok(meta) = file.metadata() else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                has_file = true;
                let stamp = meta
                    .modified()
                    .ok()
                    .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                newest = newest.max(stamp);
            }
            if !has_file {
                continue;
            }
            if best.as_ref().map(|(stamp, _)| newest > *stamp).unwrap_or(true) {
                best = Some((newest, candidate));
            }
            break;
        }
    }
    best.map(|(_, path)| path)
}

pub fn detect_save_path(
    app_name: &str,
    title: Option<&str>,
    install_path: Option<&str>,
) -> Option<String> {
    if let Some(path) = steam_userdata_save(app_name) {
        return Some(path.to_string_lossy().to_string());
    }
    // 0. Fast-path known save locations for popular titles
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let base = Path::new(&user_profile);
        let title_low = title.unwrap_or("").to_lowercase();
        let app_low = app_name.to_lowercase();

        if app_low == "ginger" || title_low.contains("cyberpunk") {
            let cp_path = base
                .join("Saved Games")
                .join("CD Projekt Red")
                .join("Cyberpunk 2077");
            if cp_path.is_dir() {
                return Some(cp_path.to_string_lossy().to_string());
            }
        }

        if app_low == "heather" || title_low.contains("red dead redemption") {
            let rdr2_path = base
                .join("Documents")
                .join("Rockstar Games")
                .join("Red Dead Redemption 2");
            if rdr2_path.is_dir() {
                return Some(rdr2_path.to_string_lossy().to_string());
            }
        }

        if title_low.contains("grand theft auto") || title_low.contains("gta") {
            for sub in ["GTAV Enhanced", "GTA V", "Grand Theft Auto V"] {
                let gta_path = base.join("Documents").join("Rockstar Games").join(sub);
                if gta_path.is_dir() {
                    return Some(gta_path.to_string_lossy().to_string());
                }
            }
        }

        if title_low.contains("spider-man") || title_low.contains("spiderman") {
            for sub in [
                "Marvel's Spider-Man Remastered",
                "Marvel's Spider-Man Miles Morales",
            ] {
                let sm_path = base.join("Documents").join(sub);
                if sm_path.is_dir() {
                    return Some(sm_path.to_string_lossy().to_string());
                }
            }
        }

        if title_low.contains("uncharted") {
            let uc_path = base
                .join("Saved Games")
                .join("Uncharted Legacy of Thieves Collection");
            if uc_path.is_dir() {
                return Some(uc_path.to_string_lossy().to_string());
            }
        }
    }

    // The bundled Ludusavi index names the save tree directly for 11k titles,
    // including games none of the generic folder scans know. It runs before the
    // scans because its paths are concrete, not guesses.
    if let Some(found) = crate::ludusavi::save_path(app_name, title, install_path) {
        return Some(found);
    }

    // Unix: XDG directories, Unity's tree and the launcher's Wine/Proton
    // prefixes. The Windows branches below are harmless there (`USERPROFILE`
    // and the AppData variables are absent), so this is an extra first pass.
    #[cfg(not(windows))]
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        let data_home = std::env::var_os("XDG_DATA_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".local").join("share"));
        let config_home = std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".config"));
        if let Some(found) = detect_save_path_unix(&home, &data_home, &config_home, app_name, title)
        {
            return Some(found);
        }
    }

    let (names, normalized) = build_search_candidates(app_name, title, install_path);

    // 1. %USERPROFILE%\Saved Games (direct and publisher subfolder)
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let base = Path::new(&user_profile);
        let saved_games_dir = base.join("Saved Games");
        if let Some(found) =
            scan_folder_for_game(&saved_games_dir, &names, &normalized, true, false)
        {
            return Some(found.to_string_lossy().to_string());
        }

        // 2. %USERPROFILE%\Documents\My Games (direct and publisher subfolder)
        let my_games = base.join("Documents").join("My Games");
        if let Some(found) = scan_folder_for_game(&my_games, &names, &normalized, true, false) {
            let inner_saved = found.join("Saved").join("SaveGames");
            if inner_saved.is_dir() {
                return Some(inner_saved.to_string_lossy().to_string());
            }
            let inner_saves = found.join("Saves");
            if inner_saves.is_dir() {
                return Some(inner_saves.to_string_lossy().to_string());
            }
            return Some(found.to_string_lossy().to_string());
        }

        // 3. %USERPROFILE%\Documents (direct and publisher subfolder)
        let docs = base.join("Documents");
        if let Some(found) = scan_folder_for_game(&docs, &names, &normalized, true, true) {
            return Some(found.to_string_lossy().to_string());
        }

        // 4. %USERPROFILE%\AppData\LocalLow (Unity games: <Publisher>\<Game>)
        let locallow = base.join("AppData").join("LocalLow");
        if let Some(found) = scan_folder_for_game(&locallow, &names, &normalized, true, false) {
            return Some(found.to_string_lossy().to_string());
        }
    }

    // 5. %LOCALAPPDATA% (Unreal Engine games, Unity, indie games)
    if let Ok(local_app) = std::env::var("LOCALAPPDATA") {
        let base = Path::new(&local_app);
        if let Some(found) = scan_folder_for_game(base, &names, &normalized, true, false) {
            if let Some(ue_path) = check_unreal_or_direct(&found) {
                return Some(ue_path.to_string_lossy().to_string());
            }
        }
    }

    // 6. %APPDATA% (Roaming)
    if let Ok(roaming) = std::env::var("APPDATA") {
        let base = Path::new(&roaming);
        if let Some(found) = scan_folder_for_game(base, &names, &normalized, true, true) {
            return Some(found.to_string_lossy().to_string());
        }
    }

    // 7. Inside install_path
    if let Some(ip) = install_path {
        let p = Path::new(ip);
        if p.is_dir() {
            for sub in ["Saved\\SaveGames", "Saved", "Saves", "save", "Save"] {
                let candidate = p.join(sub);
                if candidate.is_dir() {
                    return Some(candidate.to_string_lossy().to_string());
                }
            }
        }
    }

    None
}

/// Every user directory inside a Wine/Proton prefix (`drive_c/users/<name>`).
#[cfg(any(not(windows), test))]
fn prefix_user_dirs(prefix: &Path) -> Vec<PathBuf> {
    let mut users = Vec::new();
    if let Ok(entries) = std::fs::read_dir(prefix.join("drive_c").join("users")) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                users.push(path);
            }
        }
    }
    users
}

/// Runs the ordered root list and returns the first match.
#[cfg(any(not(windows), test))]
fn scan_unix_roots(
    roots: &[(PathBuf, bool, bool)],
    names: &[String],
    normalized: &[String],
) -> Option<String> {
    for (root, nested, require_files) in roots {
        if let Some(found) = scan_folder_for_game(root, names, normalized, *nested, *require_files)
        {
            return Some(found.to_string_lossy().to_string());
        }
    }
    None
}

/// Save locations on Linux/macOS.
///
/// The home, data and config roots are arguments rather than environment reads
/// so the layout can be unit-tested on every platform. Proton keeps the Windows
/// tree under `pfx/drive_c`, and the launcher's own prefixes live under
/// `~/Games/Efxlve/Prefixes`. A prefix named after the game is scanned first;
/// the other prefixes are only touched when it has no saves, which keeps the
/// common case to one directory tree.
/// Every Proton prefix a Steam library holds. The app id in the folder name is
/// Steam's, not the launcher's, so the caller has to search the prefixes.
#[cfg(any(not(windows), test))]
fn compat_prefixes_in(libraries: &[PathBuf]) -> Vec<PathBuf> {
    let mut prefixes = Vec::new();
    for library in libraries {
        let compatdata = library.join("steamapps").join("compatdata");
        let Ok(entries) = std::fs::read_dir(compatdata) else {
            continue;
        };
        for entry in entries.flatten() {
            let pfx = entry.path().join("pfx");
            if pfx.is_dir() {
                prefixes.push(pfx);
            }
        }
    }
    prefixes
}

#[cfg(any(not(windows), test))]
fn steam_compat_prefixes() -> Vec<PathBuf> {
    let Some(steam) = crate::steam::steam_install_path() else {
        return Vec::new();
    };
    let libraries = crate::steam::library_folders(&steam);
    compat_prefixes_in(&libraries)
}

#[cfg(any(not(windows), test))]
fn detect_save_path_unix(
    home: &Path,
    data_home: &Path,
    config_home: &Path,
    app_name: &str,
    title: Option<&str>,
) -> Option<String> {
    let (names, normalized) = build_search_candidates(app_name, title, None);

    // `nested` allows one publisher directory; `require_files` only accepts a
    // folder that holds something save-like, so a bare name match in a shared
    // directory does not win over a real save folder.
    let mut standard: Vec<(PathBuf, bool, bool)> = vec![
        (data_home.to_path_buf(), false, false),
        (config_home.join("unity3d"), true, false),
        (home.join("Documents"), true, true),
        (home.join("Saved Games"), true, true),
    ];
    if cfg!(target_os = "macos") {
        standard.push((
            home.join("Library").join("Application Support"),
            true,
            true,
        ));
    }
    if let Some(found) = scan_unix_roots(&standard, &names, &normalized) {
        return Some(found);
    }

    let prefix_root = home.join("Games").join("Efxlve").join("Prefixes");
    let mut prefixes = Vec::new();
    let preferred = prefix_root.join(app_name);
    if preferred.is_dir() {
        prefixes.push(preferred);
    }
    if let Ok(entries) = std::fs::read_dir(&prefix_root) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() && !prefixes.contains(&path) {
                prefixes.push(path);
            }
        }
    }
    // Windows keeps user data in these four folders inside the prefix.
    const SUBDIRS: [&[&str]; 4] = [
        &["AppData", "Local"],
        &["AppData", "LocalLow"],
        &["Documents"],
        &["Saved Games"],
    ];
    for prefix in prefixes {
        // Proton puts the Windows tree under `pfx`; a plain Wine prefix is the
        // tree itself.
        let pfx = prefix.join("pfx");
        let wine_root = if pfx.is_dir() { pfx } else { prefix };
        let mut roots = Vec::new();
        for user in prefix_user_dirs(&wine_root) {
            for sub in SUBDIRS {
                let path = sub
                    .iter()
                    .fold(user.clone(), |path, part| path.join(part));
                roots.push((path, true, true));
            }
        }
        if let Some(found) = scan_unix_roots(&roots, &names, &normalized) {
            return Some(found);
        }
    }

    // Steam's Proton prefixes are not named after the game and live outside the
    // launcher's prefix root. This is the last resort, and only runs when every
    // cheaper root missed.
    for prefix in steam_compat_prefixes() {
        let mut roots = Vec::new();
        for user in prefix_user_dirs(&prefix) {
            for sub in SUBDIRS {
                let path = sub
                    .iter()
                    .fold(user.clone(), |path, part| path.join(part));
                roots.push((path, true, true));
            }
        }
        if let Some(found) = scan_unix_roots(&roots, &names, &normalized) {
            return Some(found);
        }
    }
    None
}

/// Deletes the oldest timestamped backups under one game folder, keeping the
/// newest entries. Pre-restore snapshots are safety copies and are never
/// pruned, even when the user asks for a small retention window.
fn prune_local_dir(dir: &Path, keep: u32) {
    if keep == 0 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut backups: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name.starts_with("pre-restore-") {
                return None;
            }
            // `1750000000-1` is a same-second duplicate; its age is the prefix.
            let timestamp = name.split('-').next()?.parse::<u64>().ok()?;
            let path = entry.path();
            path.is_dir().then_some((timestamp, path))
        })
        .collect();
    if backups.len() <= keep as usize {
        return;
    }
    backups.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, path) in backups.into_iter().skip(keep as usize) {
        let _ = std::fs::remove_dir_all(path);
    }
}

/// Ubisoft titles keep saves where the compatibility shim or the official
/// client put them, not in a folder named after the launcher's app key.
fn ubisoft_save_path(app_name: &str) -> Option<String> {
    let product_id: u32 = app_name.strip_prefix("ubisoft::")?.parse().ok()?;
    crate::companion::ubi_save_path_for_product(product_id)
        .map(|path| path.to_string_lossy().to_string())
}

pub fn resolve_save_path(
    app_name: &str,
    save_path_override: Option<&str>,
) -> Result<String, String> {
    let installed = super::cache::read_installed(&super::skip::default_config_dir());
    let installed_game = installed.into_iter().find(|g| g.app_name == app_name);

    let cfgs = super::commands::load_all_game_custom_configs();
    let cfg = cfgs.get(app_name);

    if let Some(sp) = save_path_override.filter(|s| !s.trim().is_empty()) {
        return Ok(sp.trim().to_string());
    }
    if let Some(csp) = cfg
        .and_then(|c| c.custom_save_path.as_deref())
        .filter(|s| !s.trim().is_empty())
    {
        return Ok(csp.trim().to_string());
    }
    if let Some(sp) = installed_game
        .as_ref()
        .and_then(|g| g.save_path.as_deref())
        .filter(|s| !s.trim().is_empty())
    {
        return Ok(sp.trim().to_string());
    }
    if let Some(sp) = ubisoft_save_path(app_name) {
        return Ok(sp);
    }
    let title = installed_game.as_ref().map(|g| g.title.as_str());
    let install_path = installed_game.as_ref().map(|g| g.install_path.as_str());
    detect_save_path(app_name, title, install_path)
        .ok_or_else(|| "@t:backup.noSaveDir".to_string())
}

pub fn create_backup(
    app_name: &str,
    save_path_override: Option<&str>,
) -> Result<SaveBackupInfo, String> {
    migrate_legacy_dir(app_name);
    let save_path_str = resolve_save_path(app_name, save_path_override)?;

    let source = PathBuf::from(&save_path_str);
    if !source.exists() {
        return Err(format!("@t:backup.saveDirMissing\u{1f}{save_path_str}"));
    }

    let now_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let root = app_backup_dir(app_name);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;

    // Two backups can start in the same second. Pick a free id and copy into
    // a dot-prefixed staging folder that the list ignores; a crash leaves an
    // incomplete tree behind instead of a restore candidate.
    let mut backup_id = format!("{now_ts}");
    let mut serial = 1;
    while root.join(&backup_id).exists() {
        backup_id = format!("{now_ts}-{serial}");
        serial += 1;
    }
    let staging = root.join(format!(".{backup_id}.partial"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;

    let copied = copy_dir_all(&source, &staging.join("data"))
        .map_err(|e| format!("@t:backup.copyFailed\u{1f}{e}"));
    let (size_bytes, file_count) = match copied {
        Ok(values) => values,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };

    let formatted_date = format_backup_timestamp(now_ts);
    let content_hash = tree_content_hash(&staging.join("data"));
    let (save_root, save_rel) = save_root_kind(&source);
    let info = SaveBackupInfo {
        id: backup_id.clone(),
        app_name: app_name.to_string(),
        timestamp: now_ts,
        formatted_date,
        size_bytes,
        file_count,
        save_path: save_path_str,
        save_root,
        save_rel,
        content_hash,
        title: None,

        origin_app_name: None,
        imported_at: None,
    };

    let info_json = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    let write_info = std::fs::write(staging.join("backup_info.json"), info_json);
    if let Err(error) = write_info {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(error.to_string());
    }
    let target = root.join(&backup_id);
    if let Err(error) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(format!("@t:backup.copyFailed\u{1f}{error}"));
    }

    // A per-game limit wins over the shared cloud setting; snapshots stay
    // untouched either way.
    let per_game = crate::legendary::commands::load_all_game_custom_configs()
        .get(app_name)
        .and_then(|cfg| cfg.backup_retention);
    let keep = per_game.unwrap_or_else(|| crate::cloud_backup::manager::load_settings().retention_count);
    prune_local_dir(&app_backup_dir(app_name), keep);

    Ok(info)
}

/// Current UNIX timestamp in seconds.
fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Writes one local backup as a portable `.efxsave` archive in `folder`.
/// The archive carries `data/` and `backup_info.json`, the same shape a cloud
/// upload uses, so any launcher install can import it.
pub fn export_backup(
    app_name: &str,
    backup_id: &str,
    folder: &str,
    title: &str,
    password: Option<&str>,
) -> Result<String, String> {
    let id = safe_backup_id(backup_id)?;
    export_backup_dir(&app_backup_dir(app_name).join(id), folder, title, password)
}

fn export_backup_dir(
    source: &Path,
    folder: &str,
    title: &str,
    password: Option<&str>,
) -> Result<String, String> {
    if !source.is_dir() {
        return Err("@t:backup.infoNotFound".to_string());
    }
    let folder = PathBuf::from(folder.trim());
    if !folder.is_dir() {
        return Err("@t:backup.exportFolderMissing".to_string());
    }
    let timestamp = std::fs::read_to_string(source.join("backup_info.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<SaveBackupInfo>(&text).ok())
        .map(|info| info.timestamp)
        .unwrap_or_else(now_secs);
    let base: String = title
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let trimmed = base.trim().trim_matches('.').trim();
    let trimmed = if trimmed.is_empty() { "save" } else { trimmed };
    let stem: String = trimmed.chars().take(80).collect();
    let mut target = folder.join(format!("{stem} {timestamp}.efxsave"));
    let mut serial = 1;
    while target.exists() {
        target = folder.join(format!("{stem} {timestamp} ({serial}).efxsave"));
        serial += 1;
    }
    // Pack (and encrypt) beside the target, then rename in one step: a crash
    // leaves a dot-prefixed partial file instead of a corrupt .efxsave.
    let staging = folder.join(format!(".{stem} {timestamp}.exporting"));
    let _ = std::fs::remove_file(&staging);
    let secret = password.map(str::trim).filter(|value| !value.is_empty());
    let packed = if let Some(secret) = secret {
        let plain = std::env::temp_dir().join(format!(
            "efxlve_export_{}_{}.tar.gz",
            std::process::id(),
            now_secs()
        ));
        let packed = crate::cloud_backup::archive::pack_backup_dir(source, &plain);
        let result = packed.and_then(|_| {
            crate::cloud_backup::crypto::encrypt_file(&plain, &staging, secret)
        });
        let _ = std::fs::remove_file(&plain);
        result
    } else {
        crate::cloud_backup::archive::pack_backup_dir(source, &staging).map(|_| ())
    };
    if let Err(error) = packed {
        let _ = std::fs::remove_file(&staging);
        return Err(error);
    }
    if let Err(error) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_file(&staging);
        return Err(format!("Could not finalize the save export: {error}"));
    }
    Ok(target.display().to_string())
}

/// Cap for an imported archive; a save tree larger than this is not a save.
const MAX_IMPORT_BYTES: u64 = 16 * 1024 * 1024 * 1024;

/// Adds a portable save archive to the current game, whichever store it came
/// from. The archive keeps its original timestamp so the list shows when the
/// save was made; restoring it uses the current game's resolved folder.
pub fn import_backup(
    app_name: &str,
    archive: &str,
    password: Option<&str>,
    title: Option<&str>,
) -> Result<SaveBackupInfo, String> {
    import_backup_into(&app_backup_dir(app_name), app_name, archive, password, title)
}

fn import_backup_into(
    game_dir: &Path,
    app_name: &str,
    archive: &str,
    password: Option<&str>,
    title: Option<&str>,
) -> Result<SaveBackupInfo, String> {
    let file = Path::new(archive.trim());
    let size = std::fs::metadata(file)
        .map_err(|error| format!("@t:backup.importReadFailed\u{1f}{error}"))?
        .len();
    if size > MAX_IMPORT_BYTES {
        return Err("@t:backup.importTooLarge".to_string());
    }
    let stamp = now_secs();
    let unpack = std::env::temp_dir().join(format!(
        "efxlve_backup_import_{}_{}",
        std::process::id(),
        stamp
    ));
    let _ = std::fs::remove_dir_all(&unpack);
    let plain = std::env::temp_dir().join(format!(
        "efxlve_backup_plain_{}_{}.tar.gz",
        std::process::id(),
        stamp
    ));
    let unpack_source = if crate::cloud_backup::crypto::is_encrypted(file) {
        let secret = password.map(str::trim).unwrap_or("");
        if secret.is_empty() {
            return Err("@t:backup.passwordRequired".to_string());
        }
        if let Err(error) = crate::cloud_backup::crypto::decrypt_file(file, &plain, secret) {
            let _ = std::fs::remove_file(&plain);
            return Err(error);
        }
        plain.as_path()
    } else {
        file
    };
    let unpacked = crate::cloud_backup::archive::unpack_backup_tar_gz(unpack_source, &unpack);
    let _ = std::fs::remove_file(&plain);
    if let Err(error) = unpacked {
        let _ = std::fs::remove_dir_all(&unpack);
        return Err(error);
    }
    let data_dir = unpack.join("data");
    let parsed = std::fs::read_to_string(unpack.join("backup_info.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<SaveBackupInfo>(&text).ok())
        .filter(|_| data_dir.is_dir());
    let Some(mut info) = parsed else {
        let _ = std::fs::remove_dir_all(&unpack);
        return Err("@t:backup.notASaveArchive".to_string());
    };
    if let Err(error) = verify_backup_tree(&info, &data_dir) {
        let _ = std::fs::remove_dir_all(&unpack);
        return Err(error);
    }

    let root = game_dir;
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut id = stamp.to_string();
    let mut serial = 1;
    while root.join(&id).exists() {
        id = format!("{stamp}-{serial}");
        serial += 1;
    }
    let staging = root.join(format!(".{id}.importing"));
    let _ = std::fs::remove_dir_all(&staging);
    std::fs::create_dir_all(&staging).map_err(|e| e.to_string())?;
    let copied = copy_dir_all(&data_dir, &staging.join("data"))
        .map_err(|e| format!("@t:backup.copyFailed\u{1f}{e}"));
    let (size_bytes, file_count) = match copied {
        Ok(values) => values,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            let _ = std::fs::remove_dir_all(&unpack);
            return Err(error);
        }
    };
    info.id = id.clone();
    if let Some(title) = title.map(str::trim).filter(|value| !value.is_empty()) {
        info.title = Some(title.to_string());
    }
    if info.origin_app_name.is_none() {
        info.origin_app_name = Some(info.app_name.clone());
    }
    info.imported_at = Some(stamp);
    info.app_name = app_name.to_string();
    info.size_bytes = size_bytes;
    info.file_count = file_count;
    let info_json = serde_json::to_string_pretty(&info).map_err(|e| e.to_string())?;
    let write_info = std::fs::write(staging.join("backup_info.json"), info_json);
    if let Err(error) = write_info {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_dir_all(&unpack);
        return Err(error.to_string());
    }
    let target = root.join(&id);
    if let Err(error) = std::fs::rename(&staging, &target) {
        let _ = std::fs::remove_dir_all(&staging);
        let _ = std::fs::remove_dir_all(&unpack);
        return Err(format!("@t:backup.copyFailed\u{1f}{error}"));
    }
    let _ = std::fs::remove_dir_all(&unpack);
    Ok(info)
}

/// Creates a backup only when the save tree differs from the newest one. The
/// exit hook uses this so closing a game twice does not duplicate archives.
pub fn create_backup_if_changed(app_name: &str) -> Result<Option<SaveBackupInfo>, String> {
    let save_path = resolve_save_path(app_name, None)?;
    let source = PathBuf::from(&save_path);
    if !source.exists() {
        return Err(format!("@t:backup.saveDirMissing\u{1f}{save_path}"));
    }
    if let Some(latest) = list_backups(app_name).into_iter().next() {
        if let (Some(recorded), Some(actual)) =
            (latest.content_hash.as_deref(), tree_content_hash(&source))
        {
            if recorded == actual {
                return Ok(None);
            }
        }
    }
    create_backup(app_name, None).map(Some)
}

/// Every local backup, newest first, across every game and store.
pub fn list_all_backups() -> Vec<SaveBackupInfo> {
    let root = backups_base_dir();
    let mut list = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&root) {
        for entry in entries.flatten() {
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            let Ok(backups) = std::fs::read_dir(entry.path()) else {
                continue;
            };
            for backup in backups.flatten() {
                if !backup.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                if backup.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                if let Ok(content) =
                    std::fs::read_to_string(backup.path().join("backup_info.json"))
                {
                    if let Ok(info) = serde_json::from_str::<SaveBackupInfo>(&content) {
                        list.push(info);
                    }
                }
            }
        }
    }
    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    list
}

pub fn list_backups(app_name: &str) -> Vec<SaveBackupInfo> {
    migrate_legacy_dir(app_name);
    list_backups_in(&app_backup_dir(app_name))
}

fn list_backups_in(dir: &Path) -> Vec<SaveBackupInfo> {
    let mut list = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_name().to_string_lossy().starts_with('.') {
                continue;
            }
            if let Ok(ft) = entry.file_type() {
                if ft.is_dir() {
                    let info_path = entry.path().join("backup_info.json");
                    if let Ok(content) = std::fs::read_to_string(&info_path) {
                        if let Ok(info) = serde_json::from_str::<SaveBackupInfo>(&content) {
                            list.push(info);
                        }
                    }
                }
            }
        }
    }
    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    list
}

pub fn restore_backup(app_name: &str, backup_id: &str) -> Result<String, String> {
    restore_backup_checked(app_name, backup_id, None)
}

/// Restores a local backup. A non-empty `expected_current_hash` comes from the
/// preview dialog: when the save tree changed in the meantime the restore is
/// refused instead of overwriting a session the user just played.
pub fn restore_backup_checked(
    app_name: &str,
    backup_id: &str,
    expected_current_hash: Option<&str>,
) -> Result<String, String> {
    migrate_legacy_dir(app_name);
    let id = safe_backup_id(backup_id)?;
    let backup_dir = app_backup_dir(app_name).join(id);
    let info_path = backup_dir.join("backup_info.json");
    if !info_path.exists() {
        return Err("@t:backup.infoNotFound".to_string());
    }

    let content = std::fs::read_to_string(&info_path).map_err(|e| e.to_string())?;
    let info: SaveBackupInfo = serde_json::from_str(&content).map_err(|e| e.to_string())?;

    let data_src = backup_dir.join("data");
    if !data_src.exists() {
        return Err("@t:backup.dataFolderNotFound".to_string());
    }
    // A copy whose files no longer match the checksum recorded at backup time
    // would restore corruption over a working save tree.
    verify_backup_tree(&info, &data_src)?;

    let dest = resolve_restore_destination(app_name, &info);

    // The preview named the exact save tree it described. A different tree now
    // means the game (or another tool) wrote new saves after the dialog opened.
    if let Some(expected) = expected_current_hash.filter(|value| !value.is_empty()) {
        if !save_tree_matches(&dest, expected) {
            return Err("@t:backup.changedSincePreview".to_string());
        }
    }

    // Keep the current saves before overwriting them. The snapshot stays in the
    // local backup list, so a wrong restore can be undone from the same panel.
    snapshot_before_restore(app_name, &dest)?;

    copy_dir_all(&data_src, &dest).map_err(|e| format!("@t:backup.restoreError\u{1f}{e}"))?;

    Ok(format!(
        "@t:backup.restored\u{1f}{}\u{1f}{}",
        info.file_count, info.formatted_date
    ))
}

pub fn delete_backup(app_name: &str, backup_id: &str) -> Result<(), String> {
    migrate_legacy_dir(app_name);
    let id = safe_backup_id(backup_id)?;
    let target = app_backup_dir(app_name).join(id);
    if target.exists() {
        std::fs::remove_dir_all(target).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_keeps_snapshots_and_understands_serial_ids() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_retention_serial_{}_{}",
            std::process::id(),
            now_secs()
        ));
        for name in ["1700000000", "1700000001-1", "pre-restore-1700000002"] {
            std::fs::create_dir_all(root.join(name)).unwrap();
        }
        prune_local_dir(&root, 1);
        assert!(!root.join("1700000000").exists());
        assert!(root.join("1700000001-1").exists());
        assert!(root.join("pre-restore-1700000002").exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn list_backups_ignores_staging_dirs() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_list_skip_{}_{}",
            std::process::id(),
            now_secs()
        ));
        let good = root.join("1700000000");
        let staging = root.join(".1700000001.partial");
        for (dir, id) in [(&good, "1700000000"), (&staging, "1700000001")] {
            std::fs::create_dir_all(dir.join("data")).unwrap();
            let info = SaveBackupInfo {
                id: id.to_string(),
                app_name: "steam::1".to_string(),
                timestamp: 1_700_000_000,
                formatted_date: "x".to_string(),
                size_bytes: 0,
                file_count: 0,
                save_path: "C:/Saves".to_string(),
                save_root: "Documents".to_string(),
                save_rel: "Game".to_string(),
                content_hash: None,
                title: None,

                origin_app_name: None,
                imported_at: None,
            };
            std::fs::write(
                dir.join("backup_info.json"),
                serde_json::to_string(&info).unwrap(),
            )
            .unwrap();
        }
        let list = list_backups_in(&root);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].id, "1700000000");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_exported_save_imports_into_another_store() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_export_import_{}_{}",
            std::process::id(),
            now_secs()
        ));
        let steam = root.join("steam");
        let backup = steam.join("1700000000");
        std::fs::create_dir_all(backup.join("data")).unwrap();
        std::fs::write(backup.join("data").join("save.dat"), b"progress").unwrap();
        let hash = tree_content_hash(&backup.join("data")).unwrap();
        let info = SaveBackupInfo {
            id: "1700000000".to_string(),
            app_name: "steam::1".to_string(),
            timestamp: 1_700_000_000,
            formatted_date: "x".to_string(),
            size_bytes: 8,
            file_count: 1,
            save_path: "C:/Users/x/Documents/Game".to_string(),
            save_root: "Documents".to_string(),
            save_rel: "Game".to_string(),
            content_hash: Some(hash),
            title: None,

            origin_app_name: None,
            imported_at: None,
        };
        std::fs::write(
            backup.join("backup_info.json"),
            serde_json::to_string(&info).unwrap(),
        )
        .unwrap();

        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let archive =
            export_backup_dir(&backup, out.to_str().unwrap(), "Life is Strange", None).unwrap();
        assert!(Path::new(&archive).is_file());
        // A second export to the same folder must not overwrite the first file.
        let second =
            export_backup_dir(&backup, out.to_str().unwrap(), "Life is Strange", None).unwrap();
        assert_ne!(second, archive);
        assert!(Path::new(&second).is_file());

        let gog = root.join("gog");
        let imported =
            import_backup_into(&gog, "gog::2", &archive, None, Some("Life is Strange")).unwrap();
        assert_eq!(imported.title.as_deref(), Some("Life is Strange"));
        assert_eq!(imported.app_name, "gog::2");
        assert_eq!(imported.origin_app_name.as_deref(), Some("steam::1"));
        assert!(imported.imported_at.is_some());
        assert_eq!(imported.timestamp, 1_700_000_000);
        assert_eq!(
            std::fs::read(gog.join(&imported.id).join("data").join("save.dat")).unwrap(),
            b"progress"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_encrypted_save_needs_its_password() {
        let root = std::env::temp_dir().join(format!(
            "efxlve_export_encrypted_{}_{}",
            std::process::id(),
            now_secs()
        ));
        let backup = root.join("steam").join("1700000000");
        std::fs::create_dir_all(backup.join("data")).unwrap();
        std::fs::write(backup.join("data").join("save.dat"), b"progress").unwrap();
        let info = SaveBackupInfo {
            id: "1700000000".to_string(),
            app_name: "steam::1".to_string(),
            timestamp: 1_700_000_000,
            formatted_date: "x".to_string(),
            size_bytes: 8,
            file_count: 1,
            save_path: "C:/Users/x/Documents/Game".to_string(),
            save_root: "Documents".to_string(),
            save_rel: "Game".to_string(),
            content_hash: tree_content_hash(&backup.join("data")),
            title: None,

            origin_app_name: None,
            imported_at: None,
        };
        std::fs::write(
            backup.join("backup_info.json"),
            serde_json::to_string(&info).unwrap(),
        )
        .unwrap();

        let out = root.join("out");
        std::fs::create_dir_all(&out).unwrap();
        let archive = export_backup_dir(
            &backup,
            out.to_str().unwrap(),
            "Life is Strange",
            Some("secret"),
        )
        .unwrap();
        assert!(crate::cloud_backup::crypto::is_encrypted(Path::new(&archive)));
        let gog = root.join("gog");
        assert_eq!(
            import_backup_into(&gog, "gog::3", &archive, None, None).unwrap_err(),
            "@t:backup.passwordRequired"
        );
        assert!(import_backup_into(&gog, "gog::3", &archive, Some("wrong"), None).is_err());
        let imported =
            import_backup_into(&gog, "gog::3", &archive, Some("secret"), None).unwrap();
        assert_eq!(imported.app_name, "gog::3");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn content_hash_ignores_timestamps_and_order() {
        let root = std::env::temp_dir().join(format!("efxlve_content_hash_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("a.dat"), b"alpha").unwrap();
        std::fs::write(root.join("nested").join("b.dat"), b"beta").unwrap();

        let first = tree_content_hash(&root).unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        std::fs::write(root.join("a.dat"), b"alpha").unwrap();
        let second = tree_content_hash(&root).unwrap();
        assert_eq!(first, second);

        std::fs::write(root.join("nested").join("b.dat"), b"changed").unwrap();
        let third = tree_content_hash(&root).unwrap();
        assert_ne!(first, third);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "reads Rayman Origins; needs that direct install"]
    fn live_ubisoft_backup_source_resolves() {
        let path = ubisoft_save_path("ubisoft::80").expect("a Ubisoft save path");
        println!("Ubisoft backup source: {path}");
        assert!(std::path::Path::new(&path).is_dir());
    }

    #[test]
    fn test_backup_info_serialize() {
        let info = SaveBackupInfo {
            id: "12345".into(),
            app_name: "test_game".into(),
            timestamp: 123456789,
            formatted_date: "2026 (12:00 UTC)".into(),
            size_bytes: 1024,
            file_count: 3,
            save_path: "C:\\Saves".into(),
            save_root: "Absolute".into(),
            save_rel: String::new(),
            content_hash: None,
            title: None,

            origin_app_name: None,
            imported_at: None,
        };

        let json = serde_json::to_string(&info).unwrap();
        let parsed: SaveBackupInfo = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "12345");
        assert_eq!(parsed.file_count, 3);
    }

    #[test]
    fn a_documents_save_keeps_a_logical_root() {
        let base = std::env::temp_dir().join(format!(
            "efxlve_logical_docs_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or(0)
        ));
        let home = base.join("home");
        let save = home.join("Documents").join("Studio").join("Game");
        std::fs::create_dir_all(&save).unwrap();

        let (root, rel) = classify_save_path_with(&save, &home, None, None);
        assert_eq!(root, "Documents");
        assert_eq!(rel, "Studio/Game");
        let resolved = root_path_with(&root, &home, None, None)
            .unwrap()
            .join(safe_save_rel(&rel).unwrap());
        assert_eq!(
            resolved.canonicalize().unwrap(),
            save.canonicalize().unwrap()
        );
        assert!(safe_save_rel("../outside").is_none());
        assert!(safe_save_rel("/absolute").is_none());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_local_appdata_save_is_classified_before_home() {
        let base = std::env::temp_dir().join(format!(
            "efxlve_logical_local_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or(0)
        ));
        let home = base.join("home");
        let local = home.join("AppData").join("Local");
        let save = local.join("Studio").join("Game");
        std::fs::create_dir_all(&save).unwrap();
        std::fs::create_dir_all(home.join("Documents")).unwrap();

        let (root, rel) = classify_save_path_with(&save, &home, Some(&local), None);
        assert_eq!(root, "LocalAppData");
        assert_eq!(rel, "Studio/Game");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn backup_key_keeps_epic_names_and_sanitizes_store_keys() {
        assert_eq!(backup_key("Ginger"), "Ginger");
        assert_eq!(backup_key("gog::12345"), "gog__12345");
        assert_eq!(backup_key("steam::570"), "steam__570");
        assert_eq!(backup_key("amazon::B0/../x"), "amazon__B0_.._x");
        assert_eq!(backup_key(":::"), "game");
    }

    #[cfg(windows)]
    #[test]
    fn test_detect_save_path_candidates() {
        let temp_dir =
            std::env::temp_dir().join(format!("efxlve_test_save_detect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let save_dir = temp_dir.join("Saved").join("SaveGames");
        std::fs::create_dir_all(&save_dir).unwrap();

        let detected = detect_save_path(
            "SampleGame",
            Some("Sample Game"),
            Some(&temp_dir.to_string_lossy()),
        );
        assert!(detected.is_some());
        // Windows can hand back the same directory as an 8.3 short path
        // (RUNNER~1) or its long name (runneradmin). Canonicalize both sides
        // before comparing; this is also true on the GitHub runner.
        let detected = std::fs::canonicalize(detected.unwrap()).unwrap();
        let expected = std::fs::canonicalize(&save_dir).unwrap();
        assert_eq!(detected, expected);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    #[test]
    fn test_normalize_for_match() {
        assert_eq!(
            normalize_for_match("UNCHARTED™: Legacy of Thieves Collection"),
            "unchartedlegacyofthievescollection"
        );
        assert_eq!(
            normalize_for_match("Uncharted Legacy of Thieves Collection"),
            "unchartedlegacyofthievescollection"
        );
        assert_eq!(normalize_for_match("Cyberpunk 2077"), "cyberpunk2077");
        assert_eq!(
            normalize_for_match("Marvel's Spider-Man"),
            "marvelsspiderman"
        );
    }

    #[test]
    fn test_scan_nested_publisher() {
        let temp_dir =
            std::env::temp_dir().join(format!("efxlve_test_pub_detect_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp_dir);
        let game_dir = temp_dir.join("CD Projekt Red").join("Cyberpunk 2077");
        std::fs::create_dir_all(&game_dir).unwrap();

        let (names, normalized) = build_search_candidates("Ginger", Some("Cyberpunk 2077"), None);
        let found = scan_folder_for_game(&temp_dir, &names, &normalized, true, false);
        assert!(found.is_some());
        assert_eq!(found.unwrap(), game_dir);

        let _ = std::fs::remove_dir_all(&temp_dir);
    }

    /// Local backups from before `backup_key` used the raw store key as the
    /// folder name. A space stands in for the `::` key here: Windows cannot
    /// create a `::` folder (that was the bug), while the sanitizing rule is
    /// the same. The real `::` name is covered on Unix below.
    #[test]
    fn legacy_store_backup_folders_move_to_the_safe_key() {
        let base = std::env::temp_dir().join(format!("efxlve_legacy_backup_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let legacy = base.join("gog 123");
        let backup = legacy.join("1700000000");
        std::fs::create_dir_all(&backup).unwrap();
        std::fs::write(backup.join("backup_info.json"), b"{}").unwrap();

        let moved = migrate_legacy_dir_in(&base, "gog 123").expect("moved");
        assert_eq!(moved, base.join("gog_123"));
        assert!(base.join("gog_123").join("1700000000").is_dir());
        assert!(!legacy.exists(), "the raw folder is gone");
        // Epic names already are the safe key: there is nothing to migrate.
        assert_eq!(migrate_legacy_dir_in(&base, "Ginger"), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Both names may exist when a backup was taken before and after the fix;
    /// the old children move into the safe folder and nothing is overwritten.
    #[test]
    fn legacy_backups_merge_into_an_existing_safe_folder() {
        let base = std::env::temp_dir().join(format!("efxlve_legacy_merge_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("gog 123").join("1700000000")).unwrap();
        std::fs::create_dir_all(base.join("gog_123").join("1700000001")).unwrap();

        let moved = migrate_legacy_dir_in(&base, "gog 123").expect("merged");
        assert_eq!(moved, base.join("gog_123"));
        assert!(base.join("gog_123").join("1700000000").is_dir());
        assert!(base.join("gog_123").join("1700000001").is_dir());
        assert!(!base.join("gog 123").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    /// The real legacy name on Linux/macOS, where a `::` folder is legal.
    #[cfg(unix)]
    #[test]
    fn legacy_colon_keys_migrate_on_unix() {
        let base =
            std::env::temp_dir().join(format!("efxlve_legacy_colon_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("gog::123").join("1700000000")).unwrap();

        let moved = migrate_legacy_dir_in(&base, "gog::123").expect("moved");
        assert_eq!(moved, base.join("gog__123"));
        assert!(base.join("gog__123").join("1700000000").is_dir());
        assert!(!base.join("gog::123").exists());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn legacy_migration_rejects_path_separators() {
        let base = std::env::temp_dir().join(format!("efxlve_legacy_traversal_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();

        assert_eq!(migrate_legacy_dir_in(&base, "../outside"), None);
        assert_eq!(migrate_legacy_dir_in(&base, "gog/123"), None);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// Local retention keeps the newest timestamped backups and never removes
    /// a pre-restore snapshot.
    #[test]
    fn local_retention_keeps_the_newest_and_the_snapshot() {
        let dir = std::env::temp_dir().join(format!("efxlve_local_retention_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("100")).unwrap();
        std::fs::create_dir_all(dir.join("200")).unwrap();
        std::fs::create_dir_all(dir.join("pre-restore-300")).unwrap();

        prune_local_dir(&dir, 1);
        assert!(!dir.join("100").exists());
        assert!(dir.join("200").exists());
        assert!(dir.join("pre-restore-300").exists());

        // 0 means unlimited: a second call must not delete anything.
        prune_local_dir(&dir, 0);
        assert!(dir.join("200").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Builds one local backup plus the save folder it describes. Returns
    /// (root, backup, destination, info).
    fn local_backup_fixture(name: &str) -> (PathBuf, PathBuf, PathBuf, SaveBackupInfo) {
        let root = std::env::temp_dir().join(format!(
            "efxlve_preview_{name}_{}_{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or(0)
        ));
        let backup = root.join("backup").join("1700000000");
        let data = backup.join("data");
        std::fs::create_dir_all(&data).unwrap();
        std::fs::write(data.join("profile.sav"), b"alpha").unwrap();
        std::fs::create_dir_all(data.join("nested")).unwrap();
        std::fs::write(data.join("nested").join("slot1.sav"), b"beta").unwrap();

        let destination = root.join("saves").join("Example");
        std::fs::create_dir_all(&destination).unwrap();
        std::fs::write(destination.join("profile.sav"), b"alpha").unwrap();
        std::fs::create_dir_all(destination.join("nested")).unwrap();
        std::fs::write(destination.join("nested").join("slot1.sav"), b"beta").unwrap();

        let info = SaveBackupInfo {
            id: "1700000000".into(),
            app_name: "steam::1".into(),
            timestamp: 1_700_000_000,
            formatted_date: "14 Nov 2023".into(),
            size_bytes: 9,
            file_count: 2,
            save_path: destination.to_string_lossy().to_string(),
            save_root: String::new(),
            save_rel: String::new(),
            content_hash: tree_content_hash(&data),
            title: None,

            origin_app_name: None,
            imported_at: None,
        };
        std::fs::write(
            backup.join("backup_info.json"),
            serde_json::to_string_pretty(&info).unwrap(),
        )
        .unwrap();
        (root, backup, destination, info)
    }

    #[test]
    fn a_local_preview_lists_files_and_the_restore_target() {
        let (root, backup, destination, _) = local_backup_fixture("list");
        let preview = preview_from_backup_dir("steam::1", "1700000000", &backup).unwrap();
        assert_eq!(preview.file_count, 2);
        assert_eq!(preview.total_bytes, 9);
        assert!(!preview.truncated);
        assert!(!preview.damaged);
        assert_eq!(preview.path_source, "absolute");
        assert_eq!(preview.save_path, destination.to_string_lossy());
        assert!(preview.target_exists);
        assert!(preview
            .files
            .iter()
            .any(|file| file.path == "profile.sav" && file.size == 5));
        assert!(preview
            .files
            .iter()
            .any(|file| file.path == "nested/slot1.sav" && file.size == 4));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_corrupted_backup_is_marked_and_refused() {
        let (root, backup, _, info) = local_backup_fixture("corrupt");
        let data = backup.join("data");
        let preview = preview_from_backup_dir("steam::1", "1700000000", &backup).unwrap();
        assert!(!preview.damaged);
        assert!(verify_backup_tree(&info, &data).is_ok());

        // One changed byte is enough: the recorded checksum no longer matches.
        std::fs::write(data.join("profile.sav"), b"alphA").unwrap();
        let preview = preview_from_backup_dir("steam::1", "1700000000", &backup).unwrap();
        assert!(preview.damaged);
        assert_eq!(preview.backup_hash, info.content_hash);
        assert_eq!(
            verify_backup_tree(&info, &data).unwrap_err(),
            "@t:backup.damaged"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_older_backup_without_a_checksum_stays_restorable() {
        let (root, backup, _, mut info) = local_backup_fixture("old");
        info.content_hash = None;
        std::fs::write(
            backup.join("backup_info.json"),
            serde_json::to_string_pretty(&info).unwrap(),
        )
        .unwrap();
        let preview = preview_from_backup_dir("steam::1", "1700000000", &backup).unwrap();
        assert!(!preview.damaged);
        assert!(preview.backup_hash.is_some(), "the preview still hashes the tree");
        assert!(verify_backup_tree(&info, &backup.join("data")).is_ok());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_identical_save_tree_is_reported_and_matches_the_guard() {
        let (root, backup, destination, info) = local_backup_fixture("same");
        let preview = preview_from_backup_dir("steam::1", "1700000000", &backup).unwrap();
        assert!(preview.same_content);
        let expected = preview.current_hash.clone().expect("preview hash");
        assert!(save_tree_matches(&destination, &expected));

        // A session after the preview invalidates the hash the dialog showed.
        std::fs::write(destination.join("profile.sav"), b"newer").unwrap();
        let after = preview_from_backup_dir("steam::1", "1700000000", &backup).unwrap();
        assert!(!after.same_content);
        assert!(!save_tree_matches(&destination, &expected));
        assert_eq!(after.backup_hash, info.content_hash);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_preview_refuses_a_damaged_backup_and_a_bad_id() {
        let (root, backup, _, _) = local_backup_fixture("damaged");
        std::fs::remove_dir_all(backup.join("data")).unwrap();
        assert_eq!(
            preview_from_backup_dir("steam::1", "1700000000", &backup).unwrap_err(),
            "@t:backup.dataFolderNotFound"
        );
        assert!(safe_backup_id("1700000000").is_ok());
        assert!(safe_backup_id("pre-restore-1700000000").is_ok());
        assert!(safe_backup_id("..").is_err());
        assert!(safe_backup_id("../other").is_err());
        assert!(safe_backup_id("folder/inside").is_err());
        assert!(safe_backup_id("").is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_preview_summarizes_a_long_file_list() {
        let (root, backup, _, mut info) = local_backup_fixture("many");
        let data = backup.join("data");
        for index in 0..PREVIEW_FILE_LIMIT {
            std::fs::write(data.join(format!("bulk_{index:04}.sav")), b"x").unwrap();
        }
        // An older record may not carry a count; the preview then counts the
        // tree itself and still caps the list.
        info.file_count = 0;
        info.size_bytes = 0;
        std::fs::write(
            backup.join("backup_info.json"),
            serde_json::to_string_pretty(&info).unwrap(),
        )
        .unwrap();
        let preview = preview_from_backup_dir("steam::1", "1700000000", &backup).unwrap();
        assert_eq!(preview.files.len(), PREVIEW_FILE_LIMIT);
        assert!(preview.truncated);
        assert!(preview.file_count > PREVIEW_FILE_LIMIT);
        let _ = std::fs::remove_dir_all(&root);
    }

    fn unix_fixture(name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!(
            "efxlve_unix_saves_{name}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let home = root.join("home");
        let data = root.join("data");
        let config = root.join("config");
        std::fs::create_dir_all(&home).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        std::fs::create_dir_all(&config).unwrap();
        (home, data, config)
    }

    #[test]
    fn unix_detection_finds_a_unity_save_tree() {
        let (home, data, config) = unix_fixture("unity");
        let game = config.join("unity3d").join("Studio").join("Sample Game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("profile.sav"), b"save").unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found.unwrap(), game.to_string_lossy());

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn unix_detection_finds_an_xdg_data_save() {
        let (home, data, config) = unix_fixture("xdg");
        let game = data.join("Sample Game");
        std::fs::create_dir_all(&game).unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found.unwrap(), game.to_string_lossy());

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    /// Steam stores Proton prefixes under a numeric app id, not the game name;
    /// only folders with a real pfx tree are returned.
    #[test]
    fn steam_compat_prefixes_are_discovered() {
        let root = std::env::temp_dir().join(format!("efxlve_compat_{}", std::process::id()));
        let library = root.join("library");
        let pfx = library
            .join("steamapps")
            .join("compatdata")
            .join("12345")
            .join("pfx");
        std::fs::create_dir_all(&pfx).unwrap();
        std::fs::create_dir_all(library.join("steamapps").join("compatdata").join("empty")).unwrap();

        let prefixes = compat_prefixes_in(&[library]);
        assert_eq!(prefixes, vec![pfx]);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn unix_detection_reads_the_proton_prefix_appdata() {
        let (home, data, config) = unix_fixture("proton");
        let local = home
            .join("Games")
            .join("Efxlve")
            .join("Prefixes")
            .join("SampleGame")
            .join("pfx")
            .join("drive_c")
            .join("users")
            .join("steamuser")
            .join("AppData")
            .join("Local")
            .join("Sample Game");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("savegame.dat"), b"save").unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found.unwrap(), local.to_string_lossy());

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn unix_detection_falls_back_to_another_prefix() {
        let (home, data, config) = unix_fixture("other_prefix");
        // A custom prefix name does not match the app key; the scan still has to
        // find the saves inside it.
        let local = home
            .join("Games")
            .join("Efxlve")
            .join("Prefixes")
            .join("CustomPrefix")
            .join("pfx")
            .join("drive_c")
            .join("users")
            .join("steamuser")
            .join("AppData")
            .join("Local")
            .join("Sample Game");
        std::fs::create_dir_all(&local).unwrap();
        std::fs::write(local.join("savegame.dat"), b"save").unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found.unwrap(), local.to_string_lossy());

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }

    #[test]
    fn unix_detection_ignores_an_empty_documents_folder() {        let (home, data, config) = unix_fixture("empty");
        // A publisher folder that matches the game name but is empty is not a
        // save location; the Documents pass requires save-like content.
        let docs = home.join("Documents").join("Studio").join("Sample Game");
        std::fs::create_dir_all(&docs).unwrap();

        let found = detect_save_path_unix(&home, &data, &config, "SampleGame", Some("Sample Game"));
        assert_eq!(found, None);

        let _ = std::fs::remove_dir_all(home.parent().unwrap());
    }
}
