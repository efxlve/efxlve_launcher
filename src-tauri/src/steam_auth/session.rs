//! Steam sign-in commands: password, QR, guard code, account switch.
//!
//! The password is wiped after RSA encryption. Raw Steam errors stay in this
//! process; the UI receives a translation key.

use std::time::Duration;

use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use zeroize::Zeroize;

use super::vault::*;
use super::wire::*;
use super::*;

/* ---------- HTTP plumbing ---------- */

pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|_| "@t:steam.err.network".to_string())
}

/// JSON field lookup that tolerates both Steam spellings (`client_id` and
/// `clientId`): Valve's serializer has changed between services before.
pub fn field<'a>(value: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    value.get(snake).or_else(|| value.get(camel))
}

/// Accepts a JSON string or number and normalizes it to a string (uint64
/// fields arrive as strings in protobuf JSON).
pub fn field_str(value: &Value, snake: &str, camel: &str) -> String {
    match field(value, snake, camel) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

pub fn field_i64(value: &Value, snake: &str, camel: &str) -> i64 {
    match field(value, snake, camel) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// Response body of one service call: the `response` object plus the
/// `x-eresult` header Steam uses for validation errors.
pub struct ApiCall {
    pub(super) eresult: i64,
    pub(super) body: Value,
}

impl ApiCall {
    pub(super) fn response(&self) -> &Value {
        self.body.get("response").unwrap_or(&Value::Null)
    }
}

pub async fn post_form(
    client: &reqwest::Client,
    method: &str,
    form: &[(String, String)],
) -> Result<ApiCall, String> {
    // `format=json` is mandatory here: a protobuf request otherwise gets a
    // binary protobuf response (`application/octet-stream`), which the JSON
    // parser below would reject even on success.
    let url = format!("{API_BASE}/{method}/v1/?format=json");
    let response = client
        .post(url)
        .form(form)
        .send()
        .await
        .map_err(|_| "@t:steam.err.network".to_string())?;
    let status = response.status();
    let eresult = response
        .headers()
        .get("x-eresult")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(if status.is_success() { 1 } else { 2 });
    let body = response.text().await.unwrap_or_default();
    let payload: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(
            if status == reqwest::StatusCode::UNAUTHORIZED
                || status == reqwest::StatusCode::FORBIDDEN
            {
                "@t:steam.err.sessionExpired".to_string()
            } else {
                // The status code is kept in the message so a user screenshot is
                // enough to diagnose; no Steam payload ever reaches the UI.
                format!("@t:steam.err.steam\u{1f}HTTP {status}")
            },
        );
    }
    Ok(ApiCall {
        eresult,
        body: payload,
    })
}

/// `GetPasswordRSAPublicKey` answers on GET only (Steam rejects it as POST).
pub async fn get_rsa_key(
    client: &reqwest::Client,
    account_name: &str,
) -> Result<(String, String, String), String> {
    let response = client
        .get(format!("{API_BASE}/GetPasswordRSAPublicKey/v1/"))
        .query(&[("account_name", account_name)])
        .send()
        .await
        .map_err(|_| "@t:steam.err.network".to_string())?;
    if !response.status().is_success() {
        return Err("@t:steam.err.steam".to_string());
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "@t:steam.err.steam".to_string())?;
    let body = payload.get("response").unwrap_or(&Value::Null);
    let modulus = field_str(body, "publickey_mod", "publickeyMod");
    let exponent = field_str(body, "publickey_exp", "publickeyExp");
    let timestamp = field_str(body, "timestamp", "timestamp");
    if modulus.is_empty() || exponent.is_empty() || timestamp.is_empty() {
        return Err("@t:steam.err.steam".to_string());
    }
    Ok((modulus, exponent, timestamp))
}

/// Encrypts the password with RSA PKCS#1 v1.5, exactly like SteamKit does.
pub fn encrypt_password(
    password: &str,
    modulus_hex: &str,
    exponent_hex: &str,
) -> Result<String, String> {
    use rsa::{BigUint, Pkcs1v15Encrypt, RsaPublicKey};
    let n = BigUint::parse_bytes(modulus_hex.as_bytes(), 16)
        .ok_or_else(|| "@t:steam.err.crypto".to_string())?;
    let e = BigUint::parse_bytes(exponent_hex.as_bytes(), 16)
        .ok_or_else(|| "@t:steam.err.crypto".to_string())?;
    let key = RsaPublicKey::new(n, e).map_err(|_| "@t:steam.err.crypto".to_string())?;

    // The plaintext copy is wiped even if encryption fails.
    let mut secret = password.as_bytes().to_vec();
    let encrypted = key.encrypt(&mut rand::thread_rng(), Pkcs1v15Encrypt, secret.as_slice());
    secret.zeroize();
    let encrypted = encrypted.map_err(|_| "@t:steam.err.crypto".to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(encrypted))
}

/// Mints a web access token the official way: `finalizelogin` → `settoken`
/// sets a `steamLoginSecure` cookie whose value carries `<steamid>||<token>`.
///
/// Valve's 2025-04-30 change made `GenerateAccessTokenForApp` reject
/// WebBrowser refresh tokens (`AccessDenied`), so this is the working path for
/// a web sign-in; `GenerateAccessTokenForApp` stays as a fallback for tokens
/// that still accept it.
pub async fn finalize_web_login(
    client: &reqwest::Client,
    refresh_token: &str,
    steam_id: &str,
) -> Result<String, String> {
    let form = vec![
        ("nonce".to_string(), refresh_token.to_string()),
        ("sessionid".to_string(), random_session_id()),
        (
            "redir".to_string(),
            "https://steamcommunity.com/login/home/?goto=".to_string(),
        ),
    ];
    let response = client
        .post("https://login.steampowered.com/jwt/finalizelogin")
        .header("Origin", "https://steamcommunity.com")
        .header("Referer", "https://steamcommunity.com/")
        .form(&form)
        .send()
        .await
        .map_err(|_| "@t:steam.err.network".to_string())?;
    if !response.status().is_success() {
        return Err("@t:steam.err.sessionExpired".to_string());
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "@t:steam.err.steam".to_string())?;
    if let Some(error) = payload.get("error").and_then(Value::as_i64) {
        if error != 0 {
            return Err(eresult_error(error));
        }
    }
    let (url, params) =
        settoken_transfer(&payload).ok_or_else(|| "@t:steam.err.steam".to_string())?;

    let mut transfer_form = vec![("steamID".to_string(), steam_id.to_string())];
    transfer_form.extend(params);
    // Redirects are disabled on purpose: the `steamLoginSecure` cookie is set
    // on the redirect response itself, which a following client would hide.
    let no_redirect = reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("efxlve-launcher")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "@t:steam.err.network".to_string())?;
    let response = no_redirect
        .post(url)
        .form(&transfer_form)
        .send()
        .await
        .map_err(|_| "@t:steam.err.network".to_string())?;
    let cookie = response
        .headers()
        .get_all(reqwest::header::SET_COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .find(|cookie| cookie.to_ascii_lowercase().starts_with("steamloginsecure="))
        .ok_or_else(|| "@t:steam.err.sessionExpired".to_string())?;
    cookie_access_token(cookie).ok_or_else(|| "@t:steam.err.sessionExpired".to_string())
}

/// Short-lived access token for Web API calls (works for hours, never written
/// to disk).
pub async fn generate_access_token(
    client: &reqwest::Client,
    refresh_token: &str,
    steam_id: &str,
) -> Result<String, String> {
    let form = protobuf_payload(&encode_generate_request(refresh_token, steam_id));
    let call = post_form(client, "GenerateAccessTokenForApp", &form).await?;
    if call.eresult != 1 {
        return Err(eresult_error(call.eresult));
    }
    let token = field_str(call.response(), "access_token", "accessToken");
    if token.is_empty() {
        return Err("@t:steam.err.sessionExpired".to_string());
    }
    Ok(token)
}

/// Every owned game (installed or not), with Steam's own playtime. The
/// `steamid` parameter is mandatory with an access token: Steam's gateway
/// rejects the request with "Missing required routing parameter" without it.
pub async fn fetch_owned_games(
    client: &reqwest::Client,
    access_token: &str,
    steam_id: &str,
) -> Result<SteamOwnedGames, String> {
    let response = client
        .get(OWNED_GAMES_URL)
        .query(&[
            ("access_token", access_token),
            ("steamid", steam_id),
            ("include_appinfo", "1"),
            ("include_played_free_games", "1"),
            ("format", "json"),
        ])
        .send()
        .await
        .map_err(|_| "@t:steam.err.network".to_string())?;
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return Err("@t:steam.err.sessionExpired".to_string());
    }
    if !status.is_success() {
        return Err("@t:steam.err.steam".to_string());
    }
    let payload: Value = response
        .json()
        .await
        .map_err(|_| "@t:steam.err.steam".to_string())?;
    Ok(parse_owned_games(
        payload.get("response").unwrap_or(&Value::Null),
    ))
}

