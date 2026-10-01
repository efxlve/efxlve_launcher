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

pub(super) fn is_safe_game_dir(path: &Path, default_install: &Path) -> bool {
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
    let s = path.to_string_lossy().to_lowercase();
    let s = s.trim_start_matches(r"\\?\");

    // Must not be the default install root itself
    if let Ok(canon_def) = default_install.canonicalize() {
        let def_s = canon_def.to_string_lossy().to_lowercase();
        let def_s = def_s.trim_start_matches(r"\\?\");
        if s == def_s {
            return false;
        }
    }
    let def_raw = default_install.to_string_lossy().to_lowercase();
    let def_raw = def_raw.trim_start_matches(r"\\?\");
    if s == def_raw {
        return false;
    }

    // Blacklist critical Windows roots
    let forbidden = [
        "c:\\",
        "d:\\",
        "e:\\",
        "f:\\",
        "g:\\",
        "c:\\windows",
        "c:\\windows\\system32",
        "c:\\program files",
        "c:\\program files (x86)",
        "c:\\programdata",
        "c:\\programdata\\epic",
        "c:\\users",
    ];
    for f in forbidden {
        if s == f || s == format!("{}\\", f.trim_end_matches('\\')) {
            return false;
        }
    }

    // Children of the OS directory, not only the directory itself.
    let compact = s.trim_end_matches('\\');
    if compact == r"c:\windows" || compact.starts_with(r"c:\windows\") {
        return false;
    }

    // Must not be user profile or core profile folders
    if let Ok(user_profile) = std::env::var("USERPROFILE") {
        let up = user_profile.to_lowercase();
        if s == up
            || s == format!("{}\\desktop", up)
            || s == format!("{}\\documents", up)
            || s == format!("{}\\downloads", up)
            || s == format!("{}\\appdata", up)
        {
            return false;
        }
    }

    true
}

/// Recursively removes a directory on Windows, stripping any read-only attributes
/// that would otherwise cause `ERROR_ACCESS_DENIED` during deletion.
pub(super) fn force_remove_dir_all(path: &Path) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    // Fast path: try standard std::fs::remove_dir_all first
    if std::fs::remove_dir_all(path).is_ok() {
        return Ok(());
    }

    fn strip_readonly_and_delete(p: &Path) -> std::io::Result<()> {
        if let Ok(meta) = p.symlink_metadata() {
            if meta.is_dir() {
                if let Ok(entries) = std::fs::read_dir(p) {
                    for entry in entries.flatten() {
                        let _ = strip_readonly_and_delete(&entry.path());
                    }
                }
                if let Ok(m) = p.metadata() {
                    let mut perms = m.permissions();
                    if perms.readonly() {
                        perms.set_readonly(false);
                        let _ = std::fs::set_permissions(p, perms);
                    }
                }
                let _ = std::fs::remove_dir(p);
            } else {
                if let Ok(m) = p.metadata() {
                    let mut perms = m.permissions();
                    if perms.readonly() {
                        perms.set_readonly(false);
                        let _ = std::fs::set_permissions(p, perms);
                    }
                }
                let _ = std::fs::remove_file(p);
            }
        }
        Ok(())
    }

    let _ = strip_readonly_and_delete(path);
    if path.exists() {
        let _ = std::fs::remove_dir_all(path);
    }
    Ok(())
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
}
