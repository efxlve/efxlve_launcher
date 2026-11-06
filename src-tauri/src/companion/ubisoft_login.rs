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

/// Page script for the Ubisoft store tab and the standalone overlay login page.
///
/// The standalone page posts the session to `/v3/profiles/sessions`; this
/// captures that response and hands a base64 payload to
/// `https://efxlve.local/ubi-session`, where the store host picks it up.
///
/// The store page is different: its own `UPlayConnect-Login` call is what saves
/// the store cookie, so the script forces the store's in-page modal login (a
/// child webview has no popup), lets the store finish that call, and only then
/// hands the session over for the library import. Without that the library was
/// imported but the store tab was still signed out.
pub(crate) const WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__efxlveUbiHooks) return;
  window.__efxlveUbiHooks = true;
  // Only these two pages hand a session over.
  var loginHost = location.hostname === "connect.cdn.ubisoft.com";
  var storeHost = /(^|\.)store\.(ubisoft|ubi)\.com$/i.test(location.hostname);
  var session = null;
  function b64(text) {
    var bytes = new TextEncoder().encode(text);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  // Without `rememberMe` the session POST returns no long-lived token, and the
  // launcher is logged out as soon as the short ticket dies. Force it on the
  // sessions request so the response carries `rememberMeTicket`.
  function withRememberMe(body) {
    try {
      if (!body || typeof body !== "string") return body;
      var data = JSON.parse(body);
      if (data && typeof data === "object" && !data.rememberMe) {
        data.rememberMe = true;
        return JSON.stringify(data);
      }
    } catch (e) {}
    return body;
  }
  function payload(data) {
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch (e) { return null; }
    }
    if (!data || typeof data !== "object") return null;
    if (data.payload && typeof data.payload === "object") data = data.payload;
    // A two-factor login answers with an intermediate ticket, not a session.
    if (data.twoFactorAuthenticationTicket) return null;
    var ticket = data.ticket || "";
    var sessionId = data.sessionId || "";
    if (!ticket || !sessionId) return null;
    return {
      ticket: ticket,
      sessionId: sessionId,
      userId: data.userId || data.profileId || "",
      nameOnPlatform: data.nameOnPlatform || data.username || "",
      rememberMeTicket: data.rememberMeTicket || data.remember || ""
    };
  }
  function handoff(data) {
    var live = payload(data);
    if (!live || window.__efxlveUbiSent) return;
    window.__efxlveUbiSent = true;
    window.__efxlveUbiWantSession = false;
    clearTimeout(window.__efxlveUbiWantTimer);
    try { sessionStorage.removeItem("__efxlveUbiWantSession"); } catch (e) {}
    location.replace("https://efxlve.local/ubi-session#" + b64(JSON.stringify(live)));
  }
  // Any Ubisoft login (the store's own button, the widget, or the Accounts
  // card) should import the library. The flag lapses so a later overlay
  // refresh cannot take the tab over long after the user finished signing in.
  function wantSession() {
    window.__efxlveUbiWantSession = true;
    try { sessionStorage.setItem("__efxlveUbiWantSession", "1"); } catch (e) {}
    clearTimeout(window.__efxlveUbiWantTimer);
    window.__efxlveUbiWantTimer = setTimeout(function () {
      window.__efxlveUbiWantSession = false;
      try { sessionStorage.removeItem("__efxlveUbiWantSession"); } catch (e) {}
    }, 600000);
  }
  function take(data) {
    var live = payload(data);
    if (!live) return;
    session = live;
    clearTimeout(window.__efxlveUbiTimer);
    window.__efxlveUbiTimer = setTimeout(function () { handoff(session); }, 10000);
  }
  function inspect(url, method, text) {
    if (!loginHost || !url) return;
    if (url.indexOf("/profiles/sessions") !== -1 && method === "POST") {
      try { take(JSON.parse(text)); } catch (e) {}
    } else if (url.indexOf("/configcache/api/postauth") !== -1) {
      handoff(session);
    }
  }
  // The store ships loginType=popup for Chrome. A child webview has no popup,
  // and the store only saves its own session after its in-page modal login
  // finishes. Force the modal type before the store reads the attribute.
  function forceModalLogin() {
    var box = document.querySelector(".overlay-settings");
    if (box && box.getAttribute("data-login-type") !== "modal") {
      box.setAttribute("data-login-type", "modal");
    }
  }
  if (storeHost) {
    try {
      var observer = new MutationObserver(forceModalLogin);
      observer.observe(document.documentElement || document, { childList: true, subtree: true });
      document.addEventListener("DOMContentLoaded", function () {
        forceModalLogin();
        observer.disconnect();
      }, true);
      forceModalLogin();
    } catch (e) {}
    // The store posts the connect payload to UPlayConnect-Login right after
    // this event; let that call set the store cookie before the hand-off.
    document.addEventListener("CONNECT_SDK_LOADED", function (event) {
      if (!window.__efxlveUbiWantSession || window.__efxlveUbiSent) return;
      var live = payload(event.detail);
      if (!live) return;
      setTimeout(function () { handoff(live); }, 4000);
    });
    // A login started from the store itself (the header button or the widget)
    // must import the library too, not only the Accounts card.
    document.addEventListener("click", function (event) {
      var node = event.target;
      while (node && node !== document) {
        var names = typeof node.className === "string" ? node.className : "";
        if (/(^|\s)(js-enforced-login-btn|check-ubisoft-login)(\s|$)/.test(names)) {
          wantSession();
          return;
        }
        node = node.parentElement;
      }
    }, true);
    var widgetTries = 0;
    var widgetTimer = setInterval(function () {
      widgetTries += 1;
      var widget = window.overlayWidget;
      if (widget && typeof widget.login === "function" && !widget.__efxlveLoginWrapped) {
        clearInterval(widgetTimer);
        try {
          var originalLogin = widget.login;
          widget.login = function () {
            wantSession();
            return originalLogin.apply(this, arguments);
          };
          widget.__efxlveLoginWrapped = true;
        } catch (e) {}
      } else if (widgetTries >= 300) {
        clearInterval(widgetTimer);
      }
    }, 200);
    // Called by the Accounts card when the user asks to sign in. A store that
    // is already signed in hands its session over immediately; otherwise the
    // widget opens its modal and the login event is captured above.
    window.__efxlveUbiSignIn = function () {
      if (window.__efxlveUbiSignInBusy) return;
      window.__efxlveUbiSignInBusy = true;
      setTimeout(function () { window.__efxlveUbiSignInBusy = false; }, 5000);
      wantSession();
      var attempts = 0;
      var timer = setInterval(function () {
        attempts += 1;
        if (!window.overlayWidget || !window.overlayWidget.getTicket) {
          if (attempts >= 300) clearInterval(timer);
          return;
        }
        clearInterval(timer);
        window.overlayWidget.getTicket(function (ticket) {
          var live = ticket && ticket.status === "ok" ? payload(ticket.payload) : null;
          if (live) {
            handoff(live);
            return;
          }
          try {
            if (window.overlayWidget.toggleLoginType) {
              window.overlayWidget.toggleLoginType("modal");
            }
            if (window.overlayWidget.login) {
              setTimeout(function () {
                try { window.overlayWidget.login(); } catch (e) {}
              }, 800);
            }
          } catch (e) {}
        });
      }, 100);
    };
    // A store reload can win the race against the hand-off. Resume the silent
    // capture on the new page; if the user cancelled, drop the flag instead of
    // reopening the modal on every visit.
    var resume = false;
    try { resume = sessionStorage.getItem("__efxlveUbiWantSession") === "1"; } catch (e) {}
    if (resume) {
      window.__efxlveUbiWantSession = true;
      var resumeTries = 0;
      var resumeTimer = setInterval(function () {
        resumeTries += 1;
        if (!window.overlayWidget || !window.overlayWidget.getTicket) {
          if (resumeTries >= 300) {
            clearInterval(resumeTimer);
            window.__efxlveUbiWantSession = false;
            try { sessionStorage.removeItem("__efxlveUbiWantSession"); } catch (e) {}
          }
          return;
        }
        clearInterval(resumeTimer);
        window.overlayWidget.getTicket(function (ticket) {
          var live = ticket && ticket.status === "ok" ? payload(ticket.payload) : null;
          if (live) {
            handoff(live);
          } else {
            window.__efxlveUbiWantSession = false;
            try { sessionStorage.removeItem("__efxlveUbiWantSession"); } catch (e) {}
          }
        });
      }, 150);
    }
  }
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__efxUrl = url;
    this.__efxMethod = String(method || "").toUpperCase();
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    var xhr = this;
    if (
      xhr.__efxMethod === "POST" &&
      String(xhr.__efxUrl || "").indexOf("/profiles/sessions") !== -1
    ) {
      body = withRememberMe(body);
    }
    var sentBody = body;
    var storeLogin =
      storeHost &&
      xhr.__efxMethod === "POST" &&
      String(xhr.__efxUrl || "").indexOf("/UPlayConnect-Login") !== -1;
    xhr.addEventListener("load", function () {
      if (xhr.status !== 200) return;
      if (storeLogin && window.__efxlveUbiWantSession) {
        var fields = null;
        if (sentBody && typeof sentBody === "object") {
          fields = sentBody;
        } else {
          try { fields = JSON.parse(sentBody); } catch (e) {}
          if (!fields) {
            try {
              fields = {};
              new URLSearchParams(String(sentBody || "")).forEach(function (value, key) {
                fields[key] = value;
              });
            } catch (e) { fields = null; }
          }
        }
        var live = payload(fields);
        if (live) {
          handoff(live);
        }
      }
      var text = "";
      try {
        text = xhr.responseText;
      } catch (e) {
        try { text = xhr.response ? JSON.stringify(xhr.response) : ""; } catch (e2) { text = ""; }
      }
      inspect(String(xhr.__efxUrl || ""), xhr.__efxMethod || "", text);
    });
    return send.call(this, body);
  };
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === "string") ? input : (input && input.url) || "";
      var method = (init && init.method) ? String(init.method).toUpperCase() : "GET";
      var args = [input, init];
      var sentBody = init && init.body;
      if (method === "POST" && url.indexOf("/profiles/sessions") !== -1 && init && init.body) {
        var nextInit = {};
        for (var key in init) nextInit[key] = init[key];
        nextInit.body = withRememberMe(init.body);
        args = [input, nextInit];
        sentBody = nextInit.body;
      }
      var storeLogin =
        storeHost &&
        method === "POST" &&
        url.indexOf("/UPlayConnect-Login") !== -1;
      return origFetch.apply(this, args).then(function (response) {
        if (response && response.ok) {
          response.clone().text().then(function (text) {
            if (storeLogin && window.__efxlveUbiWantSession) {
              var fields = null;
              if (sentBody && typeof sentBody === "object") {
                fields = sentBody;
              } else {
                try { fields = JSON.parse(sentBody); } catch (e) {}
                if (!fields) {
                  try {
                    fields = {};
                    new URLSearchParams(String(sentBody || "")).forEach(function (value, key) {
                      fields[key] = value;
                    });
                  } catch (e) { fields = null; }
                }
              }
              var live = payload(fields);
              if (live) {
                handoff(live);
              }
            }
            inspect(url, method, text);
          }).catch(function () {});
        }
        return response;
      });
    };
  }
  window.__efxlveUbiRetry = function () {
    window.__efxlveUbiSent = false;
    window.__efxlveUbiWantSession = false;
    clearTimeout(window.__efxlveUbiWantTimer);
    try { sessionStorage.removeItem("__efxlveUbiWantSession"); } catch (e) {}
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

/// Bumped for every sign-in request and every hand-off. A retry loop stops as
/// soon as its request is answered, so a logged-in store reload cannot start
/// another import.
static SIGNIN_GENERATION: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

/// Called by the store host when the login page navigates to the hand-off URL.
pub(crate) fn accept_session(app: &AppHandle, fragment: &str) {
    SIGNIN_GENERATION.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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

/// Polls for the store script in the current document. A cold view can still
/// be on `about:blank` when the Accounts card asks to sign in, so the command
/// re-evaluates this until the store document owns it.
const STORE_SIGNIN_SCRIPT: &str = "(function () {\
  if (window.__efxlveUbiSignInStarted) return;\
  var tries = 0;\
  var timer = setInterval(function () {\
    tries += 1;\
    if (typeof window.__efxlveUbiSignIn === 'function') {\
      clearInterval(timer);\
      window.__efxlveUbiSignInStarted = true;\
      window.__efxlveUbiSignIn();\
    } else if (tries >= 100) {\
      clearInterval(timer);\
    }\
  }, 100);\
})();";

/// Opens Ubisoft's in-page sign-in on the store tab.
///
/// The store does not persist its session until its own `UPlayConnect-Login`
/// call runs, so the Accounts card signs in here instead of on the standalone
/// overlay page. The injected script waits for the page, hands over a session
/// that is already valid, or opens the widget's modal login.
pub(crate) fn open_store_signin(app: &AppHandle) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let window = app
        .get_window("main")
        .ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let view = window
        .get_webview("store-view-ubisoft")
        .ok_or_else(|| "@t:store.viewCreateFailed".to_string())?;
    let generation = SIGNIN_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    view.eval(STORE_SIGNIN_SCRIPT)
        .map_err(|error| error.to_string())?;
    // The first eval can land in the initial empty document. The store
    // navigation replaces it, so repeat until the real page has the script;
    // the page guard makes the retries no-ops after the first success. A
    // hand-off bumps the generation, which stops this loop before the reloaded
    // store page can start a second import.
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        for _ in 0..60 {
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            if SIGNIN_GENERATION.load(Ordering::SeqCst) != generation {
                break;
            }
            let Some(window) = handle.get_window("main") else {
                break;
            };
            let Some(view) = window.get_webview("store-view-ubisoft") else {
                break;
            };
            let _ = view.eval(STORE_SIGNIN_SCRIPT);
        }
    });
    Ok(())
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

