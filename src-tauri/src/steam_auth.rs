//! Steam account sign-in (the web flow SteamKit/Galaxy-style clients use) and
//! owned-library reading.
//!
//! Flow, all over HTTPS against `api.steampowered.com`:
//!   1. `GetPasswordRSAPublicKey`   — per-account RSA public key.
//!   2. `BeginAuthSessionViaCredentials` — password sent RSA PKCS#1 v1.5
//!      encrypted (the password itself is wiped from memory right after).
//!   3. `UpdateAuthSessionWithSteamGuardCode` — only when Steam asks for a code.
//!   4. `PollAuthSessionStatus`     — yields the refresh token once approved.
//!   5. `jwt/finalizelogin` → `steamLoginSecure` cookie — carries the web access
//!      token used by `GetOwnedGames`. (`GenerateAccessTokenForApp` is kept as a
//!      fallback only: Valve's 2025-04-30 change makes it reject WebBrowser
//!      refresh tokens.)
//!
//! Security rules (ROADMAP §13.2):
//!   * The password is never stored, logged or echoed anywhere.
//!   * The refresh token is sealed with DPAPI (`CryptProtectData`), so the file
//!     is only readable by the same Windows user on the same machine.
//!   * Access tokens live in memory only and are used as query parameters,
//!     exactly like Steam's own clients.
//!   * Errors are mapped to short translation keys (`@t:steam.err.*`); raw
//!     Steam responses never reach the UI.

use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zeroize::Zeroize;

const API_BASE: &str = "https://api.steampowered.com/IAuthenticationService";
const OWNED_GAMES_URL: &str = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
const HTTP_TIMEOUT_SECS: u64 = 12;
/// `EAuthTokenPlatformType.WebBrowser` — what the Steam community site sends.
const PLATFORM_TYPE_WEB: i64 = 2;
const WEBSITE_ID: &str = "Community";
/// The device name Steam shows in its own "authorized devices" list.
const DEVICE_NAME: &str = "efxlve-launcher";

/// `EAuthSessionGuardType` values we react to.
const GUARD_EMAIL_CODE: i64 = 2;
const GUARD_DEVICE_CODE: i64 = 3;
const GUARD_DEVICE_CONFIRMATION: i64 = 4;
const GUARD_EMAIL_CONFIRMATION: i64 = 5;

/// One in-flight sign-in kept between the `begin` / `code` / `status` commands.
#[derive(Clone, Default)]
struct PendingLogin {
    account_name: String,
    client_id: String,
    request_id: String,
    steam_id: String,
    /// Guard types Steam offered (`allowed_confirmations`).
    guard_types: Vec<i64>,
    /// Email domain hint for email Steam Guard codes.
    email_hint: String,
    /// Poll interval suggested by Steam, in seconds.
    interval: f32,
    /// Whether the refresh token should be sealed to disk.
    remember: bool,
    /// True once a guard code has been submitted; polling stays silent until then.
    code_sent: bool,
}

impl PendingLogin {
    fn needs_code(&self) -> bool {
        self.guard_types.contains(&GUARD_EMAIL_CODE) || self.guard_types.contains(&GUARD_DEVICE_CODE)
    }

    fn needs_confirmation(&self) -> bool {
        self.guard_types.contains(&GUARD_DEVICE_CONFIRMATION)
            || self.guard_types.contains(&GUARD_EMAIL_CONFIRMATION)
    }

    /// Code type to send: the mobile authenticator wins when both are offered.
    fn code_type(&self) -> i64 {
        if self.guard_types.contains(&GUARD_DEVICE_CODE) {
            GUARD_DEVICE_CODE
        } else {
            GUARD_EMAIL_CODE
        }
    }

    fn status(&self) -> SteamLoginStatus {
        let state = if !self.code_sent && self.needs_code() {
            "code"
        } else if !self.code_sent && self.needs_confirmation() {
            "confirm"
        } else {
            "pending"
        };
        SteamLoginStatus {
            state: state.into(),
            account_name: self.account_name.clone(),
            steam_id: self.steam_id.clone(),
            email_hint: self.email_hint.clone(),
            interval: self.interval,
        }
    }
}

/// A signed-in Steam account. The refresh token stays in memory while the app
/// runs and is sealed to disk only when "keep this session" was checked.
struct SteamSession {
    account_name: String,
    steam_id: String,
    refresh_token: String,
    access_token: Option<String>,
    /// Unix seconds when the access token stops working (0 = unknown).
    access_token_exp: u64,
}

impl SteamSession {
    fn access_token_valid(&self) -> Option<&str> {
        let token = self.access_token.as_deref()?;
        if self.access_token_exp > 0 && now_secs() + 60 >= self.access_token_exp {
            return None;
        }
        Some(token)
    }
}

