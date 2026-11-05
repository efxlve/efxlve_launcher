//! Native Ubisoft Connect path: the Demux ownership service and the signed
//! install manifest.
//!
//! The store sign-in already stores a `ubi_v1` ticket for the launcher app id
//! Demux expects. This module takes that ticket straight to
//! `dmx.upc.ubisoft.com`, so the owned list and its install manifest no longer
//! depend on `UbisoftConnect.exe` being installed or running.

mod achievements;
mod adopt;
mod auth;
mod cloud_saves;
mod codec;
pub(crate) mod install;
mod launch;
mod manage;
pub(crate) mod manifest;
mod relocate;
pub(crate) mod saves;
mod shim;
pub(crate) mod verify;
pub(crate) mod wire;

pub(crate) use achievements::merge as merge_achievements;
pub(crate) use adopt::{adopt as adopt_game, release as release_game, AdoptedInstall};
pub(crate) use cloud_saves::download as download_cloud_saves;
pub(crate) use relocate::{move_game, MovedInstall};
pub(crate) use saves::{
    cloud_destination, migrate_connect_saves as import_connect_saves, path_for as save_path,
    path_for_product as save_path_for_product,
};

use serde::Serialize;

use super::ubisoft;
use super::ubisoft_login;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UbiDirectGame {
    pub product_id: u32,
    pub uplay_id: u32,
    pub name: String,
    pub installable: bool,
    pub manifest: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UbiDirectProbe {
    pub account: String,
    pub total: usize,
    pub installable: usize,
    pub games: Vec<UbiDirectGame>,
}

/// The stored ticket is usually already scoped to the launcher app id. Try it
/// first; refresh the session and exchange the ticket only when Demux rejects it,
/// because the exchange is rate limited per profile.
async fn connect() -> Result<(wire::Demux, ubisoft_login::Session), String> {
    let session = ubisoft_login::stored_session()
        .ok_or_else(|| "@t:accounts.ubiSessionExpired".to_string())?;

    match wire::Demux::connect(&session.ticket).await {
        Ok(demux) => return Ok((demux, session)),
        Err(first) => {
            let refreshed = ubisoft_login::refresh_stored_session()
                .await
                .unwrap_or_else(|| session.clone());
            if refreshed.ticket != session.ticket {
                if let Ok(demux) = wire::Demux::connect(&refreshed.ticket).await {
                    return Ok((demux, refreshed));
                }
            }
            let exchanged = auth::exchange_demux_ticket(&refreshed)
                .await
                .map_err(|error| format!("{first}; ticket exchange failed: {error}"))?;
            let demux = wire::Demux::connect(&exchanged).await?;
            Ok((demux, refreshed))
        }
    }
}

/// Keep the achievement/space metadata from the ownership configuration. The
/// Connect client's local cache is encrypted on current builds, so this is the
/// only unauthenticated-free source the achievement page can use later.
fn record_achievement_metadata(owned: &[codec::OwnedGame]) {
    let cached = ubisoft::load_owned();
    let rows: Vec<super::ubi_achievements::AchievementMeta> = owned
        .iter()
        .filter(|game| game.owned)
        .filter_map(|game| {
            let name = ubisoft::game_name(&game.configuration).or_else(|| {
                cached
                    .iter()
                    .find(|row| row.product_id == game.product_id)
                    .map(|row| row.name.clone())
            })?;
            Some(super::ubi_achievements::AchievementMeta {
                product_id: game.product_id,
                uplay_id: game.uplay_id,
                space_id: ubisoft::yaml_value(&game.configuration, "space_id"),
                name,
                achievements: ubisoft::yaml_value(&game.configuration, "achievements"),
                sync_id: ubisoft::yaml_value(&game.configuration, "achievements_sync_id"),
            })
        })
        .collect();
    super::ubi_achievements::record_specs(&rows);
}

/// Refresh the achievement metadata from the ownership service without reading
/// manifests. Used when a game page has no schema and the account is signed in.
pub(crate) async fn refresh_achievement_metadata() -> Result<(), String> {
    let (mut demux, _) = connect().await?;
    let owned = demux.owned_games().await?;
    record_achievement_metadata(&owned);
    Ok(())
}

/// One product's configuration from the ownership service. A catalog-only row
/// (for example a giveaway claimed in the store) is absent from the initialize
/// response, so it needs this direct request before its achievements resolve.
pub(crate) async fn refresh_achievement_metadata_for(product_id: u32) -> Result<(), String> {
    if product_id == 0 {
        return Err("no product id".to_string());
    }
    let (mut demux, _) = connect().await?;
    let configuration = demux.product_configuration(product_id).await?;
    let name = ubisoft::game_name(&configuration)
        .ok_or_else(|| format!("product {product_id} has no name"))?;
    let rows = [super::ubi_achievements::AchievementMeta {
        product_id,
        uplay_id: 0,
        space_id: ubisoft::yaml_value(&configuration, "space_id"),
        name,
        achievements: ubisoft::yaml_value(&configuration, "achievements"),
        sync_id: ubisoft::yaml_value(&configuration, "achievements_sync_id"),
    }];
    super::ubi_achievements::record_specs(&rows);
    Ok(())
}

/// Read the account's earned achievements for one game from `ach_frontend`.
/// This is independent of a local install or spool.
pub(crate) async fn remote_achievements(product_id: &str) -> Result<Vec<(u32, u64)>, String> {
    let (mut demux, session) = connect().await?;
    if session.user_id.trim().is_empty() {
        return Err("the Ubisoft profile has no id".to_string());
    }
    // The achievement service expects the account's ownership session to have
    // initialized on this socket first.
    let _ = demux.owned_games().await?;
    demux
        .achievements(&session.user_id, product_id, "PC")
        .await
}

/// Ask Demux for the owned base games and their current manifest ids.
pub(crate) async fn probe() -> Result<UbiDirectProbe, String> {
    let (mut demux, session) = connect().await?;
    let owned = demux.owned_games().await?;
    record_achievement_metadata(&owned);
    let mut games: Vec<codec::OwnedGame> = owned
        .into_iter()
        .filter(|game| game.owned && game.product_type == 0)
        .collect();
    games.sort_by_key(|game| game.product_id);

    let missing: Vec<u32> = games
        .iter()
        .filter(|game| game.latest_manifest.is_empty())
        .map(|game| game.product_id)
        .collect();
    let resolved = demux.latest_manifests(&missing).await.unwrap_or_default();

    let mut rows: Vec<UbiDirectGame> = games
        .into_iter()
        .map(|game| {
            let manifest = if game.latest_manifest.is_empty() {
                resolved.get(&game.product_id).cloned().unwrap_or_default()
            } else {
                game.latest_manifest.clone()
            };
            let name = ubisoft::game_name(&game.configuration)
                .unwrap_or_else(|| game.product_id.to_string());
            UbiDirectGame {
                product_id: game.product_id,
                uplay_id: game.uplay_id,
                name,
                installable: !manifest.is_empty(),
                manifest,
            }
        })
        .collect();
    rows.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));

    let installable = rows.iter().filter(|game| game.installable).count();
    Ok(UbiDirectProbe {
        account: session.name,
        total: rows.len(),
        installable,
        games: rows,
    })
}