/* ---------- Commands ---------- */

/// Sign-in shape for the QR flow: the challenge URL plus an inline SVG QR code.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamQrLogin {
    pub challenge_url: String,
    /// Ready-to-embed SVG markup (black modules on white, for reliable scanning).
    pub svg: String,
    pub interval: f32,
}

/// Opens a QR sign-in: the phone scans the code, approves, and the poll below
/// completes the session. No password is involved.
#[tauri::command]
pub async fn steam_login_qr_begin(remember: Option<bool>) -> Result<SteamQrLogin, String> {
    let client = http_client()?;
    let call = post_form(
        &client,
        "BeginAuthSessionViaQR",
        &protobuf_payload(&encode_qr_begin_request()),
    )
    .await?;
    if call.eresult != 1 {
        return Err(eresult_error(call.eresult));
    }
    let response = call.response();
    let client_id = field_str(response, "client_id", "clientId");
    let request_id = field_str(response, "request_id", "requestId");
    let challenge_url = field_str(response, "challenge_url", "challengeUrl");
    if client_id.is_empty() || request_id.is_empty() || challenge_url.is_empty() {
        return Err("@t:steam.err.steam".to_string());
    }
    let mut guard_types = Vec::new();
    if let Some(confirmations) =
        field(response, "allowed_confirmations", "allowedConfirmations").and_then(Value::as_array)
    {
        for entry in confirmations {
            guard_types.push(field_i64(entry, "confirmation_type", "confirmationType"));
        }
    }
    let interval = field(response, "interval", "interval")
        .and_then(Value::as_f64)
        .unwrap_or(5.0) as f32;
    let remember = remember.unwrap_or(true);
    lock().pending = Some(PendingLogin {
        account_name: String::new(),
        client_id,
        request_id,
        steam_id: String::new(),
        guard_types,
        email_hint: String::new(),
        interval,
        remember,
        code_sent: true,
        qr: true,
    });
    Ok(SteamQrLogin {
        svg: qr_svg(&challenge_url)?,
        challenge_url,
        interval,
    })
}

