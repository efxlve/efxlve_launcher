//! On-disk format: the manifest, the block header and small helpers shared by
//! packing and restoring.

use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FORMAT_NAME: &str = "efxlve-media-archive";
/// Version 2 added stored blocks and an xtool-wrapped stream. Version 3 adds
/// per-volume Reed-Solomon parity files (`.efxpar.NNN`). Older launchers reject
/// v3 by version before they can misread the extra files.
pub const FORMAT_VERSION: u32 = 3;
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

/// One parity file for a volume. The payload is a single Reed-Solomon parity
/// shard; the manifest keeps its name and SHA-256 so a damaged parity file is
/// treated as missing rather than trusted.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParityFileInfo {
    pub index: u32,
    pub file_name: String,
    pub sha256: String,
}

/// Parity metadata for one volume. `data_sha256` has one hash per padded data
/// shard, so restore can identify which shards need recovery.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParityVolumeInfo {
    pub volume_index: u32,
    pub data_sha256: Vec<String>,
    pub files: Vec<ParityFileInfo>,
}

/// Format version 3 parity metadata. The packer writes one set per volume; the
/// restorer verifies the shard and parity hashes and can rebuild up to
/// `parity_shards` damaged shards per volume.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParityInfo {
    pub data_shards: u32,
    pub parity_shards: u32,
    pub shard_bytes: u64,
    pub volumes: Vec<ParityVolumeInfo>,
}

