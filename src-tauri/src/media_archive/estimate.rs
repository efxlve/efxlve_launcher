//! Quick size estimate before a backup starts. The largest files carry most of
//! the bytes, so sampling a few windows from each of them is enough to tell the
//! user whether a backup is worth the wait. The result is an estimate: the real
//! number comes from the backup result panel.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use zstd::bulk::Compressor;

use super::bypass::should_store_raw;
use super::pack::{scan_tree, FileEntry, ScanResult};
use super::profile::{self, MediaProfileInfo};

const MIB: u64 = 1024 * 1024;
/// Bytes read from one file. Spread over four windows, so a file with a
/// compressible table at the start and compressed payload later is not judged
/// by its header alone.
const PER_FILE_SAMPLE: u64 = 4 * MIB;
const SAMPLE_FILES: usize = 24;
/// Default and heavy-profile budgets. Level 19 runs at a few MB/s, so it gets a
/// smaller sample rather than a matching minute-long wait.
const SAMPLE_BUDGET: u64 = 96 * MIB;
const HEAVY_BUDGET: u64 = 32 * MIB;
const TAR_BLOCK: u64 = 512;
const BLOCK_HEADER: u64 = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEstimate {
    pub original_bytes: u64,
    pub estimated_bytes: u64,
    /// Estimated stored bytes divided by the original bytes, 0.0 to 1.0.
    pub ratio: f64,
    pub estimated_volumes: u32,
    pub sampled_files: u32,
    pub sampled_bytes: u64,
    pub bypassed_files: u64,
    pub bypassed_bytes: u64,
}

/// Windows to read from a file of `len` bytes, totalling at most `window`.
pub fn sample_windows(len: u64, window: u64) -> Vec<(u64, usize)> {
    if len == 0 || window == 0 {
        return Vec::new();
    }
    if len <= window {
        return vec![(0, len as usize)];
    }
    let piece = (window / 4).max(1);
    let span = len - piece;
    (0..4)
        .map(|index| (span * index / 3, piece as usize))
        .collect()
}

fn sample_file(
    entry: &FileEntry,
    budget: u64,
    compressor: &mut Compressor<'static>,
) -> Option<(u64, u64)> {
    let mut file = File::open(&entry.source).ok()?;
    let windows = sample_windows(entry.size, budget.min(PER_FILE_SAMPLE));
    let mut buffer = Vec::new();
    for (offset, size) in windows {
        let start = buffer.len();
        buffer.resize(start + size, 0);
        file.seek(SeekFrom::Start(offset)).ok()?;
        file.read_exact(&mut buffer[start..]).ok()?;
    }
    if buffer.is_empty() {
        return None;
    }
    let compressed = compressor.compress(&buffer).ok()?;
    Some((buffer.len() as u64, compressed.len() as u64))
}

/// Tar header and padding for every member, plus the two zero blocks that end
/// the archive.
fn tar_overhead(scan: &ScanResult) -> u64 {
    let mut overhead = TAR_BLOCK * 2;
    for entry in &scan.entries {
        overhead = overhead.saturating_add(TAR_BLOCK);
        if !entry.is_dir {
            overhead = overhead.saturating_add((TAR_BLOCK - entry.size % TAR_BLOCK) % TAR_BLOCK);
        }
    }
    overhead
}