/// Why a session renewal stopped. Only an explicit rejection may discard the
/// sealed ticket: a timeout or a 5xx must not sign the user out.
enum RefreshOutcome {
    Renewed(Session),
    Rejected,
    Unavailable,
}

/// Best effort session refresh, the same PUT the plugin makes before it asks
/// for entitlements. The captured ticket is used as-is when this fails.
async fn refresh_session(client: &reqwest::Client, session: &Session) -> RefreshOutcome {
    if session.ticket.is_empty() || session.session_id.is_empty() || session.user_id.is_empty() {
        return RefreshOutcome::Unavailable;
    }
    let mut map = headers(session, UBI_APP_ID, UBI_GENOME_ID, &[]);
    insert(&mut map, "Origin", "https://store.ubi.com");
    insert(&mut map, "Referer", "https://store.ubi.com/upc/login");
    let response = match client
        .put(SESSIONS_URL)
        .headers(map)
        .json(&serde_json::json!({ "rememberMe": true }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return RefreshOutcome::Unavailable,
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return RefreshOutcome::Rejected;
    }
    if !status.is_success() {
        return RefreshOutcome::Unavailable;
    }
    let Ok(value) = response.json::<serde_json::Value>().await else {
        return RefreshOutcome::Unavailable;
    };
    match apply_session(session, &value) {
        Some(next) => RefreshOutcome::Renewed(next),
        None => RefreshOutcome::Unavailable,
    }
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
    let products = entitlement_products(&entitlements);
    if products.is_empty() {
        return Ok(Vec::new());
    }
    let space_ids: Vec<String> = products.iter().map(|(space, _)| space.clone()).collect();
    let mut games = fetch_catalog(client, session, &space_ids, log).await;
    for game in &mut games {
        if let Some((_, product_id)) = products.iter().find(|(space, _)| space == &game.id) {
            game.product_id = *product_id;
        }
    }
    Ok(games)
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

/// Merge the GraphQL catalog into the entitlement-backed list. A GraphQL-only
/// space is a store claim, not a PC licence the client can install; it is
/// added only when the entitlement call itself failed.
fn merge_graphql(
    games: &mut Vec<ubisoft::OwnedGame>,
    found: Vec<ubisoft::OwnedGame>,
    allow_new: bool,
) {
    for game in found {
        if let Some(index) = games.iter().position(|existing| existing.id == game.id) {
            let existing = &mut games[index];
            if existing.name.is_empty() {
                existing.name = game.name;
            }
            if existing.cover.is_empty() {
                existing.cover = game.cover;
            }
            if existing.hero.is_empty() {
                existing.hero = game.hero;
            }
        } else if allow_new {
            games.push(game);
        }
    }
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
        "remember": !session.remember.is_empty(),
    })];
    let result = import_inner(session, &mut log, true).await;
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

