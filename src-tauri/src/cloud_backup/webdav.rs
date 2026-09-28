//! WebDAV client for Nextcloud, ownCloud, Box, pCloud, and custom WebDAV servers.

use std::path::Path;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use reqwest::{Client, Method, StatusCode};
use crate::cloud_backup::models::CloudBackupEntry;

fn basic_auth_header(user: &str, pass: &str) -> String {
    format!("Basic {}", BASE64.encode(format!("{user}:{pass}")))
}

fn clean_base_url(url: &str) -> String {
    let mut u = url.trim().to_string();
    if !u.ends_with('/') {
        u.push('/');
    }
    u
}

/// Tests connectivity and credentials against a WebDAV server.
pub async fn test_webdav_connection(client: &Client, url: &str, user: &str, pass: &str) -> Result<String, String> {
    let clean = clean_base_url(url);
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;

    let res = client
        .request(propfind, &clean)
        .header("Authorization", basic_auth_header(user, pass))
        .header("Depth", "0")
        .send()
        .await
        .map_err(|e| format!("Network connection failed: {e}"))?;

    let status = res.status();
    if status == StatusCode::MULTI_STATUS || status.is_success() {
        Ok("WebDAV connection verified successfully.".to_string())
    } else if status == StatusCode::UNAUTHORIZED {
        Err("Authentication failed: invalid username or app password.".to_string())
    } else {
        Err(format!("Server returned HTTP status: {status}"))
    }
}

/// Ensures a remote directory/collection exists via MKCOL.
pub async fn ensure_remote_collection(client: &Client, url: &str, user: &str, pass: &str) -> Result<(), String> {
    let clean = clean_base_url(url);
    let mkcol = Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?;

    let res = client
        .request(mkcol, &clean)
        .header("Authorization", basic_auth_header(user, pass))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    // 201 Created = success; 405 Method Not Allowed = already exists (standard WebDAV behavior)
    if status.is_success() || status == StatusCode::METHOD_NOT_ALLOWED {
        Ok(())
    } else {
        Err(format!("MKCOL failed with status: {status}"))
    }
}

/// Uploads a local file to a WebDAV remote URL via PUT.
pub async fn upload_file_webdav(
    client: &Client,
    target_url: &str,
    user: &str,
    pass: &str,
    local_path: &Path,
) -> Result<(), String> {
    let bytes = tokio::fs::read(local_path)
        .await
        .map_err(|e| format!("Failed to read local archive: {e}"))?;

    let res = client
        .put(target_url)
        .header("Authorization", basic_auth_header(user, pass))
        .header("Content-Type", "application/gzip")
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Upload failed: {e}"))?;

    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!("Server rejected upload with HTTP status: {}", res.status()))
    }
}

/// Downloads a remote file from WebDAV via GET.
pub async fn download_file_webdav(
    client: &Client,
    remote_url: &str,
    user: &str,
    pass: &str,
    local_dest: &Path,
) -> Result<(), String> {
    if let Some(parent) = local_dest.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let res = client
        .get(remote_url)
        .header("Authorization", basic_auth_header(user, pass))
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("Download failed with HTTP status: {}", res.status()));
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(local_dest, bytes)
        .await
        .map_err(|e| format!("Failed to save downloaded file: {e}"))?;

    Ok(())
}

/// Deletes a file on WebDAV via DELETE.
pub async fn delete_file_webdav(client: &Client, remote_url: &str, user: &str, pass: &str) -> Result<(), String> {
    let res = client
        .delete(remote_url)
        .header("Authorization", basic_auth_header(user, pass))
        .send()
        .await
        .map_err(|e| format!("Delete request failed: {e}"))?;

    if res.status().is_success() || res.status() == StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!("Delete failed with status: {}", res.status()))
    }
}