impl ParityInfo {
    pub fn validate(&self) -> Result<(), String> {
        let total = u64::from(self.data_shards) + u64::from(self.parity_shards);
        if self.data_shards == 0 || self.parity_shards == 0 || total > 255 {
            return Err("@t:archive.manifestInvalid\u{1f}parityShards".to_string());
        }
        if self.shard_bytes == 0 || self.shard_bytes > 8 * 1024 * 1024 * 1024 {
            return Err("@t:archive.manifestInvalid\u{1f}parityShard".to_string());
        }
        if self.volumes.is_empty() {
            return Err("@t:archive.manifestInvalid\u{1f}parityVolumes".to_string());
        }
        let mut volume_indices = std::collections::HashSet::new();
        let mut file_names = std::collections::HashSet::new();
        for volume in &self.volumes {
            if volume.volume_index == 0 || !volume_indices.insert(volume.volume_index) {
                return Err("@t:archive.manifestInvalid\u{1f}parityVolumes".to_string());
            }
            if volume.data_sha256.len() != self.data_shards as usize
                || volume.data_sha256.iter().any(|hash| {
                    hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                })
            {
                return Err("@t:archive.manifestInvalid\u{1f}parityShards".to_string());
            }
            if volume.files.len() != self.parity_shards as usize {
                return Err("@t:archive.manifestInvalid\u{1f}parityFiles".to_string());
            }
            for (index, file) in volume.files.iter().enumerate() {
                if file.index as usize != index + 1
                    || !safe_component(&file.file_name)
                    || !file_names.insert(file.file_name.clone())
                    || file.sha256.len() != 64
                    || !file.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
                {
                    return Err("@t:archive.manifestInvalid\u{1f}parityFile".to_string());
                }
            }
        }
        Ok(())
    }
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
    /// Planned v3 parity metadata; v2 manifests omit it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parity: Option<ParityInfo>,
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
        if let Some(parity) = &self.parity {
            if self.format_version < 3 {
                return Err(format!(
                    "@t:archive.manifestVersion\u{1f}{}",
                    FORMAT_VERSION
                ));
            }
            parity.validate()?;
            if parity.volumes.len() != self.volumes.len()
                || self
                    .volumes
                    .iter()
                    .any(|volume| {
                        !parity
                            .volumes
                            .iter()
                            .any(|entry| entry.volume_index == volume.index)
                    })
            {
                return Err("@t:archive.manifestInvalid\u{1f}parityVolumes".to_string());
            }
        }
        if !self.complete {
            return Err("@t:archive.manifestIncomplete".to_string());
        }
        if !safe_component(&self.install_dir_name) {
            return Err("@t:archive.manifestInvalid\u{1f}installDir".to_string());
        }
        let app_id = self
            .app_name
            .split_once("::")
            .map(|(_, id)| id)
            .unwrap_or(&self.app_name);
        if app_id.is_empty() || app_id.starts_with('-') || !safe_component(app_id) {
            return Err("@t:archive.manifestInvalid\u{1f}appName".to_string());
        }
        if let Some(id) = self.store_meta.steam_app_id.as_deref() {
            if !safe_steam_app_id(id) {
                return Err("@t:archive.manifestInvalid\u{1f}steamId".to_string());
            }
        }
        if let Some(id) = self.store_meta.epic_app_name.as_deref() {
            // Older manifests stored the library key (`epic::Ginger`); accept
            // it, but validate the bare app name that reaches the CLI.
            let id = id.strip_prefix("epic::").unwrap_or(id);
            if !safe_store_id(id) {
                return Err("@t:archive.manifestInvalid\u{1f}storeId".to_string());
            }
        }
        for id in [
            self.store_meta.gog_game_id.as_deref(),
            self.store_meta.amazon_product_id.as_deref(),
        ]
        .into_iter()
        .flatten()
        {
            if !safe_store_id(id) {
                return Err("@t:archive.manifestInvalid\u{1f}storeId".to_string());
            }
        }
        if self.volumes.is_empty() {
            return Err("@t:archive.manifestInvalid\u{1f}volumes".to_string());
        }
        if self.volumes.iter().any(|v| !safe_component(&v.file_name)) {
            return Err("@t:archive.manifestInvalid\u{1f}volumeName".to_string());
        }
        if self.volumes.iter().enumerate().any(|(index, volume)| {
            volume.index as usize != index + 1
                || volume.bytes == 0
                || volume.blocks == 0
                || volume.sha256.len() != 64
                || !volume.sha256.bytes().all(|byte| byte.is_ascii_hexdigit())
        }) {
            return Err("@t:archive.manifestInvalid\u{1f}volumes".to_string());
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
        let blocks: u64 = self
            .volumes
            .iter()
            .fold(0u64, |total, volume| {
                total.saturating_add(u64::from(volume.blocks))
            });
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
            out.extend(std::iter::repeat_n(volume.index, volume.blocks as usize));
        }
        out
    }

    #[cfg(test)]
    pub fn stored_bytes(&self) -> u64 {
        self.volumes
            .iter()
            .fold(0u64, |total, volume| total.saturating_add(volume.bytes))
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
///
/// Both separators are rejected on every host: an archive packed on Linux can be
/// restored on Windows, where a backslash in a name would split the path.
pub fn safe_component(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.contains('/') || trimmed.contains('\\') {
        return false;
    }
    let mut components = Path::new(trimmed).components();
    matches!(components.next(), Some(std::path::Component::Normal(_)))
        && components.next().is_none()
}

/// Store ids end up in file names and command arguments. Digits, letters, dot,
/// underscore and hyphen are enough for Steam, GOG, Epic and Amazon ids; a
/// leading `-` must never reach a CLI as a flag.
pub(crate) fn safe_store_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value != "."
        && value != ".."
        && !value.starts_with('-')
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.'))
}