pub fn estimate_archive(
    install: &Path,
    profile: &MediaProfileInfo,
    level: i32,
    window_log: u32,
) -> Result<ArchiveEstimate, String> {
    let scan = scan_tree(install)?;
    if scan.file_count == 0 {
        return Err("@t:archive.emptyGame".to_string());
    }

    let mut bypassed_files = 0u64;
    let mut bypassed_bytes = 0u64;
    let mut candidates: Vec<&FileEntry> = Vec::new();
    for entry in &scan.entries {
        if entry.is_dir {
            continue;
        }
        if should_store_raw(&entry.rel, entry.size) {
            bypassed_files += 1;
            bypassed_bytes = bypassed_bytes.saturating_add(entry.size);
        } else {
            candidates.push(entry);
        }
    }
    candidates.sort_by(|left, right| right.size.cmp(&left.size));

    let mut compressor = Compressor::new(level)
        .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
    compressor
        .set_parameter(zstd::zstd_safe::CParameter::WindowLog(window_log))
        .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;

    let mut budget = if level >= 15 { HEAVY_BUDGET } else { SAMPLE_BUDGET };
    let mut sampled_files = 0u32;
    let mut sampled_bytes = 0u64;
    let mut sampled_compressed = 0u64;
    for entry in candidates.iter().take(SAMPLE_FILES) {
        if budget == 0 {
            break;
        }
        let Some((raw, compressed)) = sample_file(entry, budget, &mut compressor) else {
            continue;
        };
        budget = budget.saturating_sub(raw);
        sampled_files += 1;
        sampled_bytes = sampled_bytes.saturating_add(raw);
        sampled_compressed = sampled_compressed.saturating_add(compressed);
    }

    // With no sample at all the game is a handful of tiny files; assume a
    // modest gain rather than promising a perfect ratio.
    let ratio = if sampled_bytes > 0 {
        sampled_compressed as f64 / sampled_bytes as f64
    } else {
        0.8
    };
    let compressible_bytes = scan.total_bytes.saturating_sub(bypassed_bytes);
    let compressed = (compressible_bytes as f64 * ratio).round() as u64;
    let overhead = tar_overhead(&scan);
    let body = bypassed_bytes
        .saturating_add(compressed)
        .saturating_add(overhead);
    let blocks = body.div_ceil(profile.frame_bytes.max(1));
    let estimated_bytes = body.saturating_add(blocks.saturating_mul(BLOCK_HEADER));
    let stored_ratio = if scan.total_bytes > 0 {
        (estimated_bytes as f64 / scan.total_bytes as f64).min(1.0)
    } else {
        1.0
    };

    Ok(ArchiveEstimate {
        original_bytes: scan.total_bytes,
        estimated_bytes,
        ratio: (stored_ratio * 10_000.0).round() / 10_000.0,
        estimated_volumes: profile::worst_case_volumes(estimated_bytes, profile.volume_bytes),
        sampled_files,
        sampled_bytes,
        bypassed_files,
        bypassed_bytes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media_archive::profile::resolve;

    fn temp_root(name: &str) -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("efxlve-estimate-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    fn noisy(len: usize, seed: u64) -> Vec<u8> {
        let mut state = seed | 1;
        let mut out = Vec::with_capacity(len);
        for _ in 0..len {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            out.push((state >> 24) as u8);
        }
        out
    }

    #[test]
    fn sample_windows_stay_inside_the_file() {
        let windows = sample_windows(10 * MIB, 4 * MIB);
        assert_eq!(windows.len(), 4);
        for (offset, size) in windows {
            assert!(offset + size as u64 <= 10 * MIB);
        }
        assert_eq!(sample_windows(1024, 4 * MIB), vec![(0, 1024)]);
        assert!(sample_windows(0, 4 * MIB).is_empty());
    }

    #[test]
    fn a_compressible_game_estimates_a_smaller_archive() {
        let root = temp_root("compressible");
        std::fs::write(root.join("data.txt"), vec![b'a'; 2 * MIB as usize]).unwrap();
        std::fs::write(root.join("movie.mp4"), noisy(300 * 1024, 3)).unwrap();
        let profile = resolve("fat32", None).unwrap();
        let estimate = estimate_archive(&root, &profile, 3, 20).unwrap();
        assert_eq!(estimate.bypassed_files, 1);
        assert_eq!(estimate.bypassed_bytes, 300 * 1024);
        assert!(estimate.estimated_bytes < estimate.original_bytes);
        assert!(estimate.ratio < 0.5);
        assert!(estimate.estimated_volumes >= 1);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn an_empty_folder_is_refused() {
        let root = temp_root("empty");
        let profile = resolve("fat32", None).unwrap();
        assert!(estimate_archive(&root, &profile, 3, 20).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }
}
