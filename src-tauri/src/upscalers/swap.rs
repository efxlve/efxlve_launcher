//! Swaps one game DLL with a cached copy and keeps the original beside it.
//!
//! The target must be a known upscaler file inside the game folder the caller
//! named. A missing backup means the current file is the original; an existing
//! backup is never overwritten, so a second swap cannot lose the first one.

use std::path::{Path, PathBuf};

use super::hash;
use super::scan::{backup_path, inspect};
use super::store;
use super::types::{UpscalerDll, UpscalerKind};

fn file_error(error: std::io::Error, action: &str) -> String {
    // ERROR_SHARING_VIOLATION: the game has the DLL mapped.
    if error.raw_os_error() == Some(32) {
        return "The DLL is in use. Close the game and try again.".to_string();
    }
    if error.kind() == std::io::ErrorKind::PermissionDenied {
        return format!(
            "Windows denied access while {action}. Close the game, move the game to a folder you can write to, or run the launcher as administrator."
        );
    }
    format!("Could not {action}: {error}")
}

fn ensure_target(
    install_path: &str,
    dll_path: &str,
) -> Result<(PathBuf, UpscalerKind), String> {
    let root = Path::new(install_path.trim());
    let target = Path::new(dll_path.trim());
    if !root.is_dir() {
        return Err("The game folder does not exist.".to_string());
    }
    if !target.is_file() {
        return Err("The selected DLL does not exist.".to_string());
    }
    let root = std::fs::canonicalize(root)
        .map_err(|error| format!("Could not resolve the game folder: {error}"))?;
    let target = std::fs::canonicalize(target)
        .map_err(|error| format!("Could not resolve the DLL path: {error}"))?;
    if !target.starts_with(&root) {
        return Err("The DLL is outside the game folder.".to_string());
    }
    let kind = target
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(UpscalerKind::from_file_name)
        .ok_or_else(|| "This is not a known upscaler DLL file name.".to_string())?;
    Ok((target, kind))
}

fn ensure_writable(target: &Path) -> Result<(), String> {
    std::fs::OpenOptions::new()
        .write(true)
        .open(target)
        .map(|_| ())
        .map_err(|error| file_error(error, "opening the DLL for writing"))
}

fn copy_over(source: &Path, target: &Path, action: &str) -> Result<(), String> {
    std::fs::copy(source, target)
        .map(|_| ())
        .map_err(|error| file_error(error, action))
}

/// Replaces `dll_path` with an imported/cached DLL.
pub fn swap_dll(
    app_data: &Path,
    install_path: &str,
    dll_path: &str,
    imported_id: &str,
) -> Result<UpscalerDll, String> {
    let (target, kind) = ensure_target(install_path, dll_path)?;
    let item = store::list_imported(app_data)?
        .into_iter()
        .find(|item| item.id == imported_id)
        .ok_or_else(|| "The selected DLL is no longer in the launcher cache.".to_string())?;
    if item.kind != kind {
        return Err("The selected DLL does not match this game file.".to_string());
    }

    let source = store::dll_path(app_data, item.kind, &item.md5);
    if !source.is_file() {
        return Err("The selected DLL is missing from the launcher cache.".to_string());
    }
    if !hash::md5_file(&source)?.eq_ignore_ascii_case(&item.md5) {
        return Err("The cached DLL failed its hash check.".to_string());
    }

    let current = hash::md5_file(&target)?;
    if current.eq_ignore_ascii_case(&item.md5) {
        return Err("This DLL is already the selected version.".to_string());
    }
    ensure_writable(&target)?;

    let backup = backup_path(&target);
    if !backup.is_file() {
        std::fs::copy(&target, &backup)
            .map_err(|error| file_error(error, "saving the original DLL"))?;
    }

    if let Err(error) = copy_over(&source, &target, "writing the new DLL") {
        // Put the original back if the copy stopped halfway.
        let _ = std::fs::copy(&backup, &target);
        return Err(error);
    }

    let after = hash::md5_file(&target)?;
    if !after.eq_ignore_ascii_case(&item.md5) {
        let _ = std::fs::copy(&backup, &target);
        return Err("The new DLL failed its hash check; the original was restored.".to_string());
    }

    inspect(&target, kind)
}

/// Moves the sidecar backup back over the game DLL and removes it.
pub fn restore_dll(install_path: &str, dll_path: &str) -> Result<UpscalerDll, String> {
    let (target, kind) = ensure_target(install_path, dll_path)?;
    let backup = backup_path(&target);
    if !backup.is_file() {
        return Err("There is no original backup for this DLL.".to_string());
    }

    let current = hash::md5_file(&target)?;
    let original = hash::md5_file(&backup)?;
    if !current.eq_ignore_ascii_case(&original) {
        ensure_writable(&target)?;
        copy_over(&backup, &target, "restoring the original DLL")?;
        let after = hash::md5_file(&target)?;
        if !after.eq_ignore_ascii_case(&original) {
            return Err("The restore failed its hash check; the backup was kept.".to_string());
        }
    }
    let _ = std::fs::remove_file(&backup);
    inspect(&target, kind)
}

/// Removes a stale sidecar backup without touching the game DLL.
pub fn discard_backup(install_path: &str, dll_path: &str) -> Result<UpscalerDll, String> {
    let (target, kind) = ensure_target(install_path, dll_path)?;
    let backup = backup_path(&target);
    if !backup.is_file() {
        return Err("There is no original backup for this DLL.".to_string());
    }
    std::fs::remove_file(&backup)
        .map_err(|error| file_error(error, "removing the original backup"))?;
    inspect(&target, kind)
}

#[cfg(test)]
mod tests {
    use super::swap_dll;
    use crate::upscalers::scan::backup_path;
    use crate::upscalers::store;
    use crate::upscalers::types::DllState;

    #[test]
    fn swap_and_restore_round_trip() {
        let root = std::env::temp_dir().join("efxlve-upscaler-swap-test");
        let _ = std::fs::remove_dir_all(&root);
        let game = root.join("game");
        std::fs::create_dir_all(&game).expect("create game folder");
        let target = game.join("nvngx_dlss.dll");
        std::fs::write(&target, b"original").expect("write original");

        let import = root.join("nvngx_dlss.dll");
        std::fs::write(&import, b"replacement").expect("write replacement");
        let app_data = root.join("app");
        let item = store::import_dll(&app_data, &import).expect("import");

        let swapped = swap_dll(
            &app_data,
            &game.to_string_lossy(),
            &target.to_string_lossy(),
            &item.id,
        )
        .expect("swap");
        assert_eq!(swapped.state, DllState::Swapped);
        assert_eq!(std::fs::read(&target).unwrap(), b"replacement");
        assert!(backup_path(&target).is_file());

        let restored = super::restore_dll(&game.to_string_lossy(), &target.to_string_lossy())
            .expect("restore");
        assert_eq!(restored.state, DllState::Original);
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        assert!(!backup_path(&target).exists());

        let _ = std::fs::remove_dir_all(&root);
    }
}
