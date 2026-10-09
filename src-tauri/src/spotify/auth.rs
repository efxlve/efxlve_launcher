//! Spotify Authorization Code with PKCE (RFC 7636) over a loopback redirect.
//!
//! Spotify allows `http://127.0.0.1:PORT` redirect URIs for desktop apps and
//! lets the port be assigned at runtime. The user registers
//! `http://127.0.0.1:8899/callback` once in their own Spotify app and the
//! flow below does the rest: random verifier, SHA-256 challenge, system
//! browser, one-shot loopback server, token exchange/refresh.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::RngCore;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub const AUTHORIZE_URL: &str = "https://accounts.spotify.com/authorize";
pub const TOKEN_URL: &str = "https://accounts.spotify.com/api/token";

/// Read-only player state, transport control, playlists and profile.
pub const SCOPES: &str = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-read-private";

/// 64 random bytes → 86 URL-safe characters, inside RFC 7636's 43–128 range.
pub fn new_verifier() -> String {
    let mut bytes = [0u8; 64];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `BASE64URL(SHA256(verifier))` without padding.
pub fn challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// Random `state` that ties the callback to this login attempt.
pub fn new_state() -> String {
    let mut bytes = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

pub fn redirect_uri(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

pub fn authorize_url(client_id: &str, redirect: &str, challenge: &str, state: &str) -> String {
    let mut url = url::Url::parse(AUTHORIZE_URL).expect("static authorize URL");
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("response_type", "code")
        .append_pair("redirect_uri", redirect)
        .append_pair("scope", SCOPES)
        .append_pair("code_challenge_method", "S256")
        .append_pair("code_challenge", challenge)
        .append_pair("state", state);
    url.to_string()
}

#[derive(Deserialize)]
pub struct TokenResponse {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_in: Option<i64>,
}

pub async fn exchange_code(
    client: &reqwest::Client,
    client_id: &str,
    code: &str,
    verifier: &str,
    redirect: &str,
) -> Result<TokenResponse, String> {
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", redirect),
        ("client_id", client_id),
        ("code_verifier", verifier),
    ];
    request_tokens(client, &params).await
}

pub async fn refresh(
    client: &reqwest::Client,
    client_id: &str,
    refresh_token: &str,
) -> Result<TokenResponse, String> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
    ];
    request_tokens(client, &params).await
}

async fn request_tokens(
    client: &reqwest::Client,
    params: &[(&str, &str)],
) -> Result<TokenResponse, String> {
    let response = client
        .post(TOKEN_URL)
        .form(params)
        .send()
        .await
        .map_err(|error| error.to_string())?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|error| error.to_string())
}

/// Minimal bilingual landing page for the browser tab.
const CALLBACK_HTML: &str = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Efxlve Launcher</title><style>body{font-family:system-ui,sans-serif;background:#0b0d12;color:#e8e8ea;display:grid;place-items:center;height:100vh;margin:0}div{text-align:center;max-width:420px}h1{font-size:18px}p{color:#9aa0ab;font-size:14px}</style></head><body><div><h1>Spotify bağlandı / Connected</h1><p>Bu sekmeyi kapatıp Efxlve Launcher'a dönebilirsin.<br>You can close this tab and return to Efxlve Launcher.</p></div></body></html>";

/// Accepts requests until the Spotify redirect arrives, then returns the
/// authorization code. `error=` (user pressed Cancel) becomes an error.
pub async fn await_callback(
    listener: TcpListener,
    expected_state: &str,
) -> Result<String, String> {
    let mut buffer = vec![0u8; 16 * 1024];
    loop {
        let (mut socket, _) = listener
            .accept()
            .await
            .map_err(|error| error.to_string())?;
        let read = socket.read(&mut buffer).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("");

        let Some(query) = target.strip_prefix("/callback?") else {
            let _ = socket
                .write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                .await;
            continue;
        };

        let params: HashMap<String, String> = url::form_urlencoded::parse(query.as_bytes())
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();

        let body = CALLBACK_HTML;
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        let _ = socket.write_all(response.as_bytes()).await;
        let _ = socket.shutdown().await;

        // The browser may fetch /favicon.ico first; only /callback? counts.
        if params.get("state").map(String::as_str) != Some(expected_state) {
            return Err("state_mismatch".to_string());
        }
        if let Some(error) = params.get("error") {
            return Err(error.clone());
        }
        return params
            .get("code")
            .cloned()
            .ok_or_else(|| "missing_code".to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::{authorize_url, challenge, redirect_uri, SCOPES};

    /// RFC 7636 Appendix B test vector.
    #[test]
    fn challenge_matches_rfc7636() {
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn authorize_url_carries_pkce_and_scope() {
        let url = authorize_url("abc123", &redirect_uri(8899), "CHAL", "STATE");
        assert!(url.starts_with("https://accounts.spotify.com/authorize?"));
        assert!(url.contains("client_id=abc123"));
        assert!(url.contains("code_challenge=CHAL"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=STATE"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A8899%2Fcallback"));
        assert!(url.contains(&url::form_urlencoded::byte_serialize(SCOPES.as_bytes()).collect::<String>()));
    }

    #[test]
    fn redirect_uses_the_registered_loopback_path() {
        assert_eq!(redirect_uri(8899), "http://127.0.0.1:8899/callback");
    }
}