/// QR code as inline SVG. Kept black-on-white: inverted codes are not scanned
/// reliably by every mobile client.
pub fn qr_svg(url: &str) -> Result<String, String> {
    let code = qrcode::QrCode::new(url.as_bytes()).map_err(|_| "@t:steam.err.steam".to_string())?;
    Ok(code
        .render::<qrcode::render::svg::Color>()
        .min_dimensions(180, 180)
        .quiet_zone(true)
        .build())
}

/// Step 1–2: fetch the RSA key, encrypt the password, open the auth session.
#[tauri::command]
pub async fn steam_login_begin(
    account_name: String,
    mut password: String,
    remember: Option<bool>,
) -> Result<SteamLoginStatus, String> {
    let account_name = account_name.trim().to_string();
    if account_name.is_empty() || password.is_empty() {
        return Err("@t:steam.err.invalidPassword".to_string());
    }
    let remember = remember.unwrap_or(true);
    let client = http_client()?;

    let (modulus, exponent, timestamp) = match get_rsa_key(&client, &account_name).await {
        Ok(key) => key,
        Err(err) => {
            password.zeroize();
            return Err(err);
        }
    };
    // `encrypt_password` wipes its own plaintext copy; this command's copy is
    // wiped as soon as the ciphertext exists — success or failure.
    let encrypted = match encrypt_password(&password, &modulus, &exponent) {
        Ok(encrypted) => encrypted,
        Err(err) => {
            password.zeroize();
            return Err(err);
        }
    };
    password.zeroize();

    // Nested `device_details` forces the protobuf payload form; the other auth
    // calls need it too, because `request_id` is a raw byte field.
    let request = encode_begin_request(&account_name, &encrypted, &timestamp, remember);
    let call = post_form(
        &client,
        "BeginAuthSessionViaCredentials",
        &protobuf_payload(&request),
    )
    .await?;
    if call.eresult != 1 {
        return Err(eresult_error(call.eresult));
    }
    let pending = parse_begin_response(&account_name, remember, call.response())?;
    let status = pending.status();
    lock().pending = Some(pending);
    Ok(status)
}

