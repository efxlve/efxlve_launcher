//! Xbox account sign-in and library import.
//!
//! Microsoft sign-in is a public OAuth client (no secret); the Microsoft token
//! is then exchanged for an Xbox Live (XSTS) token, which authenticates the
//! title-history, user-stats and achievements services. The flow and endpoints
//! follow Playnite's Xbox library and the open `xbox-webapi-python` client.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder, WebviewUrl};

use super::accounts;
use super::ea;
use super::xbox_vault::{self, XboxTokens};
use super::FoundGame;
use crate::legendary::models::GameAchievementsResponse;

const LABEL: &str = "xbox-login";
/// Public client id used by the open-source Xbox clients (Playnite, xbox-webapi).
const CLIENT_ID: &str = "38cd2fa8-66fd-4760-afb2-405eb65d5b0c";
const REDIRECT_URI: &str = "https://login.live.com/oauth20_desktop.srf";
const SCOPE: &str = "Xboxlive.signin Xboxlive.offline_access";
const AUTH_URL: &str = "https://login.live.com/oauth20_authorize.srf";
const TOKEN_URL: &str = "https://login.live.com/oauth20_token.srf";
const USER_AUTH_URL: &str = "https://user.auth.xboxlive.com/user/authenticate";
const XSTS_URL: &str = "https://xsts.auth.xboxlive.com/xsts/authorize";
const TITLEHUB_URL: &str = "https://titlehub.xboxlive.com";
const USERSTATS_URL: &str = "https://userstats.xboxlive.com/batch";
const ACHIEVEMENTS_URL: &str = "https://achievements.xboxlive.com";
const USER_AGENT: &str = "XboxApp/PC/39.39.22001.0";
/// Art preferences of the title-hub image list.
const COVER_KINDS: &[&str] = &["Poster", "BoxArt", "Tile", "SquareArt", "FeaturePromotionalSquareArt"];
const HERO_KINDS: &[&str] = &["Hero", "BrandedKeyArt", "SuperHeroArt", "TransparentKeyArt", "Background"];

/// In-memory copy of the sealed session.
static SESSION: Mutex<Option<XboxTokens>> = Mutex::new(None);
/// Short-lived XSTS token (about an hour); re-issued on demand.
static XSTS: Mutex<Option<Xsts>> = Mutex::new(None);
/// Playtime is asked for on every library paint; cache the batch answer.
static PLAYTIME: Mutex<Option<(std::time::Instant, Vec<(String, u64)>)>> = Mutex::new(None);
const PLAYTIME_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

#[derive(Debug, Clone, Default)]
pub(crate) struct Xsts {
    pub token: String,
    pub uhs: String,
    pub xuid: String,
    pub name: String,
    pub not_after: u64,
}

/// One title from the account's title history.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OwnedGame {
    pub title_id: String,
    pub pfn: String,
    pub name: String,
    pub cover: String,
    pub hero: String,
    pub achievement_current: u32,
    pub achievement_total: u32,
    pub gamerscore: u32,
    pub total_gamerscore: u32,
    /// AUMID of the installed package, empty when the game is not installed.
    #[serde(default)]
    pub aumid: String,
}

fn owned_cache_path() -> PathBuf {
    accounts::data_dir().join("companion_xbox_owned.json")
}

pub(crate) fn cached_owned() -> Vec<OwnedGame> {
    let Ok(text) = std::fs::read_to_string(owned_cache_path()) else {
        return Vec::new();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn save_owned(games: &[OwnedGame]) {
    let path = owned_cache_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(text) = serde_json::to_string(games) {
        let _ = std::fs::write(path, text);
    }
}

pub(crate) fn clear_owned() {
    let _ = std::fs::remove_file(owned_cache_path());
}

/// Drops the in-memory session and XSTS token (used when the account unlinks).
pub(crate) fn clear_session() {
    *SESSION.lock().unwrap() = None;
    *XSTS.lock().unwrap() = None;
    *PLAYTIME.lock().unwrap() = None;
}

/// The cached account row behind a title id (playtime works in title ids).
pub(crate) fn owned_for_title(title_id: &str) -> Option<OwnedGame> {
    cached_owned().into_iter().find(|game| game.title_id == title_id)
}

/// Title id of one library row: account rows use the PFN as their id, local
/// scan rows a name slug, so the cached account list is the bridge.
pub(crate) fn title_id_for(id: &str, title: &str) -> Option<String> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
        return Some(id.to_string());
    }
    let owned = cached_owned();
    if let Some(game) = owned
        .iter()
        .find(|game| !game.pfn.is_empty() && game.pfn.eq_ignore_ascii_case(id))
    {
        if !game.title_id.is_empty() {
            return Some(game.title_id.clone());
        }
    }
    let wanted = ea::normalize_title(title);
    if !wanted.is_empty() {
        if let Some(game) = owned
            .iter()
            .find(|game| ea::normalize_title(&game.name) == wanted)
        {
            if !game.title_id.is_empty() {
                return Some(game.title_id.clone());
            }
        }
    }
    None
}

