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
  if (window.__efxlveBnetWatch) return;
  window.__efxlveBnetWatch = true;
  var bag = { games: null, classic: null };
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
  function take(url, text) {
    if (!url || window.__efxlveBnetSent) return;
    var hit = url.indexOf("games-and-subs") !== -1 ? "games" : (url.indexOf("classic-games") !== -1 ? "classic" : "");
    if (!hit) return;
    try { bag[hit] = JSON.parse(text); } catch (e) { return; }
    if (!bag.games && !bag.classic) return;
    if (!hasList(bag.games) && !hasList(bag.classic)) return;
    clearTimeout(window.__efxlveBnetTimer);
    window.__efxlveBnetTimer = setTimeout(function () {
      if (window.__efxlveBnetSent) return;
      if (!hasList(bag.games) && !hasList(bag.classic)) return;
      window.__efxlveBnetSent = true;
      var body = encodeURIComponent(JSON.stringify({ games: bag.games, classic: bag.classic }));
      location.replace("https://efxlve.local/bnet-library#" + body);
    }, 600);
  }
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
        let _ = webview.navigate(url);
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

fn accept_library(app: &AppHandle, fragment: &str) {
    let games = battlenet::account_games(fragment);
    if games.is_empty() {
        return;
    }
    battlenet::save_owned(&games);
    let name = accounts::detected_name("battlenet");
    let _ = accounts::link_named("battlenet", &name);
    let _ = app.emit(
        "companion-signed-in",
        serde_json::json!({ "store": "battlenet", "count": games.len() }),
    );
    if let Some(window) = app.get_window("main") {
        if let Some(webview) = window.get_webview(LABEL) {
            let _ = webview.close();
        }
    }
}

pub fn hide_login(app: &AppHandle) {
    let Some(window) = app.get_window("main") else { return };
    if let Some(webview) = window.get_webview(LABEL) {
        let _ = webview.close();
    }
}
