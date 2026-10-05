//! Real on-disk size of a game folder.
//!
//! Store metadata under-reports some installs (addons, patches, shared bundles),
//! so the storage manager asks for the measured folder size instead. Results are
//! cached for a short window, and the walk never follows symlinks or junctions.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A re-measure inside this window reuses the cached number.
const CACHE_TTL: Duration = Duration::from_secs(300);
/// Symlink loops cannot happen (links are skipped), but a runaway tree is cheap
/// to bound anyway.
const MAX_DEPTH: u32 = 64;

fn cache() -> &'static Mutex<HashMap<String, (u64, Instant)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (u64, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn dir_size(path: &Path, depth: u32) -> u64 {
    if depth > MAX_DEPTH {
        return 0;
    }
    let Ok(entries) = std::fs::read_dir(path) else {
        return 0;
    };
    let mut total = 0u64;
    for entry in entries.flatten() {
        let child = entry.path();
        let Ok(meta) = std::fs::symlink_metadata(&child) else {
            continue;
        };
        if meta.file_type().is_symlink() {
            continue;
        }
        if meta.is_dir() {
            total += dir_size(&child, depth + 1);
        } else if meta.is_file() {
            total += meta.len();
        }
    }
    total
}

/// Bytes used by the folder at `path`, measured off the filesystem.
#[tauri::command]
pub async fn storage_path_size(path: String) -> u64 {
    if path.is_empty() {
        return 0;
    }
    if let Ok(map) = cache().lock() {
        if let Some((bytes, at)) = map.get(&path) {
            if at.elapsed() < CACHE_TTL {
                return *bytes;
            }
        }
    }
    let key = path.clone();
    let bytes = tauri::async_runtime::spawn_blocking(move || dir_size(Path::new(&key), 0))
        .await
        .unwrap_or(0);
    if let Ok(mut map) = cache().lock() {
        map.insert(path, (bytes, Instant::now()));
    }
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dir_size_sums_nested_files() {
        let root = std::env::temp_dir().join(format!("efxlve-size-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("sub")).unwrap();
        std::fs::write(root.join("a.bin"), vec![0u8; 100]).unwrap();
        std::fs::write(root.join("sub").join("b.bin"), vec![0u8; 250]).unwrap();
        assert_eq!(dir_size(&root, 0), 350);
        // A missing folder measures as zero instead of panicking.
        assert_eq!(dir_size(&root.join("nope"), 0), 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