/// The sealed session as it stands, without touching the network. The native
/// Demux path tries this ticket first; a `ubi_v1` ticket is normally already
/// scoped to the launcher app id that Demux expects.
pub(crate) fn stored_session() -> Option<Session> {
    let stored = ubi_vault::load()?;
    let session = stored.into_session();
    (!session.ticket.trim().is_empty()).then_some(session)
}

/// Renew the sealed session through the same PUT/remember-me paths the catalog
/// sync uses, and persist the result. Returns `None` when Ubisoft rejects both.
pub(crate) async fn refresh_stored_session() -> Option<Session> {
    let session = stored_session()?;
    let client = http_client().ok()?;
    let mut live = match refresh_session(&client, &session).await {
        RefreshOutcome::Renewed(next) => Some(next),
        _ => None,
    };
    if live.is_none() {
        live = post_session(&client, &session).await;
    }
    if live.is_none() {
        if let RefreshOutcome::Renewed(next) = refresh_remember(&client, &session).await {
            live = Some(next);
        }
    }
    if let Some(next) = &live {
        ubi_vault::save(next);
    }
    live
}

/// What one background sync did.
pub(crate) enum UbiSync {
    Updated(usize),
    Unchanged(usize),
    NoSession,
    AuthLost,
    Failed(String),
}

