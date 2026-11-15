//! Compressed, multi-volume game archives for USB sticks, external drives and
//! optical media.
//!
//! A backup is a folder holding a `manifest.efxmeta.json` and one or more
//! `*.efxpak.NNN` volume files. Each volume is sized for the chosen media
//! profile, so one volume can be copied to one disc without crossing the file
//! system limit. The data stream is a tar archive cut into independent zstd
//! frames; a damaged frame fails its own checksum instead of poisoning the
//! rest of the backup.

mod bypass;
pub mod commands;
mod disc;
mod estimate;
mod format;
mod pack;
mod profile;
mod restore;
mod store;
mod xtool;

use serde::{Deserialize, Serialize};

/// One progress event for packing or restoring. Numeric fields are formatted
/// by the frontend so every locale keeps its own units.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveProgress {
    pub id: String,
    /// `scanning`, `compressing`, `finalizing`, `restoring`, `registering`,
    /// `done` or `failed`.
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
