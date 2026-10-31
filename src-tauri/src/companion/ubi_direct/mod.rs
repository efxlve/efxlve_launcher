//! Native Ubisoft Connect path: the Demux ownership service and the signed
//! install manifest.
//!
//! The store sign-in already stores a `ubi_v1` ticket for the launcher app id
//! Demux expects. This module takes that ticket straight to
//! `dmx.upc.ubisoft.com`, so the owned list and its install manifest no longer
//! depend on `UbisoftConnect.exe` being installed or running.

mod auth;
mod codec;
pub(crate) mod install;
mod launch;
pub(crate) mod manifest;
mod shim;
pub(crate) mod wire;

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

/// Ask Demux for the owned base games and their current manifest ids.
pub(crate) async fn probe() -> Result<UbiDirectProbe, String> {
    let (mut demux, session) = connect().await?;
    let owned = demux.owned_games().await?;    let mut games: Vec<codec::OwnedGame> = owned
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
            "{}: {} files, {} slices, {} bytes, {} compression, {} layout",
            plan.name, plan.files, plan.slices, plan.bytes, plan.compression, plan.slice_layout
        );
        assert!(plan.files > 0);
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
}