/// Lists all save backup archives for a game from `<base_url>/efxlve_saves/<app_name>/`.
pub async fn list_webdav_backups(
    client: &Client,
    base_url: &str,
    user: &str,
    pass: &str,
    app_name: &str,
) -> Result<Vec<CloudBackupEntry>, String> {
    let clean = clean_base_url(base_url);
    let target = format!("{clean}efxlve_saves/{app_name}/");
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;

    let res = client
        .request(propfind, &target)
        .header("Authorization", basic_auth_header(user, pass))
        .header("Depth", "1")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status() == StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }

    if !res.status().is_success() && res.status() != StatusCode::MULTI_STATUS {
        return Err(format!("Failed to list remote backups: HTTP {}", res.status()));
    }

    let text = res.text().await.unwrap_or_default();
    let entries = parse_propfind_xml(&text, app_name, &clean);
    Ok(entries)
}

/// Lightweight parser for WebDAV PROPFIND responses without external heavy XML crate.
fn parse_propfind_xml(xml: &str, app_name: &str, base_url: &str) -> Vec<CloudBackupEntry> {
    let mut list = Vec::new();

    // Iterate over each <response> or <d:response> block
    for block in xml.split("<response>").chain(xml.split("<d:response>")).skip(1) {
        let block_end = block.find("</response>").or_else(|| block.find("</d:response>")).unwrap_or(block.len());
        let chunk = &block[..block_end];

        let href = extract_tag_value(chunk, "href").or_else(|| extract_tag_value(chunk, "d:href"));
        let length_str = extract_tag_value(chunk, "getcontentlength")
            .or_else(|| extract_tag_value(chunk, "d:getcontentlength"))
            .unwrap_or_default();
        let size_bytes: u64 = length_str.trim().parse().unwrap_or(0);

        if let Some(href_val) = href {
            // Find files ending in .tar.gz
            if href_val.ends_with(".tar.gz") {
                let file_name = href_val.rsplit('/').next().unwrap_or(&href_val);
                let backup_id = file_name.trim_end_matches(".tar.gz").to_string();

                let timestamp: u64 = backup_id.parse().unwrap_or(0);

                let days = timestamp / 86400;
                let rem = timestamp % 86400;
                let hours = rem / 3600;
                let minutes = (rem % 3600) / 60;
                let approx_year = 1970 + days / 365;
                let formatted_date = format!("{approx_year:04} ({hours:02}:{minutes:02} UTC)");

                let full_url = if href_val.starts_with("http") {
                    href_val
                } else {
                    format!("{}{}", base_url.trim_end_matches('/'), href_val)
                };

                list.push(CloudBackupEntry {
                    backup_id,
                    app_name: app_name.to_string(),
                    timestamp,
                    formatted_date,
                    size_bytes,
                    file_count: 0,
                    sha256: String::new(),
                    provider: "webdav".to_string(),
                    remote_id: full_url,
                });
            }
        }
    }

    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    list
}

fn extract_tag_value<'a>(haystack: &'a str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = haystack.find(&open)? + open.len();
    let end = haystack[start..].find(&close)? + start;
    Some(haystack[start..end].trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_tag_value() {
        let xml = "<d:response><d:href>/remote.php/webdav/efxlve_saves/game1/1700000000.tar.gz</d:href><d:propstat><d:prop><d:getcontentlength>12345</d:getcontentlength></d:prop></d:propstat></d:response>";
        let href = extract_tag_value(xml, "d:href");
        assert_eq!(href.unwrap(), "/remote.php/webdav/efxlve_saves/game1/1700000000.tar.gz");

        let len = extract_tag_value(xml, "d:getcontentlength");
        assert_eq!(len.unwrap(), "12345");
    }

    #[test]
    fn test_parse_propfind_xml() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/efxlve_saves/Cyberpunk2077/</d:href>
  </d:response>
  <d:response>
    <d:href>/efxlve_saves/Cyberpunk2077/1710000000.tar.gz</d:href>
    <d:propstat>
      <d:prop>
        <d:getcontentlength>54321</d:getcontentlength>
      </d:prop>
    </d:propstat>
  </d:response>
</d:multistatus>"#;

        let items = parse_propfind_xml(xml, "Cyberpunk2077", "https://cloud.example.com/");
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].backup_id, "1710000000");
        assert_eq!(items[0].size_bytes, 54321);
    }
}
