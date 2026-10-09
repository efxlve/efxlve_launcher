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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder, WebviewUrl,
};

const LABEL: &str = "spotify-player";
const HOME_URL: &str = "https://open.spotify.com/";

/// True while the frontend wants the player on screen.
static VISIBLE: AtomicBool = AtomicBool::new(false);
/// Last reported slot rectangle (logical px), re-applied after a resize.
static RECT: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);

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

/// Creates the player on first use, then positions and shows it.
#[tauri::command]
pub async fn spotify_player_show(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Ok(mut slot) = RECT.lock() {
        *slot = Some((x, y, width, height));
    }
    VISIBLE.store(true, Ordering::SeqCst);

    if let Some(view) = player(&app) {
        view.set_bounds(rect_of(x, y, width, height))
            .map_err(|error| error.to_string())?;
        view.show().map_err(|error| error.to_string())?;
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "no_main_window".to_string())?;
    let url = HOME_URL
        .parse::<url::Url>()
        .map_err(|error| error.to_string())?;
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

/// Hides the player; the page stays loaded for the next visit.
#[tauri::command]
pub fn spotify_player_hide(app: AppHandle) {
    VISIBLE.store(false, Ordering::SeqCst);
    if let Some(view) = player(&app) {
        let _ = view.hide();
    }
}

/// Re-applies the last rectangle (window resize while visible).
#[tauri::command]
pub fn spotify_player_resize(app: AppHandle, x: f64, y: f64, width: f64, height: f64) {
    if let Ok(mut slot) = RECT.lock() {
        *slot = Some((x, y, width, height));
    }
    if !VISIBLE.load(Ordering::SeqCst) {
        return;
    }
    if let Some(view) = player(&app) {
        let _ = view.set_bounds(rect_of(x, y, width, height));
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

/// Closes the player entirely (used by tests and future logout flows).
#[tauri::command]
pub fn spotify_player_close(app: AppHandle) {
    VISIBLE.store(false, Ordering::SeqCst);
    if let Some(view) = player(&app) {
        let _ = view.close();
    }
}