/// Only an explicit rejection of the short ticket (with no long-lived token) or
/// of the remember token itself means the user has to sign in again. A network
/// failure must keep the sealed session so the next sync can retry.
fn should_clear_session(put_rejected: bool, remember_rejected: bool, remember_empty: bool) -> bool {
    remember_rejected || (remember_empty && put_rejected)
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
    let live = if super::ubi_direct::ubisoft_client_running() {
        // The client owns the live session. Rotating it here makes Connect
        // report a second sign-in and log the user out.
        session.clone()
    } else {
        let put = refresh_session(&client, &session).await;
        let put_rejected = matches!(&put, RefreshOutcome::Rejected);
        let mut live = match put {
            RefreshOutcome::Renewed(next) => Some(next),
            _ => None,
        };
        // The import flow already proved that a POST with the captured ticket
        // works when the PUT does not; try it before the remember token.
        if live.is_none() {
            live = post_session(&client, &session).await;
        }
        let mut remember_rejected = false;
        if live.is_none() {
            let remembered = refresh_remember(&client, &session).await;
            remember_rejected = matches!(&remembered, RefreshOutcome::Rejected);
            if let RefreshOutcome::Renewed(next) = remembered {
                live = Some(next);
            }
        }
        let Some(live) = live else {
            if should_clear_session(put_rejected, remember_rejected, session.remember.is_empty()) {
                ubi_vault::clear();
                return UbiSync::AuthLost;
            }
            return UbiSync::Failed(
                "could not refresh the Ubisoft session; keeping the saved ticket".to_string(),
            );
        };
        live
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
        "remember": !live.remember.is_empty(),
    })];
    let result = import_inner(&live, &mut log, false).await;
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

