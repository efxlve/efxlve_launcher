//! Ubisoft Connect's web sign-in.
//!
//! The Galaxy Uplay plugin logs in through Ubisoft's overlay page and reads the
//! session that page receives. This module does the same inside the store
//! webview: the injected script watches the session POST and sends the ticket
//! back, then the owned catalog comes from the same public Ubisoft services the
//! plugin calls. Session tickets live in memory for the import only.

use base64::Engine;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::accounts;
use super::ubi_vault;
use super::ubisoft;

const UBI_APP_ID: &str = "f68a4bb5-608a-4ff2-8123-be8ef797e0a6";
const UBI_GENOME_ID: &str = "954e66a0-be1b-4aa0-9690-fb75201e4e9e";
const UBI_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) ConnectPC Safari/537.36";
const SESSIONS_URL: &str = "https://public-ubiservices.ubi.com/v3/profiles/sessions";
const ENTITLEMENTS_URL: &str =
    "https://public-ubiservices.ubi.com/v1/profiles/me/global/ubiconnect/entitlement/api/entitlements";
const CATALOG_URL: &str =
    "https://public-ubiservices.ubi.com/v1/spaces/global/ubiconnect/games/api/catalog";
const UPLAY_GRAPHQL_URL: &str = "https://public-ubiservices.ubi.com/v1/profiles/me/uplay/graphql";
/// Ubisoft answers a catalog request with at most 50 games.
const CATALOG_BATCH: usize = 50;

/// The owned-games query FriendsOfGalaxy's plugin still uses. The newer
/// entitlement endpoint is the primary source; this is the fallback.
const OWNED_GAMES_QUERY: &str = "query AllGames { viewer { id ...ownedGamesList } } \
fragment gameProps on Game { id spaceId name } \
fragment ownedGameProps on Game { ...gameProps viewer { meta { id ownedPlatformGroups { id name type } } } } \
fragment ownedGamesList on User { ownedGames: games(filterBy: {isOwned: true}) { totalCount nodes { ...ownedGameProps } } }";

/// Page script for the overlay login webview.
///
/// The page posts the session to `/v3/profiles/sessions`; this captures that
/// response and hands a base64 payload to `https://efxlve.local/ubi-session`,
/// where the store host picks it up. The two-factor page also gets its device
/// name filled in, the way the Galaxy plugin does.
pub(crate) const WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__efxlveUbiHooks) return;
  window.__efxlveUbiHooks = true;
  // Only the overlay login page hands out a session; the store page must not
  // re-trigger an import on every visit.
  var loginHost = location.hostname === "connect.cdn.ubisoft.com";
  var session = null;
  // The storefront's LOG IN calls `window.open` on the webauth page. A child
  // webview has no popup, so the click did nothing. Continue on the overlay
  // login page instead: it is the flow this script watches, and the store tab
  // reloads logged in when the session lands. Other popups keep their URL.
  var overlayUrl = "__EFXLVE_UBI_OVERLAY__";
  var realOpen = window.open;
  window.open = function (url) {
    if (typeof url === "string" && /ubisoft\.com|ubi\.com/i.test(url)) {
      location.href = /webauth|\/login|signin/i.test(url) ? overlayUrl : url;
      return null;
    }
    return realOpen ? realOpen.apply(this, arguments) : null;
  };
  function b64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function done() {
    if (!session || window.__efxlveUbiSent) return;
    window.__efxlveUbiSent = true;
    var payload = {
      ticket: session.ticket || "",
      sessionId: session.sessionId || "",
      userId: session.userId || "",
      nameOnPlatform: session.nameOnPlatform || "",
      rememberMeTicket: session.rememberMeTicket || ""
    };
    location.replace("https://efxlve.local/ubi-session#" + b64(JSON.stringify(payload)));
  }
  function take(data) {
    if (!data || !data.ticket || data.twoFactorAuthenticationTicket) return;
    session = data;
    clearTimeout(window.__efxlveUbiTimer);
    window.__efxlveUbiTimer = setTimeout(done, 10000);
  }
  function inspect(url, method, text) {
    if (!loginHost || !url) return;
    if (url.indexOf("/profiles/sessions") !== -1 && method === "POST") {
      try { take(JSON.parse(text)); } catch (e) {}
    } else if (url.indexOf("/configcache/api/postauth") !== -1) {
      done();
    }
  }
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__efxUrl = url;
    this.__efxMethod = String(method || "").toUpperCase();
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener("load", function () {
      if (xhr.status !== 200) return;
      var text = "";
      try {
        text = xhr.responseText;
      } catch (e) {
        try { text = xhr.response ? JSON.stringify(xhr.response) : ""; } catch (e2) { text = ""; }
      }
      inspect(String(xhr.__efxUrl || ""), xhr.__efxMethod || "", text);
    });
    return send.apply(this, arguments);
  };
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === "string") ? input : (input && input.url) || "";
      var method = (init && init.method) ? String(init.method).toUpperCase() : "GET";
      return origFetch.apply(this, arguments).then(function (response) {
        if (response && response.ok) {
          response.clone().text().then(function (text) { inspect(url, method, text); }).catch(function () {});
        }
        return response;
      });
    };
  }
  window.__efxlveUbiRetry = function () {
    window.__efxlveUbiSent = false;
  };
  if (location.href.indexOf("two-fa-email") !== -1) {
    var tries = 0;
    var poll = setInterval(function () {
      tries += 1;
      var box = document.getElementById("rdCheckbox");
      if (box && !box.checked) box.checked = true;
      var device = document.querySelector("input[name='deviceName']");
      if (device && !device.value) device.value = "efxlve Launcher";
      if (tries >= 240) clearInterval(poll);
    }, 250);
  }
})();
"#;

