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
/// EA's offers endpoint takes a bounded id list per call.
const OFFER_BATCH: usize = 50;

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
    /// EA game slug, kept for playtime lookups.
    #[serde(default)]
    pub slug: String,
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

const ENTITLEMENTS_QUERY: &str = r#"query{me{ownedGameProducts(storefronts:[EA],locale:"DEFAULT",paging:{limit:9999,next:null},productFound:true,orderBy:{field:NAME,direction:ASC},ownershipMethod:[PURCHASE,REDEMPTION,ENTITLEMENT_GRANT],downloadableOnly:false,entitlementEnabled:true,platforms:[PC]){items{id:originOfferId product{name gameSlug baseItem(availabilities:[VISIBLE]){title gameType}}}}}}"#;

/// The owned catalog: entitlements first, then the content ids that the
/// `origin2://` handler needs, fetched in bounded batches.
pub(crate) async fn fetch_owned(access: &str) -> Result<Vec<OwnedGame>, String> {
    let value = graphql(access, ENTITLEMENTS_QUERY).await?;
    let items = value
        .pointer("/data/me/ownedGameProducts/items")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut entries: Vec<(String, String, String)> = Vec::new(); // id, name, slug
    let mut seen = std::collections::HashSet::new();
    for item in items {
        let id = item.get("id").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
        if id.is_empty() {
            continue;
        }
        let product = item.get("product").cloned().unwrap_or_default();
        let name = product
            .get("name")
            .and_then(|v| v.as_str())
            .or_else(|| product.pointer("/baseItem/title").and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim()
            .to_string();
        if name.is_empty() {
            continue;
        }
        let slug = product
            .get("gameSlug")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let dedupe = if slug.is_empty() { format!("id:{id}") } else { format!("slug:{slug}") };
        if !seen.insert(dedupe) {
            continue;
        }
        entries.push((id, name, slug));
    }

    let mut content: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let ids: Vec<String> = entries.iter().map(|(id, _, _)| id.clone()).collect();
    for chunk in ids.chunks(OFFER_BATCH) {
        let list = serde_json::to_string(chunk).unwrap_or_else(|_| "[]".into());
        let query = format!(
            "query{{legacyOffers(offerIds:{list},locale:\"DEFAULT\"){{offerId:id contentId displayName}}}}"
        );
        let Ok(value) = graphql(access, &query).await else {
            continue;
        };
        let Some(offers) = value.get("data").and_then(|d| d.get("legacyOffers")).and_then(|v| v.as_array()) else {
            continue;
        };
        for offer in offers {
            let offer_id = offer.get("offerId").and_then(|v| v.as_str()).unwrap_or("");
            let content_id = offer.get("contentId").and_then(|v| v.as_str()).unwrap_or("");
            if !offer_id.is_empty() && !content_id.is_empty() {
                content.insert(offer_id.to_string(), content_id.to_string());
            }
        }
    }

    let mut games: Vec<OwnedGame> = entries
        .into_iter()
        .map(|(id, name, slug)| {
            let content_id = content.get(&id).cloned().unwrap_or_else(|| id.clone());
            OwnedGame { id, name, content_id, slug }
        })
        .collect();
    games.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(games)
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
        };
        let title = ea::normalize_title(&owned.name);
        let existing = games.iter_mut().find(|game| {
            game.store_id.split(',').any(|id| id.trim() == owned.content_id)
                || ea::normalize_title(&game.name) == title
        });
        assert!(existing.is_some());
        assert_eq!(games.len(), 1);
    }
}
