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

/// Fake host the dev page probe reports through; the navigation is cancelled.
const PROBE_HOST: &str = "efxlve.local";

/// Dev-only page probe. After the document finishes, the page reports its own
/// render state (title, viewport, app-mount children) through a navigation to
/// `PROBE_HOST`; that navigation is cancelled and logged, so a blank child can
/// be told apart from a loaded-but-unpainted page. Empty in release builds.
const PROBE_SCRIPT: &str = if cfg!(debug_assertions) {
    r#"
(function () {
    function probe(tag) {
        try {
            var mount = document.getElementById('app-mount');
            var ls = 'n/a';
            try {
                localStorage.setItem('__efxlve_probe', '1');
                localStorage.removeItem('__efxlve_probe');
                ls = 'ok';
            } catch (e) {
                ls = String(e);
            }
            var info = {
                tag: tag,
                ready: document.readyState,
                title: document.title,
                kids: document.body ? document.body.childElementCount : -1,
                mount: mount ? mount.childElementCount : -1,
                html: document.documentElement ? document.documentElement.outerHTML.length : -1,
                txt: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 100) : '',
                bg: document.body ? getComputedStyle(document.body).backgroundColor : '',
                vis: document.visibilityState,
                ck: 'cookieEnabled' in navigator ? navigator.cookieEnabled : null,
                ls: ls,
                sc: document.querySelectorAll('script').length,
                rs: performance.getEntriesByType ? performance.getEntriesByType('resource').length : -1,
                iw: window.innerWidth,
                ih: window.innerHeight,
                dpr: window.devicePixelRatio
            };
            location.assign('https://efxlve.local/probe?d=' + encodeURIComponent(JSON.stringify(info)));
        } catch (e) {
            location.assign('https://efxlve.local/probe?err=' + encodeURIComponent(String(e)));
        }
    }
    setTimeout(function () { probe('t2'); }, 2000);
    setTimeout(function () { probe('t8'); }, 8000);
})();
"#
} else {
    ""
};

/// Dev-only hooks installed before any page script runs: boot failures (thrown
/// errors, rejected promises, failed resource loads, `console.error`) are
/// reported through the same cancelled probe navigation. Empty in release.
const PROBE_HOOKS_SCRIPT: &str = if cfg!(debug_assertions) {
    r#"
(function () {
    if (window.__efxlveProbeHooked) { return; }
    window.__efxlveProbeHooked = true;
    var sent = 0;
    function send(kind, text) {
        if (sent > 25) { return; }
        sent += 1;
        try {
            location.assign('https://efxlve.local/probe?' + kind + '=' + encodeURIComponent(String(text).slice(0, 600)));
        } catch (e) {}
    }
    window.addEventListener('error', function (e) {
        var el = e.target;
        if (el && el.tagName) {
            send('res', el.tagName + ' ' + (el.src || el.href || ''));
            return;
        }
        send('err', (e.message || 'error') + ' @ ' + (e.filename || '') + ':' + (e.lineno || 0));
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
        var r = e.reason;
        send('rej', (r && (r.stack || r.message)) || r);
    });
    var orig = console.error;
    console.error = function () {
        try {
            send('cerr', Array.prototype.map.call(arguments, function (a) { return String(a); }).join(' '));
        } catch (e) {}
        return orig.apply(console, arguments);
    };
})();
"#
} else {
    ""
};

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
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        // Discord's dark surface, so the first paint has no white flash.
        .background_color(tauri::webview::Color(49, 51, 56, 255))
        .on_navigation(|target| {
            // Dev probe report: logged, then cancelled so the child stays on
            // Discord. Any other non-Discord host is denied outright.
            if target.host_str() == Some(PROBE_HOST) {
                eprintln!("[discord-view] probe {}", target);
                return false;
            }
            is_discord_host(target)
        })
        // Load diagnostics: the terminal that runs `tauri dev` shows whether the
        // page ever reaches a finished load, which separates a network problem
        // (blocked host, no `Finished`) from a rendering problem.
        .on_page_load(|webview, payload| {
            eprintln!("[discord-view] {:?} {}", payload.event(), payload.url());
            if payload.event() == tauri::webview::PageLoadEvent::Finished && !PROBE_SCRIPT.is_empty() {
                let _ = webview.eval(PROBE_SCRIPT);
            }
        })
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny);
    // Dev-only hooks: boot errors and failed resource loads report back so a
    // page that loads but never mounts can be explained from the terminal.
    if !PROBE_HOOKS_SCRIPT.is_empty() {
        builder = builder.initialization_script(PROBE_HOOKS_SCRIPT);
    }
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
    let existing = view(&app);
    eprintln!(
        "[discord-view] show rect=({x:.0},{y:.0},{width:.0}x{height:.0}) existing={}",
        existing.is_some()
    );
    if let Some(view) = existing {
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
        eprintln!("[discord-view] destroy");
        let _ = view.close();
    }
}

/// Opens the child webview's devtools so the page's console and network can be
/// read directly while the spike is under test. Dev builds only: the devtools
/// API does not exist in release builds, so this is a no-op there.
#[tauri::command]
pub fn discord_open_devtools(app: AppHandle) {
    #[cfg(debug_assertions)]
    {
        if let Some(view) = view(&app) {
            view.open_devtools();
        }
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
    }
}
