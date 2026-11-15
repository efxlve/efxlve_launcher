//! On-disk format: the manifest, the block header and small helpers shared by
//! packing and restoring.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FORMAT_NAME: &str = "efxlve-media-archive";
/// Version 2 can contain stored blocks and an xtool-wrapped stream. An older
/// launcher reads the version first and refuses the archive instead of
/// restoring zstd frames that are actually raw bytes.
pub const FORMAT_VERSION: u32 = 2;
pub const MANIFEST_FILE: &str = "manifest.efxmeta.json";
pub const BLOCK_MAGIC: [u8; 4] = *b"EFXB";
pub const BLOCK_VERSION: u16 = 1;
pub const BLOCK_HEADER_BYTES: usize = 64;
/// The block payload is stored byte for byte, not zstd-compressed.
pub const BLOCK_FLAG_STORED: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressionInfo {
    pub algorithm: String,
    pub level: i32,
    pub window_log: u32,
    pub frame_bytes: u64,
    /// `Some("xtool")` when the tar stream is wrapped in xtool's precompressor
    /// before zstd. Older manifests default to `None`, which means plain zstd.
    #[serde(default)]
    pub precompressor: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VolumeInfo {
    pub index: u32,
    pub file_name: String,
    pub bytes: u64,
    pub sha256: String,
    pub blocks: u32,
}

/// Store bookkeeping captured before packing. The download stores keep their
/// install state in small text files; carrying them inside the archive is what
/// makes a restore show up as installed instead of starting a new download.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreMeta {
    #[serde(default)]
    pub steam_app_id: Option<String>,
    #[serde(default)]
    pub steam_acf: Option<String>,
    #[serde(default)]
    pub epic_app_name: Option<String>,
    #[serde(default)]
    pub gog_game_id: Option<String>,
    #[serde(default)]
    pub amazon_product_id: Option<String>,
    #[serde(default)]
    pub custom_game: Option<serde_json::Value>,
    #[serde(default)]
    pub custom_exe_rel: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaManifest {
    pub format: String,
    pub format_version: u32,
    pub created_at: u64,
    pub launcher_version: String,
    pub app_name: String,
    pub store: String,
    pub title: String,
    pub install_dir_name: String,
    pub original_install_path: String,
    pub original_bytes: u64,
    pub file_count: u64,
    pub dir_count: u64,
    pub skipped_links: u64,
    pub compression: CompressionInfo,
    pub volume_bytes: u64,
    pub volumes: Vec<VolumeInfo>,
    pub store_meta: StoreMeta,
    pub complete: bool,
    /// Optical profiles put each volume in its own `disc-N` folder, next to a
    /// copy of the manifest, so the folder can be burned as one disc.
    #[serde(default)]
    pub disc_layout: bool,
}

impl MediaManifest {
    pub fn validate(&self) -> Result<(), String> {
        if self.format != FORMAT_NAME {
            return Err("@t:archive.manifestInvalid\u{1f}format".to_string());
        }
        if self.format_version == 0 || self.format_version > FORMAT_VERSION {
            return Err(format!(
                "@t:archive.manifestVersion\u{1f}{}",
                self.format_version
            ));
        }
        if !self.complete {
            return Err("@t:archive.manifestIncomplete".to_string());
        }
        if !safe_component(&self.install_dir_name) {
            return Err("@t:archive.manifestInvalid\u{1f}installDir".to_string());
        }
        if self.volumes.is_empty() {
            return Err("@t:archive.manifestInvalid\u{1f}volumes".to_string());
        }
        if self.volumes.iter().any(|v| !safe_component(&v.file_name)) {
            return Err("@t:archive.manifestInvalid\u{1f}volumeName".to_string());
        }
        if self.compression.frame_bytes == 0
            || self.compression.frame_bytes > 512 * 1024 * 1024
        {
            return Err("@t:archive.manifestInvalid\u{1f}frame".to_string());
        }
        if self
            .compression
            .precompressor
            .as_deref()
            .is_some_and(|value| value != "xtool")
        {
            return Err("@t:archive.manifestInvalid\u{1f}compression".to_string());
        }
        let blocks: u64 = self.volumes.iter().map(|v| u64::from(v.blocks)).sum();
        if blocks == 0 || blocks > 1_000_000 {
            return Err("@t:archive.manifestInvalid\u{1f}blocks".to_string());
        }
        Ok(())
    }

    pub fn total_blocks(&self) -> u32 {
        self.volumes
            .iter()
            .fold(0u32, |total, volume| total.saturating_add(volume.blocks))
    }

    /// Volume index for each block, so a checksum failure can name the disc the
    /// user has to clean or replace.
    pub fn volume_for_blocks(&self) -> Vec<u32> {
        let mut out = Vec::with_capacity(self.total_blocks() as usize);
        for volume in &self.volumes {
            out.extend(std::iter::repeat(volume.index).take(volume.blocks as usize));
        }
        out
    }

    #[cfg(test)]
    pub fn stored_bytes(&self) -> u64 {
        self.volumes.iter().map(|v| v.bytes).sum()
    }
}

pub fn manifest_path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST_FILE)
}

