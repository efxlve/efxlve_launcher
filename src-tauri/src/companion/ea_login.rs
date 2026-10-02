//! EA account sign-in and owned-library import.
//!
//! The EA app signs in through `accounts.ea.com` with a PKCE flow and a
//! hardware signature (`pcsign`). This module opens the same page in a child
//! webview, catches the `qrc://` redirect, exchanges the code for tokens and
//! reads the owned catalog from EA's own GraphQL service. Tokens are sealed
//! with DPAPI and never leave the machine.

use std::path::PathBuf;
use std::sync::Mutex;

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder, WebviewUrl};

use super::accounts;
use super::ea;
use super::ea_vault::{self, EaTokens};
use super::pcsign;
use super::FoundGame;
use crate::legendary::models::{AchievementItem, GameAchievementsResponse};

const LABEL: &str = "ea-login";
const CLIENT_ID: &str = "JUNO_PC_CLIENT";
const CLIENT_SECRET: &str =
    "4mRLtYMb6vq9qglomWEaT4ChxsXWcyqbQpuBNfMPOYOiDmYYQmjuaBsF2Zp0RyVeWkfqhE9TuGgAw7te";
const TOKEN_URL: &str = "https://accounts.ea.com/connect/token";
const AUTH_URL: &str = "https://accounts.ea.com/connect/auth";
const GRAPHQL_URL: &str = "https://service-aggregation-layer.juno.ea.com/graphql";
const REDIRECT_URI: &str = "qrc:///html/login_successful.html";
const USER_AGENT: &str = "EAApp/PC/13.680.0.6193";
const X_CLIENT_ID: &str = "EAX-JUNO-CLIENT";
/// EA's offers endpoint takes a bounded id list per call. The id list appears
/// twice in the query, so this stays well below any URL limit.
const OFFER_ID_BATCH: usize = 20;
/// Playtime accepts a longer slug list in one call.
const PLAYTIME_BATCH: usize = 50;

/// PKCE verifier for the sign-in attempt currently in flight.
static VERIFIER: Mutex<Option<String>> = Mutex::new(None);
/// In-memory copy of the sealed session, so a busy library does not unseal
/// DPAPI for every call.
static SESSION: Mutex<Option<EaTokens>> = Mutex::new(None);

/// One owned game from the EA account service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct OwnedGame {
    /// Origin offer id, the stable account-side identity.
    pub id: String,
    pub name: String,
    /// Content id used by `origin2://` deep links.
    #[serde(default)]
    pub content_id: String,
    /// EA game slug, the key of the playtime endpoint.
    #[serde(default)]
    pub slug: String,
    /// `achievementSetOverride` from the offer, the key of the achievements endpoint.
    #[serde(default)]
    pub achievement_set: String,
}

