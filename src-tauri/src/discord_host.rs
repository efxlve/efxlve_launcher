//! Embedded Discord web client (child WebView2) for the launcher's Discord page.
//!
//! The page loads the normal `discord.com/app` interface: friends, direct
//! messages and servers are the real Discord UI, no custom social layer. The
//! child webview is positioned by the frontend (slot rectangle) and parked
//! while a covering surface (modal, command palette) is open.
//!
//! A full Discord client is a heavy renderer, so the view is destroyed when the
//! user leaves the page; the WebView2 profile keeps the session, so the next
//! visit stays signed in.

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder, WebviewUrl,
};

const LABEL: &str = "discord-view";
const HOME_URL: &str = "https://discord.com/app";

/// The Discord web client stays inside its own family of hosts. Anything else
/// (help pages, external links) is denied; the system-browser handoff for those
/// links can come with the lifecycle hardening pass.
///
/// Every non-http(s) URL is allowed: internal pages such as `about:blank` and
/// Chromium's network-error page must never be blocked, or a failed load would
/// leave the child blank with nothing to show the user.
fn is_discord_host(url: &url::Url) -> bool {
    if url.scheme() != "http" && url.scheme() != "https" {
        return true;
    }
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    host == "discord.com"
        || host.ends_with(".discord.com")
        || host == "discordapp.com"
        || host.ends_with(".discordapp.com")
}

fn view(app: &AppHandle) -> Option<tauri::Webview> {
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

/// Creates the child webview inside the main window.
async fn create_view(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) -> Result<(), String> {
    let window = app
        .get_window("main")
        .ok_or_else(|| "no_main_window".to_string())?;
    let url = HOME_URL
        .parse::<url::Url>()
        .map_err(|_| "bad_url".to_string())?;
    // Never pass `additional_browser_args` to a child webview builder; it
    // silently blanks the child.
    let builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        // Discord's dark surface, so the first paint has no white flash.
        .background_color(tauri::webview::Color(49, 51, 56, 255))
        .on_navigation(is_discord_host)
        // Load diagnostics: the terminal that runs `tauri dev` shows whether the
        // page ever reaches a finished load, which separates a network problem
        // (blocked host, no `Finished`) from a rendering problem.
        .on_page_load(|_webview, payload| {
            eprintln!("[discord-view] {:?} {}", payload.event(), payload.url());
        })
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);
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

/// Creates the Discord page on first use, then positions and shows it.
#[tauri::command]
pub async fn discord_view_show(
    app: AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if let Some(view) = view(&app) {
        view.set_bounds(rect_of(x, y, width, height))
            .map_err(|error| error.to_string())?;
        view.show().map_err(|error| error.to_string())?;
        return Ok(());
    }
    create_view(&app, x, y, width, height).await
}

/// Hides the page while a covering surface (modal, command palette) is open.
/// The state stays warm for the next show.
#[tauri::command]
pub fn discord_view_hide(app: AppHandle) {
    if let Some(view) = view(&app) {
        let _ = view.hide();
    }
}

/// Reloads the page (a stuck sign-in or a stale session).
#[tauri::command]
pub fn discord_view_reload(app: AppHandle) {
    if let Some(view) = view(&app) {
        if let Ok(url) = HOME_URL.parse::<url::Url>() {
            let _ = view.navigate(url);
        }
    }
}

/// Destroys the child webview when the user leaves the page. A full Discord
/// client renderer is too heavy to keep alive next to the store/Spotify
/// children; the WebView2 profile preserves the session for the next visit.
#[tauri::command]
pub fn discord_view_destroy(app: AppHandle) {
    if let Some(view) = view(&app) {
        let _ = view.close();
    }
}
