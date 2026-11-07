//! Finds the upscaler DLLs a game already ships.
//!
//! Only the nine known file names are hashed; the directory walk itself is the
//! expensive part, so the scan stays on demand instead of running for every
//! installed game at startup.

use std::path::{Path, PathBuf};

use super::hash;
use super::types::{DllState, GameUpscalers, UpscalerDll, UpscalerKind};
use super::version;

/// Sidecar name used by DLSS Swapper as well, so both tools see the same
/// original file when the user has either one installed.
pub fn backup_path(target: &Path) -> PathBuf {
    let mut name = target.as_os_str().to_os_string();
    name.push(".dlsss");
    PathBuf::from(name)
}

/// Reads one DLL and its sidecar backup.
pub fn inspect(path: &Path, kind: UpscalerKind) -> Result<UpscalerDll, String> {
    let metadata = std::fs::metadata(path).map_err(|error| error.to_string())?;
    let md5 = hash::md5_file(path)?;
    let file_version = version::file_version(path).unwrap_or_default();

    let backup = backup_path(path);
    let (backup_path_value, backup_version, backup_md5) = if backup.is_file() {
        (
            Some(backup.to_string_lossy().to_string()),
            version::file_version(&backup),
            hash::md5_file(&backup).ok(),
        )
    } else {
        (None, None, None)
    };

    // A backup that is byte-identical to the current file is stale: the game
    // update or the user already put the original back.
    let state = match backup_md5.as_deref() {
        Some(original) if original == md5 => DllState::Original,
        Some(_) => DllState::Swapped,
        None => DllState::Original,
    };

    Ok(UpscalerDll {
        kind,
        file_name: path
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        path: path.to_string_lossy().to_string(),
        version: file_version,
        md5,
        size: metadata.len(),
        state,
        backup_path: backup_path_value,
        backup_version,
        backup_md5,
    })
}

/// Recursively scans one game folder for swappable DLLs.
pub fn scan_game(install_path: &str, game_key: &str) -> Result<GameUpscalers, String> {
    let root = Path::new(install_path.trim());
    if !root.is_dir() {
        return Err("The game folder does not exist.".to_string());
    }

    let mut found = Vec::new();
    let mut stack = vec![(root.to_path_buf(), 0usize)];
    while let Some((folder, depth)) = stack.pop() {
        if depth > 16 {
            continue;
        }
        let Ok(entries) = std::fs::read_dir(&folder) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                // Another tool's backup tree is not a second live copy.
                let folder_name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or_default();
                if is_backup_folder(folder_name) {
                    continue;
                }
                // Junctions are directories on Windows; walking one can loop.
                let metadata = entry.metadata().ok();
                if metadata.as_ref().is_some_and(is_reparse_point) {
                    continue;
                }
                stack.push((path, depth + 1));
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let file_name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or_default();
            let Some(kind) = UpscalerKind::from_file_name(file_name) else {
                continue;
            };
            if let Ok(dll) = inspect(&path, kind) {
                found.push(dll);
            }
        }
    }

    found.sort_by(|left, right| {
        left.kind
            .order()
            .cmp(&right.kind.order())
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(GameUpscalers {
        game_key: game_key.to_string(),
        install_path: root.to_string_lossy().to_string(),
        dlls: found,
    })
}

/// Backup folders left by other swappers must not appear as live DLLs.
fn is_backup_folder(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("dlss") && lower.contains("backup")
}

#[cfg(windows)]
fn is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    metadata.file_attributes() & 0x400 != 0
}

#[cfg(not(windows))]
fn is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::{backup_path, scan_game};
    use std::path::Path;

    #[test]
    fn sidecar_keeps_the_original_name() {
        let path = Path::new(r"C:\Games\Example\nvngx_dlss.dll");
        assert_eq!(
            backup_path(path),
            Path::new(r"C:\Games\Example\nvngx_dlss.dll.dlsss")
        );
    }

    #[test]
    fn scan_finds_a_known_dll_two_levels_down() {
        let root = std::env::temp_dir().join("efxlve-upscaler-scan-test");
        let _ = std::fs::remove_dir_all(&root);
        let nested = root.join("Binaries").join("Win64");
        std::fs::create_dir_all(&nested).expect("create test folders");
        std::fs::write(nested.join("nvngx_dlss.dll"), b"not a real dll").expect("write test dll");
        std::fs::write(nested.join("other.dll"), b"ignored").expect("write ignored dll");

        let result = scan_game(&root.to_string_lossy(), "test::game").expect("scan");
        assert_eq!(result.dlls.len(), 1);
        assert_eq!(result.dlls[0].file_name, "nvngx_dlss.dll");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_ignores_another_swappers_backup_tree() {
        let root = std::env::temp_dir().join("efxlve-upscaler-backup-scan-test");
        let _ = std::fs::remove_dir_all(&root);
        let backup = root
            .join("_DLSS_Backup")
            .join("originals")
            .join("8306e23d");
        std::fs::create_dir_all(&backup).expect("create backup folder");
        std::fs::write(backup.join("nvngx_dlss.dll"), b"backup").expect("write backup dll");
        std::fs::write(root.join("nvngx_dlss.dll"), b"live").expect("write live dll");

        let result = scan_game(&root.to_string_lossy(), "test::game").expect("scan");
        assert_eq!(result.dlls.len(), 1);
        assert!(!result.dlls[0].path.to_ascii_lowercase().contains("_dlss_backup"));
        let _ = std::fs::remove_dir_all(&root);
    }
}
