//! Battle.net sign-in page.
//!
//! The Galaxy plugin reads owned games from the account site after the user
//! logs in. This child webview does the same: the page's own `games-and-subs`
//! response is handed back here. No shared OAuth secret is stored.

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder, WebviewUrl};

use super::accounts;
use super::battlenet;

const LABEL: &str = "companion-login";

const WATCH_SCRIPT: &str = r#"
(function () {
  window.__efxlveBnetWatch = true;
  var bag = { games: null, classic: null, tag: "" };
  function hasList(obj) {
    if (!obj || typeof obj !== "object") return false;
    if (Array.isArray(obj.gameAccounts) && obj.gameAccounts.length) return true;
    if (Array.isArray(obj.classicGames) && obj.classicGames.length) return true;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var child = obj[keys[i]];
      if (child && typeof child === "object" && hasList(child)) return true;
    }
    return false;
  }
  function findTag(value) {
    if (!value || typeof value !== "object") return "";
    if (typeof value.battleTag === "string") return value.battleTag;
    if (typeof value.battle_tag === "string") return value.battle_tag;
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i++) {
      var child = value[keys[i]];
      if (child && typeof child === "object") {
        var found = findTag(child);
        if (found) return found;
      }
    }
    return "";
  }
  function take(url, text) {
    if (!url || window.__efxlveBnetSent) return;
    var hit = url.indexOf("games-and-subs") !== -1 ? "games" : (url.indexOf("classic-games") !== -1 ? "classic" : "");
    if (!hit && text.indexOf("battleTag") === -1 && text.indexOf("battle_tag") === -1) return;
    var parsed = null;
    try { parsed = JSON.parse(text); } catch (e) { return; }
    if (hit) bag[hit] = parsed;
    if (!bag.tag) {
      var tag = findTag(parsed);
      if (tag) bag.tag = tag;
    }
    if (!bag.games && !bag.classic) return;
    if (!hasList(bag.games) && !hasList(bag.classic)) return;
    clearTimeout(window.__efxlveBnetTimer);
    window.__efxlveBnetTimer = setTimeout(function () {
      if (window.__efxlveBnetSent) return;
      if (!hasList(bag.games) && !hasList(bag.classic)) return;
      window.__efxlveBnetSent = true;
      var body = encodeURIComponent(JSON.stringify({ games: bag.games, classic: bag.classic, tag: bag.tag }));
      location.replace("https://efxlve.local/bnet-library#" + body);
    }, 600);
  }
  if (!window.__efxlveBnetHooks) {
  window.__efxlveBnetHooks = true;
  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__efxUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener("load", function () {
      if (xhr.status === 200) take(String(xhr.__efxUrl || ""), xhr.responseText);
    });
    return send.apply(this, arguments);
  };
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = (typeof input === "string") ? input : (input && input.url) || "";
      return origFetch.apply(this, arguments).then(function (response) {
        if (response && response.ok) {
          response.clone().text().then(function (text) { take(url, text); }).catch(function () {});
        }
        return response;
      });
    };
  }
  }
  function pullAccount() {
    if (window.__efxlveBnetSent) return;
    var opts = { credentials: "include", headers: { "Accept": "application/json" } };
    Promise.all([
      fetch("/api/games-and-subs", opts).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
      fetch("/api/classic-games", opts).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
    ]).then(function (pair) {
      if (window.__efxlveBnetSent) return;
      if (!bag.tag) {
        var tag = findTag(pair[0]) || findTag(pair[1]);
        if (tag) bag.tag = tag;
      }
      if (!hasList(pair[0]) && !hasList(pair[1])) return;
      window.__efxlveBnetSent = true;
      var body = encodeURIComponent(JSON.stringify({ games: pair[0], classic: pair[1], tag: bag.tag }));
      location.replace("https://efxlve.local/bnet-library#" + body);
    });
  }
  pullAccount();
  if (!window.__efxlveBnetTimerPull) {
    window.__efxlveBnetTimerPull = setInterval(pullAccount, 2000);
  }
})();
"#;

