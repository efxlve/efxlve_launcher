//! In-app Epic sign-in window.
//!
//! Epic's OAuth login runs in a child webview over the main window. The final
//! redirect page carries the authorization code; the page script hands it back,
//! and legendary exchanges it for a session. The old external page and paste
//! field stay as a fallback on the Accounts card.

use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder, WebviewUrl};

const LABEL: &str = "epic-login";
/// Public Epic launcher client id used by legendary and other open clients.
const CLIENT_ID: &str = "34a02cf8f4414e29b15921876da36f9a";
const LOGIN_PAGE: &str = "https://www.epicgames.com/id/login";
const REDIRECT_PAGE: &str = "https://www.epicgames.com/id/api/redirect";

/// Watches the sign-in page for the authorization code and hands it to Rust.
///
/// The final redirect is a JSON document. Some flows fetch it instead of
/// navigating to it, so the script also inspects fetch/XHR responses. The close
/// button is the only way out of the frameless child.
const WATCH_SCRIPT: &str = r#"
(function () {
  if (window.__efxlveEpicWatch) return;
  window.__efxlveEpicWatch = true;

  function handoff(code) {
    if (!code || window.__efxlveEpicSent) return;
    window.__efxlveEpicSent = true;
    location.replace("https://efxlve.local/epic-auth?code=" + encodeURIComponent(code));
  }

  function codeFrom(text) {
    var trimmed = String(text || "").trim();
    if (trimmed.charAt(0) !== "{" || trimmed.indexOf("authorizationCode") === -1) return "";
    try {
      var parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.authorizationCode === "string") return parsed.authorizationCode;
    } catch (e) {}
    var match = trimmed.match(/"authorizationCode"\s*:\s*"([^"]+)"/);
    return match ? match[1] : "";
  }

  function scan(text) {
    handoff(codeFrom(String(text || "")));
  }

  function checkPage() {
    if (window.__efxlveEpicSent || location.hostname === "efxlve.local") return;
    var text = "";
    try {
      text = document.body ? (document.body.innerText || document.body.textContent || "") : "";
    } catch (e) {}
    // Edge may render a JSON answer inside its viewer instead of a body text
    // block; the pre element keeps the raw document.
    if (String(text || "").trim().charAt(0) !== "{") {
      var pre = document.querySelector("pre");
      if (pre) text = pre.innerText || pre.textContent || text;
    }
    scan(text);
  }
  setInterval(checkPage, 350);

  var open = XMLHttpRequest.prototype.open;
  var send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function () {
    this.__efxlveEpicUrl = arguments[1];
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    var xhr = this;
    xhr.addEventListener("load", function () { scan(xhr.responseText); });
    return send.apply(this, arguments);
  };
  var origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function () {
      return origFetch.apply(this, arguments).then(function (response) {
        try {
          response.clone().text().then(scan).catch(function () {});
        } catch (e) {}
        return response;
      });
    };
  }

  function addClose() {
    if (document.getElementById("efxlve-epic-close")) return;
    var button = document.createElement("button");
    button.id = "efxlve-epic-close";
    button.type = "button";
    button.textContent = "\u2715";
    button.title = "Close";
    button.style.cssText =
      "position:fixed;top:10px;right:10px;z-index:2147483647;width:32px;height:32px;" +
      "border:0;border-radius:50%;background:rgba(20,20,20,.72);color:#fff;font-size:15px;" +
      "line-height:32px;cursor:pointer;padding:0;";
    button.addEventListener("click", function () {
      location.href = "https://efxlve.local/epic-cancel";
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

fn redirect_url() -> String {
    format!("{REDIRECT_PAGE}?clientId={CLIENT_ID}&responseType=code")
}

fn login_url() -> Result<url::Url, String> {
    let mut url = url::Url::parse(LOGIN_PAGE).map_err(|e| e.to_string())?;
    url.query_pairs_mut().append_pair("redirectUrl", &redirect_url());
    Ok(url)
}

/// Opens the Epic sign-in page over the main window.
pub async fn open_login(app: AppHandle) -> Result<(), String> {
    let url = login_url()?;
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
            if target.scheme() == "https" && target.host_str() == Some("efxlve.local") {
                if target.path() == "/epic-cancel" {
                    hide_login(&app_nav);
                    return false;
                }
                if target.path() == "/epic-auth" {
                    let code = target
                        .query_pairs()
                        .find(|(key, _)| key == "code")
                        .map(|(_, value)| value.to_string())
                        .filter(|value| !value.trim().is_empty());
                    match code {
                        Some(code) => accept_code(&app_nav, code.trim()),
                        None => {
                            hide_login(&app_nav);
                            let _ = app_nav.emit("epic-auth-failed", "@t:auth.noAuthCode");
                        }
                    }
                    return false;
                }
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

fn accept_code(app: &AppHandle, code: &str) {
    hide_login(app);
    let _ = app.emit("epic-auth-code", code.to_string());
}

pub fn hide_login(app: &AppHandle) {
    let Some(window) = app.get_window("main") else {
        return;
    };
    if let Some(webview) = window.get_webview(LABEL) {
        let _ = webview.close();
    }
}

/// Centers the sheet over the main window, clamped to a small-screen window.
fn centered(window: &tauri::Window) -> (f64, f64, f64, f64) {
    let mut width = 520.0f64;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_url_carries_the_epic_client_and_redirect() {
        let url = login_url().expect("login url");
        assert_eq!(url.host_str(), Some("www.epicgames.com"));
        assert_eq!(url.path(), "/id/login");
        let redirect = url
            .query_pairs()
            .find(|(key, _)| key == "redirectUrl")
            .map(|(_, value)| value.to_string())
            .expect("redirectUrl");
        assert_eq!(
            redirect,
            "https://www.epicgames.com/id/api/redirect?clientId=34a02cf8f4414e29b15921876da36f9a&responseType=code"
        );
    }
}
