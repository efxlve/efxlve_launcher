//! WebDAV client for Nextcloud, ownCloud, Box, pCloud, and custom WebDAV servers.

use crate::cloud_backup::models::CloudBackupEntry;
use crate::legendary::backup::{backup_key, format_backup_timestamp};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use md5::{Digest, Md5};
use reqwest::{Client, Method, Response, StatusCode};
use std::path::Path;

fn basic_auth_header(user: &str, pass: &str) -> String {
    format!("Basic {}", BASE64.encode(format!("{user}:{pass}")))
}

fn md5_hex(input: &str) -> String {
    format!("{:x}", Md5::digest(input.as_bytes()))
}

/// Request URI (path and query) used by the digest response.
fn digest_uri(url: &str) -> String {
    let Ok(parsed) = reqwest::Url::parse(url) else {
        return "/".to_string();
    };
    let mut uri = parsed.path().to_string();
    if let Some(query) = parsed.query() {
        uri.push('?');
        uri.push_str(query);
    }
    uri
}

fn escape_digest(value: &str) -> String {
    value.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Splits a digest challenge without breaking on a comma inside quotes.
fn digest_params(input: &str) -> Vec<(String, String)> {
    let text = input.trim();
    let text = text.split_once(' ').map(|(_, rest)| rest).unwrap_or(text);
    let chars: Vec<char> = text.chars().collect();
    let mut params = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        while index < chars.len() && (chars[index] == ',' || chars[index].is_whitespace()) {
            index += 1;
        }
        let name_start = index;
        while index < chars.len() && chars[index] != '=' {
            index += 1;
        }
        if index >= chars.len() {
            break;
        }
        let name: String = chars[name_start..index].iter().collect();
        index += 1; // '='
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        let mut value = String::new();
        if index < chars.len() && chars[index] == '"' {
            index += 1;
            while index < chars.len() {
                let ch = chars[index];
                if ch == '\\' && index + 1 < chars.len() {
                    value.push(chars[index + 1]);
                    index += 2;
                    continue;
                }
                if ch == '"' {
                    index += 1;
                    break;
                }
                value.push(ch);
                index += 1;
            }
        } else {
            while index < chars.len() && chars[index] != ',' {
                value.push(chars[index]);
                index += 1;
            }
        }
        if !name.trim().is_empty() {
            params.push((name.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    params
}

fn digest_header(
    challenge: &str,
    method: &str,
    uri: &str,
    user: &str,
    pass: &str,
    cnonce: &str,
) -> Option<String> {
    let params = digest_params(challenge);
    let get = |name: &str| {
        params
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let realm = get("realm")?;
    let nonce = get("nonce")?;
    let algorithm = get("algorithm").unwrap_or("MD5");
    let qop = get("qop").and_then(|value| {
        value
            .split(',')
            .map(str::trim)
            .find(|item| item.eq_ignore_ascii_case("auth"))
    });

    let ha1 = md5_hex(&format!("{user}:{realm}:{pass}"));
    let ha1 = if algorithm.eq_ignore_ascii_case("MD5-sess") {
        md5_hex(&format!("{ha1}:{nonce}:{cnonce}"))
    } else {
        ha1
    };
    let ha2 = md5_hex(&format!("{method}:{uri}"));
    let nc = "00000001";
    let response = match qop {
        Some(qop) => md5_hex(&format!("{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}")),
        None => md5_hex(&format!("{ha1}:{nonce}:{ha2}")),
    };

    let mut header = format!(
        "Digest username=\"{}\", realm=\"{}\", nonce=\"{}\", uri=\"{}\", response=\"{}\"",
        escape_digest(user),
        escape_digest(realm),
        escape_digest(nonce),
        escape_digest(uri),
        response
    );
    if let Some(qop) = qop {
        header.push_str(&format!(
            ", qop={qop}, nc={nc}, cnonce=\"{}\"",
            escape_digest(cnonce)
        ));
    }
    if !algorithm.is_empty() {
        header.push_str(&format!(
            ", algorithm={}",
            if algorithm.eq_ignore_ascii_case("MD5-sess") {
                "MD5-sess"
            } else {
                "MD5"
            }
        ));
    }
    if let Some(opaque) = get("opaque") {
        header.push_str(&format!(", opaque=\"{}\"", escape_digest(opaque)));
    }
    Some(header)
}

/// Sends a request with basic auth and retries once when the server asks for
/// digest auth. Basic auth remains the first attempt so existing servers keep
/// their old behavior.
async fn send_webdav(
    client: &Client,
    method: &Method,
    url: &str,
    user: &str,
    pass: &str,
    body: Option<&[u8]>,
    content_type: Option<&str>,
    depth: Option<&str>,
    extra_headers: &[(&str, String)],
) -> Result<Response, String> {
    let build = |auth: Option<String>| {
        let mut request = client.request(method.clone(), url);
        if let Some(auth) = auth {
            request = request.header("Authorization", auth);
        }
        if let Some(body) = body {
            request = request.body(body.to_vec());
        }
        if let Some(content_type) = content_type {
            request = request.header("Content-Type", content_type);
        }
        if let Some(depth) = depth {
            request = request.header("Depth", depth);
        }
        for (name, value) in extra_headers {
            request = request.header(*name, value);
        }
        request
    };

    let response = build(Some(basic_auth_header(user, pass)))
        .send()
        .await
        .map_err(|error| format!("Network connection failed: {error}"))?;
    if response.status() != StatusCode::UNAUTHORIZED {
        return Ok(response);
    }

    let challenge = response
        .headers()
        .get_all(reqwest::header::WWW_AUTHENTICATE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|value| value.to_ascii_lowercase().starts_with("digest "))
        .map(str::to_string);
    let Some(challenge) = challenge else {
        return Ok(response);
    };
    let cnonce = format!("{:016x}", rand::random::<u64>());
    let Some(header) = digest_header(
        &challenge,
        method.as_str(),
        &digest_uri(url),
        user,
        pass,
        &cnonce,
    ) else {
        return Ok(response);
    };

    build(Some(header))
        .send()
        .await
        .map_err(|error| format!("Digest authentication request failed: {error}"))
}

#[cfg(test)]
mod digest_tests {
    use super::*;

    #[test]
    fn rfc_example_digest_response() {
        let challenge = "Digest realm=\"testrealm@host.com\", qop=\"auth,auth-int\", nonce=\"dcd98b7102dd2f0e8b11d0f600bfb0c093\", opaque=\"5ccc069c403ebaf9f0171e9517f40e41\"";
        let header = digest_header(
            challenge,
            "GET",
            "/dir/index.html",
            "Mufasa",
            "Circle Of Life",
            "0a4f113b",
        )
        .unwrap();
        assert!(header.contains("response=\"6629fae49393a05397450978507c4ef1\""), "{header}");
        assert!(header.contains("qop=auth"));
        assert!(header.contains("opaque=\"5ccc069c403ebaf9f0171e9517f40e41\""));
    }

    #[test]
    fn quoted_commas_do_not_split_params() {
        let params = digest_params("Digest realm=\"a,b\", nonce=\"c\"");
        assert_eq!(params[0], ("realm".to_string(), "a,b".to_string()));
        assert_eq!(params[1], ("nonce".to_string(), "c".to_string()));
    }
}


fn clean_base_url(url: &str) -> String {
    let mut u = url.trim().to_string();
    if !u.ends_with('/') {
        u.push('/');
    }
    u
}

/// Tests connectivity and credentials against a WebDAV server.
/// Moves a collection created under the old raw game key (gog::123) to the
/// safe key (gog__123). Missing legacy collections and an existing target are
/// not errors; the caller carries on with the safe path.
pub async fn migrate_legacy_collection(
    client: &Client,
    base_url: &str,
    user: &str,
    pass: &str,
    app_name: &str,
) -> Result<(), String> {
    let safe = backup_key(app_name);
    if safe == app_name {
        return Ok(());
    }
    let clean = clean_base_url(base_url);
    let source = format!("{clean}efxlve_saves/{app_name}/");
    let destination = format!("{clean}efxlve_saves/{safe}/");
    let method = Method::from_bytes(b"MOVE").map_err(|error| error.to_string())?;
    let headers = [
        ("Destination", destination),
        ("Overwrite", "F".to_string()),
    ];
    let response = send_webdav(
        client,
        &method,
        &source,
        user,
        pass,
        None,
        None,
        None,
        &headers,
    )
    .await?;
    match response.status() {
        StatusCode::CREATED
        | StatusCode::NO_CONTENT
        | StatusCode::NOT_FOUND
        | StatusCode::CONFLICT
        | StatusCode::PRECONDITION_FAILED
        | StatusCode::METHOD_NOT_ALLOWED => Ok(()),
        status if status.is_success() => Ok(()),
        status => Err(format!("Legacy WebDAV folder could not be moved: {status}")),
    }
}

pub async fn test_webdav_connection(
    client: &Client,
    url: &str,
    user: &str,
    pass: &str,
) -> Result<String, String> {
    let clean = clean_base_url(url);
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;

    let res = send_webdav(
        client,
        &propfind,
        &clean,
        user,
        pass,
        None,
        None,
        Some("0"),
        &[],
    )
    .await?;

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
pub async fn ensure_remote_collection(
    client: &Client,
    url: &str,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let clean = clean_base_url(url);
    let mkcol = Method::from_bytes(b"MKCOL").map_err(|e| e.to_string())?;

    let res = send_webdav(client, &mkcol, &clean, user, pass, None, None, None, &[])
        .await
        .map_err(|error| error.to_string())?;

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

    let res = send_webdav(
        client,
        &Method::PUT,
        target_url,
        user,
        pass,
        Some(&bytes),
        Some("application/gzip"),
        None,
        &[],
    )
    .await
    .map_err(|error| format!("Upload failed: {error}"))?;

    if res.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "Server rejected upload with HTTP status: {}",
            res.status()
        ))
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

    let res = send_webdav(
        client,
        &Method::GET,
        remote_url,
        user,
        pass,
        None,
        None,
        None,
        &[],
    )
    .await
    .map_err(|error| format!("Download request failed: {error}"))?;

    if !res.status().is_success() {
        return Err(format!(
            "Download failed with HTTP status: {}",
            res.status()
        ));
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(local_dest, bytes)
        .await
        .map_err(|e| format!("Failed to save downloaded file: {e}"))?;

    Ok(())
}

/// Deletes a file on WebDAV via DELETE.
pub async fn delete_file_webdav(
    client: &Client,
    remote_url: &str,
    user: &str,
    pass: &str,
) -> Result<(), String> {
    let res = send_webdav(
        client,
        &Method::DELETE,
        remote_url,
        user,
        pass,
        None,
        None,
        None,
        &[],
    )
    .await
    .map_err(|error| format!("Delete request failed: {error}"))?;

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
    migrate_legacy_collection(client, base_url, user, pass, app_name).await?;
    let clean = clean_base_url(base_url);
    let target = format!("{clean}efxlve_saves/{}/", backup_key(app_name));
    let propfind = Method::from_bytes(b"PROPFIND").map_err(|e| e.to_string())?;

    let res = send_webdav(
        client,
        &propfind,
        &target,
        user,
        pass,
        None,
        None,
        Some("1"),
        &[],
    )
    .await
    .map_err(|error| error.to_string())?;

    if res.status() == StatusCode::NOT_FOUND {
        return Ok(Vec::new());
    }

    if !res.status().is_success() && res.status() != StatusCode::MULTI_STATUS {
        return Err(format!(
            "Failed to list remote backups: HTTP {}",
            res.status()
        ));
    }

    let text = res.text().await.unwrap_or_default();
    let entries = parse_propfind_xml(&text, app_name, &clean);
    Ok(entries)
}

/// Lightweight parser for WebDAV PROPFIND responses without external heavy XML crate.
fn parse_propfind_xml(xml: &str, app_name: &str, base_url: &str) -> Vec<CloudBackupEntry> {
    let mut list = Vec::new();

    // Iterate over each <response> or <d:response> block
    for block in xml
        .split("<response>")
        .chain(xml.split("<d:response>"))
        .skip(1)
    {
        let block_end = block
            .find("</response>")
            .or_else(|| block.find("</d:response>"))
            .unwrap_or(block.len());
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
                let formatted_date = format_backup_timestamp(timestamp);

                let full_url = if href_val.starts_with("http") {
                    href_val
                } else if let Ok(base) = url::Url::parse(base_url) {
                    base.join(&href_val)
                        .map(|url| url.to_string())
                        .unwrap_or_else(|_| format!("{base_url}{href_val}"))
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
        assert_eq!(
            href.unwrap(),
            "/remote.php/webdav/efxlve_saves/game1/1700000000.tar.gz"
        );

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
        assert_eq!(
            items[0].remote_id,
            "https://cloud.example.com/efxlve_saves/Cyberpunk2077/1710000000.tar.gz"
        );
    }

    #[test]
    fn nextcloud_absolute_hrefs_do_not_repeat_the_base_path() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:">
  <d:response>
    <d:href>/remote.php/dav/files/user/efxlve_saves/gog__123/1710000000.tar.gz</d:href>
    <d:propstat><d:prop><d:getcontentlength>7</d:getcontentlength></d:prop></d:propstat>
  </d:response>
</d:multistatus>"#;
        let items = parse_propfind_xml(
            xml,
            "gog::123",
            "https://cloud.example.com/remote.php/dav/files/user/",
        );
        assert_eq!(
            items[0].remote_id,
            "https://cloud.example.com/remote.php/dav/files/user/efxlve_saves/gog__123/1710000000.tar.gz"
        );
    }
}