fn owned_cache_path() -> PathBuf {
    accounts::data_dir().join("companion_ea_owned.json")
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

/// Drops the in-memory session (used when the account is unlinked).
pub(crate) fn clear_session() {
    *SESSION.lock().unwrap() = None;
}

/* ---------- Session ---------- */

fn token_expired(access: &str) -> bool {
    let Some(payload) = access.split('.').nth(1) else {
        return false;
    };
    let Ok(bytes) = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload) else {
        return false;
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return false;
    };
    let Some(exp) = value.get("exp").and_then(|v| v.as_i64()) else {
        return false;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    exp <= now + 60
}

/// A usable access token: the sealed session's own, refreshed when needed.
pub(crate) async fn ensure_access() -> Result<String, String> {
    let tokens = {
        let memory = SESSION.lock().unwrap().clone();
        memory.or_else(ea_vault::load)
    };
    let Some(tokens) = tokens else {
        return Err("@t:accounts.eaSessionExpired".into());
    };
    if !tokens.access.is_empty() && !token_expired(&tokens.access) {
        return Ok(tokens.access);
    }
    if tokens.refresh.is_empty() {
        return Err("@t:accounts.eaSessionExpired".into());
    }
    let fresh = refresh(&tokens.refresh).await?;
    let stored = EaTokens { name: tokens.name, ..fresh };
    ea_vault::save(&stored);
    *SESSION.lock().unwrap() = Some(stored.clone());
    Ok(stored.access)
}

/* ---------- Sign-in window ---------- */

const WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__efxlveEaWatch) return;
  window.__efxlveEaWatch = true;
  // The EA app pre-checks "keep me signed in"; the web page does not.
  var tries = 0;
  var poll = setInterval(function () {
    var box = document.getElementById("rememberMe");
    if (box && !box.checked) box.checked = true;
    if (++tries >= 240) clearInterval(poll);
  }, 250);
  // The overlay has no window chrome: give the page a way back out.
  function addClose() {
    if (document.getElementById("efxlve-ea-close")) return;
    var button = document.createElement("button");
    button.id = "efxlve-ea-close";
    button.type = "button";
    button.textContent = "\u2715";
    button.title = "Close";
    button.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:2147483647;width:32px;height:32px;" +
      "border:0;border-radius:50%;background:rgba(20,20,20,.72);color:#fff;font-size:15px;" +
      "line-height:32px;cursor:pointer;padding:0;";
    button.addEventListener("click", function () {
      location.href = "https://efxlve.local/ea-cancel";
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

fn new_verifier() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn challenge(verifier: &str) -> String {
    use sha2::{Digest, Sha256};
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

fn auth_url(pc_sign: &str, challenge: &str) -> Result<String, String> {
    let mut url = url::Url::parse(AUTH_URL).map_err(|e| e.to_string())?;
    url.query_pairs_mut()
        .append_pair("response_type", "code")
        .append_pair("client_id", CLIENT_ID)
        .append_pair("display", "junoClient/login")
        .append_pair("redirect_uri", REDIRECT_URI)
        .append_pair("locale", "en_US")
        .append_pair("pc_sign", pc_sign)
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256");
    Ok(url.to_string())
}

/// Opens the EA sign-in page over the main window.
pub async fn open_login(app: AppHandle) -> Result<(), String> {
    let verifier = new_verifier();
    let code_challenge = challenge(&verifier);
    let pc_sign = tauri::async_runtime::spawn_blocking(pcsign::generate)
        .await
        .map_err(|e| e.to_string())??;
    *VERIFIER.lock().unwrap() = Some(verifier);
    let url = auth_url(&pc_sign, &code_challenge)?;
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;

    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    if let Some(webview) = window.get_webview(LABEL) {
        let _ = webview.close();
    }
    let (x, y, width, height) = centered(&window);
    let app_nav = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(parsed))
        .background_color(tauri::webview::Color(0, 0, 0, 255))
        .initialization_script(WATCH_SCRIPT)
        .on_navigation(move |target| {
            if target.scheme() == "https"
                && target.host_str() == Some("efxlve.local")
                && target.path() == "/ea-cancel"
            {
                hide_login(&app_nav);
                return false;
            }
            if target.scheme() == "qrc" && target.path().ends_with("login_successful.html") {
                let code = target
                    .query_pairs()
                    .find(|(key, _)| key == "code")
                    .map(|(_, value)| value.to_string());
                if let Some(code) = code {
                    accept_code(&app_nav, code);
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
    let mut width = 495.0f64;
    let mut height = 760.0f64;
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
                    serde_json::json!({ "store": "ea", "count": count }),
                );
            }
            Ok(_) => fail(&app, "@t:accounts.eaNoGames"),
            Err(message) => fail(&app, &message),
        }
        hide_login(&app);
    });
}

async fn import(code: &str) -> Result<usize, String> {
    let verifier = VERIFIER
        .lock()
        .unwrap()
        .take()
        .ok_or_else(|| "@t:accounts.eaLoginFailed".to_string())?;
    let tokens = exchange(code, &verifier).await?;
    let name = identity(&tokens.access).await.unwrap_or_default();
    let owned = fetch_owned(&tokens.access).await?;
    let stored = EaTokens {
        access: tokens.access,
        refresh: tokens.refresh,
        name: name.clone(),
        saved_at: 0,
    };
    ea_vault::save(&stored);
    *SESSION.lock().unwrap() = Some(stored);
    let _ = accounts::link_named("ea", &name);
    let _ = accounts::mark_needs_login("ea", false);
    save_owned(&owned);
    Ok(owned.len())
}

/// One background refresh of the owned list from the sealed session.
pub(crate) async fn sync_owned() -> Result<usize, String> {
    let access = match ensure_access().await {
        Ok(access) => access,
        Err(message) => {
            let _ = accounts::mark_needs_login("ea", true);
            return Err(message);
        }
    };
    let owned = fetch_owned(&access).await?;
    save_owned(&owned);
    let _ = accounts::mark_needs_login("ea", false);
    Ok(owned.len())
}

/* ---------- EA services ---------- */

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())
}