/// Steam app ids are numeric. They become `appmanifest_<id>.acf` under
/// `steamapps`, so a path separator here would escape that folder.
pub(crate) fn safe_steam_app_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 16
        && value.chars().all(|character| character.is_ascii_digit())
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

    fn parity_plan() -> ParityInfo {
        ParityInfo {
            data_shards: 4,
            parity_shards: 2,
            shard_bytes: 64 * 1024 * 1024,
            volumes: vec![ParityVolumeInfo {
                volume_index: 1,
                data_sha256: vec!["a".repeat(64); 4],
                files: (1..=2)
                    .map(|index| ParityFileInfo {
                        index,
                        file_name: format!("game.efxpak.001.efxpar.{index:03}"),
                        sha256: "a".repeat(64),
                    })
                    .collect(),
            }],
        }
    }

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
                sha256: "0".repeat(64),
                blocks: 1,
            }],
            store_meta: StoreMeta::default(),
            complete: true,
            disc_layout: false,
            parity: None,
        };
        let dir = std::env::temp_dir().join(format!("efxlve-manifest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = write_manifest(&dir, &manifest).unwrap();
        let loaded = read_manifest(&path).unwrap();
        assert_eq!(loaded.app_name, "steam::1");
        assert_eq!(loaded.volume_for_blocks(), vec![1]);
        assert_eq!(loaded.stored_bytes(), 10);
        assert!(!serde_json::to_string(&manifest)
            .unwrap()
            .contains("\"parity\""));
        let mut with_parity = manifest.clone();
        with_parity.parity = Some(parity_plan());
        assert!(with_parity.validate().is_ok());
        with_parity.format_version = 2;
        let error = with_parity.validate().unwrap_err();
        assert!(error.contains("manifestVersion"), "{error}");
        let mut dangerous = manifest.clone();
        dangerous.store_meta.steam_app_id = Some(r"..\..\evil".to_string());
        assert!(dangerous.validate().is_err());
        dangerous.store_meta.steam_app_id = Some("123".to_string());
        dangerous.store_meta.epic_app_name = Some("-oops".to_string());
        assert!(dangerous.validate().is_err());
        dangerous.store_meta.epic_app_name = Some("epic::Ginger".to_string());
        assert!(dangerous.validate().is_ok());
        let mut bad_volume = manifest.clone();
        bad_volume.volumes[0].index = 2;
        assert!(bad_volume.validate().is_err());
        bad_volume = manifest.clone();
        bad_volume.volumes[0].bytes = 0;
        assert!(bad_volume.validate().is_err());
        bad_volume = manifest.clone();
        bad_volume.volumes[0].sha256 = "x".to_string();
        assert!(bad_volume.validate().is_err());
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

    #[test]
    fn parity_plan_accepts_a_complete_plan() {
        assert!(parity_plan().validate().is_ok());
    }

    #[test]
    fn parity_plan_rejects_bad_counts_and_sizes() {
        let mut plan = parity_plan();
        plan.data_shards = 0;
        assert!(plan.validate().is_err());

        plan = parity_plan();
        plan.parity_shards = 0;
        assert!(plan.validate().is_err());

        plan = parity_plan();
        plan.data_shards = 200;
        plan.parity_shards = 56;
        assert!(plan.validate().is_err());

        plan = parity_plan();
        plan.shard_bytes = 0;
        assert!(plan.validate().is_err());

        plan = parity_plan();
        plan.shard_bytes = 9 * 1024 * 1024 * 1024;
        assert!(plan.validate().is_err());
    }

    #[test]
    fn parity_plan_requires_sequential_safe_files() {
        let mut plan = parity_plan();
        plan.volumes[0].files.pop();
        assert!(plan.validate().is_err());

        plan = parity_plan();
        plan.volumes[0].files[1].index = 3;
        assert!(plan.validate().is_err());

        plan = parity_plan();
        plan.volumes[0].files[0].file_name = "../evil".to_string();
        assert!(plan.validate().is_err());

        plan = parity_plan();
        plan.volumes[0].files[0].sha256 = "x".to_string();
        assert!(plan.validate().is_err());

        plan = parity_plan();
        plan.volumes[0].data_sha256.pop();
        assert!(plan.validate().is_err());
    }

    #[test]
    fn store_identifiers_stay_argument_safe() {
        assert!(safe_steam_app_id("12345"));
        assert!(safe_steam_app_id(&"1".repeat(16)));
        assert!(!safe_steam_app_id(&"1".repeat(17)));
        assert!(!safe_steam_app_id("12/345"));
        assert!(!safe_steam_app_id("-123"));
        assert!(safe_store_id("Ginger_1"));
        assert!(safe_store_id("amzn1.adg.product"));
        assert!(safe_store_id(&"a".repeat(128)));
        assert!(!safe_store_id(&"a".repeat(129)));
        assert!(!safe_store_id("-oops"));
        assert!(!safe_store_id(r"..\evil"));
        assert!(!safe_store_id(".."));
    }
}
