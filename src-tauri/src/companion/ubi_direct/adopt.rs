//! Adopt an install the official client created, and hand it back again.
//!
//! A Connect install already contains every file the CDN manifest lists, so the
//! launcher only has to record the folder and deploy its shim on the next
//! launch. Adopting never moves or downloads game data; releasing restores the
//! official loader DLLs that the shim backed up.
//!
//! The ownership service is preferred because it also supplies the product name
//! and the game's own registry key. When the session is offline, the local
//! `uplay_install.manifest` and `uplay_install.state` are enough to record the
//! same install, so a signed-out user can still leave the client.

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
pub(crate) async fn adopt(
    product_id: u32,
    install_dir: &Path,
    title: Option<&str>,
) -> Result<AdoptedInstall, String> {
    if !install_dir.is_dir() {
        return Err(format!("install folder is missing: {}", install_dir.display()));
    }
    match super::connect().await {
        Ok((mut demux, _)) => match adopt_online(product_id, install_dir, &mut demux).await {
            Ok(adopted) => Ok(adopted),
            Err(online) => adopt_local(product_id, install_dir, title)
                .map_err(|local| format!("{online}; offline adopt failed: {local}")),
        },
        Err(online) => adopt_local(product_id, install_dir, title)
            .map_err(|local| format!("{online}; offline adopt failed: {local}")),
    }
}

async fn adopt_online(
    product_id: u32,
    install_dir: &Path,
    demux: &mut super::wire::Demux,
) -> Result<AdoptedInstall, String> {
    let prepared = install::prepare(demux, product_id).await?;
    let directory = install_dir.display().to_string();
    if crate::overlay::anti_cheat::game_has_anti_cheat(&prepared.name, Some(&directory)) {
        return Err(format!(
            "{} uses an anti-cheat service; keep it on Ubisoft Connect. The direct launcher will not bypass it.",
            prepared.name
        ));
    }
    let exe = if !prepared.exe.is_empty() {
        prepared.exe.clone()
    } else {
        install::pick_executable(&prepared.manifest)
    };
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
    let _ = manifest::write_local_cache(install_dir, &prepared.manifest, &prepared.manifest_id);
    let record = record(
        product_id,
        prepared.name,
        install_dir,
        exe,
        prepared.working_dir,
        prepared.launch_args,
        prepared.install_reg,
        prepared.uplay_id,
        prepared.ticket,
        prepared.manifest_id,
    );
    finish(record)
}

fn adopt_local(
    product_id: u32,
    install_dir: &Path,
    title: Option<&str>,
) -> Result<AdoptedInstall, String> {
    let name = title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .or_else(|| {
            install_dir
                .file_name()
                .and_then(|name| name.to_str())
                .map(str::to_string)
        })
        .unwrap_or_else(|| format!("Ubisoft {product_id}"));
    let directory = install_dir.display().to_string();
    if crate::overlay::anti_cheat::game_has_anti_cheat(&name, Some(&directory)) {
        return Err(format!(
            "{name} uses an anti-cheat service; keep it on Ubisoft Connect. The direct launcher will not bypass it."
        ));
    }
    let (local, manifest_id) = manifest::read_local_install(install_dir)?;
    let _ = manifest::write_local_cache(install_dir, &local, &manifest_id);
    let name_slug = crate::companion::scan::slug(&name);
    let cached = crate::companion::ubisoft::config_rows()
        .into_iter()
        .find(|row| {
            row.install_id == u64::from(product_id)
                || row.launch_id == u64::from(product_id)
                || (!name_slug.is_empty() && crate::companion::scan::slug(&row.name) == name_slug)
        });
    let configured_exe = cached
        .as_ref()
        .map(|row| row.spec.exe.as_str())
        .unwrap_or("");
    let exe = install::resolve_executable(&local, configured_exe);
    if exe.is_empty() {
        return Err("the local Ubisoft manifest names no game executable".to_string());
    }
    let exe_path = manifest::safe_install_path(install_dir, &exe)?;
    if !exe_path.is_file() {
        return Err(format!(
            "{} does not look like an installed game: {} is missing",
            install_dir.display(),
            exe_path.display()
        ));
    }
    // Use the local configuration cache when present; otherwise the product id
    // is the best available Uplay id until the next online adopt.
    let (working_dir, launch_args, install_reg, uplay_id) = match cached {
        Some(row) => (
            row.spec.working_dir,
            row.spec.arguments,
            row.spec.install_reg,
            if row.launch_id != 0 {
                row.launch_id as u32
            } else {
                product_id
            },
        ),
        None => (String::new(), String::new(), String::new(), product_id),
    };
    let record = record(
        product_id,
        name,
        install_dir,
        exe,
        working_dir,
        launch_args,
        install_reg,
        uplay_id,
        String::new(),
        manifest_id,
    );
    finish(record)
}