/// Step 3: submit the Steam Guard code (email or mobile authenticator).
#[tauri::command]
pub async fn steam_login_code(code: String) -> Result<SteamLoginStatus, String> {
    let code = code.trim().to_string();
    if code.is_empty() {
        return Err("@t:steam.err.guardInvalid".to_string());
    }
    let pending = lock()
        .pending
        .clone()
        .ok_or_else(|| "@t:steam.err.noSession".to_string())?;
    let client = http_client()?;
    let request = encode_guard_code_request(
        &pending.client_id,
        &pending.steam_id,
        &code,
        pending.code_type(),
    );
    let call = post_form(
        &client,
        "UpdateAuthSessionWithSteamGuardCode",
        &protobuf_payload(&request),
    )
    .await?;
    if call.eresult != 1 {
        return Err(eresult_error(call.eresult));
    }
    let mut state = lock();
    let Some(pending) = state.pending.as_mut() else {
        return Err("@t:steam.err.noSession".to_string());
    };
    pending.code_sent = true;
    Ok(pending.status())
}

/// Step 4 (and current session check): polls a pending login, or reports the
/// stored session. A status call never polls when no login is in flight.
#[tauri::command]
pub async fn steam_login_status(app: tauri::AppHandle) -> Result<SteamLoginStatus, String> {
    ensure_disk_checked(&app);
    let pending = lock().pending.clone();
    let Some(pending) = pending else {
        let state = lock();
        return Ok(match state.session.as_ref() {
            Some(session) => SteamLoginStatus::signed_in(session),
            None => SteamLoginStatus::idle(),
        });
    };

    let client = http_client()?;
    let request_id = decode_base64_bytes(&pending.request_id);
    if request_id.is_empty() {
        return Err("@t:steam.err.sessionNotFound".to_string());
    }
    let request = encode_poll_request(&pending.client_id, &request_id);
    let call = post_form(
        &client,
        "PollAuthSessionStatus",
        &protobuf_payload(&request),
    )
    .await?;
    if call.eresult != 1 {
        // 22 (Pending) is not an error: the user has not approved yet.
        if call.eresult == 22 {
            return Ok(pending.status());
        }
        return Err(eresult_error(call.eresult));
    }
    match parse_poll_response(call.response(), &pending) {
        PollOutcome::Approved {
            account_name,
            steam_id,
            refresh_token,
            access_token,
        } => {
            let mut session = SteamSession {
                account_name,
                steam_id,
                refresh_token,
                access_token: if access_token.is_empty() {
                    None
                } else {
                    Some(access_token)
                },
                access_token_exp: 0,
            };
            if let Some(token) = session.access_token.clone() {
                session.access_token_exp = token_exp_secs(&token);
            }
            if pending.remember {
                persist_session(&app, &session);
            } else {
                // A one-off session must not resurrect an older sealed token.
                deactivate_vault(&app);
            }
            let status = SteamLoginStatus::signed_in(&session);
            let mut state = lock();
            state.pending = None;
            state.session = Some(session);
            Ok(status)
        }
        PollOutcome::Waiting { new_client_id } => {
            let mut state = lock();
            let Some(live) = state.pending.as_mut() else {
                return Err("@t:steam.err.expired".to_string());
            };
            if !new_client_id.is_empty() {
                live.client_id = new_client_id;
            }
            Ok(live.status())
        }
    }
}

/// Signs out: clears memory and marks the vault entry inactive (the sealed
/// account stays, so it can be switched back to later).
#[tauri::command]
pub fn steam_logout(app: tauri::AppHandle) {
    let mut state = lock();
    state.pending = None;
    if let Some(mut session) = state.session.take() {
        session.refresh_token.zeroize();
        if let Some(token) = session.access_token.as_mut() {
            token.zeroize();
        }
    }
    state.disk_checked = true;
    drop(state);
    deactivate_vault(&app);
}