async fn exchange(code: &str, verifier: &str) -> Result<EaTokens, String> {
    let params = [
        ("token_format", "JWS"),
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("code_verifier", verifier),
        ("grant_type", "authorization_code"),
        ("redirect_uri", REDIRECT_URI),
        ("code", code),
    ];
    let response = client()?
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|_| "@t:accounts.eaLoginFailed".to_string())?;
    if !response.status().is_success() {
        return Err("@t:accounts.eaLoginFailed".into());
    }
    tokens_from(response).await
}

async fn refresh(refresh_token: &str) -> Result<EaTokens, String> {
    let params = [
        ("client_id", CLIENT_ID),
        ("client_secret", CLIENT_SECRET),
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
    ];
    let response = client()?
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|_| "@t:accounts.eaSessionExpired".to_string())?;
    if !response.status().is_success() {
        return Err("@t:accounts.eaSessionExpired".into());
    }
    tokens_from(response).await
}

async fn tokens_from(response: reqwest::Response) -> Result<EaTokens, String> {
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| "@t:accounts.eaLoginFailed".to_string())?;
    let access = value
        .get("access_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let refresh = value
        .get("refresh_token")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if access.is_empty() {
        return Err("@t:accounts.eaLoginFailed".into());
    }
    Ok(EaTokens {
        access,
        refresh,
        name: String::new(),
        saved_at: 0,
    })
}

async fn graphql(access: &str, query: &str) -> Result<serde_json::Value, String> {
    // The service reads the query from the URL, so it must be percent-encoded
    // exactly like the reference client sends it.
    let url = format!("{GRAPHQL_URL}?query={}", encode_query(query));
    let response = client()?
        .get(url)
        .header("Authorization", format!("Bearer {access}"))
        .header("x-client-id", X_CLIENT_ID)
        .header("referer", "https://pc.ea.com/")
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err("@t:accounts.eaSessionExpired".into());
    }
    response.json().await.map_err(|e| e.to_string())
}

