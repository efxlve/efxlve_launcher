//! Download the save slots Ubisoft keeps in its own cloud storage.
//!
//! The client asks `cloudsave_service` for a signed S3 URL per
//! `upcCloudSaveUplayId_<uplay id>` item and then writes the returned object to
//! `savegames/<account>/<uplay id>/<slot>.save`. This module follows the same
//! read-only path: ownership token -> signed URL -> object bytes. It never calls
//! the Put or Delete methods, and an existing local slot is never overwritten.

use std::io::Read;
use std::path::Path;

use serde_json::Value;

use super::{codec, wire};
use crate::companion::ubisoft_login::Session;

const SESSION_APP_ID: &str = "f68a4bb5-608a-4ff2-8123-be8ef797e0a6";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) ConnectPC Safari/537.36";

/// Download every cloud slot for one game into `destination`. Existing files
/// are left alone; the return value counts newly written slots.
pub(crate) async fn download(
    product_id: u32,
    uplay_id: u32,
    destination: &Path,
) -> Result<usize, String> {
    if uplay_id == 0 {
        return Err("this game has no Ubisoft Uplay id".to_string());
    }
    let (mut demux, session) = super::connect().await?;
    let token = ownership_token(&mut demux, product_id, uplay_id).await?;
    let base = format!("upcCloudSaveUplayId_{uplay_id}");

    // The service may answer the base item with one request per slot; when it
    // does not, the profile entity lists the slot names that make up the item.
    let mut items = vec![base.clone()];
    let mut first_error = String::new();
    let mut urls = match sign(&mut demux, &token, uplay_id, &base).await {
        Ok(urls) => urls,
        Err(error) => {
            first_error = error;
            Vec::new()
        }
    };
    if urls.is_empty() {
        match entity_items(&session, &base).await {
            Ok(found) => {
                items = found;
            }
            Err(error) => {
                if first_error.is_empty() {
                    first_error = error;
                }
            }
        }
        // Some client builds hide the slot names behind the base entity. The
        // client itself numbers its save objects `1.savegame`, `3.savegame`, ...
        if items.len() <= 1 {
            for slot in 1..=8 {
                let item = format!("{base}/{slot}.savegame");
                if !items.contains(&item) {
                    items.push(item);
                }
            }
        }
        for item in &items {
            if item == &base {
                continue;
            }
            match sign(&mut demux, &token, uplay_id, item).await {
                Ok(mut found) => urls.append(&mut found),
                Err(error) => {
                    if first_error.is_empty() {
                        first_error = error;
                    }
                }
            }
        }
    }

    if urls.is_empty() {
        return Err(if first_error.is_empty() {
            "Ubisoft returned no cloud save slots for this game".to_string()
        } else {
            first_error
        });
    }

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|error| format!("building the cloud save client: {error}"))?;
    let mut written = 0;
    let mut found = 0;
    let mut last_error = String::new();
    for (index, signed) in urls.iter().enumerate() {
        let label = slot_label(&signed.url)
            .or_else(|| items.get(index).map(String::as_str).and_then(slot_label))
            .map(str::to_string)
            .unwrap_or_else(|| (index + 1).to_string());
        match fetch(&client, signed).await {
            Ok(bytes) => match write_payload(&bytes, &label, destination) {
                Ok(count) => {
                    found += 1;
                    written += count;
                }
                Err(error) => last_error = error,
            },
            Err(error) => last_error = error,
        }
    }
    if found == 0 {
        return Err(if last_error.is_empty() {
            "Ubisoft returned no usable cloud save slots".to_string()
        } else {
            last_error
        });
    }
    Ok(written)
}

async fn ownership_token(
    demux: &mut wire::Demux,
    product_id: u32,
    uplay_id: u32,
) -> Result<String, String> {
    if product_id == 0 {
        return demux.ownership_token(uplay_id).await;
    }
    match demux.ownership_token(product_id).await {
        Ok(token) => Ok(token),
        Err(first) if product_id != uplay_id => demux
            .ownership_token(uplay_id)
            .await
            .map_err(|second| format!("{first}; {second}")),
        Err(error) => Err(error),
    }
}