#[derive(Default)]
struct AuthState {
    pending: Option<PendingLogin>,
    session: Option<SteamSession>,
    /// Whether `<app_data>/steam/auth.bin` has been checked this process.
    disk_checked: bool,
}

static AUTH: Mutex<AuthState> = Mutex::new(AuthState {
    pending: None,
    session: None,
    disk_checked: false,
});

/// Poison-resistant lock: a panic elsewhere must not take sign-in down.
fn lock() -> std::sync::MutexGuard<'static, AuthState> {
    AUTH.lock().unwrap_or_else(|e| e.into_inner())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/* ---------- Public shapes shared with the frontend ---------- */

/// Sign-in state returned by `begin`, `code` and `status`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamLoginStatus {
    /// `idle` | `code` | `confirm` | `pending` | `signed_in`
    pub state: String,
    pub account_name: String,
    pub steam_id: String,
    pub email_hint: String,
    pub interval: f32,
}

impl SteamLoginStatus {
    fn idle() -> Self {
        Self {
            state: "idle".into(),
            account_name: String::new(),
            steam_id: String::new(),
            email_hint: String::new(),
            interval: 0.0,
        }
    }

    fn signed_in(session: &SteamSession) -> Self {
        Self {
            state: "signed_in".into(),
            account_name: session.account_name.clone(),
            steam_id: session.steam_id.clone(),
            email_hint: String::new(),
            interval: 0.0,
        }
    }
}

/// One owned Steam game (`IPlayerService/GetOwnedGames`).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SteamOwnedGame {
    pub app_id: String,
    pub name: String,
    /// Total playtime in minutes, in Steam's own unit.
    pub playtime_forever: i64,
    pub playtime_two_weeks: i64,
    pub icon_url: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SteamOwnedGames {
    pub game_count: i64,
    pub games: Vec<SteamOwnedGame>,
}

/* ---------- HTTP plumbing ---------- */

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent("efxlve-launcher")
        .build()
        .map_err(|_| "@t:steam.err.network".to_string())
}

/// JSON field lookup that tolerates both Steam spellings (`client_id` and
/// `clientId`): Valve's serializer has changed between services before.
fn field<'a>(value: &'a Value, snake: &str, camel: &str) -> Option<&'a Value> {
    value.get(snake).or_else(|| value.get(camel))
}