/* ---------- Session ---------- */

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())
}

fn xbl_header(xsts: &Xsts) -> String {
    format!("XBL3.0 x={};{}", xsts.uhs, xsts.token)
}

/// A usable XSTS token: cached while fresh, otherwise re-issued from the
/// sealed Microsoft refresh token.
pub(crate) async fn ensure_xsts() -> Result<Xsts, String> {
    if let Some(xsts) = XSTS.lock().unwrap().clone() {
        if xsts.not_after > now_secs() + 60 && !xsts.token.is_empty() {
            return Ok(xsts);
        }
    }
    let tokens = {
        let memory = SESSION.lock().unwrap().clone();
        memory.or_else(xbox_vault::load)
    };
    let Some(tokens) = tokens else {
        return Err("@t:accounts.xboxSessionExpired".into());
    };
    if tokens.refresh.is_empty() {
        return Err("@t:accounts.xboxSessionExpired".into());
    }
    let refreshed = refresh_microsoft(&tokens.refresh).await?;
    let xsts = xbl_auth(&refreshed.access).await?;
    let stored = XboxTokens {
        refresh: if refreshed.refresh.is_empty() { tokens.refresh } else { refreshed.refresh },
        name: xsts.name.clone(),
        xuid: xsts.xuid.clone(),
        saved_at: 0,
    };
    xbox_vault::save(&stored);
    *SESSION.lock().unwrap() = Some(stored);
    *XSTS.lock().unwrap() = Some(xsts.clone());
    Ok(xsts)
}

/// One Microsoft OAuth answer.
#[derive(Debug, Clone, Default)]
struct MsTokens {
    access: String,
    refresh: String,
}

async fn exchange_code(code: &str) -> Result<MsTokens, String> {
    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("scope", SCOPE),
        ("client_id", CLIENT_ID),
        ("redirect_uri", REDIRECT_URI),
    ];
    let tokens = token_request(&params).await?;
    // `Xboxlive.offline_access` must have produced a refresh token.
    if tokens.refresh.is_empty() {
        return Err("@t:accounts.xboxLoginFailed".into());
    }
    Ok(tokens)
}

async fn refresh_microsoft(refresh: &str) -> Result<MsTokens, String> {
    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh),
        ("scope", SCOPE),
        ("client_id", CLIENT_ID),
        ("redirect_uri", REDIRECT_URI),
    ];
    token_request(&params).await
}

async fn token_request(params: &[(&str, &str)]) -> Result<MsTokens, String> {
    let response = http_client()?
        .post(TOKEN_URL)
        .form(params)
        .send()
        .await
        .map_err(|_| "@t:accounts.xboxLoginFailed".to_string())?;
    if !response.status().is_success() {
        return Err("@t:accounts.xboxSessionExpired".into());
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "@t:accounts.xboxLoginFailed".to_string())?;
    let access = value.get("access_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let refresh = value.get("refresh_token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if access.is_empty() {
        return Err("@t:accounts.xboxLoginFailed".into());
    }
    Ok(MsTokens { access, refresh })
}

/// Microsoft token → Xbox Live user token → XSTS token.
async fn xbl_auth(access: &str) -> Result<Xsts, String> {
    let client = http_client()?;
    let auth_body = json!({
        "Properties": {
            "AuthMethod": "RPS",
            "SiteName": "user.auth.xboxlive.com",
            "RpsTicket": format!("d={access}")
        },
        "RelyingParty": "http://auth.xboxlive.com",
        "TokenType": "JWT"
    });
    let auth: serde_json::Value = client
        .post(USER_AUTH_URL)
        .header("x-xbl-contract-version", "1")
        .json(&auth_body)
        .send()
        .await
        .map_err(|_| "@t:accounts.xboxLoginFailed".to_string())?
        .json()
        .await
        .map_err(|_| "@t:accounts.xboxLoginFailed".to_string())?;
    let user_token = auth.get("Token").and_then(|v| v.as_str()).unwrap_or("");
    if user_token.is_empty() {
        return Err("@t:accounts.xboxLoginFailed".into());
    }

    let xsts_body = json!({
        "Properties": { "SandboxId": "RETAIL", "UserTokens": [user_token] },
        "RelyingParty": "http://xboxlive.com",
        "TokenType": "JWT"
    });
    let response = client
        .post(XSTS_URL)
        .header("x-xbl-contract-version", "1")
        .json(&xsts_body)
        .send()
        .await
        .map_err(|_| "@t:accounts.xboxLoginFailed".to_string())?;
    if !response.status().is_success() {
        // 401 carries an XErr code (no Xbox profile, child account, ...).
        return Err("@t:accounts.xboxLoginFailed".into());
    }
    let xsts: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "@t:accounts.xboxLoginFailed".to_string())?;
    let token = xsts.get("Token").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let xui = xsts
        .pointer("/DisplayClaims/xui/0")
        .cloned()
        .unwrap_or_default();
    let uhs = xui.get("uhs").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let xuid = xui.get("xid").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let name = xui.get("gtg").and_then(|v| v.as_str()).unwrap_or("").to_string();
    if token.is_empty() || uhs.is_empty() {
        return Err("@t:accounts.xboxLoginFailed".into());
    }
    Ok(Xsts {
        token,
        uhs,
        xuid,
        name,
        // XSTS tokens last for hours; re-issue after one to stay well inside.
        not_after: now_secs() + 3600,
    })
}