pub fn read_manifest(path: &Path) -> Result<MediaManifest, String> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| format!("@t:archive.manifestMissing\u{1f}{error}"))?;
    let manifest: MediaManifest = serde_json::from_str(&text)
        .map_err(|error| format!("@t:archive.manifestInvalid\u{1f}{error}"))?;
    manifest.validate()?;
    Ok(manifest)
}

/// Writes the manifest through a temporary file and flushes it to the media.
/// A half-written manifest would make an otherwise complete backup unusable.
pub fn write_manifest(dir: &Path, manifest: &MediaManifest) -> Result<PathBuf, String> {
    std::fs::create_dir_all(dir).map_err(|error| error.to_string())?;
    let target = manifest_path(dir);
    let staging = dir.join(format!(".{MANIFEST_FILE}.tmp"));
    let text = serde_json::to_string_pretty(manifest)
        .map_err(|error| format!("@t:archive.manifestWrite\u{1f}{error}"))?;
    {
        let mut file = std::fs::File::create(&staging)
            .map_err(|error| format!("@t:archive.manifestWrite\u{1f}{error}"))?;
        file.write_all(text.as_bytes())
            .map_err(|error| format!("@t:archive.manifestWrite\u{1f}{error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("@t:archive.manifestWrite\u{1f}{error}"))?;
        file.sync_all()
            .map_err(|error| format!("@t:archive.manifestWrite\u{1f}{error}"))?;
    }
    let _ = std::fs::remove_file(&target);
    std::fs::rename(&staging, &target)
        .map_err(|error| format!("@t:archive.manifestWrite\u{1f}{error}"))?;
    Ok(target)
}

pub fn sha256_bytes(bytes: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

/// A single path component that may be joined under a chosen folder. A drive
/// prefix, `..` or a separator would let a manifest write outside the target.
pub fn safe_component(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }
    let mut components = Path::new(trimmed).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

pub fn encode_block_header(
    block_index: u32,
    compressed_len: u32,
    raw_len: u32,
    flags: u32,
    raw_sha: &[u8; 32],
) -> [u8; BLOCK_HEADER_BYTES] {
    let mut header = [0u8; BLOCK_HEADER_BYTES];
    header[0..4].copy_from_slice(&BLOCK_MAGIC);
    header[4..6].copy_from_slice(&BLOCK_VERSION.to_le_bytes());
    header[6..8].copy_from_slice(&(BLOCK_HEADER_BYTES as u16).to_le_bytes());
    header[8..12].copy_from_slice(&block_index.to_le_bytes());
    header[12..16].copy_from_slice(&compressed_len.to_le_bytes());
    header[16..20].copy_from_slice(&raw_len.to_le_bytes());
    header[20..24].copy_from_slice(&flags.to_le_bytes());
    header[24..56].copy_from_slice(raw_sha);
    header
}

pub struct BlockHeader {
    pub block_index: u32,
    pub compressed_len: u32,
    pub raw_len: u32,
    pub flags: u32,
    pub raw_sha: [u8; 32],
}

pub fn decode_block_header(header: &[u8; BLOCK_HEADER_BYTES]) -> Result<BlockHeader, String> {
    if header[0..4] != BLOCK_MAGIC {
        return Err("block magic".to_string());
    }
    let version = u16::from_le_bytes([header[4], header[5]]);
    if version != BLOCK_VERSION {
        return Err(format!("block version {version}"));
    }
    let header_len = u16::from_le_bytes([header[6], header[7]]) as usize;
    if header_len != BLOCK_HEADER_BYTES {
        return Err(format!("block header length {header_len}"));
    }
    let block_index = u32::from_le_bytes(header[8..12].try_into().unwrap_or_default());
    let compressed_len = u32::from_le_bytes(header[12..16].try_into().unwrap_or_default());
    let raw_len = u32::from_le_bytes(header[16..20].try_into().unwrap_or_default());
    let flags = u32::from_le_bytes(header[20..24].try_into().unwrap_or_default());
    let mut raw_sha = [0u8; 32];
    raw_sha.copy_from_slice(&header[24..56]);
    Ok(BlockHeader {
        block_index,
        compressed_len,
        raw_len,
        flags,
        raw_sha,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_header_round_trips() {
        let sha = sha256_bytes(b"hello");
        let header = encode_block_header(7, 1234, 5678, BLOCK_FLAG_STORED, &sha);
        let decoded = decode_block_header(&header).unwrap();
        assert_eq!(decoded.block_index, 7);
        assert_eq!(decoded.compressed_len, 1234);
        assert_eq!(decoded.raw_len, 5678);
        assert_eq!(decoded.flags, BLOCK_FLAG_STORED);
        assert_eq!(decoded.raw_sha, sha);
    }

    #[test]
    fn a_foreign_header_is_rejected() {
        let mut header = encode_block_header(1, 1, 1, 0, &[0u8; 32]);
        header[0] = b'X';
        assert!(decode_block_header(&header).is_err());
    }

    #[test]
    fn manifest_round_trips_and_validates() {
        let manifest = MediaManifest {
            format: FORMAT_NAME.to_string(),
            format_version: FORMAT_VERSION,
            created_at: 1,
            launcher_version: "0.1.0".to_string(),
            app_name: "steam::1".to_string(),
            store: "steam".to_string(),
            title: "Game".to_string(),
            install_dir_name: "Game".to_string(),
            original_install_path: r"C:\Games\Game".to_string(),
            original_bytes: 10,
            file_count: 1,
            dir_count: 0,
            skipped_links: 0,
            compression: CompressionInfo {
                algorithm: "zstd".to_string(),
                level: 10,
                window_log: 27,
                frame_bytes: 64 * 1024 * 1024,
                precompressor: None,
            },
            volume_bytes: 1024,
            volumes: vec![VolumeInfo {
                index: 1,
                file_name: "game.efxpak.001".to_string(),
                bytes: 10,
                sha256: "x".to_string(),
                blocks: 1,
            }],
            store_meta: StoreMeta::default(),
            complete: true,
            disc_layout: false,
        };
        let dir = std::env::temp_dir().join(format!("efxlve-manifest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = write_manifest(&dir, &manifest).unwrap();
        let loaded = read_manifest(&path).unwrap();
        assert_eq!(loaded.app_name, "steam::1");
        assert_eq!(loaded.volume_for_blocks(), vec![1]);
        assert_eq!(loaded.stored_bytes(), 10);
        let mut older = loaded;
        older.format_version = 1;
        assert!(older.validate().is_ok());
        older.format_version = FORMAT_VERSION + 1;
        assert!(older.validate().is_err());
        older.format_version = FORMAT_VERSION;
        older.compression.precompressor = Some("other".to_string());
        assert!(older.validate().is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn path_components_stay_single() {
        assert!(safe_component("Game"));
        assert!(!safe_component(".."));
        assert!(!safe_component(r"..\Game"));
        assert!(!safe_component(r"C:\Game"));
        assert!(!safe_component("a/b"));
    }
}