async fn sign(
    demux: &mut wire::Demux,
    token: &str,
    uplay_id: u32,
    item: &str,
) -> Result<Vec<codec::CloudsaveUrl>, String> {
    demux
        .cloudsave_urls(token, uplay_id, &[item.to_string()])
        .await
}

/// The profile entity endpoint returns the slot names/sizes before any signed
/// URL exists. The exact wrapper has changed between client builds, so collect
/// every save-looking string in the document instead of pinning one shape.
async fn entity_items(session: &Session, base: &str) -> Result<Vec<String>, String> {
    if session.user_id.trim().is_empty() || session.ticket.trim().is_empty() {
        return Err("the Ubisoft session has no profile id".to_string());
    }
    let url = format!(
        "https://public-ubiservices.ubi.com/v1/profiles/{}/entities?name={base}",
        session.user_id.trim()
    );
    let response = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| format!("building the Ubisoft entity client: {error}"))?
        .get(url)
        .header("Authorization", format!("ubi_v1 t={}", session.ticket))
        .header("Ubi-AppId", SESSION_APP_ID)
        .header("Ubi-SessionId", &session.session_id)
        .header("Ubi-RequestedPlatformType", "uplay")
        .send()
        .await
        .map_err(|error| format!("reading the Ubisoft cloud save metadata: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Ubisoft returned {} for the cloud save metadata",
            response.status()
        ));
    }
    let text = response
        .text()
        .await
        .map_err(|error| format!("reading the Ubisoft cloud save metadata: {error}"))?;
    let value: Value = serde_json::from_str(&text)
        .map_err(|error| format!("parsing the Ubisoft cloud save metadata: {error}"))?;
    let mut raw = Vec::new();
    collect_save_names(&value, &mut raw);
    let mut items = Vec::new();
    for name in raw {
        let Some(item) = normalize_item(&name, base) else {
            continue;
        };
        if !items.contains(&item) {
            items.push(item);
        }
    }
    if items.is_empty() {
        return Err("the Ubisoft cloud save metadata named no slots".to_string());
    }
    Ok(items)
}

fn collect_save_names(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            if looks_like_save(text) {
                out.push(text.clone());
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_save_names(item, out);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                let key = key.to_ascii_lowercase();
                if looks_like_save(&key) {
                    out.push(key.clone());
                } else if key.chars().all(|c| c.is_ascii_digit())
                    && key.parse::<u32>().map(|slot| (1..=64).contains(&slot)).unwrap_or(false)
                {
                    out.push(key.clone());
                }
                if matches!(
                    key.as_str(),
                    "name" | "itemname" | "item_name" | "filename" | "file_name" | "path" | "key"
                ) {
                    if let Some(text) = value.as_str() {
                        if looks_like_save(text) {
                            out.push(text.to_string());
                        }
                    }
                }
                if matches!(
                    key.as_str(),
                    "slot" | "slot_id" | "slotid" | "itemid" | "item_id"
                ) {
                    if let Some(text) = value.as_str() {
                        if !text.is_empty() && text.chars().all(|c| c.is_ascii_digit()) {
                            out.push(text.to_string());
                        }
                    } else if let Some(number) = value.as_u64() {
                        out.push(number.to_string());
                    }
                }
                collect_save_names(value, out);
            }
        }
        _ => {}
    }
}

fn looks_like_save(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    lower.contains("upccloudsave") || lower.ends_with(".savegame") || lower.ends_with(".save")
}

