//! Embedded Spotify web player (child WebView2) for the launcher's Spotify page.
//!
//! The page loads the normal `open.spotify.com` interface: search, library,
//! playlists, queue — everything Spotify ships, no custom UI. WebView2 has no
//! Widevine CDM, so the embedded player cannot decrypt audio itself; pressing
//! play in the page targets the launcher's librespot Connect receiver
//! ("Efxlve Launcher"), which plays locally. That keeps the normal UI and
//! working audio at the same time.
//!
//! The child webview is positioned by the frontend (slot rectangle) and hidden
//! whenever the user leaves the page or a modal covers it.
//!
//! `spotify_open_in_launcher` lets the in-game overlay open a link here instead
//! of in the browser; it only claims the link when the embedded page already
//! has a Spotify session (`sp_dc` cookie), so callers can fall back otherwise.

use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder,
    WebviewUrl,
};

const LABEL: &str = "spotify-player";
const HOME_URL: &str = "https://open.spotify.com/";

/// Initial URL for the next player creation (`spotify_open_in_launcher` on a
/// not-yet-created player).
static PENDING_URL: Mutex<Option<String>> = Mutex::new(None);

fn player(app: &AppHandle) -> Option<tauri::Webview> {
    app.get_window("main")?
        .webviews()
        .into_iter()
        .find(|view| view.label() == LABEL)
}

fn rect_of(x: f64, y: f64, width: f64, height: f64) -> tauri::Rect {
    tauri::Rect {
        position: Position::Logical(LogicalPosition::new(x, y)),
        size: Size::Logical(LogicalSize::new(width.max(100.0), height.max(100.0))),
    }
}

/// Creates the child webview at `url` and the given rectangle.
async fn create_player(
    app: &AppHandle,
    url: url::Url,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "no_main_window".to_string())?;
    // Never pass `additional_browser_args` to a child webview builder.
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url));
    let position = Position::Logical(LogicalPosition::new(x, y));
    let size = Size::Logical(LogicalSize::new(width.max(100.0), height.max(100.0)));

    // `add_child` posts to the main thread and waits; run it off the async
    // runtime so the UI never blocks on creation.
    let target = window.clone();
    let created = tokio::task::spawn_blocking(move || target.add_child(builder, position, size));
    created
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// Creates the player on first use, then positions and shows it.
#[tauri::command]
pub async fn spotify_player_show(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(view) = player(&app) {
        view.set_bounds(rect_of(x, y, width, height))
            .map_err(|error| error.to_string())?;
        view.show().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let pending = PENDING_URL.lock().ok().and_then(|mut slot| slot.take());
    let url = pending
        .and_then(|raw| raw.parse::<url::Url>().ok())
        .or_else(|| HOME_URL.parse::<url::Url>().ok())
        .ok_or_else(|| "bad_url".to_string())?;
    create_player(&app, url, x, y, width, height).await
}

/// Hides the player; the page stays loaded for the next visit.
#[tauri::command]
pub fn spotify_player_hide(app: AppHandle) {
    if let Some(view) = player(&app) {
        let _ = view.hide();
    }
}

/// Reloads the player page (a stuck sign-in or a stale session).
#[tauri::command]
pub fn spotify_player_reload(app: AppHandle) {
    if let Some(view) = player(&app) {
        if let Ok(url) = HOME_URL.parse::<url::Url>() {
            let _ = view.navigate(url);
        }
    }
}

/// Goes back one step in the player's own history (album -> artist -> search).
#[tauri::command]
pub fn spotify_player_back(app: AppHandle) {
    if let Some(view) = player(&app) {
        let _ = view.eval("history.back()");
    }
}

/// True when the embedded page already has a signed-in Spotify session.
pub(crate) fn has_spotify_session(app: &AppHandle) -> bool {
    let Ok(url) = HOME_URL.parse::<url::Url>() else {
        return false;
    };
    let webview = player(app).or_else(|| app.get_webview("main"));
    let Some(webview) = webview else {
        return false;
    };
    webview
        .cookies_for_url(url)
        .map(|cookies| {
            cookies
                .iter()
                .any(|cookie| cookie.name() == "sp_dc" && !cookie.value().is_empty())
        })
        .unwrap_or(false)
}

/// `spotify:track:<id>` / bare links -> an `open.spotify.com` URL.
fn spotify_web_url(url: &str) -> String {
    if let Some(rest) = url.strip_prefix("spotify:") {
        if rest.is_empty() {
            return HOME_URL.to_string();
        }
        return format!("https://open.spotify.com/{}", rest.replace(':', "/"));
    }
    if url.starts_with("https://open.spotify.com/") || url.starts_with("http://open.spotify.com/") {
        return url.to_string();
    }
    HOME_URL.to_string()
}

/// True when the embedded Spotify page is signed in (drives the sidebar
/// player's visibility).
#[tauri::command]
pub async fn spotify_signed_in(app: AppHandle) -> bool {
    tauri::async_runtime::spawn_blocking(move || has_spotify_session(&app))
        .await
        .unwrap_or(false)
}

/// Opens a Spotify link in the launcher's embedded player and brings the
/// launcher forward. Returns `false` when the embedded player has no Spotify
/// session yet, so the caller can fall back to the browser.
#[tauri::command]
pub async fn spotify_open_in_launcher(app: AppHandle, url: String) -> Result<bool, String> {
    if !has_spotify_session(&app) {
        return Ok(false);
    }
    let target = spotify_web_url(&url);

    // The launcher takes over: drop the overlay and pull the window forward.
    crate::overlay::overlay_hide(app.clone());
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
    // The launcher frontend switches to the Spotify page and repositions the
    // child webview.
    let _ = app.emit_to("main", "spotify-open", target.clone());

    if let Some(view) = player(&app) {
        if let Ok(parsed) = target.parse::<url::Url>() {
            let _ = view.navigate(parsed);
        }
        let _ = view.show();
    } else if let Ok(mut slot) = PENDING_URL.lock() {
        // Created on the next `spotify_player_show` with this URL.
        *slot = Some(target);
    }
    Ok(true)
}