pub(crate) fn watch_script() -> &'static str {
    WATCH_SCRIPT
}

#[derive(Debug, Clone, Default, Deserialize)]
pub(crate) struct Session {
    #[serde(default)]
    pub ticket: String,
    #[serde(rename = "sessionId", default)]
    pub session_id: String,
    #[serde(rename = "userId", default)]
    pub user_id: String,
    #[serde(rename = "nameOnPlatform", default)]
    pub name: String,
    /// Long-lived remember-me token; it is the only reason the launcher can
    /// refresh the library without asking the user to sign in again.
    #[serde(rename = "rememberMeTicket", default)]
    pub remember: String,
}

/// The overlay page hands the session back as base64 JSON.
pub(crate) fn session_from_fragment(fragment: &str) -> Option<Session> {
    let raw = base64::engine::general_purpose::STANDARD.decode(fragment.trim()).ok()?;
    let session: Session = serde_json::from_slice(&raw).ok()?;
    if session.ticket.is_empty() || session.session_id.is_empty() {
        return None;
    }
    Some(session)
}

/// Called by the store host when the login page navigates to the hand-off URL.
pub(crate) fn accept_session(app: &AppHandle, fragment: &str) {
    let Some(session) = session_from_fragment(fragment) else {
        reset_page_flag(app);
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match import_owned(&session).await {
            Ok(count) if count > 0 => {
                let name = if session.name.trim().is_empty() {
                    accounts::detected_name("ubisoft")
                } else {
                    session.name.trim().to_string()
                };
                let _ = accounts::link_named("ubisoft", &name);
                // The login page did its job: the tab returns to the store.
                if let Some(window) = app.get_window("main") {
                    if let Some(webview) = window.get_webview("store-view-ubisoft") {
                        if let Ok(url) = url::Url::parse("https://store.ubi.com/") {
                            let _ = webview.navigate(url);
                        }
                    }
                }
                let _ = app.emit(
                    "companion-signed-in",
                    serde_json::json!({ "store": "ubisoft", "count": count }),
                );
            }
            Ok(_) => fail(&app, "@t:accounts.ubiNoGames"),
            Err(message) => fail(&app, &message),
        }
    });
}

fn fail(app: &AppHandle, message: &str) {
    let _ = app.emit("companion-signin-failed", message.to_string());
    // Let the page start another hand-off after a failed import.
    reset_page_flag(app);
}

fn reset_page_flag(app: &AppHandle) {
    if let Some(window) = app.get_window("main") {
        if let Some(webview) = window.get_webview("store-view-ubisoft") {
            let _ = webview.eval("if (window.__efxlveUbiRetry) window.__efxlveUbiRetry();");
        }
    }
}

fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(UBI_UA)
        .timeout(std::time::Duration::from_secs(60))
        .build()
        .map_err(|e| e.to_string())
}

fn insert(map: &mut reqwest::header::HeaderMap, name: &'static str, value: &str) {
    if let Ok(value) = reqwest::header::HeaderValue::from_str(value) {
        map.insert(name, value);
    }
}

