//! Which directories a delete is allowed to remove.
//!
//! `Path::join` treats an absolute child as a new root and follows `..`.
//! Callers must use these checks before `remove_dir_all`.

use std::path::Path;

/// Validates whether a path is safe to recursively delete as a game installation folder.
/// Guards against system directories, root drives, user profiles, or launcher roots.
pub(super) fn plain_folder_name(name: &str) -> bool {
    let name = name.trim();
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains("..")
        && !Path::new(name).is_absolute()
        && !name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
}

pub(crate) fn is_safe_game_dir(path: &Path, install_root: &Path) -> bool {
    if !path.is_absolute() {
        return false;
    }
    // `..` walks out of the install root even when the text still looks nested.
    if path
        .components()
        .any(|c| matches!(c, std::path::Component::ParentDir))
    {
        return false;
    }
    // Must have at least 3 path components on Windows (Prefix, RootDir, Directory)
    if path.components().count() < 3 {
        return false;
    }
    // Normalize separators and case once; both the checks and the root compare
    // must see the same spelling.
    let owned = path.to_string_lossy().to_lowercase().replace('/', "\\");
    let s = owned.trim_start_matches(r"\\?\");
    let s_trimmed = s.trim_end_matches('\\');

    // Must not be the default or the configured install root itself. A custom
    // Epic folder is often on another drive, so the caller passes the active
    // root rather than only the built-in default.
    if let Ok(canon_def) = install_root.canonicalize() {
        let def_s = canon_def
            .to_string_lossy()
            .to_lowercase()
            .replace('/', "\\");
        let def_s = def_s.trim_start_matches(r"\\?\");
        if s_trimmed == def_s.trim_end_matches('\\') {
            return false;
        }
    }
    let def_raw = install_root
        .to_string_lossy()
        .to_lowercase()
        .replace('/', "\\");
    let def_raw = def_raw.trim_start_matches(r"\\?\");
    if s_trimmed == def_raw.trim_end_matches('\\') {
        return false;
    }

    // Critical Windows locations are rejected on every drive, not only on C:.
    // `D:\Program Files` or `E:\ProgramData` is just as destructive to delete.
    let tail = if s.as_bytes().get(1) == Some(&b':') {
        &s[2..]
    } else {
        s
    };
    let compact = tail.trim_end_matches('\\');
    let forbidden_root = matches!(
        compact,
        r"\windows"
            | r"\program files"
            | r"\program files (x86)"
            | r"\programdata"
            | r"\users"
            | r"\system volume information"
            | r"\recovery"
            | r"\perflogs"
            | r"\$recycle.bin"
            | r"\boot"
            | r"\efi"
            | r"\windows.old"
    );
    if forbidden_root {
        return false;
    }

    // Children of the OS directory, not only the directory itself.
    if compact == r"\windows" || compact.starts_with(r"\windows\") {
        return false;
    }
    // System metadata trees are never a game folder, even below the root.
    for system_tree in [
        r"\system volume information\",
        r"\$recycle.bin\",
        r"\recovery\",
        r"\perflogs\",
        r"\boot\",
        r"\efi\",
    ] {
        if compact.starts_with(system_tree) {
            return false;
        }
    }
    // Epic's own ProgramData tree holds manifests and install records.
    if compact == r"\programdata\epic" || compact.starts_with(r"\programdata\epic\") {
        return false;
    }
    // A profile root is a single folder below `\Users`; games below it are
    // allowed, but the profile itself must never be removed.
    if let Some(rest) = compact.strip_prefix(r"\users\") {
        if !rest.is_empty() && !rest.contains('\\') {
            return false;
        }
    }

    // Must not be user profile or core profile folders
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let up = user_profile.to_lowercase().replace('/', "\\");
        if s_trimmed == up.trim_end_matches('\\')
            || s_trimmed == format!("{}\\desktop", up)
            || s_trimmed == format!("{}\\documents", up)
            || s_trimmed == format!("{}\\downloads", up)
            || s_trimmed == format!("{}\\appdata", up)
        {
            return false;
        }
    }
    // Unix has no USERPROFILE; the home folder and its documents/downloads
    // children are just as destructive to remove.
    if let Ok(home) = std::env::var("HOME") {
        let h = home.to_lowercase().replace('/', "\\");
        if s_trimmed == h.trim_end_matches('\\')
            || s_trimmed == format!("{}\\desktop", h)
            || s_trimmed == format!("{}\\documents", h)
            || s_trimmed == format!("{}\\downloads", h)
        {
            return false;
        }
    }

    true
}

/// Recursively removes a directory on Windows, stripping any read-only attributes
/// that would otherwise cause `ERROR_ACCESS_DENIED` during deletion.
///
/// An error means the folder survived: the caller must not report the game as
/// removed. Every attempt is made before the error is returned, so the folder is
/// the only thing left when the caller sees it.
pub(crate) fn force_remove_dir_all(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    // Fast path: try standard std::fs::remove_dir_all first
    if std::fs::remove_dir_all(path).is_ok() {
        return Ok(());
    }

    fn note(first: &mut Option<std::io::Error>, result: std::io::Result<()>) {
        if let Err(error) = result {
            if first.is_none() {
                *first = Some(error);
            }
        }
    }

    fn clear_readonly(p: &Path, first: &mut Option<std::io::Error>) {
        if let Ok(m) = p.metadata() {
            let mut perms = m.permissions();
            if perms.readonly() {
                perms.set_readonly(false);
                note(first, std::fs::set_permissions(p, perms));
            }
        }
    }

    fn strip_readonly_and_delete(p: &Path, first: &mut Option<std::io::Error>) {
        if let Ok(meta) = p.symlink_metadata() {
            if meta.is_dir() {
                match std::fs::read_dir(p) {
                    Ok(entries) => {
                        for entry in entries.flatten() {
                            strip_readonly_and_delete(&entry.path(), first);
                        }
                    }
                    Err(error) => note(first, Err(error)),
                }
                clear_readonly(p, first);
                note(first, std::fs::remove_dir(p));
            } else {
                clear_readonly(p, first);
                note(first, std::fs::remove_file(p));
            }
        }
    }

    let mut first = None;
    strip_readonly_and_delete(path, &mut first);
    if !path.exists() {
        return Ok(());
    }
    // The recursive pass can lose a race with a file that just reappeared;
    // one plain retry is cheaper than a second walk.
    let _ = std::fs::remove_dir_all(path);
    if !path.exists() {
        return Ok(());
    }
    Err(first.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            path.display().to_string(),
        )
    }))
}