/// Read the manifest and return a summary without writing anything.
pub(crate) async fn plan_game(
    product_id: u32,
    install_dir: std::path::PathBuf,
) -> Result<install::InstallPlan, String> {
    let (mut demux, _) = connect().await?;
    install::probe_plan(&mut demux, product_id, &install_dir).await
}

/// Download and verify every file of an owned product.
pub(crate) async fn install_game(
    app: tauri::AppHandle,
    product_id: u32,
    install_dir: std::path::PathBuf,
) -> Result<install::InstallSummary, String> {
    use tauri::Emitter;
    let (mut demux, _) = connect().await?;
    install::install(&mut demux, product_id, &install_dir, move |progress| {
        let _ = app.emit("ubi-direct-progress", progress);
    })
    .await
}

/// Start a game the launcher installed, without Ubisoft Connect.
pub(crate) async fn launch_game(product_id: u32, shim_enabled: bool) -> Result<(), String> {
    launch::launch(product_id, shim_enabled).await
}

/// Remove a direct install and, when asked, its folder. Never touches a folder
/// that no longer contains the recorded executable.
pub(crate) fn uninstall_game(product_id: u32, delete_files: bool) -> Result<(), String> {
    manage::uninstall(product_id, delete_files)
}

/// Ask a running direct install to stop after the current slice. The part file
/// remains for the next resume.
pub(crate) fn cancel_game(product_id: u32) {
    install::cancel(product_id)
}

/// The installed build compared with the CDN's current manifest.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCheck {
    pub installed: String,
    pub latest: String,
    pub update: bool,
    /// The record predates manifest tracking; a verify pass fills it.
    pub unknown: bool,
}