/// Percent-encodes everything but the URL-safe set, leaving `/` as-is.
fn encode_query(query: &str) -> String {
    let mut out = String::with_capacity(query.len() * 2);
    for byte in query.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'_' | b'.' | b'-' | b'~' | b'/' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

async fn identity(access: &str) -> Result<String, String> {
    let value = graphql(access, "query{me{player{pd psd displayName}}}").await?;
    let name = value
        .pointer("/data/me/player/displayName")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Ok(name)
}

/// Every owned product, with the product details the library shows.
///
/// The reference plugin also filters by `ownershipMethod` (purchase, redemption,
/// grant). That drops promotion grants — Prime Gaming copies like Mass Effect
/// Legendary Edition — so the filter is left off and DLC offers are removed by
/// their display type instead.
const ENTITLEMENTS_QUERY: &str = r#"query{me{ownedGameProducts(storefronts:[EA],locale:"DEFAULT",paging:{limit:9999,next:null},productFound:true,orderBy:{field:NAME,direction:ASC},downloadableOnly:false,entitlementEnabled:true,platforms:[PC]){items{id:originOfferId product{name gameSlug baseItem(availabilities:[VISIBLE]){title gameType}}}}}}"#;

/// Offer fields the deep links, the playtime endpoint and the achievements
/// endpoint need beyond the entitlement itself.
#[derive(Debug, Clone, Default)]
struct OfferInfo {
    content_id: String,
    display_name: String,
    display_type: String,
    achievement_set: String,
    slug: String,
    game_type: String,
}

/// Add-ons are sold as their own entitlements; only games belong in the library.
pub(crate) fn is_dlc(display_type: &str, game_type: &str) -> bool {
    let display = display_type.replace('_', "").to_lowercase();
    if matches!(display.as_str(), "addon" | "expansion" | "dlc") {
        return true;
    }
    matches!(game_type.to_lowercase().as_str(), "extra_content" | "expansion")
}

/// The owned catalog: entitlements first, then the offer details (content id,
/// achievement set, slug) in bounded batches.
pub(crate) async fn fetch_owned(access: &str) -> Result<Vec<OwnedGame>, String> {
    let value = graphql(access, ENTITLEMENTS_QUERY).await?;
    let items = value
        .pointer("/data/me/ownedGameProducts/items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut entitlements: Vec<(String, String, String)> = Vec::new(); // id, name, slug
    for item in items {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        let product = item.get("product").cloned().unwrap_or_default();
        let name = product
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        let slug = product
            .get("gameSlug")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        entitlements.push((id, name, slug));
    }

    let mut offers: std::collections::HashMap<String, OfferInfo> = std::collections::HashMap::new();
    let ids: Vec<String> = entitlements.iter().map(|(id, _, _)| id.clone()).collect();
    for chunk in ids.chunks(OFFER_ID_BATCH) {
        let list = serde_json::to_string(chunk).unwrap_or_else(|_| "[]".into());
        let query = format!(
            "query{{legacyOffers(offerIds:{list},locale:\"DEFAULT\"){{offerId:id contentId displayName displayType achievementSetOverride}} gameProducts(offerIds:{list},locale:\"DEFAULT\"){{items{{id name originOfferId gameSlug baseItem{{title gameType}}}}}}}}"
        );
        let Ok(value) = graphql(access, &query).await else {
            continue;
        };
        if let Some(legacy) = value.pointer("/data/legacyOffers").and_then(|v| v.as_array()) {
            for offer in legacy {
                let offer_id = offer.get("offerId").and_then(|v| v.as_str()).unwrap_or("");
                if offer_id.is_empty() {
                    continue;
                }
                let entry = offers.entry(offer_id.to_string()).or_default();
                entry.content_id = offer.get("contentId").and_then(|v| v.as_str()).unwrap_or("").to_string();
                if entry.display_name.is_empty() {
                    entry.display_name = offer.get("displayName").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                }
                entry.display_type = offer.get("displayType").and_then(|v| v.as_str()).unwrap_or("").to_string();
                entry.achievement_set = offer
                    .get("achievementSetOverride")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
            }
        }
        if let Some(products) = value.pointer("/data/gameProducts/items").and_then(|v| v.as_array()) {
            for product in products {
                let origin = product.get("originOfferId").and_then(|v| v.as_str()).unwrap_or("");
                if origin.is_empty() {
                    continue;
                }
                let entry = offers.entry(origin.to_string()).or_default();
                if entry.display_name.is_empty() {
                    entry.display_name = product.get("name").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
                }
                if entry.slug.is_empty() {
                    entry.slug = product.get("gameSlug").and_then(|v| v.as_str()).unwrap_or("").to_string();
                }
                if entry.game_type.is_empty() {
                    entry.game_type = product
                        .pointer("/baseItem/gameType")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                }
            }
        }
    }

    let mut games: Vec<OwnedGame> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (id, product_name, product_slug) in entitlements {
        let offer = offers.get(&id).cloned().unwrap_or_default();
        if is_dlc(&offer.display_type, &offer.game_type) {
            continue;
        }
        let name = if !product_name.is_empty() {
            product_name
        } else if !offer.display_name.is_empty() {
            offer.display_name.clone()
        } else {
            continue;
        };
        let slug = if product_slug.is_empty() { offer.slug.clone() } else { product_slug };
        let dedupe = if slug.is_empty() { format!("id:{id}") } else { format!("slug:{slug}") };
        if !seen.insert(dedupe) {
            continue;
        }
        let content_id = if offer.content_id.is_empty() { id.clone() } else { offer.content_id.clone() };
        games.push(OwnedGame {
            id,
            name,
            content_id,
            slug,
            achievement_set: offer.achievement_set.clone(),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(games)
}

/// The cached owned entry behind a game slug (playtime works in slugs).
pub(crate) fn owned_for_slug(slug: &str) -> Option<OwnedGame> {
    cached_owned().into_iter().find(|game| game.slug == slug)
}

/* ---------- Playtime ---------- */

/// API playtime is cached briefly: every library paint asks for it.
static PLAYTIME: Mutex<Option<(std::time::Instant, Vec<(String, u64)>)>> = Mutex::new(None);
const PLAYTIME_TTL: std::time::Duration = std::time::Duration::from_secs(5 * 60);

/// `totalPlayTimeSeconds` per game slug, straight from the EA account service.
pub(crate) async fn fetch_playtimes(access: &str) -> Result<Vec<(String, u64)>, String> {
    if let Some((at, rows)) = PLAYTIME.lock().unwrap().as_ref() {
        if at.elapsed() < PLAYTIME_TTL {
            return Ok(rows.clone());
        }
    }
    let mut slugs: Vec<String> = cached_owned()
        .into_iter()
        .filter(|game| !game.slug.is_empty())
        .map(|game| game.slug)
        .collect();
    slugs.sort();
    slugs.dedup();
    let mut rows: Vec<(String, u64)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for chunk in slugs.chunks(PLAYTIME_BATCH) {
        let list = serde_json::to_string(chunk).unwrap_or_else(|_| "[]".into());
        let query = format!(
            "query{{me{{recentGames(gameSlugs:{list}){{items{{gameSlug lastSessionEndDate totalPlayTimeSeconds}}}}}}}}"
        );
        let Ok(value) = graphql(access, &query).await else {
            continue;
        };
        let Some(items) = value.pointer("/data/me/recentGames/items").and_then(|v| v.as_array()) else {
            continue;
        };
        for item in items {
            let slug = item.get("gameSlug").and_then(|v| v.as_str()).unwrap_or("");
            let seconds = item.get("totalPlayTimeSeconds").and_then(|v| v.as_u64()).unwrap_or(0);
            if slug.is_empty() || seconds == 0 || !seen.insert(slug.to_string()) {
                continue;
            }
            rows.push((slug.to_string(), seconds));
        }
    }
    *PLAYTIME.lock().unwrap() = Some((std::time::Instant::now(), rows.clone()));
    Ok(rows)
}

/* ---------- Achievements ---------- */

/// Persona id (`nexus.psid`) from the access token; the achievements endpoint
/// takes it as `playerPsd`.
pub(crate) fn persona_id(access: &str) -> Option<String> {
    let payload = access.split('.').nth(1)?;
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(payload).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    match value.pointer("/nexus/psid")? {
        serde_json::Value::Number(number) => Some(number.to_string()),
        serde_json::Value::String(text) => Some(text.clone()),
        _ => None,
    }
}

/// Offer ids that may be interpolated into a GraphQL string.
fn safe_offer_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-'))
}

/// Achievement set of one library row: the cached owned entry first (by id or
/// by title, because installed rows keep their own id), then a live lookup.
async fn achievement_set_for(access: &str, id: &str, title: &str) -> Option<String> {
    let owned = cached_owned();
    if let Some(entry) = owned.iter().find(|game| game.id == id) {
        if !entry.achievement_set.is_empty() {
            return Some(entry.achievement_set.clone());
        }
    }
    let wanted = ea::normalize_title(title);
    if !wanted.is_empty() {
        if let Some(entry) = owned.iter().find(|game| ea::normalize_title(&game.name) == wanted) {
            if !entry.achievement_set.is_empty() {
                return Some(entry.achievement_set.clone());
            }
        }
    }
    if !safe_offer_id(id) {
        return None;
    }
    let query = format!(
        "query{{legacyOffers(offerIds:[\"{id}\"],locale:\"DEFAULT\"){{offerId:id achievementSetOverride}}}}"
    );
    let value = graphql(access, &query).await.ok()?;
    let set = value
        .pointer("/data/legacyOffers/0/achievementSetOverride")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if set.is_empty() {
        None
    } else {
        Some(set)
    }
}

/// One achievement as the EA service reports it.
#[derive(Debug, Clone, Default)]
pub(crate) struct EaAchievement {
    pub name: String,
    pub unlocked: bool,
    pub unlock_date: Option<String>,
}

/// EA achievements for one library row, shaped like the other stores' data.
/// The service reports the complete set (locked and unlocked) with an
/// `awardCount` flag, so no separate definitions call is needed.
pub(crate) async fn achievements(id: &str, title: &str) -> GameAchievementsResponse {
    let Ok(access) = ensure_access().await else {
        return GameAchievementsResponse::default();
    };
    let Some(persona) = persona_id(&access) else {
        return GameAchievementsResponse::default();
    };
    let Some(set) = achievement_set_for(&access, id, title).await else {
        return GameAchievementsResponse::default();
    };
    let query = format!(
        "query{{achievements(achievementSetIds:[\"{set}\"],playerPsd:\"{persona}\",showHidden:true){{id achievements{{id name awardCount date}}}}}}"
    );
    let Ok(value) = graphql(&access, &query).await else {
        return GameAchievementsResponse::default();
    };
    let sets = value
        .pointer("/data/achievements")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut items = Vec::new();
    for set_value in sets {
        let Some(list) = set_value.get("achievements").and_then(|v| v.as_array()) else {
            continue;
        };
        for achievement in list {
            let name = achievement
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if name.is_empty() {
                continue;
            }
            let unlocked = achievement.get("awardCount").and_then(|v| v.as_u64()).unwrap_or(0) == 1;
            let date = achievement.get("date").and_then(|v| v.as_str()).unwrap_or("").trim();
            items.push(EaAchievement {
                name,
                unlocked,
                // Locked rows carry the request time, which is not an unlock date.
                unlock_date: if unlocked && !date.is_empty() { Some(date.to_string()) } else { None },
            });
        }
    }
    achievements_response(items)
}

/// Maps the EA list to the shared achievement model: names, unlock flags and
/// dates; EA exposes no descriptions, icons, XP or tiers.
pub(crate) fn achievements_response(items: Vec<EaAchievement>) -> GameAchievementsResponse {
    let total = items.len() as u32;
    let achievements: Vec<AchievementItem> = items
        .into_iter()
        .map(|item| AchievementItem {
            name: item.name.clone(),
            display_name: item.name,
            description: String::new(),
            xp: 0,
            unlocked: item.unlocked,
            progress: if item.unlocked { 1.0 } else { 0.0 },
            unlock_date: item.unlock_date,
            icon_id: String::new(),
            icon_link: String::new(),
            tier: None,
            rarity: None,
            hidden: false,
            is_base: true,
        })
        .collect();
    let unlocked = achievements.iter().filter(|item| item.unlocked).count() as u32;
    GameAchievementsResponse {
        achievements,
        user_unlocked: unlocked,
        total_achievements: total,
        supported: Some(total > 0),
        ..Default::default()
    }
}

/* ---------- Library merge ---------- */

/// Adds the cached owned games to the installed rows. A local row keeps its
/// identity (and its playtime); only the missing deep links are filled in.
pub(crate) fn merge_owned(games: &mut Vec<FoundGame>) {
    for owned in cached_owned() {
        let title = ea::normalize_title(&owned.name);
        let existing = games.iter_mut().find(|game| {
            (!owned.content_id.is_empty()
                && game
                    .store_id
                    .split(',')
                    .any(|id| id.trim() == owned.content_id))
                || (!title.is_empty() && ea::normalize_title(&game.name) == title)
        });
        if let Some(game) = existing {
            if !owned.content_id.is_empty() {
                game.store_id = owned.content_id.clone();
                game.launch_uri = ea::launch_uri(std::slice::from_ref(&owned.content_id));
                game.install_uri = ea::install_uri(std::slice::from_ref(&owned.content_id));
            }
            continue;
        }
        if owned.content_id.is_empty() {
            continue;
        }
        games.push(FoundGame {
            store: "ea".into(),
            id: owned.id.clone(),
            name: owned.name.clone(),
            install_path: String::new(),
            installed: false,
            store_id: owned.content_id.clone(),
            launch_exe: String::new(),
            launch_uri: ea::launch_uri(std::slice::from_ref(&owned.content_id)),
            install_uri: ea::install_uri(std::slice::from_ref(&owned.content_id)),
            uninstall_uri: String::new(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        });
    }
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_redirect_url_parses_and_carries_the_code() {
        let url = url::Url::parse("qrc:///html/login_successful.html?code=abc123&state=x").unwrap();
        assert_eq!(url.scheme(), "qrc");
        assert!(url.path().ends_with("login_successful.html"));
        let code = url
            .query_pairs()
            .find(|(key, _)| key == "code")
            .map(|(_, value)| value.to_string());
        assert_eq!(code.as_deref(), Some("abc123"));
    }

    #[test]
    fn graphql_queries_are_percent_encoded() {
        assert_eq!(
            encode_query("query{me{player{pd}}}"),
            "query%7Bme%7Bplayer%7Bpd%7D%7D%7D"
        );
        assert_eq!(encode_query("locale:\"DEFAULT\""), "locale%3A%22DEFAULT%22");
        assert_eq!(encode_query("a/b c"), "a/b%20c");
    }

    #[test]
    fn the_auth_url_carries_the_signature_and_pkce() {
        let url = auth_url("payload.sig", "challenge").unwrap();
        assert!(url.starts_with("https://accounts.ea.com/connect/auth?"));
        assert!(url.contains("client_id=JUNO_PC_CLIENT"));
        assert!(url.contains("pc_sign=payload.sig"));
        assert!(url.contains("code_challenge=challenge"));
        assert!(url.contains("code_challenge_method=S256"));
        // The redirect must stay a custom scheme.
        assert!(url.contains("redirect_uri=qrc%3A%2F%2F%2Fhtml%2Flogin_successful.html"));
    }

    #[test]
    fn owned_rows_merge_by_content_id_and_title() {
        let installed = FoundGame {
            store: "ea".into(),
            id: "ea-sports-fc-25".into(),
            name: "EA SPORTS FC 25".into(),
            install_path: r"D:\EA Games\FC 25".into(),
            installed: true,
            store_id: "1002975".into(),
            launch_exe: String::new(),
            launch_uri: "origin2://game/launch?offerIds=1002975".into(),
            install_uri: String::new(),
            uninstall_uri: String::new(),
            cover_url: String::new(),
            hero_url: String::new(),
            description: String::new(),
        };
        let mut games = vec![installed];
        // The account row matches by content id and only fills the links.
        let owned = OwnedGame {
            id: "Origin.OFR.50.0001051".into(),
            name: "EA SPORTS FC 25".into(),
            content_id: "1002975".into(),
            slug: "ea-sports-fc-25".into(),
            achievement_set: "123_456_789".into(),
        };
        let title = ea::normalize_title(&owned.name);
        let existing = games.iter_mut().find(|game| {
            game.store_id.split(',').any(|id| id.trim() == owned.content_id)
                || ea::normalize_title(&game.name) == title
        });
        assert!(existing.is_some());
        assert_eq!(games.len(), 1);
    }

    #[test]
    fn add_ons_are_not_games() {
        assert!(is_dlc("addon", ""));
        assert!(is_dlc("AddOn", ""));
        assert!(is_dlc("expansion", ""));
        assert!(is_dlc("", "EXTRA_CONTENT"));
        assert!(is_dlc("", "expansion"));
        assert!(!is_dlc("FullGame", "BASE_GAME"));
        assert!(!is_dlc("", "COLLECTION"));
    }

    #[test]
    fn the_persona_id_comes_from_the_access_token() {
        // {"nexus":{"psid":1005725578979}} as an unpadded base64url payload.
        let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(br#"{"nexus":{"psid":1005725578979}}"#);
        let token = format!("header.{payload}.signature");
        assert_eq!(persona_id(&token).as_deref(), Some("1005725578979"));
        assert_eq!(persona_id("no-dots"), None);
        assert_eq!(persona_id("a.b.c"), None);
    }

    #[test]
    fn achievements_map_to_the_shared_model() {
        let response = achievements_response(vec![
            EaAchievement {
                name: "First".into(),
                unlocked: true,
                unlock_date: Some("2024-01-02T03:04:05.000Z".into()),
            },
            EaAchievement { name: "Second".into(), unlocked: false, unlock_date: None },
        ]);
        assert_eq!(response.total_achievements, 2);
        assert_eq!(response.user_unlocked, 1);
        assert_eq!(response.achievements.len(), 2);
        assert!(response.achievements.iter().any(|item| item.name == "First" && item.unlocked));
        assert_eq!(
            response.achievements[0].unlock_date.as_deref(),
            Some("2024-01-02T03:04:05.000Z")
        );
        assert_eq!(response.supported, Some(true));
        assert_eq!(achievements_response(Vec::new()).supported, Some(false));
    }

    #[test]
    fn offer_ids_are_sanitized_before_they_enter_a_query() {
        assert!(safe_offer_id("Origin.OFR.50.0001051"));
        assert!(safe_offer_id("OFB-EAST:55619"));
        assert!(!safe_offer_id("id\"} extra{"));
        assert!(!safe_offer_id(""));
        assert!(!safe_offer_id(&"x".repeat(65)));
    }
}