#[allow(clippy::too_many_arguments)]
fn record(
    product_id: u32,
    name: String,
    install_dir: &Path,
    exe: String,
    working_dir: String,
    launch_args: String,
    install_reg: String,
    uplay_id: u32,
    ticket: String,
    manifest_id: String,
) -> ubi_installs::InstalledGame {
    ubi_installs::InstalledGame {
        product_id,
        name,
        install_dir: install_dir.display().to_string(),
        exe,
        installed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_secs())
            .unwrap_or(0),
        install_reg,
        working_dir,
        launch_args,
        uplay_id,
        ticket,
        client_launch: false,
        manifest: manifest_id,
    }
}

fn finish(record: ubi_installs::InstalledGame) -> Result<AdoptedInstall, String> {
    ubi_installs::save(&record);
    Ok(AdoptedInstall {
        product_id: record.product_id,
        name: record.name,
        install_dir: record.install_dir,
        exe: record.exe,
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
        let adopted = adopt(80, path, Some("Rayman Origins")).await.expect("adopt");
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
        let adopted = adopt(product_id, std::path::Path::new(&path), None)
            .await
            .expect("adopt");
        println!(
            "adopted {} at {} ({})",
            adopted.name, adopted.install_dir, adopted.exe
        );
        let record = ubi_installs::find(product_id).expect("record");
        assert_eq!(record.install_dir, path);
    }

    #[test]
    fn an_offline_adopt_refuses_an_anti_cheat_title() {
        let root = std::env::temp_dir().join(format!(
            "efxlve-ubi-offline-ac-{}",
            std::process::id()
        ));
        let game = root.join("Tom Clancy's Rainbow Six Siege");
        std::fs::create_dir_all(&game).unwrap();
        let error = adopt_local(
            635,
            &game,
            Some("Tom Clancy's Rainbow Six Siege"),
        )
        .expect_err("anti-cheat titles must stay on the client");
        assert!(error.contains("anti-cheat"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_offline_adopt_reads_the_local_manifest() {
        use crate::companion::proto::{push_bytes, push_varint_field};
        use std::io::Write;

        let _guard = ubi_installs::test_lock().lock().unwrap();
        let root = std::env::temp_dir().join(format!(
            "efxlve-ubi-offline-adopt-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        let game = root.join("Offline Game");
        std::fs::create_dir_all(&game).unwrap();
        std::fs::write(game.join("game.exe"), b"exe").unwrap();

        let mut file = Vec::new();
        push_bytes(&mut file, 1, b"game.exe");
        push_varint_field(&mut file, 2, 3);
        let mut chunk = Vec::new();
        push_bytes(&mut chunk, 3, &file);
        let mut manifest_bytes = Vec::new();
        push_bytes(&mut manifest_bytes, 4, &chunk);
        let mut local = vec![0u8; 356];
        {
            let mut encoder =
                flate2::write::ZlibEncoder::new(Vec::new(), flate2::Compression::default());
            encoder.write_all(&manifest_bytes).unwrap();
            local.extend_from_slice(&encoder.finish().unwrap());
        }
        std::fs::write(game.join("uplay_install.manifest"), local).unwrap();
        let mut state = Vec::new();
        push_bytes(&mut state, 1, b"0123456789ABCDEF0123456789ABCDEF01234567");
        std::fs::write(game.join("uplay_install.state"), state).unwrap();

        let record_file = root.join("installs.json");
        let previous = std::env::var_os("EFXLVE_UBI_INSTALLS_FILE");
        std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", &record_file);
        let adopted = adopt_local(999, &game, Some("Offline Game")).expect("offline adopt");
        assert_eq!(adopted.name, "Offline Game");
        assert_eq!(adopted.exe, "game.exe");
        let record = ubi_installs::find(999).expect("record");
        assert_eq!(record.uplay_id, 999);
        assert!(!record.client_launch);
        assert_eq!(
            record.manifest,
            "0123456789ABCDEF0123456789ABCDEF01234567"
        );
        match previous {
            Some(value) => std::env::set_var("EFXLVE_UBI_INSTALLS_FILE", value),
            None => std::env::remove_var("EFXLVE_UBI_INSTALLS_FILE"),
        }
        let _ = std::fs::remove_dir_all(&root);
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
