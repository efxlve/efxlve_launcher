//! Amazon account sign-in through the Nile CLI.
//!
//! Nile's non-interactive login prints the PKCE material as JSON; the user
//! signs in on Amazon and comes back with a redirect URL that carries the
//! authorization code. `register` finishes the device registration and syncs
//! the library.

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use super::cli;

#[derive(Debug, Clone, Serialize)]
pub struct NileAuthStatus {
    /// True when the Nile binary is already on disk (no download was made).
    pub binary: bool,
    pub logged_in: bool,
    pub username: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NileLoginData {
    /// Amazon sign-in URL to open in the browser.
    pub url: String,
    pub client_id: String,
    pub code_verifier: String,
    pub serial: String,
}

/// Authorization code from the redirect URL, or a bare pasted code.
pub fn authorization_code(input: &str) -> Option<String> {
    let text = input.trim();
    if text.is_empty() {
        return None;
    }
    match url::Url::parse(text) {
        Ok(url) => url
            .query_pairs()
            .find(|(key, value)| key == "openid.oa2.authorization_code" && !value.is_empty())
            .map(|(_, value)| value.into_owned()),
        // Not a URL: treat it as the code itself.
        Err(_) => Some(text.to_string()),
    }
}

fn status_from_json(text: &str, binary: bool) -> NileAuthStatus {
    let value: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let logged_in = value
        .get("LoggedIn")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let username = value
        .get("Username")
        .and_then(|v| v.as_str())
        .filter(|name| !name.is_empty() && *name != "<not logged in>")
        .map(|name| name.to_string());
    NileAuthStatus {
        binary,
        logged_in,
        username,
    }
}

/// Sign-in state. Never downloads the binary: a missing Nile simply reports
/// "not installed, not signed in".
#[tauri::command]
pub async fn nile_auth_status(app: AppHandle) -> NileAuthStatus {
    if super::resolve_binary(&app).is_none() {
        return NileAuthStatus {
            binary: false,
            logged_in: false,
            username: None,
        };
    }
    match cli::run(&app, &["auth", "--status"], 30).await {
        Ok(out) => status_from_json(&cli::stdout_text(&out), true),
        Err(_) => NileAuthStatus {
            binary: true,
            logged_in: false,
            username: None,
        },
    }
}

/// Starts sign-in: downloads Nile when needed and returns the PKCE material
/// plus the Amazon URL the user has to open.
#[tauri::command]
pub async fn nile_login_begin(app: AppHandle) -> Result<NileLoginData, String> {
    let out = cli::run(&app, &["auth", "--login", "--non-interactive"], 180).await?;
    let text = cli::stdout_text(&out);
    let value: Value =
        serde_json::from_str(&text).map_err(|_| cli::failure_message(&out))?;
    let data = NileLoginData {
        url: value
            .get("url")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        client_id: value
            .get("client_id")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        code_verifier: value
            .get("code_verifier")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
        serial: value
            .get("serial")
            .and_then(|v| v.as_str())
            .unwrap_or_default()
            .to_string(),
    };
    if data.url.is_empty() || data.client_id.is_empty() || data.code_verifier.is_empty() {
        return Err(cli::failure_message(&out));
    }
    Ok(data)
}

/// Finishes sign-in with the redirect URL (or the bare code) the user pasted.
/// Registration also performs the first library sync, which can take a while.
#[tauri::command]
pub async fn nile_login_finish(
    app: AppHandle,
    redirect: String,
    client_id: String,
    code_verifier: String,
    serial: String,
) -> Result<String, String> {
    let code = authorization_code(&redirect)
        .ok_or_else(|| "The redirect URL did not contain an authorization code".to_string())?;
    let out = cli::run(
        &app,
        &[
            "register",
            "--code",
            &code,
            "--client-id",
            &client_id,
            "--code-verifier",
            &code_verifier,
            "--serial",
            &serial,
        ],
        300,
    )
    .await?;
    if !out.status.success() {
        return Err(cli::failure_message(&out));
    }
    Ok("ok".to_string())
}

/// Deregisters the device and removes the local session.
#[tauri::command]
pub async fn nile_logout(app: AppHandle) -> Result<(), String> {
    let out = cli::run(&app, &["auth", "--logout"], 60).await?;
    if !out.status.success() {
        return Err(cli::failure_message(&out));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redirect_url_yields_the_authorization_code() {
        let url = "https://www.amazon.com/?openid.oa2.authorization_code=ANEXAMPLE123&openid.mode=id_res";
        assert_eq!(authorization_code(url).as_deref(), Some("ANEXAMPLE123"));
        // A bare code is accepted as-is.
        assert_eq!(authorization_code("  ABCDEF  ").as_deref(), Some("ABCDEF"));
        // A URL without the code is rejected instead of becoming the code.
        assert_eq!(authorization_code("https://www.amazon.com/"), None);
        assert_eq!(authorization_code("   "), None);
    }

    #[test]
    fn status_json_maps_to_the_public_shape() {
        let logged = status_from_json(r#"{"Username":"Efxlve","LoggedIn":true}"#, true);
        assert!(logged.logged_in);
        assert_eq!(logged.username.as_deref(), Some("Efxlve"));

        let out = status_from_json(r#"{"Username":"<not logged in>","LoggedIn":false}"#, true);
        assert!(!out.logged_in);
        assert_eq!(out.username, None);
    }
}
