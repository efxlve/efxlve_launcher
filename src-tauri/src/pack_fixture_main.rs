//! Test-only fixture packer for the standalone restorer's end-to-end test.
//! Built only with the `restore-fixture` feature and never shipped.

use std::path::PathBuf;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use media_archive::format::StoreMeta;
use media_archive::pack::{pack_game, PackJob, ProgressSink};
use media_archive::profile::MediaProfileInfo;
use media_archive::ArchiveProgress;

struct NoopSink;

impl ProgressSink for NoopSink {
    fn emit(&self, _progress: ArchiveProgress) {}
}

#[path = "slug.rs"]
mod slug;

mod custom_games {
    pub use crate::slug::slugify;
}

// The packer shares these modules with the launcher; the fixture binary only
// needs the packing path, so restore and estimate are intentionally absent.
#[allow(dead_code)]
mod media_archive {
    use serde::{Deserialize, Serialize};

    #[path = "format.rs"]
    pub mod format;
    #[path = "profile.rs"]
    pub mod profile;
    #[path = "bypass.rs"]
    pub mod bypass;
    #[path = "xtool.rs"]
    pub mod xtool;
    #[path = "../store_label.rs"]
    pub mod store;
    #[path = "pack.rs"]
    pub mod pack;

    /// `pack.rs`'s disc-layout test asks the command layer for the disc list.
    /// The fixture binary has no Tauri commands; this test-only shim keeps the
    /// shared test module compiling under `cargo check --all-targets`.
    #[cfg(test)]
    pub mod commands {
        use std::path::PathBuf;

        use super::format::{read_manifest, MANIFEST_FILE};

        pub struct ArchiveDisc {
            pub volume_index: u32,
        }

        pub fn archive_discs(manifest_path: String) -> Result<Vec<ArchiveDisc>, String> {
            let path = PathBuf::from(&manifest_path);
            let (path, dir) = if path.is_dir() {
                (path.join(MANIFEST_FILE), path)
            } else {
                let dir = path
                    .parent()
                    .map(|parent| parent.to_path_buf())
                    .unwrap_or_else(|| PathBuf::from("."));
                (path, dir)
            };
            let manifest = read_manifest(&path)?;
            if !manifest.disc_layout {
                return Ok(Vec::new());
            }
            let mut discs = Vec::new();
            for volume in &manifest.volumes {
                let direct = dir.join(&volume.file_name);
                let in_disc = dir
                    .join(format!("disc-{}", volume.index))
                    .join(&volume.file_name);
                if direct.is_file() || in_disc.is_file() {
                    discs.push(ArchiveDisc {
                        volume_index: volume.index,
                    });
                }
            }
            Ok(discs)
        }
    }

    #[path = "estimate.rs"]
    pub mod estimate;
    #[path = "restore.rs"]
    pub mod restore;

    #[derive(Debug, Clone, Serialize, Deserialize)]
    #[serde(rename_all = "camelCase")]
    pub struct ArchiveProgress {
        pub id: String,
        pub stage: String,
        pub percent: f64,
        pub processed_bytes: u64,
        pub total_bytes: u64,
        pub output_bytes: u64,
        pub speed_bytes: f64,
        pub eta_seconds: u64,
        pub current_file: String,
        pub volume: u32,
        pub volume_count: u32,
        #[serde(default)]
        pub error: Option<String>,
    }
}

fn main() {
    if let Err(error) = run() {
        eprintln!("efxlve-pack-fixture: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut source = None;
    let mut target = None;
    let mut disc_layout = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--source" => source = Some(PathBuf::from(next_value(&mut args, "--source")?)),
            "--target" => target = Some(PathBuf::from(next_value(&mut args, "--target")?)),
            "--disc-layout" => disc_layout = true,
            other => return Err(format!("unknown argument `{other}`")),
        }
    }
    let source = source.ok_or_else(|| "--source is required".to_string())?;
    let target = target.ok_or_else(|| "--target is required".to_string())?;

    let outcome = pack_game(PackJob {
        app_name: "custom::Fixture".to_string(),
        title: "Fixture".to_string(),
        install_path: source,
        target_root: target,
        profile: MediaProfileInfo {
            id: if disc_layout { "dvd5" } else { "test" }.to_string(),
            volume_bytes: 32 * 1024,
            frame_bytes: 16 * 1024,
            file_system: if disc_layout { "UDF" } else { "test" }.to_string(),
        },
        level: 3,
        window_log: 20,
        xtool: None,
        store_meta: StoreMeta::default(),
        sink: Arc::new(NoopSink),
        cancel: Arc::new(AtomicBool::new(false)),
    })?;

    println!("{}", outcome.manifest_path.display());
    Ok(())
}

fn next_value(iter: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    iter.next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{flag} needs a value"))
}