pub async fn show_login(app: AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let window = app.get_window("main").ok_or_else(|| "@t:win.mainWindowNotFound".to_string())?;
    let width = width.max(640.0);
    let height = height.max(480.0);
    let url = url::Url::parse("https://account.battle.net/games").map_err(|e| e.to_string())?;
    if let Some(webview) = window.get_webview(LABEL) {
        let _ = webview.set_bounds(bounds(x, y, width, height));
        let _ = webview.show();
        // Already on the signed-in account page: ask that page for the game list.
        let _ = webview.eval(WATCH_SCRIPT);
        return Ok(());
    }
    let app_nav = app.clone();
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        .background_color(tauri::webview::Color(0, 0, 0, 255))
        .initialization_script(WATCH_SCRIPT)
        .on_navigation(move |target| {
            if target.scheme() == "https" && target.host_str() == Some("efxlve.local") && target.path() == "/bnet-library" {
                accept_library(&app_nav, target.fragment().unwrap_or(""));
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

fn bounds(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width, height)),
    }
}

pub(crate) fn watch_script() -> &'static str {
    WATCH_SCRIPT
}

pub(crate) fn accept_library(app: &AppHandle, fragment: &str) {
    // The page script hands the JSON over with `encodeURIComponent`, so the
    // fragment is percent-encoded and must be decoded before parsing.
    let decoded = percent_decode(fragment);
    let (games, tag) = battlenet::account_library(&decoded);
    if games.is_empty() {
        if let Some(window) = app.get_window("main") {
            if let Some(webview) = window.get_webview(LABEL) {
                let _ = webview.eval("window.__efxlveBnetSent = false;");
            }
        }
        return;
    }
    battlenet::save_owned(&games);
    // The page usually exposes the BattleTag; fall back to the client config.
    let name = if tag.is_empty() { accounts::detected_name("battlenet") } else { tag };
    let _ = accounts::link_named("battlenet", &name);
    // The account page did its job: the tab returns to the store page.
    if let Some(window) = app.get_window("main") {
        if let Some(webview) = window.get_webview("store-view-battlenet") {
            if let Ok(url) = url::Url::parse("https://shop.battle.net/") {
                let _ = webview.navigate(url);
            }
        }
    }
    let _ = app.emit(
        "companion-signed-in",
        serde_json::json!({ "store": "battlenet", "count": games.len() }),
    );
}

pub fn hide_login(app: &AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    if let Some(webview) = window.get_webview(LABEL) {
        let _ = webview.close();
    }
}

/// Decodes `encodeURIComponent` output: `%XX` escapes to UTF-8 bytes. `+` is
/// kept as-is (unlike form encoding), because JSON strings may contain it.
fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_digit(bytes[i + 1]), hex_digit(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percent_encoded_handoff_decodes_to_the_json_payload() {
        let payload = r#"{"games":{"gameAccounts":[{"titleId":4613486,"localizedGameName":"Diablo IV"}]}}"#;
        let mut encoded = String::new();
        for byte in payload.as_bytes() {
            match byte {
                b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                    encoded.push(*byte as char)
                }
                other => encoded.push_str(&format!("%{other:02X}")),
            }
        }
        assert_eq!(percent_decode(&encoded), payload);
        let games = battlenet::account_library(&percent_decode(&encoded)).0;
        assert!(games.iter().any(|(id, name)| id == "fenris" && name == "Diablo IV"));
    }

    #[test]
    fn percent_decode_keeps_plus_and_multibyte_utf8() {
        assert_eq!(percent_decode("a+b"), "a+b");
        assert_eq!(percent_decode("%C4%B0lk%20Kan"), "İlk Kan");
        assert_eq!(percent_decode("%7"), "%7", "a truncated escape passes through");
        assert_eq!(percent_decode("%zz"), "%zz");
    }

    #[test]
    fn battle_tag_is_read_from_the_handoff() {
        let text = r#"{"games":{"battleTag":"Player#1234","gameAccounts":[{"titleId":4613486}]},"tag":""}"#;
        let (games, tag) = battlenet::account_library(text);
        assert!(games.iter().any(|(id, _)| id == "fenris"));
        assert_eq!(tag, "Player#1234");
        let top = r#"{"games":{"gameAccounts":[{"titleId":5272175}]},"classic":null,"tag":"Other#5678"}"#;
        let (_, tag) = battlenet::account_library(top);
        assert_eq!(tag, "Other#5678");
    }
}
