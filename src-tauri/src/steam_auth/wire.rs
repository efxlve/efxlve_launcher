//! Steam sign-in protobuf bodies and response parsers.
//!
//! Owns field encoding and the JWT claim read. No disk, no password, no HTTP.

use base64::Engine;
use serde_json::Value;

use super::*;

/* ---------- Minimal protobuf writer ---------- */

/// The Web API form parser rejects the nested `device_details` message as a JSON
/// string, so the sign-in request is sent the same way Steam's own clients do:
/// as an `input_protobuf_encoded` payload. Only the handful of fields this
/// module needs are written.
pub fn put_varint(out: &mut Vec<u8>, mut value: u64) {
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

pub fn put_string(out: &mut Vec<u8>, field: u32, value: &str) {
    put_varint(out, u64::from(field << 3 | 2));
    put_varint(out, value.len() as u64);
    out.extend_from_slice(value.as_bytes());
}

pub fn put_bytes(out: &mut Vec<u8>, field: u32, value: &[u8]) {
    put_varint(out, u64::from(field << 3 | 2));
    put_varint(out, value.len() as u64);
    out.extend_from_slice(value);
}

pub fn put_number(out: &mut Vec<u8>, field: u32, value: u64) {
    put_varint(out, u64::from(field << 3));
    put_varint(out, value);
}

/// `fixed64` fields (`steamid`) are 8 little-endian bytes on the wire.
pub fn put_fixed64(out: &mut Vec<u8>, field: u32, value: u64) {
    put_varint(out, u64::from(field << 3 | 1));
    out.extend_from_slice(&value.to_le_bytes());
}

/// One `input_protobuf_encoded` form body, the way Steam's clients send it.
pub fn protobuf_payload(bytes: &[u8]) -> Vec<(String, String)> {
    vec![(
        "input_protobuf_encoded".to_string(),
        base64::engine::general_purpose::STANDARD.encode(bytes),
    )]
}

/// Protobuf JSON encodes `bytes` as base64; URL-safe input is tolerated.
pub fn decode_base64_bytes(value: &str) -> Vec<u8> {
    use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
    STANDARD
        .decode(value)
        .or_else(|_| URL_SAFE_NO_PAD.decode(value))
        .unwrap_or_default()
}

/// `CAuthentication_BeginAuthSessionViaCredentials_Request` (see
/// `steammessages_auth.steamclient.proto` field numbers).
pub fn encode_begin_request(
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

/// `CAuthentication_BeginAuthSessionViaQR_Request`. The QR flow approves on the
/// phone, so no password or guard code is involved.
pub fn encode_qr_begin_request() -> Vec<u8> {
    let mut out = Vec::new();
    put_string(&mut out, 1, DEVICE_NAME);
    put_number(&mut out, 2, PLATFORM_TYPE_WEB as u64);
    let mut device_details = Vec::new();
    put_string(&mut device_details, 1, DEVICE_NAME);
    put_number(&mut device_details, 2, PLATFORM_TYPE_WEB as u64);
    put_bytes(&mut out, 3, &device_details);
    put_string(&mut out, 4, WEBSITE_ID);
    out
}

/// `CAuthentication_PollAuthSessionStatus_Request`. `request_id` must be the
/// exact raw bytes Steam issued, so it cannot travel as a form string.
pub fn encode_poll_request(client_id: &str, request_id: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    put_number(&mut out, 1, client_id.parse::<u64>().unwrap_or(0));
    put_bytes(&mut out, 2, request_id);
    out
}

/// `CAuthentication_UpdateAuthSessionWithSteamGuardCode_Request`.
pub fn encode_guard_code_request(
    client_id: &str,
    steam_id: &str,
    code: &str,
    code_type: i64,
) -> Vec<u8> {
    let mut out = Vec::new();
    put_number(&mut out, 1, client_id.parse::<u64>().unwrap_or(0));
    put_fixed64(&mut out, 2, steam_id.parse::<u64>().unwrap_or(0));
    put_string(&mut out, 3, code);
    put_number(&mut out, 4, code_type as u64);
    out
}

/// `CAuthentication_AccessToken_GenerateForApp_Request`.
pub fn encode_generate_request(refresh_token: &str, steam_id: &str) -> Vec<u8> {
    let mut out = Vec::new();
    put_string(&mut out, 1, refresh_token);
    put_fixed64(&mut out, 2, steam_id.parse::<u64>().unwrap_or(0));
    out
}

/// Friendly translation key for a Steam `EResult`. Unknown codes keep their
/// number in the message: a screenshot is then enough to diagnose without any
/// raw Steam payload reaching the UI.
pub fn eresult_error(eresult: i64) -> String {
    match eresult {
        5 => "@t:steam.err.invalidPassword".to_string(),
        63 | 66 | 74 => "@t:steam.err.guardNeeded".to_string(),
        65 | 71 | 88 => "@t:steam.err.guardInvalid".to_string(),
        84 | 87 => "@t:steam.err.throttled".to_string(),
        85 => "@t:steam.err.need2fa".to_string(),
        101 => "@t:steam.err.captcha".to_string(),
        17 | 43 | 73 | 114 => "@t:steam.err.account".to_string(),
        3 | 16 | 20 | 35 | 36 => "@t:steam.err.network".to_string(),
        9 => "@t:steam.err.sessionNotFound".to_string(),
        _ => format!("@t:steam.err.steam\u{1f}{eresult}"),
    }
}

/* ---------- Response parsing (pure, unit tested) ---------- */

pub fn parse_begin_response(
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
    if let Some(confirmations) =
        field(response, "allowed_confirmations", "allowedConfirmations").and_then(Value::as_array)
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
        qr: false,
    })
}

/// Result of one `PollAuthSessionStatus` call.
pub enum PollOutcome {
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

pub fn parse_poll_response(response: &Value, pending: &PendingLogin) -> PollOutcome {
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
                if !id.is_empty() {
                    id
                } else if !pending.steam_id.is_empty() {
                    pending.steam_id.clone()
                } else {
                    // QR sessions never see a steamid before approval; the
                    // refresh token carries it in its `sub` claim.
                    jwt_sub(&refresh_token).unwrap_or_default()
                }
            },
            refresh_token,
            access_token: field_str(response, "access_token", "accessToken"),
        };
    }
    PollOutcome::Waiting {
        new_client_id: field_str(response, "new_client_id", "newClientId"),
    }
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
        game_count: if game_count > 0 {
            game_count
        } else {
            games.len() as i64
        },
        games,
    }
}

/// Expiry of a JWT access token, in Unix seconds (0 when unreadable).
pub fn token_exp_secs(token: &str) -> u64 {
    jwt_claim(token, "exp")
        .and_then(|v| v.as_u64())
        .unwrap_or(0)
}

/// Subject (`sub`) claim of a JWT — the SteamID64 a token belongs to.
pub fn jwt_sub(token: &str) -> Option<String> {
    jwt_claim(token, "sub").and_then(|v| v.as_str().map(str::to_string))
}

/// One claim from a JWT payload (base64url, no signature check needed: Steam
/// issued the token and the API rejects invalid ones).
pub fn jwt_claim(token: &str, claim: &str) -> Option<Value> {
    let payload = token.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(payload)
        .ok()?;
    let value = serde_json::from_slice::<Value>(&bytes).ok()?;
    value.get(claim).cloned()
}