#[cfg(test)]
mod name_tests {
    use std::path::PathBuf;

    use super::{is_safe_game_dir, plain_folder_name};

    #[test]
    fn folder_names_cannot_escape_the_install_root() {
        assert!(plain_folder_name("Ready Or Not"));
        assert!(!plain_folder_name(".."));
        assert!(!plain_folder_name(r"..\Windows"));
        assert!(!plain_folder_name(r"C:\Windows"));
        assert!(!plain_folder_name("a/b"));
        assert!(!is_safe_game_dir(
            &PathBuf::from(r"C:\Games\Foo\..\..\Windows\System32"),
            &PathBuf::from(r"C:\Games")
        ));
        assert!(!is_safe_game_dir(
            &PathBuf::from(r"C:\Windows\System32"),
            &PathBuf::from(r"C:\Games")
        ));
    }

    #[cfg(windows)]
    #[test]
    fn system_roots_are_forbidden_on_every_drive() {
        let default = PathBuf::from(r"C:\Games\Epic");
        for path in [
            r"D:\Windows",
            r"D:\Windows\System32",
            r"E:\Program Files",
            r"E:\Program Files (x86)",
            r"F:\ProgramData",
            r"F:\ProgramData\Epic",
            r"G:\Users",
            r"G:\Users\Efe",
            r"H:\System Volume Information",
            r"H:\$Recycle.Bin",
        ] {
            assert!(
                !is_safe_game_dir(&PathBuf::from(path), &default),
                "{path} must not be removable"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn a_custom_install_root_is_never_removed() {
        let root = PathBuf::from(r"D:\Games\Epic");
        assert!(!is_safe_game_dir(&root, &root));
        assert!(!is_safe_game_dir(&PathBuf::from(r"D:\Games\Epic\"), &root));
        assert!(is_safe_game_dir(
            &PathBuf::from(r"D:\Games\Epic\Game"),
            &root
        ));
        assert!(is_safe_game_dir(
            &PathBuf::from(r"E:\SteamLibrary\Game"),
            &root
        ));
    }
}
