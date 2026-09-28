//! Live Epic presence through the user's own EOS product — REST only, no SDK.
//!
//! The official launcher reads friends' live presence with the EOS SDK (its own
//! internal credentials). The same data can be reached without the SDK:
//!
//! 1. The stored legendary session yields a one-time exchange code
//!    (`account/api/oauth/exchange`).
//! 2. The exchange code plus the product's EOS client credentials produce an
//!    EOS user token with the `presence` scope
//!    (`api.epicgames.dev/epic/oauth/v2/token`).
//! 3. That token can read the launcher presence service
//!    (`presence-public-service.../presence/api/v1/_/{id}/friends/presence`),
//!    which returns the live online state of every friend.
//!
//! Credentials and tokens live under `<app_data>/eos/` and never leave the
//! machine. Everything here is best effort: a failure never blocks the launcher.

use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::legendary::friends::read_session;

const EXCHANGE_URL: &str =
    "https://account-public-service-prod.ol.epicgames.com/account/api/oauth/exchange";
const TOKEN_URL: &str = "https://api.epicgames.dev/epic/oauth/v2/token";
const PRESENCE_URL: &str =
    "https://presence-public-service-prod.ol.epicgames.com/presence/api/v1";
/// Epic Account Services scopes the launcher needs: profile, friends, presence.
const EOS_SCOPE: &str = "basic_profile friends_list presence";
/// Refresh the token this many seconds before it expires.
const TOKEN_MARGIN_SECS: i64 = 120;

/// EOS client credentials copied from the Epic Dev Portal (Product Settings).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EosCredentials {
    pub product_id: String,
    pub sandbox_id: String,
    pub deployment_id: String,
    pub client_id: String,
    pub client_secret: String,
}

impl EosCredentials {
    /// All five fields must be present before the flow can run.
    fn is_complete(&self) -> bool {
        !self.client_id.trim().is_empty()
            && !self.client_secret.trim().is_empty()
            && !self.deployment_id.trim().is_empty()
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EosToken {
    pub access_token: String,
    pub refresh_token: String,
    pub account_id: String,
    pub scope: String,
    /// Unix seconds; refresh happens a couple of minutes early.
    pub expires_at: i64,
}

impl EosToken {
    fn is_fresh(&self) -> bool {
        self.expires_at - TOKEN_MARGIN_SECS > now_secs()
    }
}

/// Connection state reported to the settings card.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EosStatus {
    pub configured: bool,
    pub connected: bool,
    pub account_id: String,
    pub scope: String,
}

fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn eos_dir(app: &AppHandle) -> PathBuf {
    app.path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("eos")
}

fn credentials_path(app: &AppHandle) -> PathBuf {
    eos_dir(app).join("credentials.json")
}

fn token_path(app: &AppHandle) -> PathBuf {
    eos_dir(app).join("token.json")
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &PathBuf) -> Option<T> {
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn write_json<T: Serialize>(path: &PathBuf, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|_| "@t:eos.storageFailed".to_string())?;
    }
    let text = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|_| "@t:eos.storageFailed".to_string())
}

pub fn load_credentials(app: &AppHandle) -> Option<EosCredentials> {
    read_json(&credentials_path(app))
}

fn load_token(app: &AppHandle) -> Option<EosToken> {
    read_json(&token_path(app))
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|_| "@t:eos.connectFailed".to_string())
}

/// One-time code that proves the player is signed in to Epic.
async fn fetch_exchange_code(client: &reqwest::Client) -> Result<String, String> {
    let (_, access_token) = read_session()?;
    let resp = client
        .get(EXCHANGE_URL)
        .header("Authorization", format!("bearer {access_token}"))
        .send()
        .await
        .map_err(|_| "@t:eos.connectFailed".to_string())?;
    if !resp.status().is_success() {
        return Err("@t:eos.noSession".into());
    }
    let value: serde_json::Value = resp
        .json()
        .await
        .map_err(|_| "@t:eos.connectFailed".to_string())?;
    value
        .get("code")
        .and_then(|c| c.as_str())
        .map(str::to_string)
        .ok_or_else(|| "@t:eos.connectFailed".to_string())
}