/* ---------- Sign-in window ---------- */

const WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__efxlveXboxWatch) return;
  window.__efxlveXboxWatch = true;
  function addClose() {
    if (document.getElementById("efxlve-xbox-close")) return;
    var button = document.createElement("button");
    button.id = "efxlve-xbox-close";
    button.type = "button";
    button.textContent = "\u2715";
    button.title = "Close";
    button.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:2147483647;width:32px;height:32px;" +
      "border:0;border-radius:50%;background:rgba(20,20,20,.72);color:#fff;font-size:15px;" +
      "line-height:32px;cursor:pointer;padding:0;";
    button.addEventListener("click", function () {
      location.href = "https://efxlve.local/xbox-cancel";
    });
    (document.body || document.documentElement).appendChild(button);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", addClose);
  } else {
    addClose();
  }
  setInterval(addClose, 1500);
})();
"#;

fn auth_url() -> Result<String, String> {
    let mut url = url::Url::parse(AUTH_URL).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("client_id", CLIENT_ID)
        .append_pair("response_type", "code")
        .append_pair("approval_prompt", "auto")
        .append_pair("scope", SCOPE)
        .append_pair("redirect_uri", REDIRECT_URI);
    Ok(url.to_string())
}

/// Opens the Microsoft sign-in page over the main window.
pub async fn open_login(app: AppHandle) -> Result<(), String> {
    let url = url::Url::parse(&auth_url()?).map_err(|e| e.to_string())?;
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    if let Some(webview) = window.get_webview(LABEL) {
        let _ = webview.close();
    }
    let (x, y, width, height) = centered(&window);
    let app_nav = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .background_color(tauri::webview::Color(0, 0, 0, 255))
        .initialization_script(WATCH_SCRIPT)
        .on_navigation(move |target| {
            if target.scheme() == "https"
                && target.host_str() == Some("efxlve.local")
                && target.path() == "/xbox-cancel"
            {
                hide_login(&app_nav);
                return false;
            }
            // The OAuth redirect comes back to login.live.com with the code.
            if target.scheme() == "https"
                && target.host_str() == Some("login.live.com")
                && target.path() == "/oauth20_desktop.srf"
            {
                let code = target
                    .query_pairs()
                    .find(|(key, _)| key == "code")
                    .map(|(_, value)| value.to_string());
                if let Some(code) = code {
                    accept_code(&app_nav, code);
                } else {
                    fail(&app_nav, "@t:accounts.xboxLoginFailed");
                }
                return false;
            }
            true
        });
    let pos = Position::Logical(LogicalPosition::new(x, y));
    let size = Size::Logical(LogicalSize::new(width, height));
    let handle = tokio::task::spawn_blocking(move || window.add_child(builder, pos, size));
    match tokio::time::timeout(std::time::Duration::from_secs(20), handle).await {
        Ok(Ok(Ok(_))) => Ok(()),
        Ok(Ok(Err(e))) => Err(e.to_string()),
        Ok(Err(_)) => Err("@t:store.viewCreateFailed".into()),
        Err(_) => Err("@t:store.viewTimeout".into()),
    }
}