/// Accepts a JSON string or number and normalizes it to a string (uint64
/// fields arrive as strings in protobuf JSON).
fn field_str(value: &Value, snake: &str, camel: &str) -> String {
    match field(value, snake, camel) {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

fn field_i64(value: &Value, snake: &str, camel: &str) -> i64 {
    match field(value, snake, camel) {
        Some(Value::Number(n)) => n.as_i64().unwrap_or(0),
        Some(Value::String(s)) => s.trim().parse::<i64>().unwrap_or(0),
        _ => 0,
    }
}

/// Response body of one service call: the `response` object plus the
/// `x-eresult` header Steam uses for validation errors.
struct ApiCall {
    eresult: i64,
    body: Value,
}

impl ApiCall {
    fn response(&self) -> &Value {
        self.body.get("response").unwrap_or(&Value::Null)
    }
}

async fn post_form(
    client: &reqwest::Client,
    method: &str,
    form: &[(String, String)],
) -> Result<ApiCall, String> {
    let url = format!("{API_BASE}/{method}/v1/");
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
        return Err(if status == reqwest::StatusCode::UNAUTHORIZED
            || status == reqwest::StatusCode::FORBIDDEN
        {
            "@t:steam.err.sessionExpired".to_string()
        } else {
            "@t:steam.err.steam".to_string()
        });
    }
    Ok(ApiCall { eresult, body: payload })
}

/// `GetPasswordRSAPublicKey` answers on GET only (Steam rejects it as POST).
async fn get_rsa_key(
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
fn encrypt_password(password: &str, modulus_hex: &str, exponent_hex: &str) -> Result<String, String> {
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

/* ---------- Minimal protobuf writer ---------- */

/// The Web API form parser rejects the nested `device_details` message as a JSON
/// string, so the sign-in request is sent the same way Steam's own clients do:
/// as an `input_protobuf_encoded` payload. Only the handful of fields this
/// module needs are written.
fn put_varint(out: &mut Vec<u8>, mut value: u64) {
    loop {
        let byte = (value & 0x7f) as u8;
        value >>= 7;
        if value == 0 {
            out.push(byte);
            return;
        }
        out.push(byte | 0x80);
    }
}

fn put_string(out: &mut Vec<u8>, field: u32, value: &str) {
    put_varint(out, u64::from(field << 3 | 2));
    put_varint(out, value.len() as u64);
    out.extend_from_slice(value.as_bytes());
}

fn put_bytes(out: &mut Vec<u8>, field: u32, value: &[u8]) {
    put_varint(out, u64::from(field << 3 | 2));
    put_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

fn put_number(out: &mut Vec<u8>, field: u32, value: u64) {
    put_varint(out, u64::from(field << 3));
    put_varint(out, value);
}

/// `CAuthentication_BeginAuthSessionViaCredentials_Request` (see
/// `steammessages_auth.steamclient.proto` field numbers).
fn encode_begin_request(
    account_name: &str,
    encrypted_password: &str,
    timestamp: &str,
    remember: bool,
) -> Vec<u8> {
    let mut out = Vec::new();
    put_string(&mut out, 2, account_name);
    put_string(&mut out, 3, encrypted_password);
    put_number(&mut out, 4, timestamp.parse::<u64>().unwrap_or(0));
    put_number(&mut out, 5, u64::from(remember));
    put_number(&mut out, 6, PLATFORM_TYPE_WEB as u64);
    put_number(&mut out, 7, u64::from(remember));
    put_string(&mut out, 8, WEBSITE_ID);
    let mut device_details = Vec::new();
    put_string(&mut device_details, 1, DEVICE_NAME);
    put_number(&mut device_details, 2, PLATFORM_TYPE_WEB as u64);
    put_bytes(&mut out, 9, &device_details);
    out
}

/// Friendly translation key for a Steam `EResult`.
fn eresult_error(eresult: i64) -> String {
    match eresult {
        5 => "@t:steam.err.invalidPassword",
        63 | 66 | 74 => "@t:steam.err.guardNeeded",
        65 | 71 | 88 => "@t:steam.err.guardInvalid",
        84 | 87 => "@t:steam.err.throttled",
        85 => "@t:steam.err.need2fa",
        101 => "@t:steam.err.captcha",
        17 | 43 | 73 | 114 => "@t:steam.err.account",
        _ => "@t:steam.err.steam",
    }
    .to_string()
}

/* ---------- Response parsing (pure, unit tested) ---------- */

fn parse_begin_response(
    account_name: &str,
    remember: bool,
    response: &Value,
) -> Result<PendingLogin, String> {
    let client_id = field_str(response, "client_id", "clientId");
    let request_id = field_str(response, "request_id", "requestId");
    if client_id.is_empty() || request_id.is_empty() {
        return Err("@t:steam.err.steam".to_string());
    }
    let mut guard_types = Vec::new();
    let mut email_hint = String::new();
    if let Some(confirmations) = field(response, "allowed_confirmations", "allowedConfirmations")
        .and_then(Value::as_array)
    {
        for entry in confirmations {
            let guard = field_i64(entry, "confirmation_type", "confirmationType");
            if guard == GUARD_EMAIL_CODE {
                email_hint = field_str(entry, "associated_message", "associatedMessage");
            }
            guard_types.push(guard);
        }
    }
    let interval = field(response, "interval", "interval")
        .and_then(Value::as_f64)
        .unwrap_or(5.0) as f32;
    Ok(PendingLogin {
        account_name: account_name.to_string(),
        client_id,
        request_id,
        steam_id: field_str(response, "steamid", "steamId"),
        guard_types,
        email_hint,
        interval,
        remember,
        code_sent: false,
    })
}

/// Result of one `PollAuthSessionStatus` call.
enum PollOutcome {
    /// Approved: carry the refresh token.
    Approved {
        account_name: String,
        steam_id: String,
        refresh_token: String,
        access_token: String,
    },
    /// Still waiting; Steam may hand out a fresh client id.
    Waiting { new_client_id: String },
}

fn parse_poll_response(response: &Value, pending: &PendingLogin) -> PollOutcome {
    let refresh_token = field_str(response, "refresh_token", "refreshToken");
    if !refresh_token.is_empty() {
        return PollOutcome::Approved {
            account_name: {
                let name = field_str(response, "account_name", "accountName");
                if name.is_empty() {
                    pending.account_name.clone()
                } else {
                    name
                }
            },
            steam_id: {
                let id = field_str(response, "steamid", "steamId");
                if id.is_empty() {
                    pending.steam_id.clone()
                } else {
                    id
                }
            },
            refresh_token,
            access_token: field_str(response, "access_token", "accessToken"),
        };
    }
    PollOutcome::Waiting { new_client_id: field_str(response, "new_client_id", "newClientId") }
}

/// `GetOwnedGames` payload → flat game list (pure, unit tested).
pub fn parse_owned_games(response: &Value) -> SteamOwnedGames {
    let games = response
        .get("games")
        .and_then(Value::as_array)
        .map(|entries| {
            entries
                .iter()
                .filter_map(|g| {
                    let app_id = field_str(g, "appid", "appId");
                    if app_id.is_empty() {
                        return None;
                    }
                    let icon = field_str(g, "img_icon_url", "imgIconUrl");
                    Some(SteamOwnedGame {
                        name: field_str(g, "name", "name"),
                        playtime_forever: field_i64(g, "playtime_forever", "playtimeForever"),
                        playtime_two_weeks: field_i64(g, "playtime_2weeks", "playtime2weeks"),
                        icon_url: if icon.is_empty() {
                            String::new()
                        } else {
                            format!("https://media.steampowered.com/steamcommunity/public/images/apps/{app_id}/{icon}.jpg")
                        },
                        app_id,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let game_count = field_i64(response, "game_count", "gameCount");
    SteamOwnedGames {
        game_count: if game_count > 0 { game_count } else { games.len() as i64 },
        games,
    }
}

/// Expiry of a JWT access token, in Unix seconds (0 when unreadable).
fn token_exp_secs(token: &str) -> u64 {
    let Some(payload) = token.split('.').nth(1) else { return 0 };
    let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) else {
        return 0;
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { return 0 };
    value.get("exp").and_then(Value::as_u64).unwrap_or(0)
}

/* ---------- DPAPI sealed storage ---------- */

/// Refresh token as written to disk (never plain text).
#[derive(Serialize, Deserialize)]
struct StoredSession {
    account_name: String,
    steam_id: String,
    refresh_token: String,
    saved_at: u64,
}

#[cfg(windows)]
mod dpapi {
    //! Minimal `CryptProtectData` / `CryptUnprotectData` wrapper. The key is
    //! derived from the Windows user account, so a copied file is useless on
    //! another machine or user.

    use std::ffi::c_void;

    /// Win32 `DATA_BLOB`.
    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x01;

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    /// Copies the output blob and frees the buffer Win32 allocated.
    unsafe fn take_blob(blob: DataBlob) -> Vec<u8> {
        let out = if blob.pb_data.is_null() || blob.cb_data == 0 {
            Vec::new()
        } else {
            std::slice::from_raw_parts(blob.pb_data, blob.cb_data as usize).to_vec()
        };
        if !blob.pb_data.is_null() {
            LocalFree(blob.pb_data as *mut c_void);
        }
        out
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob { cb_data: plain.len() as u32, pb_data: plain.as_ptr() as *mut u8 };
        let mut output = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
        let ok = unsafe {
            CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("@t:steam.err.secureStore".to_string());
        }
        Ok(unsafe { take_blob(output) })
    }

    pub fn unprotect(sealed: &[u8]) -> Result<Vec<u8>, String> {
        let input = DataBlob { cb_data: sealed.len() as u32, pb_data: sealed.as_ptr() as *mut u8 };
        let mut output = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err("@t:steam.err.secureStore".to_string());
        }
        Ok(unsafe { take_blob(output) })
    }
}

/// Fallback for non-Windows builds: the launcher targets Windows, and refusing
/// to store is safer than writing a plain token file.
#[cfg(not(windows))]
mod dpapi {
    pub fn protect(_plain: &[u8]) -> Result<Vec<u8>, String> {
        Err("@t:steam.err.secureStore".to_string())
    }
    pub fn unprotect(_sealed: &[u8]) -> Result<Vec<u8>, String> {
        Err("@t:steam.err.secureStore".to_string())
    }
}

fn auth_dir(app: &tauri::AppHandle) -> PathBuf {
    use tauri::Manager;
    let dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("steam");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn token_path(app: &tauri::AppHandle) -> PathBuf {
    auth_dir(app).join("auth.bin")
}

/// Seals the refresh token to disk (DPAPI). Failures are non-fatal: the session
/// stays usable in memory for this run.
fn persist_session(app: &tauri::AppHandle, session: &SteamSession) {
    use zeroize::Zeroizing;
    let stored = StoredSession {
        account_name: session.account_name.clone(),
        steam_id: session.steam_id.clone(),
        refresh_token: session.refresh_token.clone(),
        saved_at: now_secs(),
    };
    let Ok(json) = serde_json::to_vec(&stored).map(Zeroizing::new) else { return };
    let Ok(mut sealed) = dpapi::protect(&json) else { return };
    let path = token_path(app);
    let _ = std::fs::write(&path, &sealed);
    sealed.zeroize();
}

fn remove_stored_session(app: &tauri::AppHandle) {
    let _ = std::fs::remove_file(token_path(app));
}

/// Reads the sealed session back; `None` covers "no file", "another user" and
/// "tampered file".
fn load_stored_session(app: &tauri::AppHandle) -> Option<SteamSession> {
    use zeroize::Zeroizing;
    let sealed = std::fs::read(token_path(app)).ok()?;
    let plain = Zeroizing::new(dpapi::unprotect(&sealed).ok()?);
    let stored: StoredSession = serde_json::from_slice(&plain).ok()?;
    if stored.refresh_token.trim().is_empty() {
        return None;
    }
    Some(SteamSession {
        account_name: stored.account_name,
        steam_id: stored.steam_id,
        refresh_token: stored.refresh_token,
        access_token: None,
        access_token_exp: 0,
    })
}

/// Loads the sealed session once per process, without ever blocking the UI.
fn ensure_disk_checked(app: &tauri::AppHandle) {
    if lock().disk_checked {
        return;
    }
    let stored = load_stored_session(app);
    let mut state = lock();
    state.disk_checked = true;
    if state.session.is_none() {
        state.session = stored;
    }
}

/* ---------- Network steps used by the commands ---------- */

/// 12 random bytes as hex, used as the `sessionid` of the finalize call.
fn random_session_id() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..12).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

/// Percent-decodes a cookie value (`%7C%7C` → `||`). `+` is kept literal:
/// cookies are percent-encoded, not form-encoded.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hi = (bytes[i + 1] as char).to_digit(16);
            let lo = (bytes[i + 2] as char).to_digit(16);
            if let (Some(hi), Some(lo)) = (hi, lo) {
                out.push((hi * 16 + lo) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `steamLoginSecure=<steamid>||<access token>` (percent encoded) → access token.
pub fn cookie_access_token(cookie: &str) -> Option<String> {
    let value = cookie.split(';').next()?.trim();
    let encoded = value
        .strip_prefix("steamLoginSecure=")
        .or_else(|| value.strip_prefix("steamloginsecure="))?;
    let decoded = percent_decode(encoded);
    let (_, token) = decoded.split_once("||")?;
    let token = token.trim();
    if token.is_empty() {
        None
    } else {
        Some(token.to_string())
    }
}

/// `transfer_info` entry that installs the `steamcommunity.com` session cookie.
pub fn settoken_transfer(payload: &Value) -> Option<(String, Vec<(String, String)>)> {
    let transfers = payload.get("transfer_info").and_then(Value::as_array)?;
    let entry = transfers.iter().find(|t| {
        t.get("url")
            .and_then(Value::as_str)
            .map(|url| url.contains("steamcommunity.com/login/settoken"))
            .unwrap_or(false)
    })?;
    let url = entry.get("url").and_then(Value::as_str)?.to_string();
    let params = entry
        .get("params")
        .and_then(Value::as_object)
        .map(|obj| {
            obj.iter()
                .filter_map(|(k, v)| v.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default();
    Some((url, params))
}

/// Mints a web access token the official way: `finalizelogin` → `settoken`
/// sets a `steamLoginSecure` cookie whose value carries `<steamid>||<token>`.
///
/// Valve's 2025-04-30 change made `GenerateAccessTokenForApp` reject
/// WebBrowser refresh tokens (`AccessDenied`), so this is the working path for
/// a web sign-in; `GenerateAccessTokenForApp` stays as a fallback for tokens
/// that still accept it.
async fn finalize_web_login(
    client: &reqwest::Client,
    refresh_token: &str,
    steam_id: &str,
) -> Result<String, String> {
    let form = vec![
        ("nonce".to_string(), refresh_token.to_string()),
        ("sessionid".to_string(), random_session_id()),
        ("redir".to_string(), "https://steamcommunity.com/login/home/?goto=".to_string()),
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
    let (url, params) = settoken_transfer(&payload).ok_or_else(|| "@t:steam.err.steam".to_string())?;

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
async fn generate_access_token(
    client: &reqwest::Client,
    refresh_token: &str,
    steam_id: &str,
) -> Result<String, String> {
    let form = vec![
        ("refresh_token".to_string(), refresh_token.to_string()),
        ("steamid".to_string(), steam_id.to_string()),
    ];
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

/// Every owned game (installed or not), with Steam's own playtime.
async fn fetch_owned_games(
    client: &reqwest::Client,
    access_token: &str,
) -> Result<SteamOwnedGames, String> {
    let response = client
        .get(OWNED_GAMES_URL)
        .query(&[
            ("access_token", access_token),
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
    Ok(parse_owned_games(payload.get("response").unwrap_or(&Value::Null)))
}

/* ---------- Commands ---------- */

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

    // Nested `device_details` forces the protobuf payload form; scalar-only
    // calls below stay plain form fields.
    let request = encode_begin_request(&account_name, &encrypted, &timestamp, remember);
    let form = vec![(
        "input_protobuf_encoded".to_string(),
        base64::engine::general_purpose::STANDARD.encode(request),
    )];
    let call = post_form(&client, "BeginAuthSessionViaCredentials", &form).await?;
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
    let pending = lock().pending.clone().ok_or_else(|| "@t:steam.err.noSession".to_string())?;
    let client = http_client()?;
    let form = vec![
        ("client_id".to_string(), pending.client_id.clone()),
        ("steamid".to_string(), pending.steam_id.clone()),
        ("code".to_string(), code),
        ("code_type".to_string(), pending.code_type().to_string()),
    ];
    let call = post_form(&client, "UpdateAuthSessionWithSteamGuardCode", &form).await?;
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
    let form = vec![
        ("client_id".to_string(), pending.client_id.clone()),
        ("request_id".to_string(), pending.request_id.clone()),
    ];
    let call = post_form(&client, "PollAuthSessionStatus", &form).await?;
    if call.eresult != 1 {
        return Err(eresult_error(call.eresult));
    }
    match parse_poll_response(call.response(), &pending) {
        PollOutcome::Approved { account_name, steam_id, refresh_token, access_token } => {
            let mut session = SteamSession {
                account_name,
                steam_id,
                refresh_token,
                access_token: if access_token.is_empty() { None } else { Some(access_token) },
                access_token_exp: 0,
            };
            if let Some(token) = session.access_token.clone() {
                session.access_token_exp = token_exp_secs(&token);
            }
            if pending.remember {
                persist_session(&app, &session);
            } else {
                // A one-off session must not resurrect an older sealed token.
                remove_stored_session(&app);
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

/// Drops the session: memory first, then the sealed file.
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
    remove_stored_session(&app);
}

/// Every owned game on the signed-in account. The access token is refreshed
/// transparently; expired tokens are retried once with a fresh one.
#[tauri::command]
pub async fn steam_owned_games(app: tauri::AppHandle) -> Result<SteamOwnedGames, String> {
    ensure_disk_checked(&app);

    let cached = {
        let state = lock();
        let Some(session) = state.session.as_ref() else {
            return Err("@t:steam.err.notSignedIn".to_string());
        };
        session.access_token_valid().map(str::to_string)
    };

    let client = http_client()?;
    let token = match cached {
        Some(token) => token,
        None => refresh_access_token(&client).await?,
    };

    match fetch_owned_games(&client, &token).await {
        Err(err) if err == "@t:steam.err.sessionExpired" => {
            let fresh = refresh_access_token(&client).await?;
            fetch_owned_games(&client, &fresh).await
        }
        other => other,
    }
}

/// Mints (and caches in memory) a new access token for the session. The sealed
/// refresh token stays on disk untouched; access tokens are never persisted.
async fn refresh_access_token(client: &reqwest::Client) -> Result<String, String> {
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

#[cfg(test)]
mod tests {
    use super::*;

    fn begin_fixture() -> Value {
        serde_json::json!({
            "client_id": "12345678901234567890",
            "request_id": "q1w2e3r4t5==",
            "interval": 5.0,
            "steamid": "76561199140017878",
            "allowed_confirmations": [
                { "confirmation_type": 3, "associated_message": "" },
                { "confirmation_type": 4, "associated_message": "device" }
            ]
        })
    }

    #[test]
    fn begin_response_maps_to_a_pending_login() {
        let pending = parse_begin_response("efxlve", true, &begin_fixture()).expect("pending");
        assert_eq!(pending.account_name, "efxlve");
        assert_eq!(pending.client_id, "12345678901234567890");
        assert_eq!(pending.steam_id, "76561199140017878");
        assert_eq!(pending.code_type(), GUARD_DEVICE_CODE);
        assert!(pending.needs_code());
        assert!(pending.needs_confirmation());
        assert_eq!(pending.status().state, "code");
    }

    #[test]
    fn begin_response_rejects_incomplete_payloads() {
        assert!(parse_begin_response("x", true, &serde_json::json!({})).is_err());
        assert!(parse_begin_response(
            "x",
            true,
            &serde_json::json!({ "client_id": "1" })
        )
        .is_err());
    }

    #[test]
    fn poll_reports_approval_with_the_refresh_token() {
        let pending = parse_begin_response("efxlve", true, &begin_fixture()).unwrap();
        let response = serde_json::json!({
            "refresh_token": "eyJhbGciOiJ",
            "access_token": "",
            "account_name": "efxlve"
        });
        match parse_poll_response(&response, &pending) {
            PollOutcome::Approved { refresh_token, account_name, .. } => {
                assert_eq!(refresh_token, "eyJhbGciOiJ");
                assert_eq!(account_name, "efxlve");
            }
            PollOutcome::Waiting { .. } => panic!("approved expected"),
        }

        let waiting = serde_json::json!({ "new_client_id": "42" });
        match parse_poll_response(&waiting, &pending) {
            PollOutcome::Waiting { new_client_id } => assert_eq!(new_client_id, "42"),
            PollOutcome::Approved { .. } => panic!("waiting expected"),
        }
    }

    #[test]
    fn begin_request_encodes_the_expected_protobuf_fields() {
        let bytes = encode_begin_request("efxlve", "QUJD", "1700000000", true);
        // Tiny decoder: walk fields in order and collect (number, value).
        fn read_varint(data: &[u8], pos: &mut usize) -> u64 {
            let mut value = 0u64;
            let mut shift = 0;
            loop {
                let byte = data[*pos];
                *pos += 1;
                value |= u64::from(byte & 0x7f) << shift;
                if byte & 0x80 == 0 {
                    return value;
                }
                shift += 7;
            }
        }
        let mut pos = 0;
        let mut strings: Vec<(u64, String)> = Vec::new();
        let mut numbers: Vec<(u64, u64)> = Vec::new();
        let mut details: Option<Vec<u8>> = None;
        while pos < bytes.len() {
            let tag = read_varint(&bytes, &mut pos);
            let (field, wire) = (tag >> 3, tag & 7);
            if wire == 2 {
                let len = read_varint(&bytes, &mut pos) as usize;
                let value = bytes[pos..pos + len].to_vec();
                pos += len;
                if field == 9 {
                    details = Some(value);
                } else {
                    strings.push((field, String::from_utf8(value).unwrap()));
                }
            } else {
                numbers.push((field, read_varint(&bytes, &mut pos)));
            }
        }
        assert_eq!(strings[0], (2, "efxlve".to_string()));
        assert_eq!(strings[1], (3, "QUJD".to_string()));
        assert_eq!(strings[2], (8, WEBSITE_ID.to_string()));
        assert_eq!(numbers[0], (4, 1_700_000_000));
        assert_eq!(numbers[1], (5, 1));
        assert_eq!(numbers[2], (6, PLATFORM_TYPE_WEB as u64));
        assert_eq!(numbers[3], (7, 1));

        let details = details.expect("device_details");
        let mut expected = vec![0x0au8, DEVICE_NAME.len() as u8];
        expected.extend_from_slice(DEVICE_NAME.as_bytes());
        expected.push(0x10); // field 2, varint
        expected.push(PLATFORM_TYPE_WEB as u8);
        assert_eq!(details, expected);
    }

    #[test]
    fn owned_games_payload_is_flattened() {
        let response = serde_json::json!({
            "game_count": 2,
            "games": [
                { "appid": 620, "name": "Portal 2", "playtime_forever": 90, "img_icon_url": "abc" },
                { "appid": 730, "name": "Counter-Strike 2", "playtime_2weeks": 12 }
            ]
        });
        let owned = parse_owned_games(&response);
        assert_eq!(owned.game_count, 2);
        assert_eq!(owned.games.len(), 2);
        assert_eq!(owned.games[0].app_id, "620");
        assert_eq!(owned.games[0].playtime_forever, 90);
        assert!(owned.games[0].icon_url.ends_with("/620/abc.jpg"));
        assert_eq!(owned.games[1].app_id, "730");
        assert_eq!(owned.games[1].playtime_two_weeks, 12);
        assert!(parse_owned_games(&serde_json::json!({})).games.is_empty());
    }

    #[test]
    fn eresult_codes_become_translation_keys() {
        assert_eq!(eresult_error(5), "@t:steam.err.invalidPassword");
        assert_eq!(eresult_error(88), "@t:steam.err.guardInvalid");
        assert_eq!(eresult_error(84), "@t:steam.err.throttled");
        assert_eq!(eresult_error(101), "@t:steam.err.captcha");
        assert_eq!(eresult_error(999), "@t:steam.err.steam");
    }

    #[test]
    fn steam_login_secure_cookie_carries_the_web_access_token() {
        let cookie = "steamLoginSecure=76561199140017878%7C%7CeyJhbGciOiJub25lIn0.abc-123_456%3D%3D; Path=/; Secure; HttpOnly; SameSite=None";
        assert_eq!(
            cookie_access_token(cookie).as_deref(),
            Some("eyJhbGciOiJub25lIn0.abc-123_456==")
        );
        assert!(cookie_access_token("sessionid=abc").is_none());
        assert!(cookie_access_token("steamLoginSecure=7656119%7C%7C").is_none());
        assert_eq!(percent_decode("a%20b%7C%7Cc+d"), "a b||c+d");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn finalize_payload_yields_the_community_transfer() {
        let payload = serde_json::json!({
            "steamID": "76561199140017878",
            "transfer_info": [
                { "url": "https://store.steampowered.com/login/settoken", "params": { "nonce": "n1", "auth": "a1" } },
                { "url": "https://steamcommunity.com/login/settoken", "params": { "nonce": "n2", "auth": "a2" } }
            ]
        });
        let (url, params) = settoken_transfer(&payload).expect("community transfer");
        assert!(url.contains("steamcommunity.com"));
        let mut sorted = params;
        sorted.sort();
        assert_eq!(
            sorted,
            vec![
                ("auth".to_string(), "a2".to_string()),
                ("nonce".to_string(), "n2".to_string())
            ]
        );
        assert!(settoken_transfer(&serde_json::json!({})).is_none());
    }

    #[test]
    fn jwt_expiry_is_read_from_the_payload() {
        let payload = serde_json::json!({ "sub": "76561199140017878", "exp": 1_800_000_000u64 });
        let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&payload).unwrap());
        let token = format!("header.{encoded}.signature");
        assert_eq!(token_exp_secs(&token), 1_800_000_000);
        assert_eq!(token_exp_secs("not-a-jwt"), 0);
    }

    #[test]
    fn rsa_encrypted_password_is_decryptable() {
        use rsa::traits::PublicKeyParts;
        use rsa::{Pkcs1v15Encrypt, RsaPrivateKey};

        let mut rng = rand::thread_rng();
        let private = RsaPrivateKey::new(&mut rng, 512).expect("test key");
        let public = private.to_public_key();
        let modulus = format!("{:x}", public.n());
        let exponent = format!("{:x}", public.e());

        let encoded = encrypt_password("hunter2", &modulus, &exponent).expect("encrypted");
        let ciphertext = base64::engine::general_purpose::STANDARD.decode(encoded).unwrap();
        let plain = private.decrypt(Pkcs1v15Encrypt, &ciphertext).expect("decrypted");
        assert_eq!(String::from_utf8(plain).unwrap(), "hunter2");

        assert!(encrypt_password("x", "not-hex", "010001").is_err());
        assert!(encrypt_password("x", "0b", "0b").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn dpapi_seals_and_opens_roundtrip() {
        let secret = b"refresh-token-value";
        let sealed = dpapi::protect(secret).expect("sealed");
        assert_ne!(sealed, secret);
        assert_eq!(dpapi::unprotect(&sealed).expect("opened"), secret);
        assert!(dpapi::unprotect(b"definitely not sealed").is_err());
    }

    #[test]
    fn missing_session_is_not_signed_in() {
        // Pure parsing path: no disk, no network.
        let state = AuthState::default();
        assert!(state.session.is_none());
        assert!(state.pending.is_none());
    }

    /// Live probe: RSA key fetch + a dummy credential request. A wrong password
    /// is expected (`eresult 5`), which proves the request shape is accepted.
    /// Run: `cargo test live_steam_rsa_probe -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_steam_rsa_probe() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            let client = http_client().unwrap();
            let (modulus, exponent, timestamp) = get_rsa_key(&client, "efxlve").await.unwrap();
            println!("rsa modulus: {} chars, timestamp {timestamp}", modulus.len());
            let encrypted = encrypt_password("definitely-wrong", &modulus, &exponent).unwrap();
            let request = encode_begin_request("efxlve", &encrypted, &timestamp, true);
            let form = vec![(
                "input_protobuf_encoded".to_string(),
                base64::engine::general_purpose::STANDARD.encode(request),
            )];
            let call = post_form(&client, "BeginAuthSessionViaCredentials", &form)
                .await
                .unwrap();
            println!("begin eresult: {} ({})", call.eresult, eresult_error(call.eresult));
            assert!(call.eresult != 1, "a wrong password must not succeed");

            // finalizelogin shape: a dummy refresh token must be rejected with a
            // structured JSON error, not a routing/parse failure.
            let finalize = finalize_web_login(&client, "not-a-real-refresh-token", "76561199140017878").await;
            println!("finalize result: {:?}", finalize);
            assert!(finalize.is_err(), "a dummy refresh token must not mint a token");
        });
    }
}
