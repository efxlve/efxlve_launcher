//! Downloads one catalog DLL into the launcher cache.
//!
//! Every archive is checked against the catalog's zip MD5, the extracted file
//! against the catalog's DLL MD5, and finally against Windows' Authenticode
//! trust check. A failed step never reaches a game folder.

use std::path::Path;
use std::time::Duration;

use super::hash;
use super::store;
use super::types::{CatalogEntry, UpscalerKind};
use super::version;

fn validate(entry: &CatalogEntry) -> Result<(), String> {
    if !entry.is_signed {
        return Err("This catalog entry is not signed by a trusted publisher.".to_string());
    }
    if !entry.download_url.starts_with("https://") {
        return Err("The catalog returned an unsafe download URL.".to_string());
    }
    if entry.md5.trim().len() != 32 {
        return Err("The catalog entry has an invalid DLL hash.".to_string());
    }
    Ok(())
}

fn extract_dll(payload: &[u8], kind: UpscalerKind) -> Result<Vec<u8>, String> {
    // Some future entries may point at a raw DLL instead of a zip.
    if !payload.starts_with(b"PK") {
        return Ok(payload.to_vec());
    }
    let cursor = std::io::Cursor::new(payload);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|error| format!("Bad DLL archive: {error}"))?;
    let expected = kind.file_name().to_ascii_lowercase();
    for index in 0..archive.len() {
        let mut file = archive
            .by_index(index)
            .map_err(|error| format!("Bad DLL archive entry: {error}"))?;
        if !file.name().to_ascii_lowercase().ends_with(&expected) {
            continue;
        }
        let mut buffer = Vec::with_capacity(file.size() as usize);
        std::io::copy(&mut file, &mut buffer)
            .map_err(|error| format!("Could not read the DLL from its archive: {error}"))?;
        return Ok(buffer);
    }
    Err(format!(
        "The archive does not contain {}.",
        kind.file_name()
    ))
}

/// Makes sure one catalog entry is in the launcher cache.
pub async fn ensure_cached(app_data: &Path, entry: &CatalogEntry) -> Result<(), String> {
    validate(entry)?;
    let destination = store::dll_path(app_data, entry.kind, &entry.md5);
    if destination.is_file() {
        if hash::md5_file(&destination)?.eq_ignore_ascii_case(&entry.md5) {
            return Ok(());
        }
        let _ = std::fs::remove_file(&destination);
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(300))
        .user_agent("Efxlve-Launcher")
        .build()
        .map_err(|error| error.to_string())?;
    let response = client
        .get(&entry.download_url)
        .send()
        .await
        .map_err(|error| format!("Could not download the DLL: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The DLL server answered with an error: {error}"))?;
    let payload = response
        .bytes()
        .await
        .map_err(|error| format!("Could not read the DLL download: {error}"))?;

    if !entry.zip_md5.is_empty() {
        let actual = hash::md5_bytes(&payload);
        if !actual.eq_ignore_ascii_case(&entry.zip_md5) {
            return Err("The downloaded archive did not match the catalog hash.".to_string());
        }
    }

    let dll_bytes = extract_dll(&payload, entry.kind)?;
    let actual = hash::md5_bytes(&dll_bytes);
    if !actual.eq_ignore_ascii_case(&entry.md5) {
        return Err("The downloaded DLL did not match the catalog hash.".to_string());
    }

    let downloads = store::cache_root(app_data).join("downloads");
    std::fs::create_dir_all(&downloads).map_err(|error| error.to_string())?;
    let temp = downloads.join(format!("{}.dll", entry.md5.to_ascii_lowercase()));
    std::fs::write(&temp, &dll_bytes).map_err(|error| error.to_string())?;
    if !version::verify_signature(&temp) {
        let _ = std::fs::remove_file(&temp);
        return Err("The downloaded DLL is not signed by a trusted publisher.".to_string());
    }

    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    if std::fs::rename(&temp, &destination).is_err() {
        let _ = std::fs::remove_file(&destination);
        std::fs::rename(&temp, &destination)
            .map_err(|error| format!("Could not store the downloaded DLL: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::extract_dll;
    use crate::upscalers::types::UpscalerKind;
    use std::io::Write;

    #[tokio::test]
    #[ignore = "downloads a real DLL from the public catalog"]
    async fn live_catalog_latest_downloads_and_verifies() {
        let root = std::env::temp_dir().join("efxlve-upscaler-download-test");
        let _ = std::fs::remove_dir_all(&root);
        let entry = crate::upscalers::catalog::latest(&root, UpscalerKind::Dlss)
            .await
            .expect("catalog");
        super::ensure_cached(&root, &entry)
            .await
            .expect("download and verify");
        assert!(crate::upscalers::store::dll_path(&root, entry.kind, &entry.md5).is_file());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn raw_payload_is_returned_unchanged() {
        assert_eq!(
            extract_dll(b"not a zip", UpscalerKind::Dlss).unwrap(),
            b"not a zip"
        );
    }

    #[test]
    fn zip_entry_is_selected_by_file_name() {
        let mut buffer = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut buffer);
            let options = zip::write::SimpleFileOptions::default();
            writer.start_file("folder/nvngx_dlss.dll", options).unwrap();
            writer.write_all(b"dll payload").unwrap();
            writer.finish().unwrap();
        }
        let bytes = buffer.into_inner();
        assert_eq!(
            extract_dll(&bytes, UpscalerKind::Dlss).unwrap(),
            b"dll payload"
        );
        assert!(extract_dll(&bytes, UpscalerKind::DlssFg).is_err());
    }
}