fn centered(window: &tauri::Window) -> (f64, f64, f64, f64) {
    let mut width = 490.0f64;
    let mut height = 700.0f64;
    let mut x = 60.0f64;
    let mut y = 40.0f64;
    if let (Ok(size), Ok(scale)) = (window.inner_size(), window.scale_factor()) {
        let logical_w = size.width as f64 / scale;
        let logical_h = size.height as f64 / scale;
        width = width.min(logical_w - 24.0).max(320.0);
        height = height.min(logical_h - 24.0).max(360.0);
        x = ((logical_w - width) / 2.0).max(0.0);
        y = ((logical_h - height) / 2.0).max(0.0);
    }
    (x, y, width, height)
}

pub fn hide_login(app: &AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    if let Some(webview) = window.get_webview(LABEL) {
        let _ = webview.close();
    }
}

fn fail(app: &AppHandle, message: &str) {
    let _ = app.emit("companion-signin-failed", message.to_string());
}

fn accept_code(app: &AppHandle, code: String) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = import(&code).await;
        match result {
            Ok(count) if count > 0 => {
                let _ = app.emit(
                    "companion-signed-in",
                    serde_json::json!({ "store": "xbox", "count": count }),
                );
            }
            Ok(_) => fail(&app, "@t:accounts.xboxNoGames"),
            Err(message) => fail(&app, &message),
        }
        hide_login(&app);
    });
}

async fn import(code: &str) -> Result<usize, String> {
    let ms = exchange_code(code).await?;
    let xsts = xbl_auth(&ms.access).await?;
    let name = if xsts.name.trim().is_empty() {
        "Xbox".to_string()
    } else {
        xsts.name.clone()
    };
    let stored = XboxTokens {
        refresh: ms.refresh,
        name: name.clone(),
        xuid: xsts.xuid.clone(),
        saved_at: 0,
    };
    xbox_vault::save(&stored);
    *SESSION.lock().unwrap() = Some(stored);
    *XSTS.lock().unwrap() = Some(xsts);
    let _ = accounts::link_named("xbox", &name);
    let count = sync_owned().await?;
    Ok(count)
}

/* ---------- Library ---------- */

/// Refreshes the title history and the local install map.
pub(crate) async fn sync_owned() -> Result<usize, String> {
    let xsts = match ensure_xsts().await {
        Ok(xsts) => xsts,
        Err(message) => {
            let _ = accounts::mark_needs_login("xbox", true);
            return Err(message);
        }
    };
    let apps = start_apps();
    let mut games = fetch_titles(&xsts, &apps).await?;
    for game in &mut games {
        if let Some(aumid) = apps.get(&game.pfn.to_lowercase()) {
            game.aumid = aumid.clone();
        }
    }
    save_owned(&games);
    let _ = accounts::mark_needs_login("xbox", false);
    Ok(games.len())
}

