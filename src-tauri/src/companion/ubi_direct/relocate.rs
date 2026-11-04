//! Move a direct or adopted install to another folder.
//!
//! The record is the source of truth for the install path. A move updates the
//! record and both registry families the game and the client read, so the next
//! launch (direct or through Connect) resolves the new folder.

use std::path::{Path, PathBuf};

use serde::Serialize;

use crate::companion::ubi_installs;

use super::launch;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MovedInstall {
    pub product_id: u32,
    pub install_dir: String,
}

/// Move the game folder into `destination_parent`, keeping its folder name.
/// The parent must exist; the final folder must not exist yet.
pub(crate) fn move_game(
    product_id: u32,
    destination_parent: &Path,
) -> Result<MovedInstall, String> {
    move_game_inner(product_id, destination_parent, true)
}

fn move_game_inner(
    product_id: u32,
    destination_parent: &Path,
    update_registry: bool,
) -> Result<MovedInstall, String> {
    let mut game = ubi_installs::find(product_id)
        .ok_or_else(|| format!("product {product_id} is not installed by the launcher"))?;
    let source = PathBuf::from(&game.install_dir);
    if !source.is_dir() {
        return Err(format!("install folder is missing: {}", source.display()));
    }
    if !destination_parent.is_dir() {
        return Err(format!(
            "destination folder is missing: {}",
            destination_parent.display()
        ));
    }
    let folder = source
        .file_name()
        .ok_or_else(|| "the install folder has no name".to_string())?;
    let destination = destination_parent.join(folder);
    if destination == source {
        return Ok(MovedInstall {
            product_id,
            install_dir: source.display().to_string(),
        });
    }
    if destination.starts_with(&source) {
        return Err("the destination cannot be inside the game folder".to_string());
    }
    if destination.exists() {
        return Err(format!(
            "{} already exists; choose an empty parent folder",
            destination.display()
        ));
    }

    match std::fs::rename(&source, &destination) {
        Ok(()) => {}
        Err(rename_error) => {
            // A different volume cannot be renamed; copy and then remove the
            // source. A failure leaves the source untouched.
            if let Err(copy_error) = copy_tree(&source, &destination) {
                let _ = std::fs::remove_dir_all(&destination);
                return Err(format!(
                    "moving {}: {rename_error}; copy failed: {copy_error}",
                    source.display()
                ));
            }
            std::fs::remove_dir_all(&source)
                .map_err(|error| format!("removing {}: {error}", source.display()))?;
        }
    }

    game.install_dir = destination.display().to_string();
    ubi_installs::save(&game);
    if update_registry {
        launch::seed_registry(product_id, &destination);
        launch::seed_game_registry(&game, &destination);
    }
    Ok(MovedInstall {
        product_id,
        install_dir: destination.display().to_string(),
    })
}

fn copy_tree(source: &Path, destination: &Path) -> Result<(), String> {
    std::fs::create_dir_all(destination)
        .map_err(|error| format!("creating {}: {error}", destination.display()))?;
    for entry in std::fs::read_dir(source)
        .map_err(|error| format!("reading {}: {error}", source.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            copy_tree(&from, &to)?;
        } else if kind.is_file() {
            std::fs::copy(&from, &to)
                .map_err(|error| format!("copying {}: {error}", from.display()))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::ubi_installs;

    #[test]
    #[ignore = "moves the adopted Anno 1404 install out of the Connect folder"]
    fn live_move_anno_out_of_the_connect_folder() {
        let destination = std::path::Path::new(r"C:\Users\Efe\Games\Ubisoft");
        let moved = move_game(16232, destination).expect("move");
        println!("moved to {}", moved.install_dir);
        assert!(std::path::Path::new(&moved.install_dir).is_dir());
    }

    #[test]
    fn a_move_keeps_the_folder_name_and_rejects_a_taken_destination() {
        let _guard = ubi_installs::test_lock().lock().unwrap();
        let root = std::env::temp_dir().join(format!("efxlve-ubi-move-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let source = root.join("source");
        let game = source.join("Anno 1404 - History Edition");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("Anno1404.exe"), b"exe").unwrap();
        let target = root.join("target");
        std::fs::create_dir_all(&target).unwrap();
        let record = root.join("installs.json");
        let previous = std::env::var_os("EFXLVE_UBI_INSTALLS_FILE");
        std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", &record);
        ubi_installs::save(&ubi_installs::InstalledGame {
            product_id: 16232,
            name: "Anno 1404 - History Edition".into(),
            install_dir: game.display().to_string(),
            exe: "Anno1404.exe".into(),
            installed_at: 1,
            uplay_id: 16232,
            ..Default::default()
        });

        let moved = move_game_inner(16232, &target, false).expect("move");
        let expected = target.join("Anno 1404 - History Edition");
        assert_eq!(Path::new(&moved.install_dir), expected);
        assert!(expected.join("Anno1404.exe").is_file());
        assert!(!game.exists());
        assert_eq!(
            Path::new(&ubi_installs::find(16232).unwrap().install_dir),
            expected
        );

        // A second game with the same folder name cannot land on the first.
        let other = root.join("other").join("Anno 1404 - History Edition");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join("Anno1404.exe"), b"exe").unwrap();
        let mut record = ubi_installs::find(16232).unwrap();
        record.install_dir = other.display().to_string();
        ubi_installs::save(&record);
        let blocked = move_game_inner(16232, &target, false);
        assert!(blocked.is_err());

        match previous {
            Some(value) => std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", value),
            None => std::env::remove_var("EFXLVE_UBI_INSTALLS_FILE"),
        }
        let _ = std::fs::remove_dir_all(&root);
    }
}
