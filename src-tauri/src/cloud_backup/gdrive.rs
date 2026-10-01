//! Google Drive integration for save backups (REST API v3 & AppData folder).

use std::net::{Ipv4Addr, SocketAddr};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use crate::cloud_backup::models::CloudBackupEntry;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpSocket;

pub const GDRIVE_OAUTH_PORT: u16 = 54123;
pub const GDRIVE_REDIRECT_URI: &str = "http://127.0.0.1:54123/oauth/callback";
pub const GDRIVE_DEFAULT_CLIENT_ID: &str = "";
pub const GDRIVE_DEFAULT_CLIENT_SECRET: &str = "";

#[derive(Debug, Clone, Serialize, Deserialize)]
struct TokenResponse {
    access_token: Option<String>,
    refresh_token: Option<String>,
    expires_in: Option<u64>,
    token_type: Option<String>,
    error: Option<String>,
    error_description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UserInfoResponse {
    email: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DriveFileList {
    files: Option<Vec<DriveFileItem>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DriveFileItem {
    pub id: String,
    pub name: String,
    pub size: Option<String>,
    #[serde(rename = "createdTime")]
    pub created_time: Option<String>,
    #[serde(rename = "appProperties")]
    pub app_properties: Option<std::collections::HashMap<String, String>>,
}

/// Generates a PKCE code_verifier and code_challenge (RFC 7636).
pub fn generate_pkce() -> (String, String) {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(&bytes);
    let mut hasher = Sha256::new();
    hasher.update(verifier.as_bytes());
    let challenge = URL_SAFE_NO_PAD.encode(hasher.finalize());
    (verifier, challenge)
}

/// Generates the Google OAuth2 authorization URL with PKCE for the user to visit.
pub fn generate_auth_url(client_id: &str, code_challenge: &str) -> String {
    let scope = "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.appdata%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email";
    format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent&code_challenge={}&code_challenge_method=S256",
        client_id,
        GDRIVE_REDIRECT_URI,
        scope,
        code_challenge,
    )
}

/// Listens on loopback port 54123 for Google's OAuth2 redirect callback and returns the auth code.
pub async fn listen_for_auth_code() -> Result<String, String> {
    static IN_FLIGHT: AtomicBool = AtomicBool::new(false);
    if IN_FLIGHT.swap(true, Ordering::SeqCst) {
        return Err(
            "Google sign-in is already waiting in the browser. Finish that window first."
                .to_string(),
        );
    }
    struct Guard;
    impl Drop for Guard {
        fn drop(&mut self) {
            IN_FLIGHT.store(false, Ordering::SeqCst);
        }
    }
    let _guard = Guard;

    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, GDRIVE_OAUTH_PORT));
    let listener = bind_oauth_listener(addr).await?;

    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(120), listener.accept())
        .await
        .map_err(|_| "Google sign-in timed out. Try Connect with Google again.".to_string())?
        .map_err(|e| e.to_string())?;

    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);

    let html_success = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!DOCTYPE html><html><body style=\"background:#000000;color:#ffffff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:90vh\"><div style=\"text-align:center\"><h2 style=\"color:#ffffff;margin-bottom:8px\">Efxlve Launcher</h2><p style=\"color:#888888\">Google Drive connection successful! You can close this browser tab.</p></div></body></html>";
    let _ = stream.write_all(html_success.as_bytes()).await;
    let _ = stream.flush().await;

    // Extract query string from request line (e.g. "GET /oauth/callback?code=... HTTP/1.1")
    let first_line = req.lines().next().unwrap_or_default();
    let query_str = first_line
        .split_whitespace()
        .nth(1)
        .and_then(|p| p.split_once('?'))
        .map(|(_, q)| q)
        .unwrap_or_default();

    let mut auth_code = None;
    let mut auth_error = None;
    for (k, v) in url::form_urlencoded::parse(query_str.as_bytes()) {
        if k == "code" {
            auth_code = Some(v.into_owned());
        } else if k == "error" {
            auth_error = Some(v.into_owned());
        }
    }

    if let Some(err) = auth_error {
        if err == "invalid_client" {
            return Err(
                "Google OAuth client was not found. The Desktop client ID is missing or revoked."
                    .to_string(),
            );
        }
        return Err(format!(
            "Authorization was cancelled or rejected by Google: {err}"
        ));
    }

    if let Some(code) = auth_code {
        return Ok(code);
    }

    Err("Invalid callback request received from browser (no code).".to_string())
}

