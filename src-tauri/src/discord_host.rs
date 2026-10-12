//! Embedded Discord web client (child WebView2) for the launcher's Discord page.
//!
//! The page loads the normal `discord.com/app` interface: friends, direct
//! messages and servers are the real Discord UI, no custom social layer. The
//! child webview is positioned by the frontend (slot rectangle), stays hidden
//! until the web client has actually painted (the page's loading note shows
//! instead) and is parked while a covering surface (modal, command palette) is
//! open.
//!
//! A full Discord client is a heavy renderer, so the view is destroyed when the
//! user leaves the page; the WebView2 profile keeps the session, so the next
//! visit stays signed in.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Position, Size, WebviewBuilder, WebviewUrl,
};
use tauri_plugin_opener::OpenerExt;

const LABEL: &str = "discord-view";
const HOME_URL: &str = "https://discord.com/app";

/// How long a fresh child may stay hidden while it boots. The finished load is
/// not enough: on a slow network the document arrives long before Discord's
/// client paints. After this the child is shown anyway, so a stuck page (an
/// error page included) is never hidden forever.
const FIRST_PAINT_TIMEOUT: Duration = Duration::from_secs(45);

/// True once the web client reported that it painted; only then may the child
/// take over from the loading note.
static PAINTED: AtomicBool = AtomicBool::new(false);
/// The frontend still wants the page on screen (it hides the child under modals).
static WANT_VISIBLE: AtomicBool = AtomicBool::new(false);
/// Bumped on every create/destroy, so a stale first-paint timer cannot show a
/// newer child.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Fake host the dev page probe reports through; the navigation is cancelled.
const PROBE_HOST: &str = "efxlve.local";

/// Read-only readiness check: Discord's client-side root gains children only
/// when the web client has actually painted. The report navigation is
/// cancelled, so the page itself never changes; the loading note stays visible
/// until the report arrives. Small and idempotent on purpose.
const READY_SCRIPT: &str = r#"
(function () {
    var mount = document.getElementById('app-mount');
    var kids = mount ? mount.childElementCount : -1;
    try {
        location.assign('https://efxlve.local/ready?m=' + kids);
    } catch (e) {}
})();
"#;

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
                href: location.href,
                origin: location.origin,
                secure: window.isSecureContext,
                topFrame: window.top === window,
                kids: document.body ? document.body.childElementCount : -1,
                mount: mount ? mount.childElementCount : -1,
                mountHtml: mount ? mount.innerHTML.replace(/\s+/g, ' ').slice(0, 160) : '',
                html: document.documentElement ? document.documentElement.outerHTML.length : -1,
                txt: document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 100) : '',
                bg: document.body ? getComputedStyle(document.body).backgroundColor : '',
                vis: document.visibilityState,
                ck: 'cookieEnabled' in navigator ? navigator.cookieEnabled : null,
                lsType: typeof window.localStorage,
                ssType: typeof window.sessionStorage,
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

/// The Discord host family the embedded page may navigate to.
fn is_discord_host(url: &url::Url) -> bool {
    let host = url.host_str().unwrap_or("").to_ascii_lowercase();
    host == "discord.com"
        || host.ends_with(".discord.com")
        || host == "discordapp.com"
        || host.ends_with(".discordapp.com")
}

