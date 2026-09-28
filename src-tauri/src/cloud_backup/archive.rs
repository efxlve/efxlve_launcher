//! Archive packaging (.tar.gz) and verification for save backups.

use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

use flate2::read::GzDecoder;
use flate2::write::GzEncoder;
use flate2::Compression;
use sha2::{Digest, Sha256};

/// Packages the entire backup folder (including data/ and backup_info.json) into a compressed .tar.gz archive.
/// Returns (archive_size_bytes, sha256_checksum).
pub fn pack_backup_dir(source_backup_dir: &Path, target_tar_gz: &Path) -> Result<(u64, String), String> {
    if !source_backup_dir.is_dir() {
        return Err(format!("Source directory does not exist: {}", source_backup_dir.display()));
    }

    if let Some(parent) = target_tar_gz.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let file = File::create(target_tar_gz).map_err(|e| format!("Failed to create archive file: {e}"))?;
    let writer = BufWriter::new(file);
    let enc = GzEncoder::new(writer, Compression::default());
    let mut tar_builder = tar::Builder::new(enc);

    // Recursively append all contents of source_backup_dir
    tar_builder
        .append_dir_all(".", source_backup_dir)
        .map_err(|e| format!("Failed to append files to archive: {e}"))?;

    let enc = tar_builder
        .into_inner()
        .map_err(|e| format!("Failed to finalize archive: {e}"))?;

    let mut writer = enc
        .finish()
        .map_err(|e| format!("Failed to complete compression: {e}"))?;

    writer.flush().map_err(|e| format!("Failed to flush archive: {e}"))?;

    // Compute size and SHA-256
    let (size, sha) = compute_file_sha256(target_tar_gz)?;
    Ok((size, sha))
}

/// Unpacks a .tar.gz backup archive into the target backup directory.
pub fn unpack_backup_tar_gz(tar_gz_file: &Path, target_backup_dir: &Path) -> Result<(), String> {
    if !tar_gz_file.is_file() {
        return Err(format!("Archive file not found: {}", tar_gz_file.display()));
    }

    std::fs::create_dir_all(target_backup_dir).map_err(|e| e.to_string())?;

    let file = File::open(tar_gz_file).map_err(|e| format!("Failed to open archive: {e}"))?;
    let reader = BufReader::new(file);
    let gz = GzDecoder::new(reader);
    let mut archive = tar::Archive::new(gz);

    archive
        .unpack(target_backup_dir)
        .map_err(|e| format!("Failed to unpack archive: {e}"))?;

    Ok(())
}

/// Calculates size and hex SHA-256 checksum of any file.
pub fn compute_file_sha256(path: &Path) -> Result<(u64, String), String> {
    let file = File::open(path).map_err(|e| format!("Failed to read file for checksum: {e}"))?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 16384];
    let mut total_bytes = 0u64;

    loop {
        let n = reader.read(&mut buffer).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
        total_bytes += n as u64;
    }

    let hash_bytes = hasher.finalize();
    let sha_hex = format!("{:x}", hash_bytes);
    Ok((total_bytes, sha_hex))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_pack_and_unpack_roundtrip() {
        let temp_base = std::env::temp_dir().join(format!("efxlve_test_archive_{}", std::process::id()));
        let src_dir = temp_base.join("source");
        let dst_dir = temp_base.join("unpacked");
        let archive_file = temp_base.join("backup.tar.gz");

        let _ = std::fs::remove_dir_all(&temp_base);
        std::fs::create_dir_all(src_dir.join("data")).unwrap();

        std::fs::write(src_dir.join("backup_info.json"), r#"{"id":"123"}"#).unwrap();
        std::fs::write(src_dir.join("data").join("save.dat"), b"SAVEGAME_DATA_BINARY").unwrap();

        // Pack
        let (size, sha) = pack_backup_dir(&src_dir, &archive_file).expect("packing should succeed");
        assert!(size > 0);
        assert!(!sha.is_empty());
        assert!(archive_file.is_file());

        // Unpack
        unpack_backup_tar_gz(&archive_file, &dst_dir).expect("unpacking should succeed");

        assert_eq!(
            std::fs::read_to_string(dst_dir.join("backup_info.json")).unwrap(),
            r#"{"id":"123"}"#
        );
        assert_eq!(
            std::fs::read(dst_dir.join("data").join("save.dat")).unwrap(),
            b"SAVEGAME_DATA_BINARY"
        );

        let _ = std::fs::remove_dir_all(&temp_base);
    }
}