/// PC titles from the account's title history, plus installed Store games the
/// history does not cover yet (never played).
async fn fetch_titles(xsts: &Xsts, apps: &HashMap<String, String>) -> Result<Vec<OwnedGame>, String> {
    let client = http_client()?;
    let url = format!(
        "{TITLEHUB_URL}/users/xuid({})/titles/titlehistory/decoration/achievement,image,detail?maxItems=1000",
        xsts.xuid
    );
    let response = client
        .get(url)
        .header("Authorization", xbl_header(xsts))
        .header("x-xbl-contract-version", "2")
        .header("Accept-Language", "en-US")
        .send()
        .await
        .map_err(|_| "@t:accounts.xboxSessionExpired".to_string())?;
    if !response.status().is_success() {
        return Err("@t:accounts.xboxSessionExpired".into());
    }
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let mut games = parse_titles(&value);
    let known: std::collections::HashSet<String> =
        games.iter().map(|game| game.pfn.to_lowercase()).collect();

    // Installed Store packages that never appeared in the history: one batch
    // lookup tells which of them are games.
    let mut missing: Vec<String> = apps
        .keys()
        .filter(|pfn| !pfn.is_empty() && !known.contains(*pfn) && plausible_game_pfn(pfn))
        .take(60)
        .cloned()
        .collect();
    missing.sort();
    if !missing.is_empty() {
        let body = json!({ "pfns": missing, "windowsPhoneProductIds": [] });
        if let Ok(response) = client
            .post(format!("{TITLEHUB_URL}/titles/batch/decoration/achievement,image,detail"))
            .header("Authorization", xbl_header(xsts))
            .header("x-xbl-contract-version", "2")
            .header("Accept-Language", "en-US")
            .json(&body)
            .send()
            .await
        {
            if let Ok(value) = response.json::<serde_json::Value>().await {
                let extra = parse_titles(&value);
                let mut seen: std::collections::HashSet<String> =
                    games.iter().map(|game| game.pfn.to_lowercase()).collect();
                for game in extra {
                    if seen.insert(game.pfn.to_lowercase()) {
                        games.push(game);
                    }
                }
            }
        }
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(games)
}

/// System packages are never games; skip them before the batch lookup.
fn plausible_game_pfn(pfn: &str) -> bool {
    let lower = pfn.to_lowercase();
    !lower.starts_with("microsoft.windows")
        && !lower.starts_with("microsoft.xbox")
        && !lower.starts_with("microsoft.gamingapp")
        && !lower.starts_with("microsoft.storepurchaseapp")
        && !lower.starts_with("microsoft.ui")
        && !lower.starts_with("microsoft.edge")
        && !lower.starts_with("microsoft.office")
}

/// Titles that are PC games: `titlehistory/decoration` answers with apps too.
pub(crate) fn parse_titles(value: &serde_json::Value) -> Vec<OwnedGame> {
    let Some(titles) = value.get("titles").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut games = Vec::new();
    for title in titles {
        if title.get("type").and_then(|v| v.as_str()) != Some("Game") {
            continue;
        }
        let devices = title.get("devices").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let is_pc = devices
            .iter()
            .any(|device| device.as_str() == Some("PC"));
        if !is_pc {
            continue;
        }
        let pfn = title.get("pfn").and_then(|v| v.as_str()).unwrap_or("").to_string();
        if pfn.is_empty() {
            continue;
        }
        let raw_name = title.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let name = clean_title(raw_name);
        if name.is_empty() {
            continue;
        }
        let images: Vec<serde_json::Value> = title
            .get("images")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let display_image = title.get("displayImage").and_then(|v| v.as_str()).unwrap_or("");
        let cover = {
            let picked = pick_image(&images, COVER_KINDS);
            if picked.is_empty() { display_image.to_string() } else { picked }
        };
        let achievement = title.get("achievement").cloned().unwrap_or_default();
        games.push(OwnedGame {
            title_id: title.get("titleId").and_then(|v| v.as_str()).unwrap_or("").to_string(),
            pfn,
            name,
            cover,
            hero: pick_image(&images, HERO_KINDS),
            achievement_current: achievement
                .get("currentAchievements")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            achievement_total: achievement
                .get("totalAchievements")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            gamerscore: achievement
                .get("currentGamerscore")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            total_gamerscore: achievement
                .get("totalGamerscore")
                .and_then(|v| v.as_u64())
                .unwrap_or(0) as u32,
            aumid: String::new(),
        });
    }
    games
}

/// Playnite strips the PC suffixes and trademark symbols from Xbox titles.
pub(crate) fn clean_title(name: &str) -> String {
    let mut out = name.trim().to_string();
    for suffix in ["(PC)", "(Windows)", "for Windows 10", "- Windows 10"] {
        if let Some(stripped) = out.strip_suffix(suffix) {
            out = stripped.trim().to_string();
        }
    }
    out
        .replace(['\u{2122}', '\u{00ae}', '\u{00a9}'], "")
        .trim()
        .to_string()
}

/// First URL of an image with one of the preferred purposes.
pub(crate) fn pick_image(images: &[serde_json::Value], kinds: &[&str]) -> String {
    for kind in kinds {
        for image in images {
            let matches = image
                .get("type")
                .and_then(|v| v.as_str())
                .map(|value| value.eq_ignore_ascii_case(kind))
                .unwrap_or(false);
            if !matches {
                continue;
            }
            if let Some(url) = image.get("url").and_then(|v| v.as_str()) {
                if !url.is_empty() {
                    return url.to_string();
                }
            }
        }
    }
    String::new()
}

/// `Get-StartApps` answers with every Start-menu entry; Store packages have the
/// `<PFN>!<AppId>` shape. The map is PFN (lowercase) → AUMID.
#[cfg(windows)]
pub(crate) fn start_apps() -> HashMap<String, String> {
    use std::os::windows::process::CommandExt;
    let mut cmd = std::process::Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        "Get-StartApps | Select-Object -ExpandProperty AppID",
    ]);
    cmd.creation_flags(0x0800_0000);
    let Ok(output) = cmd.output() else {
        return HashMap::new();
    };
    let mut map = HashMap::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let aumid = line.trim();
        if !safe_aumid(aumid) {
            continue;
        }
        if let Some((pfn, _)) = aumid.split_once('!') {
            map.insert(pfn.to_lowercase(), aumid.to_string());
        }
    }
    map
}

#[cfg(not(windows))]
pub(crate) fn start_apps() -> HashMap<String, String> {
    HashMap::new()
}

