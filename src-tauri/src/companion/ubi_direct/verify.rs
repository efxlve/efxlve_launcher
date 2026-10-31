//! Integrity check and repair for a direct Ubisoft install.
//!
//! The manifest carries a SHA-1 of every decompressed slice. A file is good
//! when its size matches and every slice hash matches; a bad file is removed
//! and the normal installer re-downloads only the missing files.

use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde::Serialize;
use sha1::{Digest, Sha1};

use super::manifest::{self, Manifest};

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifyReport {
    pub files: usize,
    pub checked: usize,
    pub missing: usize,
    pub corrupt: usize,
    pub repaired: usize,
    pub bad_files: Vec<String>,
}

pub(crate) fn verify(manifest: &Manifest, install_dir: &Path) -> VerifyReport {
    let mut report = VerifyReport {
        files: manifest.files.len(),
        ..Default::default()
    };
    for file in &manifest.files {
        let Ok(path) = manifest::safe_install_path(install_dir, &file.name) else {
            report.missing += 1;
            report.bad_files.push(file.name.clone());
            continue;
        };
        if file.is_dir {
            if path.is_dir() {
                report.checked += 1;
            } else {
                report.missing += 1;
                report.bad_files.push(file.name.clone());
            }
            continue;
        }
        let Ok(meta) = std::fs::metadata(&path) else {
            report.missing += 1;
            report.bad_files.push(file.name.clone());
            continue;
        };
        if !meta.is_file() || meta.len() != file.size {
            report.corrupt += 1;
            report.bad_files.push(file.name.clone());
            continue;
        }
        if file.slices.is_empty() || !verify_slices(&path, file) {
            if file.slices.is_empty() {
                report.checked += 1;
            } else {
                report.corrupt += 1;
                report.bad_files.push(file.name.clone());
            }
            continue;
        }
        report.checked += 1;
    }
    report
}

/// Remove the files the check rejected so the installer fetches them again.
/// Directories are left to the installer, which recreates them.
pub(crate) fn remove_bad(install_dir: &Path, bad_files: &[String]) -> usize {
    let mut removed = 0;
    for name in bad_files {
        let Ok(path) = manifest::safe_install_path(install_dir, name) else {
            continue;
        };
        if path.is_file() && std::fs::remove_file(&path).is_ok() {
            removed += 1;
        }
    }
    removed
}

fn verify_slices(path: &Path, file: &manifest::ManifestFile) -> bool {
    let Ok(mut handle) = std::fs::File::open(path) else {
        return false;
    };
    for slice in &file.slices {
        if slice.content_sha1.is_empty() {
            if handle.seek(SeekFrom::Current(i64::from(slice.size))).is_err() {
                return false;
            }
            continue;
        }
        let mut buffer = vec![0u8; slice.size as usize];
        if handle.read_exact(&mut buffer).is_err() {
            return false;
        }
        let mut hasher = Sha1::new();
        hasher.update(&buffer);
        let got = manifest::hex_upper(&hasher.finalize());
        let want = manifest::hex_upper(&slice.content_sha1);
        if got != want {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::companion::proto::{push_bytes, push_varint_field};

    fn slice(data: &[u8]) -> Vec<u8> {
        let mut hasher = Sha1::new();
        hasher.update(data);
        let digest = hasher.finalize();
        let mut out = Vec::new();
        push_varint_field(&mut out, 1, data.len() as u64);
        push_bytes(&mut out, 3, digest.as_slice());
        out
    }

    fn file(name: &str, data: &[u8]) -> Vec<u8> {
        let mut hasher = Sha1::new();
        hasher.update(data);
        let digest = hasher.finalize();
        let mut out = Vec::new();
        push_bytes(&mut out, 1, name.as_bytes());
        push_varint_field(&mut out, 2, data.len() as u64);
        push_varint_field(&mut out, 3, 0);
        push_bytes(&mut out, 4, digest.as_slice());
        push_bytes(&mut out, 7, &slice(data));
        out
    }

    fn manifest(name: &str, data: &[u8]) -> Manifest {
        let mut chunk = Vec::new();
        push_bytes(&mut chunk, 3, &file(name, data));
        let mut bytes = Vec::new();
        push_bytes(&mut bytes, 4, &chunk);
        manifest::parse_manifest(&bytes)
    }

    #[test]
    fn accepts_intact_files_and_flags_changed_ones() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-verify-{}", std::process::id()));
        std::fs::create_dir_all(root.join("Data")).unwrap();
        let manifest = manifest("Data\\level.pak", b"hello");
        std::fs::write(root.join("Data").join("level.pak"), b"hello").unwrap();
        let report = verify(&manifest, &root);
        assert_eq!(report.checked, 1);
        assert_eq!(report.corrupt, 0);

        std::fs::write(root.join("Data").join("level.pak"), b"HELLO").unwrap();
        let report = verify(&manifest, &root);
        assert_eq!(report.corrupt, 1);
        assert_eq!(report.bad_files, vec!["Data\\level.pak".to_string()]);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn flags_a_missing_file() {
        let root = std::env::temp_dir().join(format!("efxlve-ubi-missing-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let report = verify(&manifest("game.exe", b"exe"), &root);
        assert_eq!(report.missing, 1);
        assert_eq!(report.checked, 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}

