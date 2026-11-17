//! Standalone file restorer for an Efxlve media archive.
//!
//! This is deliberately a file-recovery tool, not a store client: GOG and
//! custom archives are DRM-free, while Steam, Epic and Amazon games still need
//! their client and an account that owns the game. It never bypasses DRM.

use std::io::{self, Write};
use std::process::ExitCode;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use media_archive::format::{read_manifest, MANIFEST_FILE};
use media_archive::pack::ProgressSink;
use media_archive::restore::{locate_volumes, restore_game, verify_archive, RestoreJob};
use media_archive::xtool::Xtool;
use media_archive::ArchiveProgress;

#[path = "restore_cli.rs"]
mod restore_cli;

use restore_cli::{
    auto_disc_dirs, display_path, fmt_bytes, localize, parse_args, resolve_manifest, store_hint,
};

#[path = "slug.rs"]
mod slug;

mod custom_games {
    pub use crate::slug::slugify;
}

// The archive engine is shared with the launcher; this binary only calls the
// restore path, so the packer and the estimate helpers are unused here.
#[allow(dead_code)]
mod media_archive {
    use serde::{Deserialize, Serialize};

    #[path = "bypass.rs"]
    pub mod bypass;
    #[path = "format.rs"]
    pub mod format;
    #[path = "profile.rs"]
    pub mod profile;
    #[path = "xtool.rs"]
    pub mod xtool;

    /// The standalone binary does not register store records; `pack.rs` only
    /// needs the store label while it writes a manifest.
    #[path = "../store_label.rs"]
    pub mod store;

    #[path = "pack.rs"]
    pub mod pack;

    /// `pack.rs`'s disc-layout test asks the command layer for the disc list.
    /// The standalone binary has no Tauri commands; this test-only shim keeps
    /// the shared test module compiling.
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

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("efxlve-restore: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<(), String> {
    let args = parse_args(std::env::args().skip(1))?;
    if args.help || (args.manifest.is_none() && args.target.is_none()) {
        print_help();
        return Ok(());
    }

    let manifest_path = resolve_manifest(
        args.manifest
            .ok_or_else(|| "--manifest is required; use --help".to_string())?,
        MANIFEST_FILE,
    )?;
    let manifest_dir = manifest_path
        .parent()
        .ok_or_else(|| "the manifest has no parent folder".to_string())?
        .to_path_buf();
    let manifest = read_manifest(&manifest_path).map_err(|error| localize(&error))?;
    let store = manifest.store.clone();
    let title = manifest.title.clone();

    let mut extra_dirs = args.extra_dirs;
    for dir in auto_disc_dirs(&manifest_dir) {
        if !extra_dirs.contains(&dir) {
            extra_dirs.push(dir);
        }
    }
    let (_, missing) = locate_volumes(&manifest, &manifest_dir, &extra_dirs);
    if let Some(index) = missing.first() {
        return Err(format!(
            "volume {index} is missing; put the other disc folders under the same parent or pass --extra"
        ));
    }

    let cancel = Arc::new(AtomicBool::new(false));
    let handler_cancel = cancel.clone();
    ctrlc::set_handler(move || {
        handler_cancel.store(true, Ordering::SeqCst);
    })
    .map_err(|error| format!("could not install the Ctrl+C handler: {error}"))?;

    eprintln!("Archive: {title} ({store})");

    if args.verify {
        eprintln!("Checking every block; nothing is written.");
        let outcome = verify_archive(
            &manifest,
            &manifest_dir,
            &extra_dirs,
            Arc::new(ConsoleSink::new()),
            cancel,
        )
        .map_err(|error| localize(&error))?;
        println!();
        println!(
            "Verified {} blocks across {} parts.",
            outcome.blocks, outcome.volume_count
        );
        return Ok(());
    }

    let target_parent = args
        .target
        .ok_or_else(|| "--target is required unless --verify is used; use --help".to_string())?;
    let xtool = match args.xtool.as_deref() {
        Some(path) => Some(Xtool::new(path).map_err(|error| localize(&error))?),
        None => None,
    };
    if manifest.compression.precompressor.as_deref() == Some("xtool") && xtool.is_none() {
        return Err(
            "this archive was made with xtool; pass --xtool <path to xtool.exe>".to_string(),
        );
    }

    eprintln!(
        "Target:  {}",
        target_parent.join(&manifest.install_dir_name).display()
    );
    eprintln!("{}", store_hint(&store));
    eprintln!();

    let outcome = restore_game(RestoreJob {
        manifest,
        manifest_dir,
        extra_dirs,
        target_parent,
        overwrite: args.overwrite,
        xtool,
        sink: Arc::new(ConsoleSink::new()),
        cancel,
    })
    .map_err(|error| localize(&error))?;

    println!();
    println!(
        "Restored {} files ({}).",
        outcome.file_count,
        fmt_bytes(outcome.bytes)
    );
    println!("Location: {}", display_path(&outcome.target));
    println!("{}", store_hint(&store));
    Ok(())
}

fn print_help() {
    println!(
        "efxlve-restore - recover an Efxlve media archive without the launcher

Usage:
  efxlve-restore --manifest <file-or-folder> [--target <parent-folder>] [options]

Options:
  -m, --manifest <path>  manifest.efxmeta.json or the folder that contains it
  -t, --target <path>    parent folder for the restored game (omit with --verify)
      --overwrite        replace an existing game folder
      --verify           check every block and exit without writing anything
      --xtool <path>     xtool.exe for an archive made with xtool
      --extra <folder>   another folder that holds missing volumes (repeatable)
  -h, --help             show this help

Notes:
  GOG and custom archives are DRM-free. Steam, Epic and Amazon games still
  need their client and an account that owns the game; this tool only writes
  files and never bypasses DRM."
    );
}

struct ConsoleSink {
    last: Mutex<(String, i32)>,
}

impl ConsoleSink {
    fn new() -> Self {
        Self {
            last: Mutex::new((String::new(), -1)),
        }
    }
}

impl ProgressSink for ConsoleSink {
    fn emit(&self, progress: ArchiveProgress) {
        let percent = progress.percent.round().clamp(0.0, 100.0) as i32;
        let stage = progress.stage.clone();
        let Ok(mut last) = self.last.lock() else {
            return;
        };
        let stage_changed = last.0 != stage;
        let bucket_changed = last.1 / 5 != percent / 5;
        if !stage_changed && !bucket_changed && stage != "done" && stage != "failed" {
            return;
        }
        *last = (stage.clone(), percent);
        let mut out = io::stdout().lock();
        let _ = writeln!(
            out,
            "[{stage}] {percent:3}%  vol {}/{}  {}",
            progress.volume, progress.volume_count, progress.current_file
        );
    }
}


