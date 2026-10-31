//! Adopt an install the official client created, and hand it back again.
//!
//! A Connect install already contains every file the CDN manifest lists, so the
//! launcher only has to record the folder and deploy its shim on the next
//! launch. Adopting never moves or downloads game data; releasing restores the
//! official loader DLLs that the shim backed up.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

use crate::companion::ubi_installs;

use super::{install, manifest, shim};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AdoptedInstall {
    pub product_id: u32,
    pub name: String,
    pub install_dir: String,
    pub exe: String,
}

/// Record an existing game folder as a direct install. The main executable has
/// to be present; everything else is checked by the first verify pass.
pub(crate) async fn adopt(product_id: u32, install_dir: &Path) -> Result<AdoptedInstall, String> {
    if !install_dir.is_dir() {
        return Err(format!("install folder is missing: {}", install_dir.display()));
    }
    let (mut demux, _) = super::connect().await?;
    let prepared = install::prepare(&mut demux, product_id).await?;
    let exe = install::pick_executable(&prepared.manifest);
    if exe.is_empty() {
        return Err("the Ubisoft manifest names no game executable".to_string());
    }
    let exe_path = manifest::safe_install_path(install_dir, &exe)?;
    if !exe_path.is_file() {
        return Err(format!(
            "{} does not look like the {} install: {} is missing",
            install_dir.display(),
            prepared.name,
            exe_path.display()
        ));
    }
    let install_dir = install_dir.to_path_buf();
    let record = ubi_installs::InstalledGame {
        product_id,
        name: prepared.name.clone(),
        install_dir: install_dir.display().to_string(),
        exe: exe.clone(),
        installed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
        install_reg: prepared.install_reg,
        uplay_id: prepared.uplay_id,
        ticket: prepared.ticket,
        client_launch: false,
        manifest: prepared.manifest_id,
    };
    ubi_installs::save(&record);
    Ok(AdoptedInstall {
        product_id,
        name: record.name,
        install_dir: record.install_dir,
        exe,
    })
}

/// Stop managing an install and put the official loaders back. The game files
/// stay where they are, so Ubisoft Connect can start the title again.
pub(crate) fn release(product_id: u32) -> Result<usize, String> {
    let game = ubi_installs::find(product_id)
        .ok_or_else(|| format!("product {product_id} is not installed by the launcher"))?;
    let root = Path::new(&game.install_dir);
    let mut directories = vec![root.to_path_buf()];
    if let Ok(exe) = manifest::safe_install_path(root, &game.exe) {
        if let Some(parent) = exe.parent() {
            if !directories.iter().any(|dir| dir == parent) {
                directories.push(parent.to_path_buf());
            }
        }
    }
    let restored = directories
        .iter()
        .map(|directory| shim::restore_originals(directory))
        .sum();
    if directories.iter().any(|directory| shim::has_originals(directory)) {
        return Err(
            "could not restore every official loader; close the game and try again".to_string(),
        );
    }
    ubi_installs::remove(product_id);
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore = "reads Rayman Origins; needs that install"]
    async fn live_adopt_records_an_existing_folder() {
        let path = std::path::Path::new(r"C:\Users\Efe\Games\Ubisoft\Rayman Origins");
        let adopted = adopt(80, path).await.expect("adopt");
        println!(
            "adopted {} at {} ({})",
            adopted.name, adopted.install_dir, adopted.exe
        );
        let record = ubi_installs::find(80).expect("record");
        assert!(!record.manifest.is_empty());
        assert!(!record.client_launch);
        assert!(record.install_dir.ends_with("Rayman Origins"));
    }

    #[tokio::test]
    #[ignore = "adopts a real install named by EFXLVE_UBI_TEST_ADOPT_PRODUCT and EFXLVE_UBI_TEST_ADOPT_PATH"]
    async fn live_adopt_a_configured_install() {
        let product_id: u32 = std::env::var("EFXLVE_UBI_TEST_ADOPT_PRODUCT")
            .ok()
            .and_then(|value| value.parse().ok())
            .expect("EFXLVE_UBI_TEST_ADOPT_PRODUCT");
        let path = std::env::var("EFXLVE_UBI_TEST_ADOPT_PATH").expect("EFXLVE_UBI_TEST_ADOPT_PATH");
        let adopted = adopt(product_id, std::path::Path::new(&path))
            .await
            .expect("adopt");
        println!(
            "adopted {} at {} ({})",
            adopted.name, adopted.install_dir, adopted.exe
        );
        let record = ubi_installs::find(product_id).expect("record");
        assert_eq!(record.install_dir, path);
        assert!(!record.manifest.is_empty());
    }

    #[test]
    fn releasing_restores_the_backed_up_loader() {
        let root = std::env::temp_dir().join(format!(
            "efxlve-ubi-release-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("uplay_r1_loader.dll"), b"shim").unwrap();
        std::fs::write(root.join("uplay_r1_loader.dll.efxlve-orig"), b"official").unwrap();
        assert_eq!(shim::restore_originals(&root), 1);
        assert_eq!(
            std::fs::read(root.join("uplay_r1_loader.dll")).unwrap(),
            b"official"
        );
        assert!(!root.join("uplay_r1_loader.dll.efxlve-orig").exists());
        let _ = std::fs::remove_dir_all(&root);
    }
}