/// Turn an entity field into the item name `cloudsave_service` expects.
fn normalize_item(raw: &str, base: &str) -> Option<String> {
    let value = raw.trim().trim_start_matches('/');
    if value.is_empty() {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    if lower.starts_with("upccloudsave") {
        return Some(value.to_string());
    }
    if let Some((_, name)) = value.rsplit_once('/') {
        if name.ends_with(".savegame") || name.ends_with(".save") {
            return Some(format!("{base}/{name}"));
        }
    }
    if lower.ends_with(".savegame") || lower.ends_with(".save") {
        return Some(format!("{base}/{value}"));
    }
    if value.chars().all(|c| c.is_ascii_digit()) {
        return Some(format!("{base}/{value}.savegame"));
    }
    None
}

fn slot_label(value: &str) -> Option<&str> {
    let path = value.split('?').next().unwrap_or(value);
    let name = path.rsplit('/').next()?.trim();
    if name.is_empty() {
        return None;
    }
    Some(name)
}

fn file_name(label: &str) -> String {
    let normalized = label.trim().replace('\\', "/");
    let base = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    let stem = base
        .trim_end_matches(".savegame")
        .trim_end_matches(".save")
        .trim();
    if !stem.is_empty()
        && stem != "."
        && stem != ".."
        && stem
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
    {
        format!("{stem}.save")
    } else {
        "cloud.save".to_string()
    }
}

async fn fetch(client: &reqwest::Client, signed: &codec::CloudsaveUrl) -> Result<Vec<u8>, String> {
    let mut request = client.get(&signed.url);
    for line in signed.header.lines() {
        let Some((name, value)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        request = request.header(name, value.trim());
    }
    let response = request
        .send()
        .await
        .map_err(|error| format!("downloading a cloud save slot: {error}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "Ubisoft returned {} for a cloud save slot",
            response.status()
        ));
    }
    response
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|error| format!("reading a cloud save slot: {error}"))
}

fn write_payload(payload: &[u8], label: &str, destination: &Path) -> Result<usize, String> {
    if payload.starts_with(b"PK\x03\x04") {
        return write_zip(payload, destination);
    }
    if payload.starts_with(&[0x1f, 0x8b]) {
        let mut inflated = Vec::new();
        flate2::read::GzDecoder::new(payload)
            .read_to_end(&mut inflated)
            .map_err(|error| format!("inflating a cloud save pack: {error}"))?;
        return write_payload(&inflated, label, destination);
    }
    if payload.first() == Some(&0x78) {
        let mut inflated = Vec::new();
        flate2::read::ZlibDecoder::new(payload)
            .read_to_end(&mut inflated)
            .map_err(|error| format!("inflating a cloud save pack: {error}"))?;
        return write_payload(&inflated, label, destination);
    }
    write_slot(payload, &file_name(label), destination)
}

fn write_zip(payload: &[u8], destination: &Path) -> Result<usize, String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(payload))
        .map_err(|error| format!("reading a cloud save archive: {error}"))?;
    let mut written = 0;
    let mut seen = 0;
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|error| format!("reading a cloud save entry: {error}"))?;
        if !looks_like_save(entry.name()) {
            continue;
        }
        seen += 1;
        let name = file_name(entry.name());
        let mut data = Vec::new();
        entry
            .read_to_end(&mut data)
            .map_err(|error| format!("reading a cloud save entry: {error}"))?;
        written += write_slot(&data, &name, destination)?;
    }
    if seen == 0 {
        return Err("the cloud save archive held no slots".to_string());
    }
    Ok(written)
}

