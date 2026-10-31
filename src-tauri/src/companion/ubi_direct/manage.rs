//! Remove a game the launcher installed from Ubisoft's CDN.
//!
//! The client's uninstaller is not in this path. The record is the source of
//! truth for the folder, and a folder is only deleted when it still contains
//! the executable the record names. A moved or hand-edited folder is left alone
//! and only the record is dropped.

use std::path::{Component, Path};

use crate::companion::ubi_installs;

pub(crate) fn uninstall(product_id: u32, delete_files: bool) -> Result<(), String> {
    let game = ubi_installs::find(product_id)
        .ok_or_else(|| format!("product {product_id} is not installed by the launcher"))?;
    if delete_files {
        let directory = Path::new(&game.install_dir);
        if directory.exists() && !safe_to_delete(directory, &game.exe) {
            return Err(format!(
                "refusing to delete {}: it no longer looks like the recorded install",
                directory.display()
            ));
        }
        if directory.exists() {
            std::fs::remove_dir_all(directory)
                .map_err(|error| format!("deleting {}: {error}", directory.display()))?;
        }
    }
    ubi_installs::remove(product_id);
    Ok(())
}

/// A destructive delete needs an absolute path with a root, at least one folder
/// below it, no `..`, and the executable the record named still present.
fn safe_to_delete(directory: &Path, exe: &str) -> bool {
    if !directory.is_absolute() {
        return false;
    }
    let components: Vec<Component> = directory.components().collect();
    if components.len() < 3 {
        return false;
    }
    if components
        .iter()
        .any(|component| matches!(component, Component::ParentDir))
    {
        return false;
    }
    if !matches!(
        components.first(),
        Some(Component::Prefix(_)) | Some(Component::RootDir)
    ) {
        return false;
    }
    if exe.trim().is_empty() {
        return false;
    }
    directory
        .join(exe.replace('\\', std::path::MAIN_SEPARATOR_STR))
        .is_file()
}

#[cfg(test)]
mod tests {
    use super::{safe_to_delete, uninstall};
    use crate::companion::ubi_installs;

    #[test]
    fn refuses_roots_and_folders_without_the_recorded_exe() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-uninstall-{}", std::process::id()));
        let game = root.join("Ubisoft").join("Rayman Origins");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("Rayman Origins.exe"), b"exe").unwrap();

        assert!(safe_to_delete(&game, "Rayman Origins.exe"));
        assert!(!safe_to_delete(&root.join("Ubisoft"), "Rayman Origins.exe"));
        assert!(!safe_to_delete(&game, "missing.exe"));
        assert!(!safe_to_delete(&game, r"..\Rayman Origins.exe"));
        assert!(!safe_to_delete(std::path::Path::new("C:\\"), "game.exe"));
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn removes_the_recorded_folder_and_the_record() {
        let _guard = ubi_installs::test_lock().lock().unwrap();
        let root = std::env::temp_dir().join(format!("efxlve-ubi-remove-{}", std::process::id()));
        let game = root.join("Ubisoft").join("Test Game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("game.exe"), b"exe").unwrap();
        let record_file = root.join("installs.json");
        let previous = std::env::var_os("EFXLVE_UBI_INSTALLS_FILE");
        std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", &record_file);
        ubi_installs::save(&ubi_installs::InstalledGame {
            product_id: 999,
            name: "Test Game".into(),
            install_dir: game.display().to_string(),
            exe: "game.exe".into(),
            installed_at: 1,
            install_reg: String::new(),
            uplay_id: 0,
            ticket: String::new(),
            client_launch: false,
        });
        uninstall(999, true).expect("uninstall");
        assert!(!game.exists());
        assert!(ubi_installs::find(999).is_none());
        match previous {
            Some(value) => std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", value),
            None => std::env::remove_var("EFXLVE_UBI_INSTALLS_FILE"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