fn headers(
    session: &Session,
    app_id: &'static str,
    genome_id: &'static str,
    extra: &[(&'static str, &str)],
) -> reqwest::header::HeaderMap {
    let mut map = reqwest::header::HeaderMap::new();
    insert(&mut map, "Authorization", &format!("Ubi_v1 t={}", session.ticket));
    insert(&mut map, "Ubi-AppId", app_id);
    insert(&mut map, "Ubi-GenomeId", genome_id);
    insert(&mut map, "Ubi-SessionId", &session.session_id);
    insert(&mut map, "Accept", "*/*");
    insert(&mut map, "Content-Type", "application/json");
    insert(&mut map, "ubi-localecode", "en-US");
    for (name, value) in extra {
        insert(&mut map, name, value);
    }
    map
}

/// Best effort session refresh, the same PUT the plugin makes before it asks
/// for entitlements. The captured ticket is used as-is when this fails.
async fn refresh_session(client: &reqwest::Client, session: &Session) -> Option<Session> {
    if session.ticket.is_empty() || session.session_id.is_empty() || session.user_id.is_empty() {
        return None;
    }
    let mut map = headers(session, UBI_APP_ID, UBI_GENOME_ID, &[]);
    insert(&mut map, "Origin", "https://store.ubi.com");
    insert(&mut map, "Referer", "https://store.ubi.com/upc/login");
    let response = client
        .put(SESSIONS_URL)
        .headers(map)
        .json(&serde_json::json!({ "rememberMe": true }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: serde_json::Value = response.json().await.ok()?;
    apply_session(session, &value)
}

fn apply_session(session: &Session, value: &serde_json::Value) -> Option<Session> {
    let ticket = value.get("ticket")?.as_str()?.trim().to_string();
    if ticket.is_empty() {
        return None;
    }
    let mut next = session.clone();
    next.ticket = ticket;
    if let Some(id) = value.get("sessionId").and_then(|v| v.as_str()) {
        if !id.is_empty() {
            next.session_id = id.to_string();
        }
    }
    if let Some(id) = value.get("userId").and_then(|v| v.as_str()) {
        if !id.is_empty() {
            next.user_id = id.to_string();
        }
    }
    if let Some(name) = value.get("nameOnPlatform").and_then(|v| v.as_str()) {
        if !name.is_empty() {
            next.name = name.to_string();
        }
    }
    if let Some(token) = value.get("rememberMeTicket").and_then(|v| v.as_str()) {
        if !token.is_empty() {
            next.remember = token.to_string();
        }
    }
    Some(next)
}

/// One diagnostic row per HTTP step; only a snippet of the body is kept.
fn log_step(log: &mut Vec<serde_json::Value>, step: &str, status: u16, body: &str) {
    log.push(serde_json::json!({
        "step": step,
        "status": status,
        "body": body.chars().take(1200).collect::<String>(),
    }));
}

fn log_note(log: &mut Vec<serde_json::Value>, step: &str, ok: bool) {
    log.push(serde_json::json!({ "step": step, "ok": ok }));
}

/// Writes the last import's steps so a failed sign-in can be inspected at
/// `~/.config/efxlve/ubi_debug.json`.
fn write_debug(log: &[serde_json::Value], result: &Result<usize, String>) {
    let path = super::accounts::data_dir().join("ubi_debug.json");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let payload = serde_json::json!({
        "ok": result.as_ref().ok(),
        "error": result.as_ref().err(),
        "steps": log,
    });
    if let Ok(text) = serde_json::to_string_pretty(&payload) {
        let _ = std::fs::write(path, text);
    }
}

async fn fetch_entitlements(
    client: &reqwest::Client,
    session: &Session,
    log: &mut Vec<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let response = client
        .get(ENTITLEMENTS_URL)
        .headers(headers(session, UBI_APP_ID, UBI_GENOME_ID, &[]))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    log_step(log, "entitlements", status.as_u16(), &text);
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Err("@t:accounts.ubiLoginFailed".into());
    }
    if !status.is_success() {
        return Err(format!("Ubisoft {}", status.as_u16()));
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

async fn fetch_catalog(
    client: &reqwest::Client,
    session: &Session,
    space_ids: &[String],
    log: &mut Vec<serde_json::Value>,
) -> Vec<ubisoft::OwnedGame> {
    let mut games = Vec::new();
    for chunk in space_ids.chunks(CATALOG_BATCH) {
        let response = client
            .get(CATALOG_URL)
            .query(&[("spaceIds", chunk.join(","))])
            .headers(headers(session, UBI_APP_ID, UBI_GENOME_ID, &[("Ubi-RequestedPlatformType", "uplay")]))
            .send()
            .await;
        let Ok(response) = response else { continue };
        let status = response.status();
        let Ok(text) = response.text().await else { continue };
        log_step(log, "catalog", status.as_u16(), &text);
        if !status.is_success() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
            continue;
        };
        games.extend(catalog_games(&value));
    }
    games
}

/// The entitlement API plus its catalog lookup, the fork's owned-games path.
async fn collect_entitlements(
    client: &reqwest::Client,
    session: &Session,
    log: &mut Vec<serde_json::Value>,
) -> Result<Vec<ubisoft::OwnedGame>, String> {
    let entitlements = fetch_entitlements(client, session, log).await?;
    let space_ids = entitlement_space_ids(&entitlements);
    if space_ids.is_empty() {
        return Ok(Vec::new());
    }
    Ok(fetch_catalog(client, session, &space_ids, log).await)
}

/// `AllGames` GraphQL, the FriendsOfGalaxy plugin's owned-games path.
async fn collect_graphql(
    client: &reqwest::Client,
    session: &Session,
    log: &mut Vec<serde_json::Value>,
) -> Result<Vec<ubisoft::OwnedGame>, String> {
    let body = serde_json::json!({
        "operationName": "AllGames",
        "variables": { "owned": true },
        "query": OWNED_GAMES_QUERY,
    });
    let response = client
        .post(UPLAY_GRAPHQL_URL)
        .headers(headers(session, UBI_APP_ID, UBI_GENOME_ID, &[]))
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    log_step(log, "graphql", status.as_u16(), &text);
    if !status.is_success() {
        return Err(format!("Ubisoft {}", status.as_u16()));
    }
    let value: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(graphql_games(&value))
}

/// Owned games from the account API, ready for the local cache.
///
/// Used right after the overlay sign-in; on success the refreshable session is
/// sealed to disk so later syncs do not ask the user to sign in again.
pub(crate) async fn import_owned(session: &Session) -> Result<usize, String> {
    let mut log = vec![serde_json::json!({
        "step": "session",
        "ticket": !session.ticket.is_empty(),
        "sessionId": !session.session_id.is_empty(),
        "userId": !session.user_id.is_empty(),
        "name": !session.name.is_empty(),
    })];
    let result = import_inner(session, &mut log).await;
    let mapped = result
        .as_ref()
        .map(|(count, _)| *count)
        .map_err(|err| err.clone());
    write_debug(&log, &mapped);
    match result {
        Ok((count, live)) => {
            // The account catalog now provides the art; stale Steam-search
            // covers for this store must not survive.
            super::covers::clear_store("ubisoft");
            ubi_vault::save(&live);
            Ok(count)
        }
        Err(err) => Err(err),
    }
}

/// What one background sync did.
pub(crate) enum UbiSync {
    Updated(usize),
    Unchanged(usize),
    NoSession,
    AuthLost,
    Failed(String),
}

/// Refreshes the sealed session and re-imports the owned catalog. This is what
/// makes a new purchase appear without a browser sign-in.
pub(crate) async fn sync_owned() -> UbiSync {
    // Never run two syncs at once (boot, rescan and the timer can overlap).
    static SYNC_RUNNING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    struct RunningGuard;
    impl Drop for RunningGuard {
        fn drop(&mut self) {
            SYNC_RUNNING.store(false, std::sync::atomic::Ordering::SeqCst);
        }
    }
    if SYNC_RUNNING.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return UbiSync::Unchanged(0);
    }
    let _guard = RunningGuard;

    let Some(stored) = ubi_vault::load() else {
        return UbiSync::NoSession;
    };
    let session = stored.into_session();
    let client = match http_client() {
        Ok(client) => client,
        Err(err) => return UbiSync::Failed(err),
    };
    let mut live = refresh_session(&client, &session).await;
    if live.is_none() {
        live = refresh_remember(&client, &session).await;
    }
    let Some(live) = live else {
        ubi_vault::clear();
        return UbiSync::AuthLost;
    };
    let signature = |games: Vec<ubisoft::OwnedGame>| -> std::collections::HashSet<(String, String, String)> {
        games
            .into_iter()
            .map(|game| (game.id, game.cover, game.description))
            .collect()
    };
    let before = signature(ubisoft::load_owned());
    let mut log = vec![serde_json::json!({
        "step": "sync",
        "ticket": !live.ticket.is_empty(),
    })];
    let result = import_inner(&live, &mut log).await;
    let mapped = result
        .as_ref()
        .map(|(count, _)| *count)
        .map_err(|err| err.clone());
    write_debug(&log, &mapped);
    match result {
        Ok((count, refreshed)) => {
            ubi_vault::save(&refreshed);
            let after = signature(ubisoft::load_owned());
            if count > 0 && after != before {
                // The owned set changed: drop stale art so it is re-resolved.
                super::covers::clear_store("ubisoft");
                UbiSync::Updated(count)
            } else {
                UbiSync::Unchanged(count)
            }
        }
        Err(err) => {
            if err == "@t:accounts.ubiLoginFailed" {
                ubi_vault::clear();
                UbiSync::AuthLost
            } else {
                UbiSync::Failed(err)
            }
        }
    }
}

async fn import_inner(session: &Session, log: &mut Vec<serde_json::Value>) -> Result<(usize, Session), String> {
    let client = http_client()?;
    let mut live = session.clone();
    // The plugin order: post the captured session once, renew it, then read.
    let posted = post_session(&client, &live).await;
    log_note(log, "post-session", posted.is_some());
    if let Some(next) = posted {
        live = next;
    }
    let refreshed = refresh_session(&client, &live).await;
    log_note(log, "put-session", refreshed.is_some());
    if let Some(next) = refreshed {
        live = next;
    }
    let mut first_error = None;
    let mut games = match collect_entitlements(&client, &live, log).await {
        Ok(games) => games,
        Err(err) => {
            first_error = Some(err);
            // The captured ticket can be stale; one more session POST is the
            // plugin's fallback before it gives up.
            if let Some(next) = post_session(&client, &live).await {
                live = next;
                match collect_entitlements(&client, &live, log).await {
                    Ok(games) => games,
                    Err(err) => {
                        first_error = Some(err);
                        Vec::new()
                    }
                }
            } else {
                Vec::new()
            }
        }
    };
    // The catalog and the GraphQL list cover the same account from two sides;
    // the union keeps a game that only one of them knows about and the catalog
    // contributes the box art.
    match collect_graphql(&client, &live, log).await {
        Ok(found) => {
            for game in found {
                match games.iter_mut().find(|g| g.id == game.id) {
                    Some(existing) => {
                        if existing.name.is_empty() {
                            existing.name = game.name;
                        }
                        if existing.cover.is_empty() {
                            existing.cover = game.cover;
                        }
                        if existing.hero.is_empty() {
                            existing.hero = game.hero;
                        }
                    }
                    None => games.push(game),
                }
            }
        }
        Err(err) => {
            if first_error.is_none() {
                first_error = Some(err);
            }
        }
    }
    let mut seen = std::collections::HashSet::new();
    games.retain(|game| seen.insert(game.id.clone()));
    if games.is_empty() {
        if let Some(err) = first_error {
            return Err(err);
        }
        return Ok((0, live));
    }
    ubisoft::save_owned(&games);
    Ok((games.len(), live))
}

/// Long-lived refresh: POST with the remember-me token (`rm_v1`) returns a new
/// ticket when the short-lived one has died.
async fn refresh_remember(client: &reqwest::Client, session: &Session) -> Option<Session> {
    if session.remember.is_empty() {
        return None;
    }
    let mut map = headers(
        session,
        UBI_APP_ID,
        UBI_GENOME_ID,
        &[
            ("Origin", "https://connect.ubisoft.com"),
            ("Referer", "https://connect.ubisoft.com"),
        ],
    );
    insert(&mut map, "Authorization", &format!("rm_v1 t={}", session.remember));
    let response = client
        .post(SESSIONS_URL)
        .headers(map)
        .json(&serde_json::json!({ "rememberMe": true }))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: serde_json::Value = response.json().await.ok()?;
    apply_session(session, &value)
}

/// Plain ticket refresh (`Ubi_v1`), used when the PUT did not revive the session.
async fn post_session(client: &reqwest::Client, session: &Session) -> Option<Session> {
    let mut map = headers(session, UBI_APP_ID, UBI_GENOME_ID, &[]);
    insert(&mut map, "Origin", "https://store.ubi.com");
    insert(&mut map, "Referer", "https://store.ubi.com/upc/login");
    let response = client.post(SESSIONS_URL).headers(map).send().await.ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: serde_json::Value = response.json().await.ok()?;
    apply_session(session, &value)
}

/// Space ids of owned, non-expired entitlements.
pub(crate) fn entitlement_space_ids(value: &serde_json::Value) -> Vec<String> {
    let mut ids = Vec::new();
    let Some(items) = value.get("entitlements").and_then(|v| v.as_array()) else {
        return ids;
    };
    for item in items {
        if item.get("availability").and_then(|v| v.as_str()) == Some("expired") {
            continue;
        }
        let Some(space) = item.get("spaceId").and_then(|v| v.as_str()) else {
            continue;
        };
        if space.is_empty() || ids.iter().any(|id| id == space) {
            continue;
        }
        ids.push(space.to_string());
    }
    ids
}

/// PC titles from a catalog response, with Ubisoft's own box art.
pub(crate) fn catalog_games(value: &serde_json::Value) -> Vec<ubisoft::OwnedGame> {
    let mut games = Vec::new();
    let Some(items) = value.get("games").and_then(|v| v.as_array()) else {
        return games;
    };
    for item in items {
        let Some(space) = item.get("spaceId").and_then(|v| v.as_str()) else {
            continue;
        };
        let name = item
            .get("displayName")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("name").and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim();
        if space.is_empty() || name.is_empty() || name.eq_ignore_ascii_case("unknown") {
            continue;
        }
        let pc = item
            .get("platforms")
            .and_then(|v| v.as_array())
            .map(|platforms| {
                platforms
                    .iter()
                    .any(|p| p.get("type").and_then(|v| v.as_str()) == Some("PC"))
            })
            .unwrap_or(false);
        if !pc {
            continue;
        }
        let image = |key: &str| {
            item.pointer(&format!("/imageUrls/{key}"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        };
        let low = image("lowBoxArt");
        let cover = if low.is_empty() { image("highBoxArt") } else { low };
        // The catalog calls the store blurb `displayDescription`; older
        // responses only carry `description`.
        let description = item
            .get("displayDescription")
            .and_then(|v| v.as_str())
            .or_else(|| item.get("description").and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim()
            .to_string();
        games.push(ubisoft::OwnedGame {
            id: space.to_string(),
            name: name.to_string(),
            cover,
            hero: image("background"),
            description,
        });
    }
    games
}

/// PC titles from the `AllGames` GraphQL response. It has no artwork.
pub(crate) fn graphql_games(value: &serde_json::Value) -> Vec<ubisoft::OwnedGame> {
    let Some(nodes) = value.pointer("/data/viewer/ownedGames/nodes").and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut games = Vec::new();
    for node in nodes {
        let Some(space) = node.get("spaceId").and_then(|v| v.as_str()) else {
            continue;
        };
        let name = node.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        if space.is_empty() || name.is_empty() || name.eq_ignore_ascii_case("unknown") {
            continue;
        }
        let Some(platforms) = node.pointer("/viewer/meta/ownedPlatformGroups") else {
            continue;
        };
        if !has_pc_platform(platforms) {
            continue;
        }
        games.push(ubisoft::OwnedGame {
            id: space.to_string(),
            name: name.to_string(),
            cover: String::new(),
            hero: String::new(),
            description: String::new(),
        });
    }
    games
}

fn has_pc_platform(value: &serde_json::Value) -> bool {
    match value {
        serde_json::Value::Array(items) => items.iter().any(has_pc_platform),
        serde_json::Value::Object(map) => {
            if map.get("type").and_then(|v| v.as_str()) == Some("PC") {
                return true;
            }
            map.values().any(has_pc_platform)
        }
        _ => false,
    }
}

/// One playtime row keyed by the id the library card uses.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaytimeRow {
    pub id: String,
    pub total_seconds: u64,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn playtime_cache_path() -> std::path::PathBuf {
    super::accounts::data_dir().join("companion_ubi_playtime.json")
}

fn load_playtime_cache() -> std::collections::HashMap<String, (u64, u64)> {
    let Ok(text) = std::fs::read_to_string(playtime_cache_path()) else {
        return std::collections::HashMap::new();
    };
    let value: serde_json::Value = serde_json::from_str(&text).unwrap_or_default();
    let mut out = std::collections::HashMap::new();
    if let Some(map) = value.as_object() {
        for (id, row) in map {
            let seconds = row.get("seconds").and_then(|v| v.as_u64()).unwrap_or(0);
            let fetched = row.get("fetchedAt").and_then(|v| v.as_u64()).unwrap_or(0);
            out.insert(id.clone(), (seconds, fetched));
        }
    }
    out
}

fn save_playtime_cache(cache: &std::collections::HashMap<String, (u64, u64)>) {
    let mut map = serde_json::Map::new();
    for (id, (seconds, fetched)) in cache {
        map.insert(id.clone(), serde_json::json!({ "seconds": seconds, "fetchedAt": fetched }));
    }
    if let Ok(text) = serde_json::to_string(&serde_json::Value::Object(map)) {
        let path = playtime_cache_path();
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let _ = std::fs::write(path, text);
    }
}

/// Playtime for every owned game, keyed by the library id. Cached for a day;
/// a missing cache entry is fetched with the sealed session.
pub(crate) async fn playtimes() -> Vec<PlaytimeRow> {
    let Some(stored) = ubi_vault::load() else {
        return Vec::new();
    };
    let session = stored.into_session();
    let Ok(client) = http_client() else {
        return Vec::new();
    };
    let mut live = refresh_session(&client, &session).await;
    if live.is_none() {
        live = refresh_remember(&client, &session).await;
    }
    let Some(live) = live else {
        return Vec::new();
    };
    let owned = ubisoft::load_owned();
    if owned.is_empty() {
        return Vec::new();
    }
    let local = super::discover("ubisoft");
    let now = now_secs();
    let mut cache = load_playtime_cache();
    let mut changed = false;
    let mut rows = Vec::new();
    for game in &owned {
        // The card id is the local launch id when the client knows the game.
        let card_id = local
            .iter()
            .find(|g| super::scan::slug(&g.name) == super::scan::slug(&game.name))
            .map(|g| g.id.clone())
            .unwrap_or_else(|| game.id.clone());
        let cached = cache.get(&game.id).copied();
        // A zero entry is not "fresh": it means the last call answered without
        // stats (wrong endpoint, 412) and must be retried, not cached for a day.
        let fresh = cached
            .map(|(seconds, fetched)| seconds > 0 && now.saturating_sub(fetched) < 24 * 3600)
            .unwrap_or(false);
        let seconds = if fresh {
            cached.map(|(seconds, _)| seconds).unwrap_or(0)
        } else {
            match fetch_playtime(&client, &live, &game.id).await {
                Some(seconds) => {
                    cache.insert(game.id.clone(), (seconds, now));
                    changed = true;
                    seconds
                }
                None => cached.map(|(seconds, _)| seconds).unwrap_or(0),
            }
        };
        rows.push(PlaytimeRow { id: card_id, total_seconds: seconds });
    }
    if changed {
        save_playtime_cache(&cache);
    }
    rows
}

async fn fetch_playtime(client: &reqwest::Client, session: &Session, space_id: &str) -> Option<u64> {
    if session.user_id.is_empty() {
        return None;
    }
    // The client and the Galaxy plugin both read `/statscard`; `/stats` is a
    // different endpoint and answered without any Statscards.
    let url = format!("https://public-ubiservices.ubi.com/v1/profiles/{}/statscard", session.user_id);
    let response = client
        .get(url)
        .query(&[("spaceId", space_id), ("offset", "0")])
        .headers(headers(
            session,
            UBI_APP_ID,
            UBI_GENOME_ID,
            &[("Ubi-RequestedPlatformType", "uplay"), ("Ubi-LocaleCode", "en-GB")],
        ))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let value: serde_json::Value = response.json().await.ok()?;
    Some(parse_playtime(&value))
}

/// `Statscards` to total seconds, following the Galaxy plugin's heuristics.
pub(crate) fn parse_playtime(value: &serde_json::Value) -> u64 {
    let Some(cards) = value.get("Statscards").and_then(|v| v.as_array()) else {
        return 0;
    };
    let time_cards: Vec<&serde_json::Value> = cards
        .iter()
        .filter(|card| card.get("format").and_then(|v| v.as_str()) == Some("LongTimespan"))
        .collect();
    if time_cards.is_empty() {
        return 0;
    }
    let chosen: Vec<&serde_json::Value> = if time_cards.len() == 1 {
        vec![time_cards[0]]
    } else {
        const TOTAL_NAMES: [&str; 5] = ["playtime", "time played", "play time", "total play time", "total playtime"];
        let named = time_cards.iter().find(|card| {
            let display = card.get("displayName").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            TOTAL_NAMES.contains(&display.as_str())
        });
        if let Some(card) = named {
            vec![*card]
        } else if time_cards.len() == 2 && complementary_modes(&time_cards) {
            time_cards.clone()
        } else {
            let weight = |card: &serde_json::Value| -> i32 {
                let text = format!(
                    "{} {}",
                    card.get("displayName").and_then(|v| v.as_str()).unwrap_or("").to_lowercase(),
                    card.get("statName").and_then(|v| v.as_str()).unwrap_or("").to_lowercase()
                );
                ["all", "total", "absolute"].iter().filter(|word| text.contains(**word)).count() as i32
            };
            let max = time_cards.iter().map(|card| weight(card)).max().unwrap_or(0);
            time_cards.iter().filter(|card| weight(card) == max).copied().collect()
        }
    };
    let seconds: f64 = chosen.iter().filter_map(|card| normalize_seconds(card)).sum();
    seconds.max(0.0).floor() as u64
}

fn complementary_modes(cards: &[&serde_json::Value]) -> bool {
    let name = |card: &serde_json::Value| {
        format!(
            "{} {}",
            card.get("statName").and_then(|v| v.as_str()).unwrap_or("").to_lowercase(),
            card.get("displayName").and_then(|v| v.as_str()).unwrap_or("").to_lowercase()
        )
    };
    let a = name(cards[0]);
    let b = name(cards[1]);
    [("pvp", "pve"), ("solo", "coop"), ("single", "multi")]
        .iter()
        .any(|(x, y)| (a.contains(x) && b.contains(y)) || (a.contains(y) && b.contains(x)))
}

fn normalize_seconds(card: &serde_json::Value) -> Option<f64> {
    let raw = card.get("value")?;
    let value = match raw {
        serde_json::Value::Number(n) => n.as_f64()?,
        serde_json::Value::String(s) => {
            if s.is_empty() {
                0.0
            } else {
                s.parse::<f64>().ok()?
            }
        }
        _ => return None,
    };
    match card.get("unit").and_then(|v| v.as_str()) {
        Some("Hours") => Some(value * 3600.0),
        Some("Minutes") => Some(value * 60.0),
        Some("Seconds") => Some(value),
        Some("Miliseconds") => Some(value / 1000.0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fragment(json: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(json)
    }

    #[test]
    fn session_fragment_round_trips_and_requires_a_ticket() {
        let json = r#"{"ticket":"T","sessionId":"S","userId":"U","nameOnPlatform":"Player","rememberMeTicket":"rm"}"#;
        let session = session_from_fragment(&fragment(json)).unwrap();
        assert_eq!(session.ticket, "T");
        assert_eq!(session.session_id, "S");
        assert_eq!(session.user_id, "U");
        assert_eq!(session.name, "Player");
        assert!(session_from_fragment("not-base64").is_none());
        assert!(session_from_fragment(&fragment(r#"{"sessionId":"S"}"#)).is_none());
    }

    #[test]
    fn entitlements_skip_expired_duplicates_and_empty_spaces() {
        let value = serde_json::json!({"entitlements": [
            {"spaceId": "a", "availability": "owned"},
            {"spaceId": "a", "availability": "owned"},
            {"spaceId": "b", "availability": "expired"},
            {"spaceId": "", "availability": "owned"},
            {}
        ]});
        assert_eq!(entitlement_space_ids(&value), vec!["a"]);
    }

    #[test]
    fn catalog_keeps_named_pc_games_only_and_reads_the_box_art() {
        let value = serde_json::json!({"games": [
            {"spaceId": "a", "displayName": "Watch Dogs", "displayDescription": "  Hacking in Chicago.  ", "platforms": [{"type": "PC"}],
             "imageUrls": {"lowBoxArt": "https://cdn/low.png", "highBoxArt": "https://cdn/high.png", "background": "https://cdn/bg.jpg"}},
            {"spaceId": "b", "name": "Fallback Name", "description": "Legacy blurb", "platforms": [{"type": "PC"}], "imageUrls": {"highBoxArt": "https://cdn/high.png"}},
            {"spaceId": "c", "displayName": "Console Only", "platforms": [{"type": "PS5"}]},
            {"spaceId": "d", "displayName": "Unknown", "platforms": [{"type": "PC"}]},
            {"spaceId": "e", "platforms": [{"type": "PC"}]}
        ]});
        let games = catalog_games(&value);
        assert_eq!(games.len(), 2);
        assert_eq!(games[0].id, "a");
        assert_eq!(games[0].name, "Watch Dogs");
        assert_eq!(games[0].cover, "https://cdn/low.png");
        assert_eq!(games[0].hero, "https://cdn/bg.jpg");
        assert_eq!(games[0].description, "Hacking in Chicago.");
        assert_eq!(games[1].cover, "https://cdn/high.png");
        assert_eq!(games[1].description, "Legacy blurb");
    }

    #[test]
    fn graphql_keeps_owned_pc_games_with_platform_groups() {
        let value = serde_json::json!({"data": {"viewer": {"ownedGames": {"nodes": [
            {"spaceId": "a", "name": "Watch Dogs", "viewer": {"meta": {"ownedPlatformGroups": [[{"type": "PC"}]]}}},
            {"spaceId": "b", "name": "Console Only", "viewer": {"meta": {"ownedPlatformGroups": [[{"type": "PS5"}]]}}},
            {"spaceId": "c", "name": "No Meta"}
        ]}}}});
        let games = graphql_games(&value);
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].id, "a");
        assert!(games[0].cover.is_empty());
    }

    #[test]
    fn playtime_reads_the_total_card_and_mode_splits() {
        let one = serde_json::json!({"Statscards": [
            {"format": "LongTimespan", "displayName": "Playtime", "statName": "TotalPlaytime", "unit": "Seconds", "value": "3661"}
        ]});
        assert_eq!(parse_playtime(&one), 3661);

        let named = serde_json::json!({"Statscards": [
            {"format": "LongTimespan", "displayName": "PvP", "statName": "PvpTime", "unit": "Hours", "value": "2"},
            {"format": "LongTimespan", "displayName": "Time Played", "statName": "TimePlayed", "unit": "Minutes", "value": "90"}
        ]});
        assert_eq!(parse_playtime(&named), 5400);

        let modes = serde_json::json!({"Statscards": [
            {"format": "LongTimespan", "displayName": "Solo", "statName": "SoloTime", "unit": "Hours", "value": "1"},
            {"format": "LongTimespan", "displayName": "Coop", "statName": "CoopTime", "unit": "Hours", "value": "2"}
        ]});
        assert_eq!(parse_playtime(&modes), 10800);

        assert_eq!(parse_playtime(&serde_json::json!({})), 0);
    }
}
