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
    /// Amazon account id of the live session (`amzn1.account.*`).
    pub user_id: Option<String>,
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

/// Sign-in state, read straight from Nile's config files: spawning the CLI on
/// every session load costs a Python start for data already on disk. A missing
/// binary or token file reports "not signed in".
#[tauri::command]
pub async fn nile_auth_status(app: AppHandle) -> NileAuthStatus {
    let root = cli::config_root(&app);
    let binary = super::resolve_binary(&app).is_some();
    let user = super::accounts::read_current_user(&root);
    let logged_in =
        binary && user.is_some() && super::accounts::has_token_file(&cli::config_dir(&app));
    NileAuthStatus {
        binary,
        logged_in,
        username: if logged_in {
            user.as_ref()
                .map(|(name, _)| name.clone())
                .filter(|name| !name.is_empty())
        } else {
            None
        },
        user_id: user.map(|(_, id)| id),
    }
}

/// Starts sign-in: downloads Nile when needed and returns the PKCE material
/// plus the Amazon URL the user has to open.
///
/// Nile keeps exactly one session, so an already signed-in account is archived
/// first and the live session is cleared to make room for the new one.
#[tauri::command]
pub async fn nile_login_begin(app: AppHandle) -> Result<NileLoginData, String> {
    let root = cli::config_root(&app);
    if super::accounts::read_current_user(&root).is_some() {
        super::accounts::ensure_current_saved(&root);
        super::accounts::clear_live_session(&cli::config_dir(&app));
    }
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
    // Archive the fresh session so "add another account" can switch back to it.
    super::accounts::ensure_current_saved(&cli::config_root(&app));
    Ok("ok".to_string())
}

/// Deregisters the device and removes the local session.
#[tauri::command]
pub async fn nile_logout(app: AppHandle) -> Result<(), String> {
    let out = cli::run(&app, &["auth", "--logout"], 60).await?;
    if !out.status.success() {
        return Err(cli::failure_message(&out));
    }
    // The CLI removes its own files; clear anything it left behind so the next
    // status check cannot read a half session.
    super::accounts::clear_live_session(&cli::config_dir(&app));
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
}