fn update_state(installed: &str, latest: &str) -> UpdateCheck {
    let installed = installed.trim().to_string();
    let latest = latest.trim().to_string();
    UpdateCheck {
        unknown: installed.is_empty(),
        update: !installed.is_empty()
            && !latest.is_empty()
            && !installed.eq_ignore_ascii_case(&latest),
        installed,
        latest,
    }
}

/// Compare the recorded CDN manifest with the one ownership reports now, so
/// the Manage panel can tell the user an update exists without hashing files.
pub(crate) async fn check_update(product_id: u32) -> Result<UpdateCheck, String> {
    let record = crate::companion::ubi_installs::find(product_id)
        .ok_or_else(|| format!("product {product_id} is not installed by the launcher"))?;
    let (mut demux, _) = connect().await?;
    let owned = demux.owned_games().await?;
    let owned_latest = owned
        .iter()
        .find(|game| game.product_id == product_id && game.owned)
        .map(|game| game.latest_manifest.clone())
        .ok_or_else(|| format!("product {product_id} is not in the owned library"))?;
    let latest = if owned_latest.is_empty() {
        demux
            .latest_manifests(&[product_id])
            .await?
            .remove(&product_id)
            .unwrap_or_default()
    } else {
        owned_latest
    };
    Ok(update_state(&record.manifest, &latest))
}