async fn bind_oauth_listener(addr: SocketAddr) -> Result<tokio::net::TcpListener, String> {
    let mut last_err = String::new();
    for attempt in 0..5 {
        let socket = TcpSocket::new_v4().map_err(|e| e.to_string())?;
        let _ = socket.set_reuseaddr(true);
        match socket.bind(addr) {
            Ok(()) => {
                return socket
                    .listen(8)
                    .map_err(|e| format!("Failed to bind local OAuth listener on {addr}: {e}"));
            }
            Err(e) => {
                last_err = e.to_string();
                if attempt < 4 {
                    tokio::time::sleep(Duration::from_millis(150 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(format!(
        "Failed to bind local OAuth listener on {addr}: {last_err}. Close the previous Google sign-in tab and try again."
    ))
}

/// Exchanges authorization code for refresh and access tokens.
pub async fn exchange_code_for_tokens(
    client: &Client,
    client_id: &str,
    client_secret: Option<&str>,
    code: &str,
    code_verifier: Option<&str>,
) -> Result<(String, String, Option<String>), String> {
    let mut params = vec![
        ("code", code.to_string()),
        ("client_id", client_id.to_string()),
        ("redirect_uri", GDRIVE_REDIRECT_URI.to_string()),
        ("grant_type", "authorization_code".to_string()),
    ];

    if let Some(secret) = client_secret.filter(|s| !s.trim().is_empty()) {
        params.push(("client_secret", secret.to_string()));
    }
    if let Some(verifier) = code_verifier.filter(|v| !v.trim().is_empty()) {
        params.push(("code_verifier", verifier.to_string()));
    }

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| format!("Failed to connect to Google token endpoint: {e}"))?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;

    let token_resp: TokenResponse = serde_json::from_str(&text).map_err(|e| {
        format!("Failed to parse Google response (HTTP {status}): {e} (body: {text})")
    })?;

    if let Some(err) = token_resp.error {
        let desc = token_resp.error_description.unwrap_or_default();
        if err == "invalid_client" {
            return Err("Google OAuth client was not found or is not a Desktop app. The stored client ID is missing or revoked.".to_string());
        }
        return Err(format!(
            "Google token exchange failed ({status}): {err} ({desc})"
        ));
    }

    let access = token_resp
        .access_token
        .ok_or_else(|| "Missing access token in response".to_string())?;
    let refresh = token_resp
        .refresh_token
        .ok_or_else(|| "Missing refresh token in response".to_string())?;

    // Fetch user email for display
    let email = fetch_user_email(client, &access).await.ok();

    Ok((access, refresh, email))
}

/// Gets a fresh access token using a stored refresh token.
pub async fn refresh_access_token(
    client: &Client,
    client_id: &str,
    client_secret: Option<&str>,
    refresh_token: &str,
) -> Result<String, String> {
    let mut params = vec![
        ("client_id", client_id.to_string()),
        ("refresh_token", refresh_token.to_string()),
        ("grant_type", "refresh_token".to_string()),
    ];

    if let Some(secret) = client_secret.filter(|s| !s.trim().is_empty()) {
        params.push(("client_secret", secret.to_string()));
    }

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let token_resp: TokenResponse = res.json().await.map_err(|e| e.to_string())?;
    if let Some(err) = token_resp.error {
        return Err(format!("Token refresh failed: {err}"));
    }

    token_resp
        .access_token
        .ok_or_else(|| "Failed to refresh access token".to_string())
}

/// Fetches the user's Google account email.
pub async fn fetch_user_email(client: &Client, access_token: &str) -> Result<String, String> {
    let res = client
        .get("https://www.googleapis.com/oauth2/v2/userinfo")
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let info: UserInfoResponse = res.json().await.map_err(|e| e.to_string())?;
    info.email
        .ok_or_else(|| "Email address not found".to_string())
}

/// Uploads a backup archive directly to Google Drive's hidden `appDataFolder` using Resumable Upload.
pub async fn upload_backup_gdrive(
    client: &Client,
    access_token: &str,
    app_name: &str,
    backup_id: &str,
    local_archive_path: &Path,
) -> Result<String, String> {
    let file_metadata = tokio::fs::metadata(local_archive_path)
        .await
        .map_err(|e| format!("Could not read local archive metadata: {e}"))?;
    let file_len = file_metadata.len();

    let filename = format!("{app_name}_{backup_id}.tar.gz");

    let metadata = serde_json::json!({
        "name": filename,
        "parents": ["appDataFolder"],
        "appProperties": {
            "efxlve_game": app_name,
            "backup_id": backup_id,
        }
    });

    // 1. Initiate resumable upload session
    let init_res = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable")
        .bearer_auth(access_token)
        .header("X-Upload-Content-Type", "application/gzip")
        .header("X-Upload-Content-Length", file_len.to_string())
        .json(&metadata)
        .send()
        .await
        .map_err(|e| format!("Failed to initiate Google Drive upload session: {e}"))?;

    if !init_res.status().is_success() {
        let status = init_res.status();
        let err_txt = init_res.text().await.unwrap_or_default();
        return Err(format!(
            "Google Drive upload session rejected (HTTP {status}): {err_txt}"
        ));
    }

    let upload_url = init_res
        .headers()
        .get("Location")
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| "Google Drive did not return upload Location header".to_string())?
        .to_string();

    // 2. Upload file bytes directly
    let file_bytes = tokio::fs::read(local_archive_path)
        .await
        .map_err(|e| format!("Could not read local archive bytes: {e}"))?;

    let upload_res = client
        .put(&upload_url)
        .header("Content-Length", file_len.to_string())
        .header("Content-Type", "application/gzip")
        .body(file_bytes)
        .send()
        .await
        .map_err(|e| format!("Google Drive file upload failed: {e}"))?;

    if !upload_res.status().is_success() {
        let status = upload_res.status();
        let err_txt = upload_res.text().await.unwrap_or_default();
        return Err(format!(
            "Google Drive file upload rejected (HTTP {status}): {err_txt}"
        ));
    }

    let created: serde_json::Value = upload_res.json().await.map_err(|e| e.to_string())?;
    let file_id = created
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    Ok(file_id)
}

/// Lists all save backup archives for a specific game in Google Drive `appDataFolder`.
pub async fn list_gdrive_backups(
    client: &Client,
    access_token: &str,
    app_name: &str,
) -> Result<Vec<CloudBackupEntry>, String> {
    let q = format!(
        "appProperties has {{ key='efxlve_game' and value='{app_name}' }} and trashed = false"
    );
    let res = client
        .get("https://www.googleapis.com/drive/v3/files")
        .bearer_auth(access_token)
        .query(&[
            ("spaces", "appDataFolder"),
            ("q", &q),
            ("fields", "files(id,name,size,createdTime,appProperties)"),
        ])
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !res.status().is_success() {
        return Err(format!("Drive API query failed: HTTP {}", res.status()));
    }

    let data: DriveFileList = res.json().await.map_err(|e| e.to_string())?;
    let files = data.files.unwrap_or_default();

    let mut list = Vec::new();
    for f in files {
        let backup_id = f
            .app_properties
            .as_ref()
            .and_then(|m| m.get("backup_id"))
            .cloned()
            .unwrap_or_else(|| {
                f.name
                    .trim_start_matches(&format!("{app_name}_"))
                    .trim_end_matches(".tar.gz")
                    .to_string()
            });

        let timestamp: u64 = backup_id.parse().unwrap_or(0);
        let size_bytes: u64 = f.size.as_deref().and_then(|s| s.parse().ok()).unwrap_or(0);

        let days = timestamp / 86400;
        let rem = timestamp % 86400;
        let hours = rem / 3600;
        let minutes = (rem % 3600) / 60;
        let approx_year = 1970 + days / 365;
        let formatted_date = format!("{approx_year:04} ({hours:02}:{minutes:02} UTC)");

        list.push(CloudBackupEntry {
            backup_id,
            app_name: app_name.to_string(),
            timestamp,
            formatted_date,
            size_bytes,
            file_count: 0,
            sha256: String::new(),
            provider: "google_drive".to_string(),
            remote_id: f.id,
        });
    }

    list.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(list)
}

/// Downloads a backup archive from Google Drive by its file ID.
pub async fn download_backup_gdrive(
    client: &Client,
    access_token: &str,
    file_id: &str,
    local_dest: &Path,
) -> Result<(), String> {
    if let Some(parent) = local_dest.parent() {
        let _ = tokio::fs::create_dir_all(parent).await;
    }

    let url = format!("https://www.googleapis.com/drive/v3/files/{file_id}?alt=media");
    let res = client
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| format!("Download request failed: {e}"))?;

    if !res.status().is_success() {
        return Err(format!("Download failed: HTTP {}", res.status()));
    }

    let bytes = res.bytes().await.map_err(|e| e.to_string())?;
    tokio::fs::write(local_dest, bytes)
        .await
        .map_err(|e| format!("Failed to write downloaded archive: {e}"))?;

    Ok(())
}

/// Deletes a file on Google Drive.
pub async fn delete_backup_gdrive(
    client: &Client,
    access_token: &str,
    file_id: &str,
) -> Result<(), String> {
    let url = format!("https://www.googleapis.com/drive/v3/files/{file_id}");
    let res = client
        .delete(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if res.status().is_success() || res.status() == reqwest::StatusCode::NOT_FOUND {
        Ok(())
    } else {
        Err(format!("Delete failed: HTTP {}", res.status()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_pkce_valid() {
        let (verifier, challenge) = generate_pkce();
        assert!(!verifier.is_empty());
        assert!(!challenge.is_empty());
        assert_ne!(verifier, challenge);
        assert!(!verifier.contains('='));
        assert!(!challenge.contains('='));
    }

    #[test]
    fn test_generate_auth_url_contains_pkce_and_client_id() {
        let url = generate_auth_url("test_client_id_123", "test_challenge_abc");
        assert!(url.contains("client_id=test_client_id_123"));
        assert!(url.contains("code_challenge=test_challenge_abc"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("redirect_uri="));
    }

    #[test]
    fn test_parse_auth_code_from_query() {
        let req = "GET /oauth/callback?code=4%2F0Adw123xyz&scope=email HTTP/1.1\r\nHost: 127.0.0.1:54123\r\n";
        let first_line = req.lines().next().unwrap_or_default();
        let query_str = first_line
            .split_whitespace()
            .nth(1)
            .and_then(|p| p.split_once('?'))
            .map(|(_, q)| q)
            .unwrap_or_default();

        let mut auth_code = None;
        for (k, v) in url::form_urlencoded::parse(query_str.as_bytes()) {
            if k == "code" {
                auth_code = Some(v.into_owned());
            }
        }
        assert_eq!(auth_code, Some("4/0Adw123xyz".to_string()));
    }
}
