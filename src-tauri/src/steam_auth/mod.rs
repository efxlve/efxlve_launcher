//! Steam account sign-in and the owned-games read.
//!
//! Callers still use `steam_auth::steam_login_begin` and the other commands.
//!
//! | File | Owns |
//! |---|---|
//! | `wire.rs` | protobuf request bodies and response parsers |
//! | `vault.rs` | DPAPI-sealed refresh tokens |
//! | `session.rs` | the sign-in commands and HTTPS calls |
//!
//! The password is never stored or logged. Refresh tokens are sealed with
//! DPAPI. Access tokens stay in memory. UI errors are `@t:steam.err.*` keys.

use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::Serialize;

pub const API_BASE: &str = "https://api.steampowered.com/IAuthenticationService";
pub const OWNED_GAMES_URL: &str = "https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/";
pub const HTTP_TIMEOUT_SECS: u64 = 12;
/// `EAuthTokenPlatformType.WebBrowser` — what the Steam community site sends.
pub const PLATFORM_TYPE_WEB: i64 = 2;
pub const WEBSITE_ID: &str = "Community";
/// The device name Steam shows in its own "authorized devices" list.
pub const DEVICE_NAME: &str = "efxlve-launcher";

/// `EAuthSessionGuardType` values we react to.
pub const GUARD_EMAIL_CODE: i64 = 2;
pub const GUARD_DEVICE_CODE: i64 = 3;
pub const GUARD_DEVICE_CONFIRMATION: i64 = 4;
pub const GUARD_EMAIL_CONFIRMATION: i64 = 5;

/// One in-flight sign-in kept between the `begin` / `code` / `status` commands.
#[derive(Clone, Default)]
pub struct PendingLogin {
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
    /// True for the QR flow: the phone approves, so there is no local code step.
    qr: bool,
}

impl PendingLogin {
    fn needs_code(&self) -> bool {
        self.guard_types.contains(&GUARD_EMAIL_CODE)
            || self.guard_types.contains(&GUARD_DEVICE_CODE)
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
        let state = if self.qr || self.code_sent {
            "pending"
        } else if self.needs_code() {
            "code"
        } else if self.needs_confirmation() {
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
            confirm: self.needs_confirmation(),
        }
    }
}

/// A signed-in Steam account. The refresh token stays in memory while the app
/// runs and is sealed to disk only when "keep this session" was checked.
pub struct SteamSession {
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
pub struct AuthState {
    pending: Option<PendingLogin>,
    session: Option<SteamSession>,
    /// Whether `<app_data>/steam/auth.bin` has been checked this process.
    disk_checked: bool,
}

pub static AUTH: Mutex<AuthState> = Mutex::new(AuthState {
    pending: None,
    session: None,
    disk_checked: false,
});

/// Poison-resistant lock: a panic elsewhere must not take sign-in down.
pub fn lock() -> std::sync::MutexGuard<'static, AuthState> {
    AUTH.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn now_secs() -> u64 {
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
    /// Steam also accepts a one-tap approval in the mobile app (or an email
    /// link) for this session, so the code is optional.
    pub confirm: bool,
}

impl SteamLoginStatus {
    fn idle() -> Self {
        Self {
            state: "idle".into(),
            account_name: String::new(),
            steam_id: String::new(),
            email_hint: String::new(),
            interval: 0.0,
            confirm: false,
        }
    }

    fn signed_in(session: &SteamSession) -> Self {
        Self {
            state: "signed_in".into(),
            account_name: session.account_name.clone(),
            steam_id: session.steam_id.clone(),
            email_hint: String::new(),
            interval: 0.0,
            confirm: false,
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

mod session;
mod vault;
mod wire;

#[allow(unused_imports)]
pub use session::*;
#[allow(unused_imports)]
pub use vault::*;
#[allow(unused_imports)]
pub use wire::*;

#[cfg(test)]
mod tests;