/// Check every file against the manifest's slice hashes; with `repair`, delete
/// the rejected files and download only those again. A clean check, or a
/// successful repair, records the current manifest id for update checks.
pub(crate) async fn verify_game(
    app: tauri::AppHandle,
    product_id: u32,
    repair: bool,
) -> Result<verify::VerifyReport, String> {
    use tauri::Emitter;
    let mut record = crate::companion::ubi_installs::find(product_id)
        .ok_or_else(|| format!("product {product_id} is not installed by the launcher"))?;
    let directory = std::path::PathBuf::from(&record.install_dir);
    let (manifest, latest_id) = match connect().await {
        Ok((mut demux, _)) => {
            let prepared = install::prepare(&mut demux, product_id).await?;
            (prepared.manifest, prepared.manifest_id)
        }
        Err(online) => manifest::read_local_install(&directory).map_err(|local| {
            format!("{online}; offline verify failed: {local}")
        })?,
    };
    let mut report = verify::verify(&manifest, &directory);
    if repair && !report.bad_files.is_empty() {
        verify::stage_bad(&directory, &report.bad_files);
        let (mut demux, _) = connect().await?;
        install::install(&mut demux, product_id, &directory, |progress| {
            let _ = app.emit("ubi-direct-progress", progress);
        })
        .await?;
        report.repaired = report.bad_files.len();
    }
    if report.bad_files.is_empty() || report.repaired > 0 {
        record.manifest = latest_id;
        crate::companion::ubi_installs::save(&record);
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_probe_serializes_with_camel_case_for_the_frontend() {
        let probe = UbiDirectProbe {
            account: "player".into(),
            total: 1,
            installable: 1,
            games: vec![UbiDirectGame {
                product_id: 1,
                uplay_id: 2,
                name: "Game".into(),
                installable: true,
                manifest: "m".into(),
            }],
        };
        let json = serde_json::to_string(&probe).unwrap();
        assert!(json.contains("\"productId\":1"));
        assert!(json.contains("\"uplayId\":2"));
        assert!(json.contains("\"installable\":true"));
    }

    #[tokio::test]
    #[ignore = "needs a linked Ubisoft session"]
    async fn live_ach_frontend_reads_rainbow_six() {
        let mut any = false;
        for id in ["635", "RSIX7"] {
            match remote_achievements(id).await {
                Ok(earned) => {
                    println!("{id}: {} earned achievements", earned.len());
                    any |= !earned.is_empty();
                }
                Err(error) => println!("{id}: {error}"),
            }
        }
        assert!(any, "the achievement service returned no records");
    }

    #[tokio::test]
    #[ignore = "needs a linked Ubisoft session"]
    async fn live_probe_lists_non_base_products() {
        let (mut demux, _) = connect().await.expect("Demux connect failed");
        let owned = demux.owned_games().await.expect("ownership");
        for game in owned.iter().filter(|game| game.product_type != 0) {
            let name = ubisoft::game_name(&game.configuration).unwrap_or_default();
            println!(
                "type={} product={} uplay={} owned={} manifest={} name={}",
                game.product_type,
                game.product_id,
                game.uplay_id,
                game.owned,
                game.latest_manifest,
                name
            );
        }
    }

    #[test]
    #[ignore = "reads the local Rainbow Six install manifest"]
    fn live_parse_local_r6_manifest() {
        use std::io::Read;
        let path = std::path::Path::new(
            r"C:\Program Files (x86)\Ubisoft\Ubisoft Game Launcher\games\Tom Clancy's Rainbow Six Siege\uplay_install.manifest",
        );
        let bytes = std::fs::read(path).expect("manifest");
        let mut inflated = Vec::new();
        flate2::read::ZlibDecoder::new(&bytes[356..])
            .read_to_end(&mut inflated)
            .expect("inflate");
        let manifest = manifest::parse_manifest(&inflated);
        let total = manifest.total_bytes();
        let compressed: u64 = manifest
            .files
            .iter()
            .flat_map(|file| &file.slices)
            .map(|slice| u64::from(slice.download_size.unwrap_or(slice.size)))
            .sum();
        println!(
            "files={} total={} compressed={}",
            manifest.files.len(),
            total,
            compressed
        );
    }

    #[tokio::test]
    #[ignore = "prints one product's configuration; set EFXLVE_UBI_TEST_PRODUCT"]
    async fn live_print_product_configuration() {
        let product: u32 = std::env::var("EFXLVE_UBI_TEST_PRODUCT")
            .ok()
            .and_then(|value| value.parse().ok())
            .expect("EFXLVE_UBI_TEST_PRODUCT");
        let (mut demux, _) = connect().await.expect("Demux connect");
        let owned = demux.owned_games().await.expect("ownership");
        let game = owned
            .iter()
            .find(|game| game.product_id == product)
            .expect("product");
        for line in game.configuration.lines() {
            let lower = line.to_lowercase();
            if lower.contains("start_game")
                || lower.contains("exe")
                || lower.contains("launch")
                || lower.contains("command")
                || lower.contains("size")
                || lower.contains("space_id")
                || lower.contains("achievement")
                || lower.contains("chunk")
                || lower.contains("install")
            {
                println!("{line}");
            }
        }
    }

    #[tokio::test]
    #[ignore = "needs a linked Ubisoft session"]
    async fn live_probe_lists_owned_games() {
        let probe = probe().await.expect("Demux probe failed");
        println!(
            "account={} total={} installable={}",
            probe.account, probe.total, probe.installable
        );
        for game in probe.games.iter().take(50) {
            println!(
                "  {} product={} uplay={} installable={} manifest={}",
                game.name, game.product_id, game.uplay_id, game.installable, game.manifest
            );
        }
        assert!(probe.total > 0, "the account reported no owned base games");
    }

    #[tokio::test]
    #[ignore = "needs EFXLVE_UBI_TEST_PRODUCT and a linked Ubisoft session"]
    async fn live_plan_reads_a_manifest() {
        let product_id: u32 = std::env::var("EFXLVE_UBI_TEST_PRODUCT")
            .expect("set EFXLVE_UBI_TEST_PRODUCT")
            .parse()
            .expect("product id must be a number");
        let (mut demux, _) = connect().await.expect("Demux connect failed");
        let plan = install::probe_plan(&mut demux, product_id, &std::env::temp_dir())
            .await
            .expect("manifest plan failed");
        println!(
            "{}: {} files, {} slices, {} bytes ({} download), {} compression, {} layout, client_only={}",
            plan.name,
            plan.files,
            plan.slices,
            plan.bytes,
            plan.download_bytes,
            plan.compression,
            plan.slice_layout,
            plan.client_only
        );
        assert!(plan.files > 0);
        assert!(plan.download_bytes > 0);
    }

    #[tokio::test]
    #[ignore = "downloads a full game; needs EFXLVE_UBI_TEST_PRODUCT, EFXLVE_UBI_TEST_DIR and a linked session"]
    async fn live_install_downloads_a_game() {
        let product_id: u32 = std::env::var("EFXLVE_UBI_TEST_PRODUCT")
            .expect("set EFXLVE_UBI_TEST_PRODUCT")
            .parse()
            .expect("product id must be a number");
        let directory = std::env::var("EFXLVE_UBI_TEST_DIR")
            .expect("set EFXLVE_UBI_TEST_DIR");
        let (mut demux, _) = connect().await.expect("Demux connect failed");
        let mut last = 0u64;
        let summary = install::install(
            &mut demux,
            product_id,
            std::path::Path::new(&directory),
            |progress| {
                let step = progress.total_bytes / 20;
                if progress.done_bytes - last >= step {
                    last = progress.done_bytes;
                    println!(
                        "{} / {} MB — {}",
                        progress.done_bytes / 1_000_000,
                        progress.total_bytes / 1_000_000,
                        progress.file
                    );
                }
            },
        )
        .await
        .expect("direct install failed");
        println!("{summary:?}");
        assert!(summary.bytes > 0);
    }

    #[tokio::test]
    #[ignore = "launches an installed game; needs EFXLVE_UBI_TEST_PRODUCT"]
    async fn live_launch_installed_game() {
        let product_id: u32 = std::env::var("EFXLVE_UBI_TEST_PRODUCT")
            .expect("set EFXLVE_UBI_TEST_PRODUCT")
            .parse()
            .expect("product id must be a number");
        let installed = crate::companion::ubi_installs::find(product_id)
            .expect("the game must be installed by the launcher first");
        let exe = std::path::Path::new(&installed.install_dir).join(&installed.exe);
        println!("exe={}", exe.display());
        let loader = shim::detect(&exe).expect("loader detection");
        println!("loader={loader:?}");
        launch_game(product_id, true).await.expect("direct launch");
    }

    #[test]
    #[ignore = "reads the real Ubisoft achievement cache"]
    fn live_rayman_achievement_catalogue() {
        let response = crate::companion::ubi_achievements::achievements_for(
            "80",
            "Rayman Origins",
            "en",
        );
        println!(
            "total={} unlocked={}",
            response.total_achievements, response.user_unlocked
        );
        for item in response.achievements.iter().take(8) {
            println!(
                "  id={} name={} unlocked={}",
                item.name, item.display_name, item.unlocked
            );
        }
        if response.total_achievements == 0 {
            println!("no achievement schema is cached for this title; the shim will record unlocks only after one exists");
            return;
        }
        assert!(response.total_achievements > 0);
    }

    struct RestoreFile {
        path: std::path::PathBuf,
        data: Vec<u8>,
    }

    impl Drop for RestoreFile {
        fn drop(&mut self) {
            let _ = std::fs::write(&self.path, &self.data);
        }
    }

    #[tokio::test]
    #[ignore = "repairs Rayman Origins; needs that direct install"]
    async fn live_repair_restores_a_corrupted_file() {
        let record = crate::companion::ubi_installs::find(80).expect("Rayman Origins record");
        let directory = std::path::PathBuf::from(&record.install_dir);
        let path = directory.join("Rayman.ico");
        let original = std::fs::read(&path).expect("Rayman.ico");
        let _restore = RestoreFile {
            path: path.clone(),
            data: original.clone(),
        };
        std::fs::write(&path, b"corrupted").unwrap();

        let (mut demux, _) = connect().await.expect("Demux connect");
        let prepared = install::prepare(&mut demux, 80).await.expect("manifest");
        let report = verify::verify(&prepared.manifest, &directory);
        println!(
            "verify: files={} checked={} corrupt={} missing={}",
            report.files, report.checked, report.corrupt, report.missing
        );
        assert!(report.corrupt >= 1, "the corrupted icon must be detected");
        verify::stage_bad(&directory, &report.bad_files);

        let (mut demux, _) = connect().await.expect("Demux connect");
        install::install(&mut demux, 80, &directory, |_| {})
            .await
            .expect("repair install");
        let repaired = std::fs::read(&path).expect("repaired icon");
        assert_eq!(repaired, original);
        println!("repaired {} bytes", repaired.len());
    }

    #[test]
    #[ignore = "reads Rayman Origins; needs that direct install"]
    fn live_launch_mode_round_trip() {
        assert!(crate::companion::ubi_installs::set_client_launch(80, true));
        assert!(
            crate::companion::ubi_installs::find(80)
                .expect("record")
                .client_launch
        );
        assert!(crate::companion::ubi_installs::set_client_launch(80, false));
        assert!(
            !crate::companion::ubi_installs::find(80)
                .expect("record")
                .client_launch
        );
        println!("Rayman launch mode toggled to client and back to direct");
    }

    #[test]
    fn update_state_compares_manifest_ids_and_flags_old_records() {
        let fresh = update_state("ABC123", "abc123");
        assert!(!fresh.update);
        assert!(!fresh.unknown);
        let stale = update_state("ABC123", "DEF456");
        assert!(stale.update);
        assert_eq!(stale.installed, "ABC123");
        assert_eq!(stale.latest, "DEF456");
        let legacy = update_state("", "DEF456");
        assert!(legacy.unknown);
        assert!(!legacy.update);
        let no_build = update_state("ABC123", "");
        assert!(!no_build.unknown);
        assert!(!no_build.update);
    }

    #[tokio::test]
    #[ignore = "reads Rayman Origins; needs that direct install"]
    async fn live_rayman_update_check_matches_the_current_build() {
        let mut record =
            crate::companion::ubi_installs::find(80).expect("Rayman Origins record");
        if record.manifest.is_empty() {
            // The app records the same id after a clean verify; do it once here
            // so the live check has a baseline.
            let (mut demux, _) = connect().await.expect("Demux connect");
            let prepared = install::prepare(&mut demux, 80).await.expect("manifest");
            let report = verify::verify(&prepared.manifest, std::path::Path::new(&record.install_dir));
            assert_eq!(report.bad_files.len(), 0);
            record.manifest = prepared.manifest_id;
            crate::companion::ubi_installs::save(&record);
        }
        let check = check_update(80).await.expect("update check");
        println!(
            "installed={} latest={} update={} unknown={}",
            check.installed, check.latest, check.update, check.unknown
        );
        assert!(!check.unknown);
        assert!(!check.update);
    }

    #[tokio::test]
    #[ignore = "launches Anno 1404 from the moved install"]
    async fn live_launch_anno_from_the_moved_install() {
        launch_game(16232, true).await.expect("direct launch");
        println!("Anno 1404 launched from the moved install");
    }

    #[test]
    #[ignore = "deletes the adopted Anno 1404 install"]
    fn live_uninstall_anno_removes_the_moved_install() {
        uninstall_game(16232, true).expect("uninstall");
        assert!(!std::path::Path::new(
            r"C:\Users\Efe\Games\Ubisoft\Anno 1404 - History Edition"
        )
        .exists());
        assert!(crate::companion::ubi_installs::find(16232).is_none());
        println!("Anno 1404 removed from the moved install");
    }

    #[test]
    #[ignore = "reads Rayman Origins; needs that direct install"]
    fn live_rayman_save_folder_resolves() {
        let path = saves::path_for_product(80).expect("a save folder");
        println!("Rayman saves: {}", path.display());
        assert!(path.is_dir());
        assert!(path.ends_with("Saves"));
    }

    #[tokio::test]
    #[ignore = "reads Rayman Origins; needs that direct install"]
    async fn live_rayman_verify_is_clean() {
        let record = crate::companion::ubi_installs::find(80).expect("Rayman Origins record");
        let directory = std::path::PathBuf::from(&record.install_dir);
        let (mut demux, _) = connect().await.expect("Demux connect");
        let prepared = install::prepare(&mut demux, 80).await.expect("manifest");
        let report = verify::verify(&prepared.manifest, &directory);
        println!(
            "files={} checked={} missing={} corrupt={}",
            report.files, report.checked, report.missing, report.corrupt
        );
        assert_eq!(report.missing, 0);
        assert_eq!(report.corrupt, 0);
    }

    #[tokio::test]
    #[ignore = "reads manifests; needs a linked session and EFXLVE_UBI_TEST_PRODUCTS"]
    async fn live_manifest_loader_inventory() {        let list = std::env::var("EFXLVE_UBI_TEST_PRODUCTS")
            .unwrap_or_else(|_| "1651,420,2688,720,95".to_string());
        let (mut demux, _) = connect().await.expect("Demux connect failed");
        for value in list.split(',').filter(|value| !value.trim().is_empty()) {
            let product_id: u32 = value.trim().parse().expect("numeric product id");
            match install::prepare(&mut demux, product_id).await {
                Ok(prepared) => {
                    let files = &prepared.manifest.files;
                    let total = prepared.manifest.total_bytes();
                    let loaders: Vec<&str> = files
                        .iter()
                        .filter(|file| file.name.to_lowercase().contains("loader"))
                        .map(|file| file.name.as_str())
                        .collect();
                    let exes: Vec<&str> = files
                        .iter()
                        .filter(|file| file.name.to_lowercase().ends_with(".exe"))
                        .map(|file| file.name.as_str())
                        .take(4)
                        .collect();
                    println!(
                        "{product_id} {} {:.2} GB loaders={loaders:?} exes={exes:?}",
                        prepared.name,
                        total as f64 / 1e9
                    );
                }
                Err(error) => println!("{product_id} failed: {error}"),
            }
        }
    }
}