/// Exchanges the one-time code for an EOS user token (presence scope included).
async fn request_token(
    client: &reqwest::Client,
    credentials: &EosCredentials,
    form: &[(&str, String)],
) -> Result<EosToken, String> {
    let mut params: Vec<(&str, String)> = vec![("deployment_id", credentials.deployment_id.clone())];
    params.extend(form.iter().cloned());
    params.push(("scope", EOS_SCOPE.to_string()));

    let resp = client
        .post(TOKEN_URL)
        .basic_auth(&credentials.client_id, Some(&credentials.client_secret))
        .form(&params)
        .send()
        .await
        .map_err(|_| "@t:eos.connectFailed".to_string())?;

    let status = resp.status();
    let value: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        // The service answers 400 with `client_missing_application_id` while the
        // Dev Portal application is not linked yet; anything else is a bad key.
        let code = value
            .get("errorCode")
            .and_then(|c| c.as_str())
            .unwrap_or_default()
            .to_string();
        if code.contains("client_missing_application_id") {
            return Err("@t:eos.applicationMissing".into());
        }
        if code.contains("invalid_grant") || code.contains("invalid_client") {
            return Err("@t:eos.invalidCredentials".into());
        }
        return Err("@t:eos.connectFailed".into());
    }

    let expires_in = value.get("expires_in").and_then(|v| v.as_i64()).unwrap_or(3600);
    Ok(EosToken {
        access_token: value
            .get("access_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        refresh_token: value
            .get("refresh_token")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        account_id: value
            .get("account_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        scope: value
            .get("scope")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        expires_at: now_secs() + expires_in,
    })
}

/// Returns a usable EOS token, refreshing it when it is about to expire.
async fn ensure_token(app: &AppHandle) -> Result<EosToken, String> {
    let credentials = load_credentials(app).filter(EosCredentials::is_complete).ok_or_else(|| "@t:eos.notConfigured".to_string())?;
    let client = http_client()?;

    if let Some(token) = load_token(app) {
        if token.is_fresh() {
            return Ok(token);
        }
        if !token.refresh_token.is_empty() {
            let refreshed = request_token(
                &client,
                &credentials,
                &[("grant_type", "refresh_token".into()), ("refresh_token", token.refresh_token.clone())],
            )
            .await?;
            write_json(&token_path(app), &refreshed)?;
            return Ok(refreshed);
        }
    }

    let code = fetch_exchange_code(&client).await?;
    let token = request_token(
        &client,
        &credentials,
        &[("grant_type", "exchange_code".into()), ("exchange_code", code)],
    )
    .await?;
    write_json(&token_path(app), &token)?;
    Ok(token)
}

/// Reads the live presence of every friend from the launcher presence service.
pub async fn fetch_presence(app: &AppHandle) -> Result<serde_json::Value, String> {
    let token = ensure_token(app).await?;
    if token.account_id.is_empty() {
        return Err("@t:eos.notConfigured".into());
    }
    let client = http_client()?;
    let resp = client
        .get(format!("{PRESENCE_URL}/_/{}/friends/presence", token.account_id))
        .header("Authorization", format!("bearer {}", token.access_token))
        .send()
        .await
        .map_err(|_| "@t:eos.connectFailed".to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED || resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Err("@t:eos.tokenExpired".into());
    }
    if !resp.status().is_success() {
        return Err("@t:eos.connectFailed".into());
    }
    resp.json::<serde_json::Value>()
        .await
        .map_err(|_| "@t:eos.connectFailed".to_string())
}

/// Stores the Dev Portal credentials and completes the exchange-code handshake.
#[tauri::command]
pub async fn eos_social_connect(
    app: AppHandle,
    credentials: EosCredentials,
) -> Result<EosStatus, String> {
    if !credentials.is_complete() {
        return Err("@t:eos.invalidCredentials".into());
    }
    write_json(&credentials_path(&app), &credentials)?;
    // Drop any stale token from a previous account/application.
    let _ = std::fs::remove_file(token_path(&app));
    let token = ensure_token(&app).await?;
    Ok(EosStatus {
        configured: true,
        connected: !token.access_token.is_empty(),
        account_id: token.account_id,
        scope: token.scope,
    })
}

/// Reports whether credentials are stored and the token still works.
#[tauri::command]
pub async fn eos_social_status(app: AppHandle) -> Result<EosStatus, String> {
    let configured = load_credentials(&app)
        .map(|c| c.is_complete())
        .unwrap_or(false);
    if !configured {
        return Ok(EosStatus {
            configured: false,
            connected: false,
            account_id: String::new(),
            scope: String::new(),
        });
    }
    match ensure_token(&app).await {
        Ok(token) => Ok(EosStatus {
            configured: true,
            connected: !token.access_token.is_empty(),
            account_id: token.account_id,
            scope: token.scope,
        }),
        Err(_) => Ok(EosStatus {
            configured: true,
            connected: false,
            account_id: String::new(),
            scope: String::new(),
        }),
    }
}

/// Removes stored credentials and tokens.
#[tauri::command]
pub fn eos_social_disconnect(app: AppHandle) -> Result<(), String> {
    let _ = std::fs::remove_file(credentials_path(&app));
    let _ = std::fs::remove_file(token_path(&app));
    Ok(())
}

/// Live friend presence (raw payload while the shape is being finalised).
#[tauri::command]
pub async fn eos_social_presence(app: AppHandle) -> Result<serde_json::Value, String> {
    fetch_presence(&app).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_credentials_are_rejected() {
        let mut creds = EosCredentials::default();
        assert!(!creds.is_complete());
        creds.client_id = "id".into();
        creds.client_secret = "secret".into();
        assert!(!creds.is_complete());
        creds.deployment_id = "dep".into();
        assert!(creds.is_complete());
    }

    #[test]
    fn token_freshness_respects_the_margin() {
        let mut token = EosToken::default();
        token.expires_at = now_secs() + 30;
        assert!(!token.is_fresh());
        token.expires_at = now_secs() + 600;
        assert!(token.is_fresh());
    }

    #[test]
    fn token_json_roundtrip_uses_camel_case() {
        let token = EosToken {
            access_token: "a".into(),
            refresh_token: "r".into(),
            account_id: "acc".into(),
            scope: "basic_profile presence".into(),
            expires_at: 42,
        };
        let text = serde_json::to_string(&token).unwrap();
        assert!(text.contains("\"accessToken\""));
        assert!(text.contains("\"refreshToken\""));
        assert!(text.contains("\"expiresAt\""));
        let back: EosToken = serde_json::from_str(&text).unwrap();
        assert_eq!(back.account_id, "acc");
        assert_eq!(back.expires_at, 42);
    }
}
