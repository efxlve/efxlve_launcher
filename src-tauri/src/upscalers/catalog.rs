//! Public upscaler DLL catalog.
//!
//! The catalog URL and download URLs are the ones the open-source DLSS Swapper
//! project publishes. The launcher never bundles these binaries; it only asks
//! for the manifest when the user opens the feature and downloads a version the
//! user explicitly selected.

use std::path::Path;
use std::time::Duration;

use serde::Deserialize;

use super::types::{CatalogEntry, UpscalerKind};

const MANIFEST_URL: &str =
    "https://raw.githubusercontent.com/beeradmoore/dlss-swapper-manifest-builder/refs/heads/main/manifest.json";
const CACHE_TTL_SECS: u64 = 24 * 3600;
const CACHE_SCHEMA: u32 = 1;

#[derive(Debug, Deserialize)]
struct RawEntry {
    version: String,
    #[serde(default)]
    version_number: u64,
    #[serde(default)]
    additional_label: String,
    md5_hash: String,
    #[serde(default)]
    zip_md5_hash: String,
    download_url: String,
    #[serde(default)]
    file_size: u64,
    #[serde(default)]
    zip_file_size: u64,
    #[serde(default)]
    is_dev_file: bool,
    #[serde(default)]
    is_signature_valid: bool,
}

fn cache_path(app_data: &Path) -> std::path::PathBuf {
    super::store::cache_root(app_data).join("manifest.json")
}

fn parse_manifest(text: &str) -> Result<Vec<CatalogEntry>, String> {
    let root: serde_json::Value =
        serde_json::from_str(text).map_err(|error| format!("Catalog parse failed: {error}"))?;
    let mut entries = Vec::new();
    for kind in [
        UpscalerKind::Dlss,
        UpscalerKind::DlssFg,
        UpscalerKind::DlssRr,
        UpscalerKind::Fsr31Dx12,
        UpscalerKind::Fsr31Vk,
        UpscalerKind::Xess,
        UpscalerKind::XessDx11,
        UpscalerKind::XessFg,
        UpscalerKind::Xell,
    ] {
        let Some(items) = root.get(kind.manifest_key()).and_then(|value| value.as_array()) else {
            continue;
        };
        for item in items {
            let Ok(raw) = serde_json::from_value::<RawEntry>(item.clone()) else {
                continue;
            };
            if raw.md5_hash.trim().is_empty() || raw.download_url.trim().is_empty() {
                continue;
            }
            entries.push(CatalogEntry {
                kind,
                id: super::store::id_for(kind, &raw.md5_hash),
                version: raw.version,
                version_number: raw.version_number,
                label: raw.additional_label,
                md5: raw.md5_hash.to_ascii_uppercase(),
                zip_md5: raw.zip_md5_hash.to_ascii_uppercase(),
                download_url: raw.download_url,
                file_size: raw.file_size,
                zip_file_size: raw.zip_file_size,
                is_dev: raw.is_dev_file,
                is_signed: raw.is_signature_valid,
            });
        }
    }
    // Newest first; within one version the stable file comes before a beta.
    entries.sort_by(|left, right| {
        right
            .version_number
            .cmp(&left.version_number)
            .then_with(|| left.is_dev.cmp(&right.is_dev))
            .then_with(|| left.kind.order().cmp(&right.kind.order()))
    });
    Ok(entries)
}

async fn fetch_manifest() -> Result<Vec<CatalogEntry>, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("Efxlve-Launcher")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(MANIFEST_URL)
        .send()
        .await
        .map_err(|error| format!("Could not reach the DLL catalog: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The DLL catalog answered with an error: {error}"))?;
    let text = response.text().await.map_err(|error| error.to_string())?;
    parse_manifest(&text)
}

/// Loads the catalog, preferring a fresh on-disk copy. A failed refresh falls
/// back to an older cached copy so an offline user can still use downloaded
/// versions.
pub async fn load_catalog(app_data: &Path, force: bool) -> Result<Vec<CatalogEntry>, String> {
    let path = cache_path(app_data);
    if !force {
        if let Some((entries, fetched_at)) =
            crate::lookup_cache::read::<Vec<CatalogEntry>>(&path, CACHE_SCHEMA)
        {
            if crate::lookup_cache::fresh(fetched_at, CACHE_TTL_SECS) {
                return Ok(entries);
            }
        }
    }

    match fetch_manifest().await {
        Ok(entries) => {
            crate::lookup_cache::write(&path, CACHE_SCHEMA, &entries);
            Ok(entries)
        }
        Err(error) => {
            if let Some((entries, _)) =
                crate::lookup_cache::read::<Vec<CatalogEntry>>(&path, CACHE_SCHEMA)
            {
                return Ok(entries);
            }
            Err(error)
        }
    }
}

/// The newest signed stable entry for one DLL family.
pub async fn latest(app_data: &Path, kind: UpscalerKind) -> Result<CatalogEntry, String> {
    let entries = load_catalog(app_data, false).await?;
    let mut candidates: Vec<&CatalogEntry> = entries
        .iter()
        .filter(|entry| entry.kind == kind && entry.is_signed)
        .collect();
    candidates.sort_by(|left, right| {
        right
            .version_number
            .cmp(&left.version_number)
            .then_with(|| left.is_dev.cmp(&right.is_dev))
    });
    if let Some(stable) = candidates.iter().find(|entry| !entry.is_dev) {
        return Ok((*stable).clone());
    }
    candidates
        .into_iter()
        .next()
        .cloned()
        .ok_or_else(|| "The catalog has no signed version for this DLL.".to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_manifest;
    use crate::upscalers::types::UpscalerKind;

    #[test]
    fn manifest_arrays_become_entries() {
        let text = r#"{
            "dlss": [
                {
                    "version": "3.1.11.0",
                    "version_number": 844429225820160,
                    "md5_hash": "aabb",
                    "zip_md5_hash": "ccdd",
                    "download_url": "https://example.invalid/dlss.zip",
                    "is_signature_valid": true,
                    "is_dev_file": false
                }
            ],
            "xess": []
        }"#;
        let entries = parse_manifest(text).expect("parse");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, UpscalerKind::Dlss);
        assert_eq!(entries[0].md5, "AABB");
        assert_eq!(entries[0].id, "dlss-aabb");
        assert!(entries[0].is_signed);
    }
}