/// Chromium's own pages (`about:blank`, the network-error page): they must
/// never be blocked, or a failed load would leave the child blank.
fn is_internal_scheme(scheme: &str) -> bool {
    matches!(
        scheme,
        "about" | "blob" | "data" | "chrome" | "chrome-error" | "edge"
    )
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
    let nav_app = app.clone();
    let mut builder = WebviewBuilder::new(LABEL, WebviewUrl::External(url))
        // The app's obsidian void, so a frame painted before Discord's own
        // background never flashes the gray of Discord's dark theme.
        .background_color(tauri::webview::Color(14, 15, 18, 255))
        .on_navigation(move |target| {
            if target.host_str() == Some(PROBE_HOST) {
                // Readiness report: the web client painted, so the child may
                // take over from the loading note.
                if target.path() == "/ready" {
                    let kids = target
                        .query_pairs()
                        .find(|(key, _)| key == "m")
                        .and_then(|(_, value)| value.parse::<i64>().ok())
                        .unwrap_or(-1);
                    if kids > 0 {
                        PAINTED.store(true, Ordering::SeqCst);
                        if WANT_VISIBLE.load(Ordering::SeqCst) {
                            if let Some(view) = view(&nav_app) {
                                let _ = view.show();
                            }
                        }
                    }
                    return false;
                }
                // Dev probe report: logged, then cancelled so the child stays
                // on Discord.
                eprintln!("[discord-view] probe {}", target);
                return false;
            }
            match target.scheme() {
                "http" | "https" => {
                    if is_discord_host(target) {
                        return true;
                    }
                    // A web link outside Discord belongs to the system browser;
                    // it must not navigate the embedded client away.
                    let _ = nav_app.opener().open_url(target.as_str(), None::<&str>);
                    false
                }
                scheme if is_internal_scheme(scheme) => true,
                _ => {
                    // mailto:, discord:, spotify: … hand over to the OS handler.
                    let _ = nav_app.opener().open_url(target.as_str(), None::<&str>);
                    false
                }
            }
        })
        // Load diagnostics: the terminal that runs `tauri dev` shows whether the
        // page ever reaches a finished load, which separates a network problem
        // (blocked host, no `Finished`) from a rendering problem.
        .on_page_load(|webview, payload| {
            eprintln!("[discord-view] {:?} {}", payload.event(), payload.url());
            if payload.event() != tauri::webview::PageLoadEvent::Finished {
                return;
            }
            // The finished load only means the document arrived; the readiness
            // report decides when the child may show.
            let _ = webview.eval(READY_SCRIPT);
            if !PROBE_SCRIPT.is_empty() {
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

    PAINTED.store(false, Ordering::SeqCst);
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // `add_child` posts to the main thread and waits; run it off the async
    // runtime so the UI never blocks on creation.
    let target = window.clone();
    let created = tokio::task::spawn_blocking(move || target.add_child(builder, position, size));
    created
        .await
        .map_err(|error| error.to_string())?
        .map_err(|error| error.to_string())?;

    // The document can finish loading while the web client is still blank (its
    // assets trickle in on a slow network), so the child stays hidden behind
    // the loading note until `#app-mount` actually has children. A destroy
    // bumps the generation, so a stale poll is inert; the timeout shows the
    // child anyway so an error page is never hidden forever.
    let ready_app = app.clone();
    tauri::async_runtime::spawn(async move {
        let deadline = std::time::Instant::now() + FIRST_PAINT_TIMEOUT;
        while std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(700)).await;
            if GENERATION.load(Ordering::SeqCst) != generation || PAINTED.load(Ordering::SeqCst) {
                return;
            }
            if let Some(view) = view(&ready_app) {
                let _ = view.eval(READY_SCRIPT);
            }
        }
        if GENERATION.load(Ordering::SeqCst) == generation
            && !PAINTED.load(Ordering::SeqCst)
            && WANT_VISIBLE.load(Ordering::SeqCst)
        {
            eprintln!("[discord-view] readiness timeout; showing the child anyway");
            if let Some(view) = view(&ready_app) {
                let _ = view.show();
            }
        }
    });
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
    WANT_VISIBLE.store(true, Ordering::SeqCst);
    let existing = view(&app);
    eprintln!(
        "[discord-view] show rect=({x:.0},{y:.0},{width:.0}x{height:.0}) existing={}",
        existing.is_some()
    );
    if let Some(view) = existing {
        view.set_bounds(rect_of(x, y, width, height))
            .map_err(|error| error.to_string())?;
        // A child that has not painted yet stays hidden; the loading note
        // shows in its place.
        if PAINTED.load(Ordering::SeqCst) {
            view.show().map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    create_view(&app, x, y, width, height).await
}

/// Hides the page while a covering surface (modal, command palette) is open.
/// The state stays warm for the next show.
#[tauri::command]
pub fn discord_view_hide(app: AppHandle) {
    WANT_VISIBLE.store(false, Ordering::SeqCst);
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
    WANT_VISIBLE.store(false, Ordering::SeqCst);
    PAINTED.store(false, Ordering::SeqCst);
    GENERATION.fetch_add(1, Ordering::SeqCst);
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
