//! Quick size estimate before a backup starts. The largest files carry most of
//! the bytes, so sampling a few windows from each of them is enough to tell the
//! user whether a backup is worth the wait. The result is an estimate: the real
//! number comes from the backup result panel.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;
use zstd::bulk::Compressor;

use super::bypass::should_store_raw;
use super::pack::{scan_tree, FileEntry, ScanResult};
use super::profile::{self, MediaProfileInfo};
use super::xtool::Xtool;

const MIB: u64 = 1024 * 1024;
/// Bytes read from one file. Spread over four windows, so a file with a
/// compressible table at the start and compressed payload later is not judged
/// by its header alone.
const PER_FILE_SAMPLE: u64 = 4 * MIB;
const SAMPLE_FILES: usize = 24;
/// Default and heavy-profile budgets. Level 19 runs at a few MB/s, so it gets a
/// smaller sample rather than a matching minute-long wait. The xtool sample
/// runs at a few MB/s itself, so the default stays well under a minute even on
/// a large game.
const SAMPLE_BUDGET: u64 = 64 * MIB;
const HEAVY_BUDGET: u64 = 32 * MIB;
const TAR_BLOCK: u64 = 512;
const BLOCK_HEADER: u64 = 64;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEstimate {
    pub original_bytes: u64,
    pub estimated_bytes: u64,
    /// Estimated stored bytes divided by the original bytes. Slightly over 1.0
    /// is possible for incompressible games because of the archive overhead.
    pub ratio: f64,
    pub estimated_volumes: u32,
    pub sampled_files: u32,
    pub sampled_bytes: u64,
    pub bypassed_files: u64,
    pub bypassed_bytes: u64,
    /// True when the sample went through xtool instead of plain zstd.
    pub uses_xtool: bool,
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

/// One contiguous window, centred in the file. `xtool` needs complete zlib
/// streams, so its sample must not be cut into disjoint 1 MiB slices.
pub fn contiguous_window(len: u64, window: u64) -> (u64, usize) {
    if len == 0 || window == 0 {
        return (0, 0);
    }
    let size = len.min(window);
    let offset = if len > size { (len - size) / 2 } else { 0 };
    (offset, size as usize)
}

fn read_contiguous(entry: &FileEntry, budget: u64) -> Option<Vec<u8>> {
    let (offset, size) = contiguous_window(entry.size, budget.min(PER_FILE_SAMPLE));
    if size == 0 {
        return None;
    }
    let mut file = File::open(&entry.source).ok()?;
    file.seek(SeekFrom::Start(offset)).ok()?;
    let mut buffer = vec![0u8; size];
    file.read_exact(&mut buffer).ok()?;
    Some(buffer)
}

fn read_sample(entry: &FileEntry, budget: u64) -> Option<Vec<u8>> {
    let mut file = File::open(&entry.source).ok()?;
    let windows = sample_windows(entry.size, budget.min(PER_FILE_SAMPLE));
    let mut buffer = Vec::new();
    for (offset, size) in windows {
        let start = buffer.len();
        buffer.resize(start + size, 0);
        file.seek(SeekFrom::Start(offset)).ok()?;
        file.read_exact(&mut buffer[start..]).ok()?;
    }
    (!buffer.is_empty()).then_some(buffer)
}

fn compress_with(compressor: &mut Compressor<'static>, bytes: &[u8]) -> Option<u64> {
    compressor.compress(bytes).ok().map(|packed| packed.len() as u64)
}

/// Mirrors the packing pipeline: xtool precompresses the sample, then zstd
/// compresses its output. xtool needs real files, so the sample goes through a
/// short-lived temp folder instead of a pipe.
fn compress_with_xtool(
    xtool: &Xtool,
    sample: &[u8],
    level: i32,
    window_log: u32,
) -> Result<u64, String> {
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let dir = std::env::temp_dir().join(format!(
        "efxlve-estimate-{}-{suffix}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
    let input = dir.join("sample.bin");
    let output = dir.join("sample.xtool");
    let result = (|| {
        std::fs::write(&input, sample)
            .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
        xtool.precompress_file(&input, &output)?;
        let packed = std::fs::read(&output)
            .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
        let mut compressor = Compressor::new(level)
            .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
        compressor
            .set_parameter(zstd::zstd_safe::CParameter::WindowLog(window_log))
            .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
        // `compress` borrows the compressor mutably; it is local to this
        // closure so the temp folder is always removed on the way out.
        compress_with(&mut compressor, &packed)
            .ok_or_else(|| "@t:archive.compressFailed\u{1f}zstd".to_string())
    })();
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn parity_reserve(body: u64, full_volume_recovery: bool) -> u64 {
    if full_volume_recovery {
        body
    } else {
        body / 12
    }
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

fn check_cancel(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::Relaxed) {
        Err("@t:archive.cancelled".to_string())
    } else {
        Ok(())
    }
}

pub fn estimate_archive(
    install: &Path,
    profile: &MediaProfileInfo,
    level: i32,
    window_log: u32,
    xtool: Option<&Xtool>,
    full_volume_recovery: bool,
    cancel: &AtomicBool,
) -> Result<ArchiveEstimate, String> {
    let scan = scan_tree(install)?;
    check_cancel(cancel)?;
    if scan.file_count == 0 {
        return Err("@t:archive.emptyGame".to_string());
    }
    let uses_xtool = xtool.is_some();

    let mut bypassed_files = 0u64;
    let mut bypassed_bytes = 0u64;
    let mut candidates: Vec<&FileEntry> = Vec::new();
    for entry in &scan.entries {
        check_cancel(cancel)?;
        if entry.is_dir {
            continue;
        }
        // xtool receives the whole tar stream, so bypassing a member would
        // split that stream. In xtool mode every file is a candidate, including
        // the video and engine packs that a plain backup stores raw.
        if !uses_xtool && should_store_raw(&entry.rel, entry.size) {
            bypassed_files += 1;
            bypassed_bytes = bypassed_bytes.saturating_add(entry.size);
        } else {
            candidates.push(entry);
        }
    }
    candidates.sort_by_key(|entry| std::cmp::Reverse(entry.size));

    let mut budget = if level >= 15 { HEAVY_BUDGET } else { SAMPLE_BUDGET };
    let mut sampled_files = 0u32;
    let mut sampled_bytes = 0u64;
    let mut sampled_compressed = 0u64;
    match xtool {
        Some(xtool) => {
            let mut sample = Vec::new();
            for entry in candidates.iter().take(SAMPLE_FILES) {
                check_cancel(cancel)?;
                if budget == 0 {
                    break;
                }
                let Some(bytes) = read_contiguous(entry, budget) else {
                    continue;
                };
                budget = budget.saturating_sub(bytes.len() as u64);
                sampled_files += 1;
                sample.extend_from_slice(&bytes);
            }
            check_cancel(cancel)?;
            sampled_bytes = sample.len() as u64;
            if !sample.is_empty() {
                sampled_compressed = compress_with_xtool(xtool, &sample, level, window_log)?;
                check_cancel(cancel)?;
            }
        }
        None => {
            let mut compressor = Compressor::new(level)
                .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
            compressor
                .set_parameter(zstd::zstd_safe::CParameter::WindowLog(window_log))
                .map_err(|error| format!("@t:archive.compressFailed\u{1f}{error}"))?;
            for entry in candidates.iter().take(SAMPLE_FILES) {
                check_cancel(cancel)?;
                if budget == 0 {
                    break;
                }
                let Some(bytes) = read_sample(entry, budget) else {
                    continue;
                };
                budget = budget.saturating_sub(bytes.len() as u64);
                let Some(compressed) = compress_with(&mut compressor, &bytes) else {
                    continue;
                };
                sampled_files += 1;
                sampled_bytes = sampled_bytes.saturating_add(bytes.len() as u64);
                sampled_compressed = sampled_compressed.saturating_add(compressed);
            }
        }
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
    let stored_body = body.saturating_add(blocks.saturating_mul(BLOCK_HEADER));
    let reserve = parity_reserve(body, full_volume_recovery);
    let estimated_bytes = stored_body.saturating_add(reserve);
    let stored_ratio = if scan.total_bytes > 0 {
        estimated_bytes as f64 / scan.total_bytes as f64
    } else {
        1.0
    };
    check_cancel(cancel)?;

    Ok(ArchiveEstimate {
        original_bytes: scan.total_bytes,
        estimated_bytes,
        ratio: (stored_ratio * 10_000.0).round() / 10_000.0,
        estimated_volumes: profile::worst_case_volumes(
            stored_body,
            super::pack::effective_volume_bytes(
                profile.volume_bytes,
                super::pack::DEFAULT_PARITY_SHARDS,
                full_volume_recovery,
            ),
        ),
        sampled_files,
        sampled_bytes,
        bypassed_files,
        bypassed_bytes,
        uses_xtool,
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
    fn contiguous_windows_are_inside_the_file() {
        assert_eq!(contiguous_window(0, 10), (0, 0));
        assert_eq!(contiguous_window(10, 4), (3, 4));
        assert_eq!(contiguous_window(4, 10), (0, 4));
        let (offset, size) = contiguous_window(100, 40);
        assert!(offset + size as u64 <= 100);
    }

    #[test]
    fn a_compressible_game_estimates_a_smaller_archive() {
        let root = temp_root("compressible");
        std::fs::write(root.join("data.txt"), vec![b'a'; 2 * MIB as usize]).unwrap();
        std::fs::write(root.join("movie.mp4"), noisy(300 * 1024, 3)).unwrap();
        let profile = resolve("fat32", None).unwrap();
        let estimate =
            estimate_archive(&root, &profile, 3, 20, None, false, &AtomicBool::new(false))
                .unwrap();
        assert!(!estimate.uses_xtool);
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
        assert!(estimate_archive(&root, &profile, 3, 20, None, false, &AtomicBool::new(false)).is_err());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_cancelled_estimate_reports_cancelled() {
        let root = temp_root("cancelled");
        std::fs::write(root.join("data.bin"), noisy(1024 * 1024, 9)).unwrap();
        let profile = resolve("fat32", None).unwrap();
        let error = estimate_archive(&root, &profile, 3, 20, None, false, &AtomicBool::new(true))
            .unwrap_err();
        assert!(error.contains("cancelled"), "{error}");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn full_volume_recovery_reserves_a_second_copy() {
        let root = temp_root("full-parity");
        std::fs::write(root.join("data.bin"), noisy(2 * 1024 * 1024, 7)).unwrap();
        let profile = resolve("fat32", None).unwrap();
        let normal =
            estimate_archive(&root, &profile, 3, 20, None, false, &AtomicBool::new(false)).unwrap();
        let full =
            estimate_archive(&root, &profile, 3, 20, None, true, &AtomicBool::new(false)).unwrap();
        assert!(full.estimated_bytes > normal.estimated_bytes);
        assert!(
            full.estimated_bytes >= normal.estimated_bytes.saturating_mul(3) / 2,
            "full={} normal={}",
            full.estimated_bytes,
            normal.estimated_bytes
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    #[ignore = "needs EFXLVE_XTOOL and EFXLVE_ESTIMATE_GAME"]
    fn a_real_game_can_be_estimated() {
        let _lock = crate::media_archive::xtool::test_lock();
        let game = std::env::var("EFXLVE_ESTIMATE_GAME").expect("set EFXLVE_ESTIMATE_GAME");
        let xtool_path = std::env::var("EFXLVE_XTOOL").expect("set EFXLVE_XTOOL");
        let xtool = Xtool::new(&xtool_path).unwrap();
        let profile = resolve("fat32", None).unwrap();
        let estimate = estimate_archive(
            std::path::Path::new(&game),
            &profile,
            3,
            24,
            Some(&xtool),
            false,
            &AtomicBool::new(false),
        )
        .unwrap();
        eprintln!("{estimate:#?}");
        assert!(estimate.uses_xtool);
        assert!(estimate.estimated_bytes < estimate.original_bytes);
    }
}