/// `<PFN>!<AppId>` with plain identifier characters only.
pub(crate) fn safe_aumid(aumid: &str) -> bool {
    if aumid.len() > 300 || !aumid.contains('!') {
        return false;
    }
    let identifier = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    match aumid.split_once('!') {
        Some((pfn, app)) => identifier(pfn) && identifier(app),
        None => false,
    }
}

/// Installed titles from the local scan plus the account's PC titles.
pub(crate) fn merged_games(installed: &[FoundGame]) -> Vec<FoundGame> {
    let mut games: Vec<FoundGame> = installed
        .iter()
        .filter(|game| game.store == "xbox")
        .cloned()
        .collect();
    for owned in cached_owned() {
        let title = ea::normalize_title(&owned.name);
        let existing = games.iter_mut().find(|game| {
            !title.is_empty() && ea::normalize_title(&game.name) == title
        });
        if let Some(game) = existing {
            if !owned.cover.is_empty() {
                game.cover_url = owned.cover.clone();
            }
            if !owned.hero.is_empty() {
                game.hero_url = owned.hero.clone();
            }
            if !owned.aumid.is_empty() && game.launch_exe.is_empty() && game.launch_uri.is_empty() {
                game.launch_uri = format!("aumid:{}", owned.aumid);
            }
            continue;
        }
        if owned.pfn.is_empty() {
            continue;
        }
        games.push(FoundGame {
            store: "xbox".into(),
            id: owned.pfn.clone(),
            name: owned.name.clone(),
            install_path: String::new(),
            installed: false,
            store_id: String::new(),
            launch_exe: String::new(),
            launch_uri: if owned.aumid.is_empty() {
                String::new()
            } else {
                format!("aumid:{}", owned.aumid)
            },
            install_uri: format!("ms-windows-store://pdp/?PFN={}", owned.pfn),
            uninstall_uri: String::new(),
            cover_url: owned.cover.clone(),
            hero_url: owned.hero.clone(),
            description: String::new(),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    games
}

/* ---------- Playtime ---------- */

/// `MinutesPlayed` per title id, straight from the account service.
pub(crate) async fn fetch_playtimes() -> Result<Vec<(String, u64)>, String> {
    if let Some((at, rows)) = PLAYTIME.lock().unwrap().as_ref() {
        if at.elapsed() < PLAYTIME_TTL {
            return Ok(rows.clone());
        }
    }
    let xsts = ensure_xsts().await?;
    let mut ids: Vec<String> = cached_owned()
        .into_iter()
        .filter(|game| !game.title_id.is_empty())
        .map(|game| game.title_id)
        .collect();
    ids.sort();
    ids.dedup();
    if ids.is_empty() {
        return Ok(Vec::new());
    }
    let mut rows = Vec::new();
    for chunk in ids.chunks(100) {
        let stats: Vec<serde_json::Value> = chunk
            .iter()
            .map(|id| json!({ "name": "MinutesPlayed", "titleid": id }))
            .collect();
        let body = json!({
            "arrangebyfield": "xuid",
            "stats": stats,
            "xuids": [xsts.xuid]
        });
        let Ok(response) = http_client()?
            .post(USERSTATS_URL)
            .header("Authorization", xbl_header(&xsts))
            .header("x-xbl-contract-version", "2")
            .json(&body)
            .send()
            .await
        else {
            continue;
        };
        let Ok(value) = response.json::<serde_json::Value>().await else {
            continue;
        };
        rows.extend(parse_playtime_batch(&value));
    }
    *PLAYTIME.lock().unwrap() = Some((std::time::Instant::now(), rows.clone()));
    Ok(rows)
}

/// `statlistscollection[0].stats[]` → (title id, seconds).
pub(crate) fn parse_playtime_batch(value: &serde_json::Value) -> Vec<(String, u64)> {
    let mut rows = Vec::new();
    let Some(collections) = value.get("statlistscollection").and_then(|v| v.as_array()) else {
        return rows;
    };
    for collection in collections {
        let Some(stats) = collection.get("stats").and_then(|v| v.as_array()) else {
            continue;
        };
        for stat in stats {
            if stat.get("name").and_then(|v| v.as_str()) != Some("MinutesPlayed") {
                continue;
            }
            let title_id = stat.get("titleid").and_then(|v| v.as_str()).unwrap_or("");
            let minutes = stat
                .get("value")
                .and_then(|v| v.as_str())
                .and_then(|text| text.parse::<u64>().ok())
                .unwrap_or(0);
            if !title_id.is_empty() && minutes > 0 {
                rows.push((title_id.to_string(), minutes * 60));
            }
        }
    }
    rows
}

/* ---------- Achievements ---------- */

/// Achievement list of one title, shaped like the other stores' data.
pub(crate) async fn achievements(title_id: &str) -> GameAchievementsResponse {
    if title_id.is_empty() || !title_id.chars().all(|c| c.is_ascii_digit()) {
        return GameAchievementsResponse::default();
    }
    let Ok(xsts) = ensure_xsts().await else {
        return GameAchievementsResponse::default();
    };
    let url = format!(
        "{ACHIEVEMENTS_URL}/users/xuid({})/achievements?titleId={title_id}&maxItems=1000",
        xsts.xuid
    );
    let Ok(client) = http_client() else {
        return GameAchievementsResponse::default();
    };
    let Ok(response) = client
        .get(url)
        .header("Authorization", xbl_header(&xsts))
        .header("x-xbl-contract-version", "2")
        .header("Accept-Language", "en-US")
        .send()
        .await
    else {
        return GameAchievementsResponse::default();
    };
    let Ok(value) = response.json::<serde_json::Value>().await else {
        return GameAchievementsResponse::default();
    };
    achievements_from_json(&value)
}

/// Maps the achievements endpoint answer to the shared model: names,
/// descriptions, unlock times, gamerscore and the icon media asset.
pub(crate) fn achievements_from_json(value: &serde_json::Value) -> GameAchievementsResponse {
    let Some(list) = value.get("achievements").and_then(|v| v.as_array()) else {
        return GameAchievementsResponse::default();
    };
    let mut total_xp = 0u32;
    let mut user_xp = 0u32;
    let mut unlocked_count = 0u32;
    let mut achievements = Vec::new();
    for achievement in list {
        let name = achievement.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if name.is_empty() {
            continue;
        }
        let unlocked = achievement.get("progressState").and_then(|v| v.as_str()) == Some("Achieved");
        let description = achievement
            .get("description")
            .and_then(|v| v.as_str())
            .or_else(|| achievement.get("lockedDescription").and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim()
            .to_string();
        let unlock_date = if unlocked {
            achievement
                .pointer("/progression/timeUnlocked")
                .and_then(|v| v.as_str())
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty() && !text.starts_with("0001-01-01"))
        } else {
            None
        };
        let gamerscore: u32 = achievement
            .get("rewards")
            .and_then(|v| v.as_array())
            .map(|rewards| {
                rewards
                    .iter()
                    .filter(|reward| reward.get("type").and_then(|v| v.as_str()) == Some("Gamerscore"))
                    .filter_map(|reward| reward.get("value").and_then(|v| v.as_str()))
                    .filter_map(|value| value.parse::<u32>().ok())
                    .sum()
            })
            .unwrap_or(0);
        let icon = achievement
            .get("mediaAssets")
            .and_then(|v| v.as_array())
            .map(|assets| {
                assets
                    .iter()
                    .find(|asset| asset.get("type").and_then(|v| v.as_str()) == Some("Icon"))
                    .or_else(|| assets.first())
                    .and_then(|asset| asset.get("url").and_then(|v| v.as_str()))
                    .unwrap_or("")
                    .to_string()
            })
            .unwrap_or_default();
        total_xp = total_xp.saturating_add(gamerscore);
        if unlocked {
            user_xp = user_xp.saturating_add(gamerscore);
            unlocked_count += 1;
        }
        achievements.push(crate::legendary::models::AchievementItem {
            name: name.clone(),
            display_name: name,
            description,
            xp: gamerscore,
            unlocked,
            progress: if unlocked { 1.0 } else { 0.0 },
            unlock_date,
            icon_id: String::new(),
            icon_link: icon,
            tier: None,
            rarity: None,
            hidden: achievement.get("isSecret").and_then(|v| v.as_bool()).unwrap_or(false),
            is_base: true,
        });
    }
    let total = achievements.len() as u32;
    GameAchievementsResponse {
        achievements,
        user_unlocked: unlocked_count,
        user_xp,
        total_achievements: total,
        total_xp,
        supported: Some(total > 0),
        ..Default::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pc_suffixes_and_symbols_are_stripped() {
        assert_eq!(clean_title("Forza Horizon 5 (PC)"), "Forza Horizon 5");
        assert_eq!(clean_title("Halo Infinite for Windows 10"), "Halo Infinite");
        assert_eq!(clean_title("Gears 5\u{2122}"), "Gears 5");
        assert_eq!(clean_title("  Sea of Thieves  "), "Sea of Thieves");
    }

    #[test]
    fn cover_prefers_the_poster_and_hero_prefers_the_wide_art() {
        let images = vec![
            json!({"url": "https://x/tile.png", "type": "Tile"}),
            json!({"url": "https://x/poster.png", "type": "Poster"}),
            json!({"url": "https://x/hero.png", "type": "Hero"}),
            json!({"url": "https://x/box.png", "type": "BoxArt"}),
        ];
        assert_eq!(pick_image(&images, COVER_KINDS), "https://x/poster.png");
        assert_eq!(pick_image(&images, HERO_KINDS), "https://x/hero.png");
        assert_eq!(pick_image(&[], COVER_KINDS), "");
    }

    #[test]
    fn title_history_keeps_pc_games_only() {
        let value = json!({
            "titles": [
                {
                    "titleId": "123",
                    "pfn": "Microsoft.ForzaHorizon5_8wekyb3d8bbwe",
                    "name": "Forza Horizon 5 (PC)",
                    "type": "Game",
                    "devices": ["PC"],
                    "images": [
                        {"url": "https://x/poster.png", "type": "Poster"},
                        {"url": "https://x/hero.png", "type": "Hero"}
                    ],
                    "achievement": {
                        "currentAchievements": 10,
                        "totalAchievements": 50,
                        "currentGamerscore": 200,
                        "totalGamerscore": 1000
                    }
                },
                {
                    "titleId": "456",
                    "pfn": "Microsoft.SomeApp_8wekyb3d8bbwe",
                    "name": "Some App",
                    "type": "Application",
                    "devices": ["PC"]
                },
                {
                    "titleId": "789",
                    "pfn": "Microsoft.ConsoleOnly_8wekyb3d8bbwe",
                    "name": "Console Only",
                    "type": "Game",
                    "devices": ["XboxOne"]
                }
            ]
        });
        let games = parse_titles(&value);
        assert_eq!(games.len(), 1);
        let game = &games[0];
        assert_eq!(game.name, "Forza Horizon 5");
        assert_eq!(game.cover, "https://x/poster.png");
        assert_eq!(game.hero, "https://x/hero.png");
        assert_eq!(game.achievement_current, 10);
        assert_eq!(game.total_gamerscore, 1000);
    }

    #[test]
    fn aumids_are_plain_identifiers() {
        assert!(safe_aumid("Microsoft.ForzaHorizon5_8wekyb3d8bbwe!ForzaHorizon5"));
        assert!(!safe_aumid("Microsoft.ForzaHorizon5_8wekyb3d8bbwe"));
        assert!(!safe_aumid("Microsoft.X_8wekyb3d8bbwe!App Id"));
        assert!(!safe_aumid(""));
    }

    #[test]
    fn playtime_batch_reads_minutes() {
        let value = json!({
            "statlistscollection": [
                {
                    "stats": [
                        {"name": "MinutesPlayed", "titleid": "123", "value": "90"},
                        {"name": "MinutesPlayed", "titleid": "456", "value": "0"}
                    ]
                }
            ]
        });
        let rows = parse_playtime_batch(&value);
        assert_eq!(rows, vec![("123".to_string(), 5400)]);
    }

    #[test]
    fn achievements_read_names_icons_and_gamerscore() {
        let value = json!({
            "achievements": [
                {
                    "name": "First Steps",
                    "description": "Finish the tutorial",
                    "progressState": "Achieved",
                    "isSecret": false,
                    "progression": {"timeUnlocked": "2024-05-06T07:08:09.000Z"},
                    "mediaAssets": [
                        {"name": "icon", "type": "Icon", "url": "https://x/ach.png"}
                    ],
                    "rewards": [
                        {"type": "Gamerscore", "value": "50"}
                    ]
                },
                {
                    "name": "Secret Thing",
                    "lockedDescription": "This is secret",
                    "progressState": "NotStarted",
                    "isSecret": true,
                    "progression": {"timeUnlocked": "0001-01-01T00:00:00Z"},
                    "rewards": [{"type": "Gamerscore", "value": "25"}]
                }
            ]
        });
        let response = achievements_from_json(&value);
        assert_eq!(response.total_achievements, 2);
        assert_eq!(response.user_unlocked, 1);
        assert_eq!(response.user_xp, 50);
        assert_eq!(response.total_xp, 75);
        assert_eq!(response.achievements[0].icon_link, "https://x/ach.png");
        assert_eq!(
            response.achievements[0].unlock_date.as_deref(),
            Some("2024-05-06T07:08:09.000Z")
        );
        assert!(response.achievements[1].hidden);
        assert_eq!(response.achievements[1].unlock_date, None);
    }
}