/// Save objects are the same 36-byte-header files the client keeps locally.
/// Only a recognised header is written, so an HTML error page can never land in
/// the save folder as `1.save`.
fn write_slot(payload: &[u8], name: &str, destination: &Path) -> Result<usize, String> {
    if payload.len() < 4 {
        return Err("a cloud save slot is empty".to_string());
    }
    let header = u32::from_le_bytes(payload[0..4].try_into().unwrap_or([0; 4]));
    if !matches!(header, 36 | 40 | 548 | 552) {
        return Err(format!(
            "a cloud save slot has an unknown header ({header})"
        ));
    }
    let path = destination.join(name);
    if path.exists() {
        return Ok(0);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("creating {}: {error}", parent.display()))?;
    }
    std::fs::write(&path, payload)
        .map_err(|error| format!("writing {}: {error}", path.display()))?;
    Ok(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_signed_url_names_its_slot() {
        assert_eq!(
            slot_label("https://example.invalid/c13/635/1.savegame?X-Amz-Signature=x"),
            Some("1.savegame")
        );
        assert_eq!(file_name("1.savegame"), "1.save");
        assert_eq!(file_name("slot-3.save"), "slot-3.save");
        assert_eq!(file_name("folder/2.savegame"), "2.save");
        assert_eq!(file_name("../bad"), "bad.save");
    }

    #[test]
    fn entity_names_become_service_items() {
        let base = "upcCloudSaveUplayId_635";
        assert_eq!(
            normalize_item("upcCloudSaveUplayId_635/1.savegame", base).as_deref(),
            Some("upcCloudSaveUplayId_635/1.savegame")
        );
        assert_eq!(
            normalize_item("c13ea7a8/635/3.savegame", base).as_deref(),
            Some("upcCloudSaveUplayId_635/3.savegame")
        );
        assert_eq!(
            normalize_item("3.savegame", base).as_deref(),
            Some("upcCloudSaveUplayId_635/3.savegame")
        );
        assert_eq!(
            normalize_item("3", base).as_deref(),
            Some("upcCloudSaveUplayId_635/3.savegame")
        );
        assert!(normalize_item("avatar.png", base).is_none());
    }

    #[test]
    fn the_entity_walker_finds_only_save_names() {
        let json = serde_json::json!({
            "entities": [{
                "name": "upcCloudSaveUplayId_635",
                "fields": {
                    "slots": [
                        {"name": "1.savegame", "writeLength": 86051},
                        {"name": "3.savegame", "writeLength": 29492},
                        {"name": "avatar.png", "writeLength": 100}
                    ],
                    "map": {"4": {"md5": "abc"}, "5": {"md5": "def"}}
                }
            }]
        });
        let mut names = Vec::new();
        collect_save_names(&json, &mut names);
        assert!(names.contains(&"1.savegame".to_string()));
        assert!(names.contains(&"3.savegame".to_string()));
        assert!(names.contains(&"4".to_string()));
        assert!(names.contains(&"5".to_string()));
        assert!(!names.contains(&"avatar.png".to_string()));
    }

    #[test]
    fn a_modern_slot_is_written_once_and_never_overwritten() {
        let dir = std::env::temp_dir().join(format!(
            "efxlve-ubi-cloud-{}-{}",
            std::process::id(),
            "write"
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let mut payload = 36u32.to_le_bytes().to_vec();
        payload.extend_from_slice(b"c64d185ec397aff177ce456953bd5cb0");
        payload.extend_from_slice(b"progress");
        assert_eq!(write_slot(&payload, "1.save", &dir).unwrap(), 1);
        assert_eq!(write_slot(&payload, "1.save", &dir).unwrap(), 0);
        assert_eq!(std::fs::read(dir.join("1.save")).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_unknown_payload_is_rejected() {
        let dir = std::env::temp_dir();
        let error =
            write_slot(b"<html>error</html>", "1.save", &dir).expect_err("HTML is not a save");
        assert!(error.contains("unknown header"));
    }

    #[tokio::test]
    #[ignore = "downloads a user's Ubisoft cloud saves; needs EFXLVE_UBI_TEST_PRODUCT and a linked session"]
    async fn live_downloads_cloud_saves() {
        let product: u32 = std::env::var("EFXLVE_UBI_TEST_PRODUCT")
            .ok()
            .and_then(|value| value.parse().ok())
            .expect("EFXLVE_UBI_TEST_PRODUCT");
        let uplay: u32 = std::env::var("EFXLVE_UBI_TEST_UPLAY")
            .ok()
            .and_then(|value| value.parse().ok())
            .unwrap_or(product);
        let dir = std::env::temp_dir().join(format!(
            "efxlve-ubi-cloud-live-{}-{product}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let count = download(product, uplay, &dir)
            .await
            .expect("cloud download");
        println!("{count} cloud slot(s) in {}", dir.display());
        assert!(count > 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
