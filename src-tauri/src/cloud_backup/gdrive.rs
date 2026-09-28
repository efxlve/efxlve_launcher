//! Google Drive integration for save backups (REST API v3 & AppData folder).

use std::path::Path;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use crate::cloud_backup::models::CloudBackupEntry;

pub const GDRIVE_OAUTH_PORT: u16 = 54123;
pub const GDRIVE_REDIRECT_URI: &str = "http://127.0.0.1:54123/oauth/callback";
pub const GDRIVE_DEFAULT_CLIENT_ID: &str = "982937084531-h0d2lfl5m2kmhvh128vcrb1pceekj9ep.apps.googleusercontent.com";

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

/// Generates the Google OAuth2 authorization URL for the user to visit.
pub fn generate_auth_url(client_id: &str) -> String {
    let scope = "https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.appdata%20https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fuserinfo.email";
    format!(
        "https://accounts.google.com/o/oauth2/v2/auth?client_id={}&redirect_uri={}&response_type=code&scope={}&access_type=offline&prompt=consent",
        client_id,
        GDRIVE_REDIRECT_URI,
        scope,
    )
}

/// Listens on loopback port 54123 for Google's OAuth2 redirect callback and returns the auth code.
pub async fn listen_for_auth_code() -> Result<String, String> {
    let addr = format!("127.0.0.1:{GDRIVE_OAUTH_PORT}");
    let listener = TcpListener::bind(&addr)
        .await
        .map_err(|e| format!("Failed to bind local OAuth listener on {addr}: {e}"))?;

    // Wait for incoming HTTP request
    let (mut stream, _) = listener.accept().await.map_err(|e| e.to_string())?;

    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let req = String::from_utf8_lossy(&buf[..n]);

    let html_success = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\n\r\n<!DOCTYPE html><html><body style=\"background:#0b0b0b;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:90vh\"><div style=\"text-align:center\"><h2 style=\"color:#fff;margin-bottom:8px\">Efxlve Launcher</h2><p style=\"color:#a0a0a0\">Google Drive connection successful! You can close this browser tab.</p></div></body></html>";
    let _ = stream.write_all(html_success.as_bytes()).await;
    let _ = stream.flush().await;

    // Extract `code=` parameter from query string
    if let Some(code_start) = req.find("code=") {
        let after = &req[code_start + 5..];
        let code_end = after.find(['&', ' ']).unwrap_or(after.len());
        let code = &after[..code_end];
        return Ok(code.to_string());
    }

    if req.contains("error=") {
        return Err("Authorization was cancelled or rejected by the user.".to_string());
    }

    Err("Invalid callback request received from browser.".to_string())
}

/// Exchanges authorization code for refresh and access tokens.
pub async fn exchange_code_for_tokens(
    client: &Client,
    client_id: &str,
    code: &str,
) -> Result<(String, String, Option<String>), String> {
    let params = [
        ("code", code),
        ("client_id", client_id),
        ("redirect_uri", GDRIVE_REDIRECT_URI),
        ("grant_type", "authorization_code"),
    ];

    let res = client
        .post("https://oauth2.googleapis.com/token")
        .form(&params)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let token_resp: TokenResponse = res.json().await.map_err(|e| e.to_string())?;

    if let Some(err) = token_resp.error {
        let desc = token_resp.error_description.unwrap_or_default();
        return Err(format!("Token exchange failed: {err} ({desc})"));
    }

    let access = token_resp.access_token.ok_or_else(|| "Missing access token in response".to_string())?;
    let refresh = token_resp.refresh_token.ok_or_else(|| "Missing refresh token in response".to_string())?;

    // Fetch user email for display
    let email = fetch_user_email(client, &access).await.ok();

    Ok((access, refresh, email))
}

/// Gets a fresh access token using a stored refresh token.
pub async fn refresh_access_token(client: &Client, client_id: &str, refresh_token: &str) -> Result<String, String> {
    let params = [
        ("client_id", client_id),
        ("refresh_token", refresh_token),
        ("grant_type", "refresh_token"),
    ];

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
    info.email.ok_or_else(|| "Email address not found".to_string())
}

/// Uploads a backup archive directly to Google Drive's hidden `appDataFolder`.
pub async fn upload_backup_gdrive(
    client: &Client,
    access_token: &str,
    app_name: &str,
    backup_id: &str,
    local_archive_path: &Path,
) -> Result<String, String> {
    let file_bytes = tokio::fs::read(local_archive_path)
        .await
        .map_err(|e| format!("Could not read local archive: {e}"))?;

    let filename = format!("{app_name}_{backup_id}.tar.gz");

    let metadata = serde_json::json!({
        "name": filename,
        "parents": ["appDataFolder"],
        "appProperties": {
            "efxlve_game": app_name,
            "backup_id": backup_id,
        }
    });

    let boundary = "-------EfxlveBoundary7MA4YWxkTrZu0gW";
    let delimiter = format!("\r\n--{boundary}\r\n");
    let close_delimiter = format!("\r\n--{boundary}--\r\n");

    let mut body = Vec::new();
    body.extend_from_slice(delimiter.as_bytes());
    body.extend_from_slice(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend_from_slice(metadata.to_string().as_bytes());
    body.extend_from_slice(delimiter.as_bytes());
    body.extend_from_slice(b"Content-Type: application/gzip\r\n\r\n");
    body.extend_from_slice(&file_bytes);
    body.extend_from_slice(close_delimiter.as_bytes());

    let res = client
        .post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart")
        .bearer_auth(access_token)
        .header("Content-Type", format!("multipart/related; boundary={boundary}"))
        .body(body)
        .send()
        .await
        .map_err(|e| format!("Upload request failed: {e}"))?;

    if !res.status().is_success() {
        let err_txt = res.text().await.unwrap_or_default();
        return Err(format!("Google Drive upload rejected: {err_txt}"));
    }

    let created: serde_json::Value = res.json().await.map_err(|e| e.to_string())?;
    let file_id = created.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();

    Ok(file_id)
}

/// Lists all save backup archives for a specific game in Google Drive `appDataFolder`.
pub async fn list_gdrive_backups(
    client: &Client,
    access_token: &str,
    app_name: &str,
) -> Result<Vec<CloudBackupEntry>, String> {
    let q = format!("appProperties has {{ key='efxlve_game' and value='{app_name}' }} and trashed = false");
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
pub async fn delete_backup_gdrive(client: &Client, access_token: &str, file_id: &str) -> Result<(), String> {
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
