//! Media presets. A volume is never larger than the usable space on one disc,
//! and the frame size is small enough that two frames fit in an empty volume.

use serde::{Deserialize, Serialize};

const MIB: u64 = 1024 * 1024;
const MAX_FRAME_BYTES: u64 = 64 * MIB;
const MIN_FRAME_BYTES: u64 = 1 * MIB;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaProfileInfo {
    pub id: String,
    /// Usable bytes for one volume on this media.
    pub volume_bytes: u64,
    /// Uncompressed bytes per zstd frame.
    pub frame_bytes: u64,
    pub file_system: String,
}

impl MediaProfileInfo {
    /// Optical profiles get one folder per disc; a USB drive keeps every part
    /// in one flat folder.
    pub fn disc_layout(&self) -> bool {
        matches!(
            self.id.as_str(),
            "cd" | "dvd5" | "dvd9" | "bd25" | "bd50" | "bd100"
        )
    }

    fn new(id: &str, mib: u64, file_system: &str) -> Self {
        let volume_bytes = mib * MIB;
        Self {
            id: id.to_string(),
            volume_bytes,
            frame_bytes: (volume_bytes / 2).clamp(MIN_FRAME_BYTES, MAX_FRAME_BYTES),
            file_system: file_system.to_string(),
        }
    }
}

/// Every profile the picker offers. Sizes leave room for the file system and
/// the outer edge of an optical disc, matching the safe limits in the design.
pub fn all() -> Vec<MediaProfileInfo> {
    vec![
        MediaProfileInfo::new("cd", 680, "ISO 9660 + Joliet"),
        MediaProfileInfo::new("dvd5", 4_400, "UDF 2.01"),
        MediaProfileInfo::new("dvd9", 7_950, "UDF 2.01"),
        MediaProfileInfo::new("bd25", 22_500, "UDF 2.50"),
        MediaProfileInfo::new("bd50", 45_000, "UDF 2.50"),
        MediaProfileInfo::new("bd100", 90_000, "UDF 2.60"),
        MediaProfileInfo::new("fat32", 3_950, "FAT32 / exFAT"),
        MediaProfileInfo::new("custom", 0, "Custom"),
    ]
}

/// Resolves a profile id. `custom_mib` is only read for the `custom` profile.
pub fn resolve(id: &str, custom_mib: Option<u64>) -> Result<MediaProfileInfo, String> {
    if id == "custom" {
        let mib = custom_mib.unwrap_or(0);
        if !(16..=1_000_000).contains(&mib) {
            return Err("@t:archive.invalidProfile".to_string());
        }
        return Ok(MediaProfileInfo::new("custom", mib, "Custom"));
    }
    all()
        .into_iter()
        .find(|profile| profile.id == id)
        .ok_or_else(|| "@t:archive.invalidProfile".to_string())
}

/// Worst-case volume count: compression can only reduce the bytes written, so
/// an uncompressed estimate never promises fewer discs than the job needs.
pub fn worst_case_volumes(total_bytes: u64, volume_bytes: u64) -> u32 {
    if total_bytes == 0 || volume_bytes == 0 {
        return 1;
    }
    let count = total_bytes.div_ceil(volume_bytes);
    count.min(u64::from(u32::MAX)) as u32
}

#[derive(Debug, Clone, Default)]
pub struct TargetInfo {
    pub free_bytes: Option<u64>,
    pub file_system: Option<String>,
}

/// Free space and file system of the volume that holds `path`. The file system
/// matters because a FAT32 stick cannot hold a single file over 4 GB even when
/// it has room for the bytes.
pub fn target_info(path: &std::path::Path) -> TargetInfo {
    let mut probe = path.to_path_buf();
    while !probe.exists() {
        match probe.parent() {
            Some(parent) if parent != probe => probe = parent.to_path_buf(),
            _ => break,
        }
    }
    let probe = plain_path(&probe);
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64, String)> = None;
    for disk in disks.iter() {
        let mount = plain_path(disk.mount_point());
        if probe.starts_with(&mount) {
            let length = mount.to_string_lossy().len();
            if best
                .as_ref()
                .map(|(seen, _, _)| length > *seen)
                .unwrap_or(true)
            {
                best = Some((
                    length,
                    disk.available_space(),
                    disk.file_system().to_string_lossy().trim().to_string(),
                ));
            }
        }
    }
    match best {
        Some((_, free, file_system)) => TargetInfo {
            free_bytes: Some(free),
            file_system: (!file_system.is_empty()).then_some(file_system),
        },
        None => TargetInfo::default(),
    }
}

pub fn free_bytes(path: &std::path::Path) -> Option<u64> {
    target_info(path).free_bytes
}

/// `canonicalize` on Windows returns a `\\?\` verbatim path, which does not
/// compare with a mount point such as `D:\`. Strip the prefix for comparisons.
fn plain_path(path: &std::path::Path) -> std::path::PathBuf {
    let canonical = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    #[cfg(windows)]
    {
        let text = canonical.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return std::path::PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return std::path::PathBuf::from(rest);
        }
    }
    canonical
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn presets_keep_frames_inside_a_volume() {
        for profile in all() {
            if profile.id == "custom" {
                continue;
            }
            assert!(profile.volume_bytes > 0);
            assert!(profile.frame_bytes >= MIN_FRAME_BYTES);
            assert!(profile.frame_bytes <= MAX_FRAME_BYTES);
            assert!(profile.frame_bytes * 2 <= profile.volume_bytes);
        }
    }

    #[test]
    fn custom_needs_a_sensible_size() {
        assert!(resolve("custom", Some(16)).is_ok());
        assert!(resolve("custom", Some(0)).is_err());
        assert!(resolve("custom", None).is_err());
        assert_eq!(resolve("fat32", None).unwrap().volume_bytes, 3_950 * MIB);
        assert!(resolve("dvd5", None).unwrap().disc_layout());
        assert!(!resolve("fat32", None).unwrap().disc_layout());
    }

    #[test]
    fn worst_case_rounds_up() {
        assert_eq!(worst_case_volumes(0, 100), 1);
        assert_eq!(worst_case_volumes(100, 100), 1);
        assert_eq!(worst_case_volumes(101, 100), 2);
    }
}