async fn import_inner(
    session: &Session,
    log: &mut Vec<serde_json::Value>,
    renew: bool,
) -> Result<(usize, Session), String> {
    let client = http_client()?;
    let mut live = session.clone();
    if renew {
        // The plugin order: post the captured session once, renew it, then read.
        let posted = post_session(&client, &live).await;
        log_note(log, "post-session", posted.is_some());
        if let Some(next) = posted {
            live = next;
        }
        let refreshed = refresh_session(&client, &live).await;
        log_note(log, "put-session", matches!(refreshed, RefreshOutcome::Renewed(_)));
        if let RefreshOutcome::Renewed(next) = refreshed {
            live = next;
        }
    }
    let mut first_error = None;
    // A successful entitlement call is the PC licence list. The GraphQL list
    // also carries store claims the client cannot install, so it is only used
    // as the ownership source when the entitlement call itself failed.
    let (mut games, entitlements_ok) = match collect_entitlements(&client, &live, log).await {
        Ok(games) => (games, true),
        Err(err) => {
            first_error = Some(err);
            // The captured ticket can be stale; one more session POST is the
            // plugin's fallback before it gives up.
            if let Some(next) = post_session(&client, &live).await {
                live = next;
                match collect_entitlements(&client, &live, log).await {
                    Ok(games) => (games, true),
                    Err(err) => {
                        first_error = Some(err);
                        (Vec::new(), false)
                    }
                }
            } else {
                (Vec::new(), false)
            }
        }
    };
    log_note(log, "entitlements", entitlements_ok);
    // The catalog and the GraphQL list cover the same account from two sides;
    // the GraphQL pass contributes the box art and the fallback list.
    match collect_graphql(&client, &live, log).await {
        Ok(found) => merge_graphql(&mut games, found, !entitlements_ok),
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
async fn refresh_remember(
    client: &reqwest::Client,
    session: &Session,
) -> RefreshOutcome {
    if session.remember.is_empty() {
        return RefreshOutcome::Unavailable;
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
    let response = match client
        .post(SESSIONS_URL)
        .headers(map)
        .json(&serde_json::json!({ "rememberMe": true }))
        .send()
        .await
    {
        Ok(response) => response,
        Err(_) => return RefreshOutcome::Unavailable,
    };
    let status = response.status();
    if status == reqwest::StatusCode::UNAUTHORIZED || status == reqwest::StatusCode::FORBIDDEN {
        return RefreshOutcome::Rejected;
    }
    if !status.is_success() {
        return RefreshOutcome::Unavailable;
    }
    let Ok(value) = response.json::<serde_json::Value>().await else {
        return RefreshOutcome::Unavailable;
    };
    match apply_session(session, &value) {
        Some(next) => RefreshOutcome::Renewed(next),
        None => RefreshOutcome::Unavailable,
    }
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

/// Space ids and numeric product ids of owned, non-expired entitlements.
pub(crate) fn entitlement_products(value: &serde_json::Value) -> Vec<(String, u32)> {
    let mut rows: Vec<(String, u32)> = Vec::new();
    let Some(items) = value.get("entitlements").and_then(|v| v.as_array()) else {
        return rows;
    };
    for item in items {
        if item.get("availability").and_then(|v| v.as_str()) == Some("expired") {
            continue;
        }
        let Some(space) = item.get("spaceId").and_then(|v| v.as_str()) else {
            continue;
        };
        if space.is_empty() || rows.iter().any(|(id, _)| id == space) {
            continue;
        }
        let product = item
            .get("productId")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        rows.push((space.to_string(), product));
    }
    rows
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
            product_id: 0,
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
            product_id: 0,
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
    let live = refresh_session(&client, &session).await;
    let mut live = match live {
        RefreshOutcome::Renewed(next) => Some(next),
        _ => None,
    };
    if live.is_none() {
        live = post_session(&client, &session).await;
    }
    if live.is_none() {
        if let RefreshOutcome::Renewed(next) = refresh_remember(&client, &session).await {
            live = Some(next);
        }
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
        assert_eq!(session.remember, "rm");
        assert!(session_from_fragment("not-base64").is_none());
        assert!(session_from_fragment(&fragment(r#"{"sessionId":"S"}"#)).is_none());
    }

    #[test]
    fn the_store_script_keeps_the_store_login_in_page() {
        // The store persists its own session in UPlayConnect-Login. Hijacking
        // its popup to the standalone overlay was what left the tab signed out.
        assert!(WATCH_SCRIPT.contains("UPlayConnect-Login"));
        assert!(WATCH_SCRIPT.contains("toggleLoginType(\"modal\")"));
        assert!(WATCH_SCRIPT.contains("data-login-type"));
        assert!(WATCH_SCRIPT.contains("__efxlveUbiSignIn"));
        assert!(!WATCH_SCRIPT.contains("window.open ="));
    }

    #[test]
    fn a_network_failure_keeps_the_sealed_session_but_a_rejection_does_not() {
        assert!(!should_clear_session(false, false, false));
        assert!(!should_clear_session(true, false, false));
        assert!(should_clear_session(true, false, true));
        assert!(should_clear_session(false, true, false));
        assert!(should_clear_session(false, true, true));
        assert!(!should_clear_session(false, false, true));
    }

    #[test]
    fn apply_session_keeps_the_remember_token_when_the_response_omits_it() {
        let session = Session {
            ticket: "old".into(),
            session_id: "S".into(),
            user_id: "U".into(),
            name: "P".into(),
            remember: "rm".into(),
        };
        let next = apply_session(&session, &serde_json::json!({"ticket": "new"})).unwrap();
        assert_eq!(next.ticket, "new");
        assert_eq!(next.remember, "rm");
    }

    #[test]
    fn entitlements_skip_expired_duplicates_and_empty_spaces() {
        let value = serde_json::json!({"entitlements": [
            {"spaceId": "a", "productId": 123, "availability": "owned"},
            {"spaceId": "a", "productId": 999, "availability": "owned"},
            {"spaceId": "b", "productId": 456, "availability": "expired"},
            {"spaceId": "", "productId": 789, "availability": "owned"},
            {}
        ]});
        assert_eq!(entitlement_products(&value), vec![("a".to_string(), 123)]);
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

    fn owned(id: &str, name: &str, product_id: u32) -> ubisoft::OwnedGame {
        ubisoft::OwnedGame {
            id: id.into(),
            product_id,
            name: name.into(),
            cover: String::new(),
            hero: String::new(),
            description: String::new(),
        }
    }

    #[test]
    fn graphql_store_claims_do_not_join_the_entitlement_list() {
        let mut games = vec![owned("space-real", "Real Game", 1234)];
        merge_graphql(
            &mut games,
            vec![
                owned("space-real", "Real Game", 0),
                owned("space-fenyx", "Immortals Fenyx Rising", 0),
            ],
            false,
        );
        assert_eq!(games.len(), 1);
        assert_eq!(games[0].id, "space-real");

        // A failed entitlement call keeps the GraphQL list as the fallback.
        let mut fallback = Vec::new();
        merge_graphql(
            &mut fallback,
            vec![owned("space-fenyx", "Immortals Fenyx Rising", 0)],
            true,
        );
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].id, "space-fenyx");
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