/// Saved Steam accounts (sealed refresh tokens; passwords are never stored).
#[tauri::command]
pub fn steam_get_saved_accounts(app: tauri::AppHandle) -> Vec<SteamSavedAccount> {
    migrate_legacy_session(&app);
    load_meta(&auth_dir(&app))
}

/// Switches the launcher session to another saved Steam account.
#[tauri::command]
pub fn steam_switch_account(
    app: tauri::AppHandle,
    steam_id: String,
) -> Result<SteamLoginStatus, String> {
    if !valid_steam_id(&steam_id) {
        return Err("@t:steam.err.account".to_string());
    }
    let Some(session) = read_vault_session(&app, &steam_id) else {
        return Err("@t:steam.err.notSignedIn".to_string());
    };
    let mut accounts = load_meta(&auth_dir(&app));
    for account in accounts.iter_mut() {
        account.is_active = account.steam_id == steam_id;
        if account.is_active {
            account.last_used = now_secs();
        }
    }
    save_meta(&auth_dir(&app), &accounts);
    let status = SteamLoginStatus::signed_in(&session);
    let mut state = lock();
    state.pending = None;
    state.session = Some(session);
    state.disk_checked = true;
    Ok(status)
}

/// Removes one saved account; the active session is dropped when it matches.
#[tauri::command]
pub fn steam_remove_saved_account(app: tauri::AppHandle, steam_id: String) {
    // Refuse anything that is not a SteamID64 before it becomes a file path.
    if !valid_steam_id(&steam_id) {
        return;
    }
    let _ = std::fs::remove_file(vault_path(&auth_dir(&app), &steam_id));
    let mut accounts = load_meta(&auth_dir(&app));
    accounts.retain(|account| account.steam_id != steam_id);
    save_meta(&auth_dir(&app), &accounts);

    let mut state = lock();
    let is_active = state
        .session
        .as_ref()
        .map(|session| session.steam_id == steam_id)
        .unwrap_or(false);
    if is_active {
        if let Some(mut session) = state.session.take() {
            session.refresh_token.zeroize();
        }
    }
}

/// Every owned game on the signed-in account. The access token is refreshed
/// transparently; expired tokens are retried once with a fresh one.
#[tauri::command]
pub async fn steam_owned_games(app: tauri::AppHandle) -> Result<SteamOwnedGames, String> {
    ensure_disk_checked(&app);

    let (steam_id, cached) = {
        let state = lock();
        let Some(session) = state.session.as_ref() else {
            return Err("@t:steam.err.notSignedIn".to_string());
        };
        (
            session.steam_id.clone(),
            session.access_token_valid().map(str::to_string),
        )
    };

    let client = http_client()?;
    let token = match cached {
        Some(token) => token,
        None => refresh_access_token(&client).await?,
    };

    match fetch_owned_games(&client, &token, &steam_id).await {
        Err(err) if err == "@t:steam.err.sessionExpired" => {
            let fresh = refresh_access_token(&client).await?;
            fetch_owned_games(&client, &fresh, &steam_id).await
        }
        other => other,
    }
}

/// Mints (and caches in memory) a new access token for the session. The sealed
/// refresh token stays on disk untouched; access tokens are never persisted.
pub async fn refresh_access_token(client: &reqwest::Client) -> Result<String, String> {
    let (refresh_token, steam_id) = {
        let state = lock();
        let Some(session) = state.session.as_ref() else {
            return Err("@t:steam.err.notSignedIn".to_string());
        };
        (session.refresh_token.clone(), session.steam_id.clone())
    };
    let token = match finalize_web_login(client, &refresh_token, &steam_id).await {
        Ok(token) => token,
        Err(primary) => generate_access_token(client, &refresh_token, &steam_id)
            .await
            .map_err(|_| primary)?,
    };
    let mut state = lock();
    if let Some(session) = state.session.as_mut() {
        session.access_token_exp = token_exp_secs(&token);
        session.access_token = Some(token.clone());
    } else {
        return Err("@t:steam.err.notSignedIn".to_string());
    }
    Ok(token)
}
