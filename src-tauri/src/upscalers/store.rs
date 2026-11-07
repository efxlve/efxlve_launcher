//! Launcher-owned cache of DLLs the user imported or downloaded.
//!
//! Nothing here is bundled with the app: the cache only holds files the user
//! selected or explicitly downloaded, and it lives under the app data folder.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use super::hash;
use super::types::{ImportedDll, UpscalerKind};

const SCHEMA: u32 = 1;
const MAX_DLL_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoreFile {
    #[serde(default)]
    schema: u32,
    #[serde(default)]
    items: Vec<ImportedDll>,
}

impl Default for StoreFile {
    fn default() -> Self {
        Self {
            schema: SCHEMA,
            items: Vec::new(),
        }
    }
}

pub fn cache_root(app_data: &Path) -> PathBuf {
    app_data.join("upscalers")
}

pub fn imported_file(app_data: &Path) -> PathBuf {
    cache_root(app_data).join("imported.json")
}

pub fn dll_path(app_data: &Path, kind: UpscalerKind, md5: &str) -> PathBuf {
    cache_root(app_data)
        .join("dlls")
        .join(kind.dir_name())
        .join(format!("{}.dll", md5.to_ascii_lowercase()))
}

pub fn id_for(kind: UpscalerKind, md5: &str) -> String {
    format!("{}-{}", kind.dir_name(), md5.to_ascii_lowercase())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn load(app_data: &Path) -> StoreFile {
    let Ok(text) = std::fs::read_to_string(imported_file(app_data)) else {
        return StoreFile::default();
    };
    let mut store: StoreFile = serde_json::from_str(&text).unwrap_or_default();
    if store.schema != SCHEMA {
        return StoreFile::default();
    }
    store.items.retain(|item| !item.id.is_empty());
    store
}

fn save(app_data: &Path, store: &StoreFile) -> Result<(), String> {
    let path = imported_file(app_data);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(store).map_err(|error| error.to_string())?;
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temp = path.with_extension(format!("{stamp}.tmp"));
    std::fs::write(&temp, text).map_err(|error| error.to_string())?;
    if std::fs::rename(&temp, &path).is_err() {
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&temp, &path).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn copy_atomic(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_nanos())
        .unwrap_or(0);
    let temp = destination.with_extension(format!("{stamp}.tmp"));
    std::fs::copy(source, &temp).map_err(|error| error.to_string())?;
    if std::fs::rename(&temp, destination).is_err() {
        let _ = std::fs::remove_file(destination);
        std::fs::rename(&temp, destination).map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Every cached DLL whose file is still present.
pub fn list_imported(app_data: &Path) -> Result<Vec<ImportedDll>, String> {
    let store = load(app_data);
    let mut items: Vec<ImportedDll> = store
        .items
        .into_iter()
        .filter(|item| dll_path(app_data, item.kind, &item.md5).is_file())
        .collect();
    items.sort_by(|left, right| {
        left.kind
            .order()
            .cmp(&right.kind.order())
            .then_with(|| right.imported_at.cmp(&left.imported_at))
    });
    Ok(items)
}

/// Copies a DLL the user picked into the launcher cache.
pub fn import_dll(app_data: &Path, source: &Path) -> Result<ImportedDll, String> {
    if !source.is_file() {
        return Err("The selected file does not exist.".to_string());
    }
    let file_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "The selected file has no usable name.".to_string())?;
    let kind = UpscalerKind::from_file_name(file_name).ok_or_else(|| {
        "This is not a known DLSS, FSR or XeSS DLL file name.".to_string()
    })?;
    let metadata = std::fs::metadata(source).map_err(|error| error.to_string())?;
    if metadata.len() == 0 {
        return Err("The selected DLL is empty.".to_string());
    }
    if metadata.len() > MAX_DLL_BYTES {
        return Err("The selected DLL is too large to be an upscaler file.".to_string());
    }

    let md5 = hash::md5_file(source)?;
    let id = id_for(kind, &md5);
    let destination = dll_path(app_data, kind, &md5);
    let mut store = load(app_data);

    if let Some(existing) = store.items.iter().find(|item| item.id == id) {
        if !destination.is_file() {
            copy_atomic(source, &destination)?;
        }
        return Ok(existing.clone());
    }

    copy_atomic(source, &destination)?;
    let item = ImportedDll {
        id,
        kind,
        file_name: file_name.to_string(),
        version: super::version::file_version(source).unwrap_or_default(),
        md5: md5.clone(),
        size: metadata.len(),
        imported_at: now_secs(),
        source_path: source.to_string_lossy().to_string(),
    };
    store.items.push(item.clone());
    save(app_data, &store)?;
    Ok(item)
}

/// Registers a DLL that is already in the cache. Used by catalog downloads.
pub fn record_cached(
    app_data: &Path,
    kind: UpscalerKind,
    md5: &str,
    version: &str,
    file_name: &str,
    size: u64,
    source: &str,
) -> Result<ImportedDll, String> {
    let destination = dll_path(app_data, kind, md5);
    if !destination.is_file() {
        return Err("The downloaded DLL is not in the launcher cache.".to_string());
    }
    if !hash::md5_file(&destination)?.eq_ignore_ascii_case(md5) {
        return Err("The cached DLL does not match its catalog hash.".to_string());
    }

    let id = id_for(kind, md5);
    let mut store = load(app_data);
    if let Some(existing) = store.items.iter().find(|item| item.id == id) {
        return Ok(existing.clone());
    }
    let item = ImportedDll {
        id,
        kind,
        file_name: file_name.to_string(),
        version: version.to_string(),
        md5: md5.to_ascii_uppercase(),
        size,
        imported_at: now_secs(),
        source_path: source.to_string(),
    };
    store.items.push(item.clone());
    save(app_data, &store)?;
    Ok(item)
}

#[cfg(test)]
mod tests {
    use super::{dll_path, import_dll, list_imported};
    use crate::upscalers::types::UpscalerKind;

    #[test]
    fn imported_dll_is_copied_and_listed() {
        let root = std::env::temp_dir().join("efxlve-upscaler-store-test");
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("create test root");
        let source = root.join("nvngx_dlss.dll");
        std::fs::write(&source, b"test payload").expect("write source");

        let item = import_dll(&root.join("app"), &source).expect("import");
        assert_eq!(item.kind, UpscalerKind::Dlss);
        assert!(dll_path(&root.join("app"), item.kind, &item.md5).is_file());
        assert_eq!(list_imported(&root.join("app")).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }
}
